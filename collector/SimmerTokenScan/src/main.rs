use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tokscale_core::sessions::{
    codex::parse_codex_file, dsh::parse_dsh_file, zcode::parse_zcode_sqlite, UnifiedMessage,
};
use walkdir::WalkDir;

const PARSER_VERSION: &str = "tokscale-b069c85";
const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Default)]
struct Options {
    codex_root: Option<PathBuf>,
    zcode_root: Option<PathBuf>,
    dsh_root: Option<PathBuf>,
    modified_since_ms: Option<u128>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenEvent {
    source_event_id: String,
    source: String,
    provider: String,
    model: String,
    occurred_at: String,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    reasoning_tokens: i64,
    total_tokens: i64,
    parser_version: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    parser_version: &'static str,
    events: Vec<TokenEvent>,
    diagnostics: Diagnostics,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    codex_files: usize,
    zcode_databases: usize,
    dsh_files: usize,
    skipped_invalid_events: usize,
}

fn main() {
    match run() {
        Ok(result) => {
            if let Err(error) = serde_json::to_writer(std::io::stdout(), &result) {
                eprintln!("failed_to_write_result:{error}");
                std::process::exit(2);
            }
        }
        Err(error) => {
            eprintln!("scan_failed:{error}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<ScanResult, String> {
    let options = parse_options()?;
    let mut messages: Vec<(String, UnifiedMessage)> = Vec::new();
    let mut diagnostics = Diagnostics::default();

    if let Some(root) = options.codex_root.as_deref() {
        for directory in [root.join("sessions"), root.join("archived_sessions")] {
            for file in files_named(&directory, |path| {
                path.extension().and_then(|value| value.to_str()) == Some("jsonl")
            }, options.modified_since_ms) {
                diagnostics.codex_files += 1;
                messages.extend(parse_codex_file(&file).into_iter().map(|message| ("codex".into(), message)));
            }
        }
    }

    if let Some(root) = options.zcode_root.as_deref() {
        let database = root.join("cli").join("db").join("db.sqlite");
        if database.is_file() {
            diagnostics.zcode_databases = 1;
            messages.extend(parse_zcode_sqlite(&database).into_iter().map(|message| ("zcode".into(), message)));
        }
    }

    if let Some(root) = options.dsh_root.as_deref() {
        let sessions = root.join("sessions");
        for file in files_named(&sessions, |path| {
            matches!(path.file_name().and_then(|value| value.to_str()), Some("session.jsonl") | Some("session.jsonl.zstd"))
        }, options.modified_since_ms) {
            diagnostics.dsh_files += 1;
            messages.extend(parse_dsh_file(&file).into_iter().map(|message| ("dsh".into(), message)));
        }
    }

    let mut seen = HashSet::new();
    let mut events = Vec::with_capacity(messages.len());
    for (source, message) in messages {
        match normalize_message(&source, message) {
            Some(event) if seen.insert(event.source_event_id.clone()) => events.push(event),
            Some(_) => {}
            None => diagnostics.skipped_invalid_events += 1,
        }
    }
    events.sort_by(|left, right| {
        left.occurred_at
            .cmp(&right.occurred_at)
            .then_with(|| left.source_event_id.cmp(&right.source_event_id))
    });

    Ok(ScanResult { parser_version: PARSER_VERSION, events, diagnostics })
}

fn parse_options() -> Result<Options, String> {
    let mut options = Options::default();
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--codex-root" => options.codex_root = Some(required_path(&mut args, &argument)?),
            "--zcode-root" => options.zcode_root = Some(required_path(&mut args, &argument)?),
            "--dsh-root" => options.dsh_root = Some(required_path(&mut args, &argument)?),
            "--modified-since-ms" => {
                let value = args.next().ok_or_else(|| format!("missing_value:{argument}"))?;
                options.modified_since_ms = Some(value.parse().map_err(|_| "invalid_modified_since".to_string())?);
            }
            "--version" => {
                println!("{PARSER_VERSION}");
                std::process::exit(0);
            }
            unknown => return Err(format!("unknown_argument:{unknown}")),
        }
    }
    Ok(options)
}

fn required_path(args: &mut impl Iterator<Item = String>, argument: &str) -> Result<PathBuf, String> {
    args.next().map(PathBuf::from).ok_or_else(|| format!("missing_value:{argument}"))
}

fn files_named(
    root: &Path,
    predicate: impl Fn(&Path) -> bool,
    modified_since_ms: Option<u128>,
) -> Vec<PathBuf> {
    if !root.is_dir() {
        return Vec::new();
    }
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && predicate(entry.path()))
        .filter(|entry| {
            let Some(cutoff) = modified_since_ms else { return true };
            entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .is_some_and(|duration| duration.as_millis() >= cutoff)
        })
        .map(|entry| entry.into_path())
        .collect()
}

fn normalize_message(source: &str, message: UnifiedMessage) -> Option<TokenEvent> {
    if message.timestamp <= 0 {
        return None;
    }
    let input = message.tokens.input.max(0);
    let output = message.tokens.output.max(0);
    let cache_read = message.tokens.cache_read.max(0);
    let cache_write = message.tokens.cache_write.max(0);
    let reasoning = message.tokens.reasoning.max(0);
    let total = input
        .checked_add(output)?
        .checked_add(cache_read)?
        .checked_add(cache_write)?
        .checked_add(reasoning)?;
    if total <= 0 || total > JS_MAX_SAFE_INTEGER {
        return None;
    }

    let identity = message.dedup_key.unwrap_or_else(|| {
        format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            source,
            message.session_id,
            message.timestamp,
            message.provider_id,
            message.model_id,
            input,
            output,
            cache_read,
            cache_write,
            reasoning,
            total
        )
    });
    let mut hasher = Sha256::new();
    hasher.update(source.as_bytes());
    hasher.update(b"\0");
    hasher.update(identity.as_bytes());
    let source_event_id = format!("{:x}", hasher.finalize());

