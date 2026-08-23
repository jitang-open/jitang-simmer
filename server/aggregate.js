/* ============================================================
 * Simmer Server · 聚合查询层
 *  - 返回结构与前端 js/data.js 的查询函数同构（SRV-03）：
 *    yearSeries / trendSeries / appTotals / appWeekday / range
 *  - device = 'all' 时跨全部设备求和
 *  - apps 参数（可选数组）对应前端白名单过滤
 * ============================================================ */
const db = require('./db');
const { dayStr, eachDay, rangeBounds } = require('./time-range');

const pad = n => String(n).padStart(2, '0');
const now = () => new Date();

/* ---------- 设备 ---------- */
function devices() {
  return db.prepare(`
    SELECT device_id AS id,
           COALESCE(NULLIF(custom_name, ''), name) AS name,
           name AS reportedName,
           custom_name AS customName,
           paused,
           first_seen AS firstSeen,
           last_seen AS lastSeen
    FROM devices
    ORDER BY last_seen DESC
  `).all().map(device => ({ ...device, paused: !!device.paused }));
}
function deviceIds(device) {
  if (device && device !== 'all') return [device];
  return db.prepare('SELECT device_id FROM devices').pluck().all();
}

/* ---------- 拼装 WHERE 片段 ---------- */
function scope(device, apps, extraSql = '') {
  const ids = deviceIds(device);
  const params = [];
  let sql = ' WHERE 1=1';
  if (ids.length) {
    sql += ` AND device_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else {
    sql += ' AND 0';   // 没有任何设备时直接空结果
  }
  if (apps !== undefined) {
    if (apps.length) {
      sql += ` AND app IN (${apps.map(() => '?').join(',')})`;
      params.push(...apps);
    } else {
      sql += ' AND 0';   // 显式空白名单：不能退化为“全部软件”
    }
  }
  return { sql: sql + extraSql, params };
}

/* ---------- 年度点阵（完整自然年，未来日期 minutes=null） ---------- */
function yearSeries(device, apps, year) {
  const { sql, params } = scope(device, apps, ` AND substr(ts,1,4)=?`);
  params.push(String(year));
  const rows = db.prepare(
    `SELECT substr(ts,1,10) AS day, COUNT(*) AS minutes FROM usage_minutes ${sql} GROUP BY day`
  ).all(...params);
  const map = new Map(rows.map(r => [r.day, r.minutes]));

  const today = dayStr(now());
  const out = [];
  const end = new Date(year, 11, 31);
  for (let t = new Date(year, 0, 1); t <= end; t.setDate(t.getDate() + 1)) {
    const day = dayStr(t);
    out.push({
      date: new Date(t),
      minutes: day > today ? null : (map.get(day) || 0),
    });
  }
  return out;
}

/* ---------- 趋势：daily=某日24h / weekly=某周 / monthly=某月 / total=近12个月 ---------- */
function trendSeries(device, apps, range, anchor) {
  const n = now();
  if (range === 'daily') {
    const day = dayStr(rangeBounds('daily', anchor, n).start);
    const { sql, params } = scope(device, apps, ` AND substr(ts,1,10)=?`);
    params.push(day);
    const rows = db.prepare(
      `SELECT CAST(substr(ts,12,2) AS INTEGER) AS h, COUNT(*) AS m FROM usage_minutes ${sql} GROUP BY h`
    ).all(...params);
    const map = new Map(rows.map(r => [r.h, r.m]));
    const labels = [], values = [];
    for (let h = 0; h < 24; h++) { labels.push(h + ':00'); values.push(+( (map.get(h) || 0) / 60 ).toFixed(2)); }
    return { labels, values, unit: 'h' };
  }
  if (range === 'weekly' || range === 'monthly') {
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const labels = [], values = [];
    const bounds = rangeBounds(range, anchor, n);
    for (const d of eachDay(bounds.start, bounds.end)) {
      const day = dayStr(d);
      const { sql, params } = scope(device, apps, ` AND substr(ts,1,10)=?`);
      params.push(day);
      const r = db.prepare(`SELECT COUNT(*) AS m FROM usage_minutes ${sql}`).get(...params);
      labels.push(range === 'weekly'
        ? wd[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate()
        : (d.getMonth() + 1) + '/' + d.getDate());
      values.push(+((r.m) / 60).toFixed(2));
    }
    return { labels, values, unit: 'h' };
  }
  // total：近 12 个月（含当月）
  const labels = [], values = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(n.getFullYear(), n.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    const { sql, params } = scope(device, apps, ` AND substr(ts,1,7)=?`);
    params.push(ym);
    const r = db.prepare(`SELECT COUNT(*) AS m FROM usage_minutes ${sql}`).get(...params);
    labels.push((d.getMonth() + 1) + '月');
    values.push(+((r.m) / 60).toFixed(1));
  }
  return { labels, values, unit: 'h' };
}

/* ---------- 软件时长合计（降序） ---------- */
function appTotals(device, apps, range, anchor) {
  const bounds = rangeBounds(range, anchor, now());
  let dayFilter = '';

  let appFilter = '';
  const base = [];
  const ids = deviceIds(device);
  if (!ids.length) return [];
  const devFilter = ` AND device_id IN (${ids.map(() => '?').join(',')})`;
  base.push(...ids);
  if (apps !== undefined) {
    if (!apps.length) return [];
    appFilter = ` AND app IN (${apps.map(() => '?').join(',')})`;
    base.push(...apps);
  }
  if (bounds) {
    dayFilter = ' AND substr(ts,1,10)>=? AND substr(ts,1,10)<=?';
    base.push(dayStr(bounds.start), dayStr(bounds.end));
  }

  const rows = db.prepare(
    `SELECT app, COUNT(*) AS minutes FROM usage_minutes WHERE 1=1 ${devFilter} ${appFilter} ${dayFilter} GROUP BY app ORDER BY minutes DESC`
  ).all(...base);
  return rows.map(r => ({ id: r.app, name: r.app, minutes: r.minutes }));
}

/* ---------- 单软件星期分布（全历史日均） ---------- */
function appWeekday(device, app) {
  const ids = deviceIds(device);
  if (!ids.length) return { labels: [], values: [] };
  const rows = db.prepare(
    `SELECT strftime('%w', substr(ts,1,10)) AS w, COUNT(*) AS m
     FROM usage_minutes
     WHERE device_id IN (${ids.map(() => '?').join(',')}) AND app=?
     GROUP BY w`
  ).all(...ids, app);
  // 分母使用各设备完整的已观测日期范围，包含该软件零使用的日期，与 MockDB 语义一致。
  const ranges = db.prepare(
    `SELECT device_id, MIN(substr(ts,1,10)) AS min_day, MAX(substr(ts,1,10)) AS max_day
     FROM usage_minutes
     WHERE device_id IN (${ids.map(() => '?').join(',')})
     GROUP BY device_id`
  ).all(...ids);
  const dayCounts = Array(7).fill(0);
  for (const range of ranges) {
    const end = new Date(range.max_day + 'T00:00:00');
    for (let d = new Date(range.min_day + 'T00:00:00'); d <= end; d.setDate(d.getDate() + 1)) {
      dayCounts[d.getDay()]++;
    }
  }
  const wmap = new Map(rows.map(r => [r.w, r.m]));
  const order = [1, 2, 3, 4, 5, 6, 0];
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return {
    labels: order.map(w => names[w]),
    values: order.map(w => Math.round((wmap.get(String(w)) || 0) / Math.max(1, dayCounts[w]))),
  };
}

/* ---------- 数据范围（SRV-04：年份下拉由真实数据驱动） ---------- */
function rangeInfo() {
  const r = db.prepare('SELECT MIN(substr(ts,1,10)) AS min, MAX(substr(ts,1,10)) AS max FROM usage_minutes').get();
  return { minDate: r.min || null, maxDate: r.max || null };
}

module.exports = { devices, yearSeries, trendSeries, appTotals, appWeekday, rangeInfo };
