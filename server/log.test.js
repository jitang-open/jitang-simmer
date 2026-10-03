const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* log.js 在 require 时解析 SIMMER_DATA_DIR，必须在引入前指向临时目录 */
process.env.SIMMER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'simmer-logs-'));
const log = require('./log');

/* 构造"北京时间墙上时刻 = 参数"的绝对时间点（北京 = UTC+8，无夏令时） */
const beijing = (year, month, day, hour, minute, second) =>
  new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));

test('凌晨 4 点前算前一天，4 点整起算新一天', () => {
  assert.equal(log.stampParts(beijing(2026, 10, 3, 3, 59, 59)).dayString, '2026-10-02');
  assert.equal(log.stampParts(beijing(2026, 10, 3, 4, 0, 0)).dayString, '2026-10-03');
  assert.equal(log.stampParts(beijing(2026, 10, 3, 0, 0, 0)).dayString, '2026-10-02');
  assert.equal(log.stampParts(beijing(2026, 10, 3, 23, 59, 59)).dayString, '2026-10-03');
});

test('时间戳前缀为北京时间，跨月日志日落在对应月份文件夹', () => {
  assert.deepEqual(log.stampParts(beijing(2026, 10, 3, 19, 5, 9)),
    { dayString: '2026-10-03', clock: '19:05:09' });
  assert.equal(log.stampParts(beijing(2026, 11, 1, 3, 59, 59)).dayString, '2026-10-31');
  assert.equal(log.stampParts(beijing(2026, 11, 1, 4, 0, 0)).dayString, '2026-11-01');
  assert.equal(log.stampParts(beijing(2027, 1, 1, 4, 0, 0)).dayString, '2027-01-01');
});

test('append 写入当天的月文件夹日志文件，内容带时间戳', () => {
  log.append('测试日志行');
  const logRoot = path.join(process.env.SIMMER_DATA_DIR, 'logs');
  const files = fs.readdirSync(logRoot, { recursive: true })
    .map(entry => entry.replaceAll('\\', '/'))
    .filter(entry => entry.endsWith('.txt'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^2026-\d{2}\/log-\d{4}-\d{2}-\d{2}\.txt$/);
  const content = fs.readFileSync(path.join(logRoot, files[0]), 'utf8');
  assert.match(content, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 测试日志行\n$/);
});
