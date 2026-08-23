/* ============================================================
 * Simmer Server · AI Token 聚合查询层
 *  - 所有日期分桶均按服务端本地时区计算
 *  - 只读取请求级数字事件，不涉及提示词、回复或本地路径
 * ============================================================ */
const db = require('./db');
const { dayStr, eachDay, rangeBounds } = require('./time-range');

const SOURCES = ['codex', 'zcode', 'dsh', 'workbuddy'];
const TOKEN_COLUMNS = [
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'reasoning_tokens',
  'total_tokens',
];
const pad = n => String(n).padStart(2, '0');
const now = () => new Date();

function deviceIds(device) {
  if (device && device !== 'all') return [device];
  return db.prepare(
    'SELECT DISTINCT device_id FROM ai_token_events UNION SELECT DISTINCT device_id FROM ai_source_status'
  ).pluck().all();
}

function normalizeFilter(values) {
  if (values === undefined) return undefined;
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
}

function rangeSql(range, anchor, reference = now()) {
  const bounds = rangeBounds(range, anchor, reference);
  if (bounds) return {
    sql: " AND date(occurred_at, 'localtime')>=? AND date(occurred_at, 'localtime')<=?",
    params: [dayStr(bounds.start), dayStr(bounds.end)],
  };
  return { sql: '', params: [] };
}

function scope(device, filters = {}, range = 'total', extraSql = '', anchor) {
  const ids = deviceIds(device);
  const params = [];
  let sql = ' WHERE 1=1';
  if (!ids.length) {
    sql += ' AND 0';
  } else {
    sql += ` AND device_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }

  for (const [field, raw] of [
    ['source', filters.sources],
    ['provider', filters.providers],
    ['model', filters.models],
  ]) {
    const values = normalizeFilter(raw);
    if (values === undefined) continue;
    if (!values.length) return { sql: ' WHERE 0', params: [] };
    sql += ` AND ${field} IN (${values.map(() => '?').join(',')})`;
    params.push(...values);
  }

  const rangePart = rangeSql(range, anchor);
  sql += rangePart.sql + extraSql;
  params.push(...rangePart.params);
  return { sql, params };
}

function rowToSummary(row = {}) {
  return {
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    cacheReadTokens: Number(row.cache_read_tokens || 0),
    cacheWriteTokens: Number(row.cache_write_tokens || 0),
    reasoningTokens: Number(row.reasoning_tokens || 0),
    totalTokens: Number(row.total_tokens || 0),
    eventCount: Number(row.event_count || 0),
  };
}

function summary(device, filters, range, anchor) {
  const { sql, params } = scope(device, filters, range, '', anchor);
  const sums = TOKEN_COLUMNS.map(column => `COALESCE(SUM(${column}), 0) AS ${column}`).join(', ');
  const row = db.prepare(`SELECT ${sums}, COUNT(*) AS event_count FROM ai_token_events ${sql}`).get(...params);
  return rowToSummary(row);
}

function trend(device, filters, range, anchor, groupByModel = false) {
  const reference = now();
  const labels = [];
  const keys = [];
  let keySql;

  if (range === 'daily') {
    keySql = "strftime('%H', occurred_at, 'localtime')";
    for (let hour = 0; hour < 24; hour++) {
      keys.push(pad(hour));
      labels.push(`${hour}:00`);
    }
  } else if (range === 'weekly' || range === 'monthly') {
    keySql = "date(occurred_at, 'localtime')";
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const bounds = rangeBounds(range, anchor, reference);
    for (const date of eachDay(bounds.start, bounds.end)) {
      keys.push(dayStr(date));
      labels.push(range === 'weekly'
        ? `${weekdays[date.getDay()]} ${date.getMonth() + 1}/${date.getDate()}`
        : `${date.getMonth() + 1}/${date.getDate()}`);
    }
  } else {
    keySql = "strftime('%Y-%m', occurred_at, 'localtime')";
    for (let offset = 11; offset >= 0; offset--) {
      const date = new Date(reference.getFullYear(), reference.getMonth() - offset, 1);
      keys.push(`${date.getFullYear()}-${pad(date.getMonth() + 1)}`);
      labels.push(`${date.getMonth() + 1}月`);
    }
  }

  const { sql, params } = scope(
    device, filters, range, ` AND ${keySql} IN (${keys.map(() => '?').join(',')})`, anchor
  );
  params.push(...keys);
  if (groupByModel) {
    const rows = db.prepare(
      `SELECT ${keySql} AS bucket,
              CASE WHEN model='' THEN 'unknown' ELSE model END AS model,
              SUM(total_tokens) AS tokens
       FROM ai_token_events ${sql}
       GROUP BY bucket, model`
    ).all(...params);
    const byModel = new Map();
    for (const row of rows) {
      if (!byModel.has(row.model)) byModel.set(row.model, new Map());
      byModel.get(row.model).set(row.bucket, Number(row.tokens));
    }
    return {
      labels,
      series: [...byModel].sort(([left], [right]) => left.localeCompare(right)).map(([id, values]) => ({
        id,
        values: keys.map(key => values.get(key) || 0),
      })),
      unit: 'tokens',
    };
  }
  const rows = db.prepare(
    `SELECT ${keySql} AS bucket, SUM(total_tokens) AS tokens FROM ai_token_events ${sql} GROUP BY bucket`
  ).all(...params);
  const valuesByKey = new Map(rows.map(row => [row.bucket, Number(row.tokens)]));
  return { labels, values: keys.map(key => valuesByKey.get(key) || 0), unit: 'tokens' };
}

function yearSeries(device, filters, year) {
  const { sql, params } = scope(
    device, filters, 'total', " AND strftime('%Y', occurred_at, 'localtime')=?"
  );
  params.push(String(year));
  const rows = db.prepare(
    `SELECT date(occurred_at, 'localtime') AS day, SUM(total_tokens) AS tokens
     FROM ai_token_events ${sql} GROUP BY day`
  ).all(...params);
  const valuesByDay = new Map(rows.map(row => [row.day, Number(row.tokens)]));
  const today = dayStr(now());
  const result = [];
  const end = new Date(year, 11, 31);
  for (let date = new Date(year, 0, 1); date <= end; date.setDate(date.getDate() + 1)) {
    const day = dayStr(date);
    result.push({ date: day, tokens: day > today ? null : (valuesByDay.get(day) || 0) });
  }
  return result;
}

function breakdown(device, filters, range, dimension, anchor) {
  const columns = { source: 'source', provider: 'provider', model: 'model' };
  const column = columns[dimension] || columns.source;
  const { sql, params } = scope(device, filters, range, '', anchor);
  return db.prepare(
    `SELECT CASE WHEN ${column}='' THEN 'unknown' ELSE ${column} END AS id,
            SUM(total_tokens) AS tokens, COUNT(*) AS event_count
     FROM ai_token_events ${sql}
     GROUP BY id ORDER BY tokens DESC, id ASC`
  ).all(...params).map(row => ({
    id: row.id,
    tokens: Number(row.tokens),
    eventCount: Number(row.event_count),
  }));
}

function markStoredHistory(rows, ids) {
  if (!ids.length || !rows.length) return rows;
  const history = new Set(db.prepare(
    `SELECT DISTINCT device_id, source FROM ai_token_events
     WHERE device_id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids).map(row => `${row.device_id}\u0000${row.source}`));
  return rows.map(row => {
    const hasHistory = history.has(`${row.deviceId}\u0000${row.source}`);
    if (!hasHistory || !['not_found', 'installed_no_data'].includes(row.state)) return row;
    return { ...row, state: 'history_only', detailCode: 'server_history_only' };
  });
}

