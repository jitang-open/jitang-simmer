const test = require('node:test');
const assert = require('node:assert/strict');

const { buildHeatmapScale } = require('../js/charts');

const rows = minutes => minutes.map(value => ({ minutes: value }));

test('点阵比例色阶忽略零值、未来日期与无效值', () => {
  const scale = buildHeatmapScale(rows([0, null, undefined, NaN, -10]));
  assert.equal(scale.capMinutes, 0);
  assert.deepEqual(scale.thresholds, []);
  assert.equal(scale.level(0), 0);
  assert.equal(scale.level(null), 0);
});

test('P95 被等分为八个阈值并覆盖九个正值色阶', () => {
  const scale = buildHeatmapScale(rows([100, 200, 300, 400, 500, 600, 700, 800]));
  assert.equal(scale.capMinutes, 800);
  assert.deepEqual(scale.thresholds, [100, 200, 300, 400, 500, 600, 700, 800]);
  assert.equal(scale.level(1), 1);
  assert.equal(scale.level(100), 2);
  assert.equal(scale.level(400), 5);
  assert.equal(scale.level(800), 9);
  assert.equal(scale.level(8000), 9);
});

test('P95 限制极端异常日，不让普通日期失去颜色层次', () => {
  const normal = Array.from({ length: 19 }, (_, index) => (index + 1) * 60);
  const scale = buildHeatmapScale(rows([...normal, 60000]));
  assert.equal(scale.capMinutes, 1140);
  assert.equal(scale.level(1140), 9);
  assert.equal(scale.level(60000), 9);
  assert.ok(scale.level(570) > 1);
});

test('总览与单软件独立尺度对相同比例产生相同色阶', () => {
  const appScale = buildHeatmapScale(rows([10, 20, 30, 40, 50, 60, 70, 80]));
  const totalScale = buildHeatmapScale(rows([100, 200, 300, 400, 500, 600, 700, 800]));
  assert.equal(appScale.capMinutes, 80);
  assert.equal(totalScale.capMinutes, 800);
  assert.equal(appScale.level(40), totalScale.level(400));
});

test('AI Token 年度点阵复用 P95 色阶但读取独立 tokens 字段', () => {
  const scale = buildHeatmapScale(
    [1000, 2000, 3000, 4000, null].map(tokens => ({ tokens })),
    'tokens'
  );
  assert.equal(scale.capMinutes, 4000);
  assert.equal(scale.level(4000), 9);
  assert.equal(scale.level(null), 0);
});

test('软件时长点阵可在 P95 之上再按五小时硬封顶', () => {
  const scale = buildHeatmapScale(rows([60, 120, 240, 480, 1200]), 'minutes', 300);
  assert.equal(scale.capMinutes, 300);
  assert.equal(scale.level(300), 9);
  assert.equal(scale.level(1200), 9);
  assert.ok(scale.level(120) > 1);
});
