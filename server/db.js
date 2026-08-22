/* ============================================================
 * Simmer Server · 数据库层（SQLite）
 *  - usage_minutes：逐分钟前台软件记录（每行 = 某设备某分钟在某软件）
 *  - devices：设备注册表
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
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_minutes (
  device_id   TEXT NOT NULL,
  ts          TEXT NOT NULL,
  app         TEXT NOT NULL,
  PRIMARY KEY (device_id, ts, app)
) WITHOUT ROWID;
`);

module.exports = db;
