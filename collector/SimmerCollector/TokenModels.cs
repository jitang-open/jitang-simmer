using System.Text.Json.Serialization;

namespace SimmerCollector;

internal static class TokenProtocol
{
    public const string ParserVersion = "tokscale-b069c85";
    public static readonly string[] Sources = ["codex", "zcode", "dsh"];
}

internal sealed class TokenEvent
{
    [JsonPropertyName("sourceEventId")] public string SourceEventId { get; set; } = "";
    [JsonPropertyName("source")] public string Source { get; set; } = "";
    [JsonPropertyName("provider")] public string Provider { get; set; } = "";
    [JsonPropertyName("model")] public string Model { get; set; } = "";
    [JsonPropertyName("occurredAt")] public string OccurredAt { get; set; } = "";
    [JsonPropertyName("inputTokens")] public long InputTokens { get; set; }
    [JsonPropertyName("outputTokens")] public long OutputTokens { get; set; }
    [JsonPropertyName("cacheReadTokens")] public long CacheReadTokens { get; set; }
    [JsonPropertyName("cacheWriteTokens")] public long CacheWriteTokens { get; set; }
    [JsonPropertyName("reasoningTokens")] public long ReasoningTokens { get; set; }
    [JsonPropertyName("totalTokens")] public long TotalTokens { get; set; }
    [JsonPropertyName("parserVersion")] public string ParserVersion { get; set; } = TokenProtocol.ParserVersion;

    [JsonIgnore]
    public string QueueKey => Source + ":" + SourceEventId;

    public bool IsValid()
    {
        if (!TokenProtocol.Sources.Contains(Source) || SourceEventId.Length != 64 ||
            Provider.Length > 200 || Model.Length > 200 || ParserVersion.Length > 80 ||
            !DateTimeOffset.TryParse(OccurredAt, out _)) return false;
        if (InputTokens < 0 || OutputTokens < 0 || CacheReadTokens < 0 || CacheWriteTokens < 0 ||
            ReasoningTokens < 0 || TotalTokens < 0) return false;
        try
        {
            return checked(InputTokens + OutputTokens + CacheReadTokens + CacheWriteTokens + ReasoningTokens) == TotalTokens;
        }
        catch (OverflowException) { return false; }
    }
}

internal sealed class TokenSourceStatus
{
    [JsonPropertyName("source")] public string Source { get; set; } = "";
    [JsonPropertyName("state")] public string State { get; set; } = "not_found";
    [JsonPropertyName("detailCode")] public string DetailCode { get; set; } = "not_scanned";
    [JsonPropertyName("checkedAt")] public string CheckedAt { get; set; } = DateTimeOffset.UtcNow.ToString("O");
    [JsonPropertyName("parserVersion")] public string ParserVersion { get; set; } = TokenProtocol.ParserVersion;
}

internal sealed class TokenScanOutput
{
    [JsonPropertyName("parserVersion")] public string ParserVersion { get; set; } = "";
    [JsonPropertyName("events")] public List<TokenEvent> Events { get; set; } = new();
    [JsonPropertyName("diagnostics")] public TokenScanDiagnostics Diagnostics { get; set; } = new();
}

internal sealed class TokenScanDiagnostics
{
    [JsonPropertyName("codexFiles")] public int CodexFiles { get; set; }
    [JsonPropertyName("zcodeDatabases")] public int ZCodeDatabases { get; set; }
    [JsonPropertyName("dshFiles")] public int DshFiles { get; set; }
    [JsonPropertyName("skippedInvalidEvents")] public int SkippedInvalidEvents { get; set; }
}

internal sealed record TokenDiscoveryResult(
    string Source,
    string? DataRoot,
    bool HasData,
    bool HasExecutable,
    TokenSourceStatus Status);
