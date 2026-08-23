const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simmer-aggregate-'));
process.env.SIMMER_DATA_DIR = tempDir;

const db = require('./db');
const agg = require('./aggregate');

test.after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test.before(() => {
  db.prepare(`INSERT INTO devices (device_id, name, first_seen, last_seen)
              VALUES ('pc-1', 'PC 1', '2026-08-03', '2026-08-10')`).run();
  const insert = db.prepare('INSERT INTO usage_minutes (device_id, ts, app) VALUES (?, ?, ?)');
  for (let minute = 0; minute < 10; minute++) {
    insert.run('pc-1', `2026-08-03T09:${String(minute).padStart(2, '0')}`, 'Code.exe');
  }
  insert.run('pc-1', '2026-08-10T09:00', 'Other.exe');
});

test('显式空软件集合返回零数据，未提供筛选仍返回全部数据', () => {
  assert.deepEqual(agg.appTotals('all', [], 'total'), []);
  assert.equal(agg.appTotals('all', undefined, 'total').length, 2);
});

test('星期均值包含完整日期范围内的零使用日期', () => {
  const result = agg.appWeekday('pc-1', 'Code.exe');
  assert.equal(result.labels[0], '周一');
  assert.equal(result.values[0], 5); // 两个周一中仅第一个使用 10 分钟
});

test('软件统计可按任意日、自然周和自然月查询', () => {
  assert.deepEqual(
    agg.appTotals('pc-1', undefined, 'daily', '2026-08-03').map(row => [row.id, row.minutes]),
    [['Code.exe', 10]]
  );
  assert.deepEqual(
    agg.appTotals('pc-1', undefined, 'weekly', '2026-08-05').map(row => [row.id, row.minutes]),
    [['Code.exe', 10]]
  );
  assert.deepEqual(
    agg.appTotals('pc-1', undefined, 'monthly', '2026-08-22').map(row => [row.id, row.minutes]),
    [['Code.exe', 10], ['Other.exe', 1]]
  );
  const monthTrend = agg.trendSeries('pc-1', undefined, 'monthly', '2026-08-22');
  assert.equal(monthTrend.labels.length, 31);
  assert.equal(monthTrend.values[2], 0.17);
});

test('软件统计支持任意起止日期，长范围趋势自动按月聚合', () => {
  assert.deepEqual(
    agg.appTotals('pc-1', undefined, 'custom', null, '2026-08-03', '2026-08-09')
      .map(row => [row.id, row.minutes]),
    [['Code.exe', 10]]
  );
  const weekTrend = agg.trendSeries(
    'pc-1', undefined, 'custom', null, '2026-08-03', '2026-08-09'
  );
  assert.equal(weekTrend.labels.length, 7);
  assert.equal(weekTrend.values.reduce((sum, value) => sum + value, 0), 0.17);

  const longTrend = agg.trendSeries(
    'pc-1', undefined, 'custom', null, '2026-07-01', '2026-09-30'
  );
  assert.deepEqual(longTrend.labels, ['2026/7', '2026/8', '2026/9']);
  assert.deepEqual(longTrend.values, [0, 0.18, 0]);
});