function sourceStatuses(device) {
  const ids = deviceIds(device);
  if (!ids.length) return [];
  const rows = db.prepare(
    `SELECT device_id AS deviceId, source, state, detail_code AS detailCode,
            checked_at AS checkedAt, parser_version AS parserVersion
     FROM ai_source_status
     WHERE device_id IN (${ids.map(() => '?').join(',')})
     ORDER BY device_id, source`
  ).all(...ids);
  if (device === 'all' || !device) return markStoredHistory(rows, ids);

  const bySource = new Map(rows.map(row => [row.source, row]));
  return markStoredHistory(SOURCES.map(source => bySource.get(source) || {
    deviceId: device,
    source,
    state: 'not_found',
    detailCode: 'not_scanned',
    checkedAt: null,
    parserVersion: '',
  }), ids);
}

function dimensions(device) {
  const ids = deviceIds(device);
  if (!ids.length) return { sources: [], providers: [], models: [] };
  const where = `device_id IN (${ids.map(() => '?').join(',')})`;
  const distinct = column => db.prepare(
    `SELECT DISTINCT ${column} AS value FROM ai_token_events
     WHERE ${where} AND ${column}<>'' ORDER BY value`
  ).pluck().all(...ids);
  return { sources: distinct('source'), providers: distinct('provider'), models: distinct('model') };
}

module.exports = { SOURCES, summary, trend, yearSeries, breakdown, sourceStatuses, dimensions };