    let occurred_at = unix_millis_to_iso(message.timestamp)?;
    Some(TokenEvent {
        source_event_id,
        source: source.to_string(),
        provider: truncate(message.provider_id, 200),
        model: truncate(message.model_id, 200),
        occurred_at,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_write_tokens: cache_write,
        reasoning_tokens: reasoning,
        total_tokens: total,
        parser_version: PARSER_VERSION,
    })
}

fn unix_millis_to_iso(timestamp: i64) -> Option<String> {
    let seconds = timestamp.div_euclid(1000);
    let millis = timestamp.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days)?;
    let hour = second_of_day / 3_600;
    let minute = (second_of_day % 3_600) / 60;
    let second = second_of_day % 60;
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    ))
}

// Howard Hinnant 的公历换算；避免为时间格式再引入一个大型依赖。
fn civil_from_days(days_since_epoch: i64) -> Option<(i64, i64, i64)> {
    let z = days_since_epoch.checked_add(719_468)?;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    (1..=9999).contains(&year).then_some((year, month, day))
}

fn truncate(value: String, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokscale_core::TokenBreakdown;

    fn message(session_id: &str) -> UnifiedMessage {
        UnifiedMessage::new_with_dedup(
            "codex",
            "gpt-test",
            "openai",
            session_id,
            1_787_330_096_123,
            TokenBreakdown {
                input: 10,
                output: 20,
                cache_read: 30,
                cache_write: 40,
                reasoning: 50,
            },
            0.0,
            Some("upstream-stable-key".to_string()),
        )
    }

    #[test]
    fn normalizes_five_disjoint_buckets_and_iso_timestamp() {
        let event = normalize_message("codex", message("private-session")).unwrap();
        assert_eq!(event.total_tokens, 150);
        assert_eq!(event.occurred_at, "2026-08-21T16:34:56.123Z");
        assert_eq!(event.source_event_id.len(), 64);
    }

    #[test]
    fn upstream_dedup_key_hides_session_and_stays_stable_across_copies() {
        let first = normalize_message("codex", message("session-a")).unwrap();
        let second = normalize_message("codex", message("session-b")).unwrap();
        assert_eq!(first.source_event_id, second.source_event_id);
        let serialized = serde_json::to_string(&first).unwrap();
        assert!(!serialized.contains("session-a"));
        assert!(!serialized.contains("upstream-stable-key"));
    }

    #[test]
    fn converts_unix_epoch_and_leap_day_without_external_time_state() {
        assert_eq!(unix_millis_to_iso(0).unwrap(), "1970-01-01T00:00:00.000Z");
        assert_eq!(unix_millis_to_iso(1_709_164_800_000).unwrap(), "2024-02-29T00:00:00.000Z");
    }
}
