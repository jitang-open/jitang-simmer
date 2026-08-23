/* ============================================================
 * Simmer Server · 硬件指标聚合
 *  - 原始数据一分钟一条，字段可为空
 *  - 单设备按桶取平均；全部设备时功耗求和，其余指标取平均
 *  - “当前值”仅接受十分钟内的样本，避免采集器退出后展示陈旧读数
 * ============================================================ */
const db = require('./db');
const { addDays, dayStr } = require('./time-range');

const METRICS = Object.freeze({
  cpu: 'cpu_load',
  gpu: 'gpu_load',
  mem: 'memory_load',
  vram: 'vram_load',
  cpuTemp: 'cpu_temp',
  gpuTemp: 'gpu_temp',
  power: 'power_watts',
  disk: 'disk_load',
});
const pad = value => String(value).padStart(2, '0');
const minuteStr = date => `${dayStr(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

function idsFor(device) {
  if (device && device !== 'all') return [String(device)];
  return db.prepare('SELECT device_id FROM devices').pluck().all();
}

function metricColumn(metric) {
  return METRICS[metric] || null;
}

function aggregateAcrossDevices(deviceValues, metric) {
  const values = [...deviceValues.values()].filter(Number.isFinite);
  if (!values.length) return null;
  const value = metric === 'power'
    ? values.reduce((sum, row) => sum + row, 0)
    : values.reduce((sum, row) => sum + row, 0) / values.length;
  return +value.toFixed(1);
}

function current(device, metric, reference = new Date()) {
  const column = metricColumn(metric);
  const ids = idsFor(device);
  if (!column || !ids.length) return { value: null, updatedAt: null };

  const cutoff = new Date(reference.getTime() - 10 * 60_000);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT sample.device_id AS deviceId, sample.ts, sample.${column} AS value
    FROM hardware_samples sample
    INNER JOIN (
      SELECT device_id, MAX(ts) AS ts
      FROM hardware_samples
      WHERE device_id IN (${placeholders}) AND ts>=? AND ${column} IS NOT NULL
      GROUP BY device_id
    ) latest ON latest.device_id=sample.device_id AND latest.ts=sample.ts
  `).all(...ids, minuteStr(cutoff));
  const values = new Map(rows.map(row => [row.deviceId, Number(row.value)]));
  return {
    value: aggregateAcrossDevices(values, metric),
    updatedAt: rows.length ? rows.map(row => row.ts).sort().at(-1) : null,
  };
}

function rangeDefinition(range, reference) {
  const today = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
  if (range === 'daily') {
    return {
      start: today,
      end: today,
      keys: Array.from({ length: 24 }, (_, hour) => `${dayStr(today)}T${pad(hour)}`),
      labels: Array.from({ length: 24 }, (_, hour) => `${hour}:00`),
      keyOf: ts => ts.slice(0, 13),
    };
  }
  if (range === 'weekly') {
    const start = addDays(today, -6);
    const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
    const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return {
      start,
      end: today,
      keys: days.map(dayStr),
      labels: days.map(date => `${weekNames[date.getDay()]} ${date.getMonth() + 1}/${date.getDate()}`),
      keyOf: ts => ts.slice(0, 10),
    };
  }

  const first = new Date(today.getFullYear(), today.getMonth() - 11, 1);
  const months = Array.from({ length: 12 }, (_, index) =>
    new Date(first.getFullYear(), first.getMonth() + index, 1));
  return {
    start: first,
    end: today,
    keys: months.map(date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`),
    labels: months.map(date => `${date.getMonth() + 1}月`),
    keyOf: ts => ts.slice(0, 7),
  };
}

function series(device, metric, range = 'daily', reference = new Date()) {
  const column = metricColumn(metric);
  const ids = idsFor(device);
  const definition = rangeDefinition(range, reference);
  if (!column || !ids.length) {
    return { labels: definition.labels, values: definition.labels.map(() => null) };
  }

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT device_id AS deviceId, ts, ${column} AS value
    FROM hardware_samples
    WHERE device_id IN (${placeholders})
      AND substr(ts,1,10)>=? AND substr(ts,1,10)<=?
      AND ${column} IS NOT NULL
    ORDER BY ts
  `).all(...ids, dayStr(definition.start), dayStr(definition.end));

  const buckets = new Map();
  for (const row of rows) {
    const key = definition.keyOf(row.ts);
    if (!buckets.has(key)) buckets.set(key, new Map());
    const perDevice = buckets.get(key);
    if (!perDevice.has(row.deviceId)) perDevice.set(row.deviceId, []);
    perDevice.get(row.deviceId).push(Number(row.value));
  }

  const values = definition.keys.map(key => {
    const perDevice = buckets.get(key);
    if (!perDevice) return null;
    const averages = new Map([...perDevice].map(([deviceId, rowsForDevice]) => [
      deviceId,
      rowsForDevice.reduce((sum, value) => sum + value, 0) / rowsForDevice.length,
    ]));
    return aggregateAcrossDevices(averages, metric);
  });
  return { labels: definition.labels, values };
}

module.exports = { METRICS, current, series };
