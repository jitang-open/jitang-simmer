/* ============================================================
 * Simmer Server · 数据库层（SQLite）
 *  - usage_minutes：逐分钟前台软件记录（每行 = 某设备某分钟在某软件）
 *  - devices：设备注册表
 *  - ai_token_events：请求级 AI Token 数字事件（不保存对话内容或本地路径）
 *  - ai_source_status：各设备的本地 AI 来源发现状态
 *  - ts 为采集端本地时间字符串 'YYYY-MM-DDTHH:MM'，便于字符串比较聚合
 * ============================================================ */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.SIMMER_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'simmer.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  custom_name TEXT,
  paused      INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_minutes (
  device_id   TEXT NOT NULL,
  ts          TEXT NOT NULL,
  app         TEXT NOT NULL,
  PRIMARY KEY (device_id, ts, app)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS dashboard_settings (
  settings_id INTEGER PRIMARY KEY CHECK (settings_id = 1),
  data_json   TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_token_events (
  device_id          TEXT NOT NULL,
  source             TEXT NOT NULL CHECK (source IN ('codex', 'zcode', 'dsh')),
  source_event_id    TEXT NOT NULL,
  provider           TEXT NOT NULL DEFAULT '',
  model              TEXT NOT NULL DEFAULT '',
  occurred_at        TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens      INTEGER NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens  INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
  reasoning_tokens   INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
  total_tokens       INTEGER NOT NULL CHECK (total_tokens >= 0),
  parser_version     TEXT NOT NULL DEFAULT '',
  received_at        TEXT NOT NULL,
  PRIMARY KEY (device_id, source, source_event_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_ai_token_events_occurred
  ON ai_token_events (occurred_at, device_id);
CREATE INDEX IF NOT EXISTS idx_ai_token_events_dimensions
  ON ai_token_events (source, provider, model);
CREATE TABLE IF NOT EXISTS ai_source_status (
  device_id       TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('codex', 'zcode', 'dsh')),
  state           TEXT NOT NULL,
  detail_code     TEXT NOT NULL DEFAULT '',
  checked_at      TEXT NOT NULL,
  parser_version  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (device_id, source)
) WITHOUT ROWID;
`);

// 兼容已有数据库：设备别名不会再被后续采集上报覆盖，暂停状态由服务端统一控制。
const deviceColumns = new Set(db.prepare('PRAGMA table_info(devices)').all().map(column => column.name));
if (!deviceColumns.has('custom_name')) db.exec('ALTER TABLE devices ADD COLUMN custom_name TEXT');
if (!deviceColumns.has('paused')) db.exec('ALTER TABLE devices ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');

module.exports = db;
