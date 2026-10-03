/* ============================================================
 * Simmer Server · 文件日志（<DATA_DIR>/logs/）
 *  - 按天轮转：以凌晨 4 点为一天的分界（4 点前算前一天）
 *  - 按月分文件夹：<DATA_DIR>/logs/<YYYY-MM>/log-<YYYY-MM-DD>.txt
 *  - 历史日志永不删除，只追加
 *  - 时间戳与日期分界均按北京时间（UTC+8，无夏令时）。容器时区多为 UTC，
 *    这里直接做固定偏移，不依赖容器 TZ 设置。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const { format } = require('util');

const DATA_DIR = process.env.SIMMER_DATA_DIR || path.join(__dirname, 'data');
const LOG_ROOT = path.join(DATA_DIR, 'logs');
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_BOUNDARY_MS = 4 * 60 * 60 * 1000;

const pad = (value) => String(value).padStart(2, '0');

/* 北京时间的"日志日"（yyyy-mm-dd）与时刻前缀（HH:mm:ss）。
 * 先加 +8h 换算成北京墙上时间，再减 4h 取日期，即得到 4 点分界的日志日。 */
function stampParts(date) {
  const wall = new Date(date.getTime() + BEIJING_OFFSET_MS);
  const day = new Date(wall.getTime() - DAY_BOUNDARY_MS);
  const dayString = `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}`;
  const clock = `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}`;
  return { dayString, clock };
}

function append(line) {
  try {
    const { dayString, clock } = stampParts(new Date());
    const directory = path.join(LOG_ROOT, dayString.slice(0, 7));
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    // 同步追加保证同进程内行序稳定；日志量小，阻塞可忽略
    fs.appendFileSync(path.join(directory, `log-${dayString}.txt`), `${dayString} ${clock} ${line}\n`);
  } catch { /* 文件日志失败不影响接口服务 */ }
}

/* console.log/info/warn/error 落盘一份，stdout 原样保留（docker logs 继续可用） */
function teeConsole() {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      try { append(`[${level}] ${format(...args)}`); } catch { /* 忽略 */ }
      original[level](...args);
    };
  }
}

/* HTTP 访问日志：`[access] GET /api/range 200 12ms` */
function access(message) { append(`[access] ${message}`); }

module.exports = { append, access, teeConsole, stampParts };
