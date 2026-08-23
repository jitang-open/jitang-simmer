/* ============================================================
 * Simmer Server · HTTP 入口
 *  - POST /api/ingest   采集端上报（Bearer token 鉴权，幂等）
 *  - GET  /api/devices  设备列表
 *  - PATCH /api/devices/:id  修改设备显示名或暂停状态
 *  - GET  /api/year?device=&year=&apps=        年度逐日分钟数
 *  - GET  /api/trend?device=&range=&apps=      趋势（daily/weekly/total）
 *  - GET  /api/app-totals?device=&range=&apps= 软件时长合计
 *  - GET  /api/app-weekday?device=&app=        单软件星期分布
 *  - GET  /api/range                           数据日期范围（SRV-04）
 *  - GET/PUT /api/settings                     白名单与软件元数据（SRV-05）
 *  - POST /api/ai-token-events                 请求级 Token 数字事件（Bearer token 鉴权）
 *  - GET  /api/ai-tokens/*                     Token 汇总、趋势、热力图与来源状态
 *  - 静态托管前端（http://localhost:8788/ 直接真数据预览）
 * ============================================================ */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const db = require('./db');
const agg = require('./aggregate');
const tokenAgg = require('./token-aggregate');

/* ---------- 配置（首启自动生成 token） ---------- */
const CONFIG_PATH = process.env.SIMMER_CONFIG_PATH || path.join(__dirname, 'config.json');
let config;
if (process.env.SIMMER_TOKEN) {
  config = {
    token: process.env.SIMMER_TOKEN,
    port: Number(process.env.SIMMER_PORT) || 8788,
    host: process.env.SIMMER_HOST || '0.0.0.0',
  };
} else if (fs.existsSync(CONFIG_PATH)) {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} else {
  config = { token: crypto.randomBytes(24).toString('hex'), port: 8788 };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log('[simmer] 已生成 server/config.json，上报 token：' + config.token);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

/* ---------- 上报 ---------- */
const upsertDevice = db.prepare(`
  INSERT INTO devices (device_id, name, first_seen, last_seen) VALUES (@id, @name, @now, @now)
  ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen
`);
const insertMinute = db.prepare(`
  INSERT INTO usage_minutes (device_id, ts, app) VALUES (?, ?, ?)
  ON CONFLICT(device_id, ts, app) DO NOTHING      -- 幂等：重复上报无害
`);
const insertBatch = db.transaction((deviceId, minutes) => {
  for (const m of minutes) insertMinute.run(deviceId, m.t, m.app);
});
const getDevicePaused = db.prepare('SELECT paused FROM devices WHERE device_id=?');

function registerDevice(deviceId, deviceName, timestamp) {
  upsertDevice.run({ id: deviceId, name: deviceName, now: timestamp });
  return !!getDevicePaused.get(deviceId)?.paused;
}

function auth(req, res, next) {
  if ((req.headers.authorization || '') !== 'Bearer ' + config.token) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.post('/api/ingest', auth, (req, res) => {
  const { deviceId, deviceName, minutes } = req.body || {};
  if (!deviceId || !deviceName || !Array.isArray(minutes)) {
    return res.status(400).json({ error: 'bad_request', required: '{ deviceId, deviceName, minutes: [{ t, app }] }' });
  }
  const bad = minutes.find(m => !m || typeof m.t !== 'string' || typeof m.app !== 'string');
  if (bad) return res.status(400).json({ error: 'bad_minute_row' });

  const nowIso = new Date().toISOString();
  const paused = registerDevice(deviceId, deviceName, nowIso);
  if (paused) return res.json({ ok: true, received: 0, skipped: minutes.length, paused: true });
  insertBatch(deviceId, minutes);
  res.json({ ok: true, received: minutes.length });
});

/* ---------- AI Token 请求级事件上报（TS-04/06） ---------- */
const SOURCE_STATES = new Set(['ready', 'installed_no_data', 'history_only', 'not_found', 'incompatible', 'error']);
const SOURCE_EVENT_ID = /^[a-f0-9]{64}$/;
const MAX_TOKEN_EVENTS = 5000;
const safeText = (value, max, { allowEmpty = true } = {}) =>
  typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0);
const safeToken = value => Number.isSafeInteger(value) && value >= 0;
const safeTimestamp = value => safeText(value, 64, { allowEmpty: false }) && Number.isFinite(Date.parse(value));

function normalizeTokenEvent(event) {
  if (!event || typeof event !== 'object' ||
      !SOURCE_EVENT_ID.test(event.sourceEventId || '') ||
      !tokenAgg.SOURCES.includes(event.source) ||
      !safeText(event.provider, 200) || !safeText(event.model, 200) ||
      !safeTimestamp(event.occurredAt) || !safeText(event.parserVersion, 80)) return null;

  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'];
  if (!fields.every(field => safeToken(event[field]))) return null;
  const computedTotal = event.inputTokens + event.outputTokens + event.cacheReadTokens +
    event.cacheWriteTokens + event.reasoningTokens;
  if (!Number.isSafeInteger(computedTotal) || computedTotal !== event.totalTokens) return null;

  return {
    sourceEventId: event.sourceEventId,
    source: event.source,
    provider: event.provider,
    model: event.model,
    occurredAt: new Date(event.occurredAt).toISOString(),
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    reasoningTokens: event.reasoningTokens,
    totalTokens: event.totalTokens,
    parserVersion: event.parserVersion,
  };
}

function normalizeSourceStatus(status) {
  if (!status || typeof status !== 'object' ||
      !tokenAgg.SOURCES.includes(status.source) || !SOURCE_STATES.has(status.state) ||
      !safeText(status.detailCode, 100) || !safeTimestamp(status.checkedAt) ||
      !safeText(status.parserVersion, 80)) return null;
  return {
    source: status.source,
    state: status.state,
    detailCode: status.detailCode,
    checkedAt: new Date(status.checkedAt).toISOString(),
    parserVersion: status.parserVersion,
  };
}

const insertTokenEvent = db.prepare(`
  INSERT INTO ai_token_events (
    device_id, source, source_event_id, provider, model, occurred_at,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
    reasoning_tokens, total_tokens, parser_version, received_at
  ) VALUES (
    @deviceId, @source, @sourceEventId, @provider, @model, @occurredAt,
    @inputTokens, @outputTokens, @cacheReadTokens, @cacheWriteTokens,
    @reasoningTokens, @totalTokens, @parserVersion, @receivedAt
  ) ON CONFLICT(device_id, source, source_event_id) DO NOTHING
`);
const upsertSourceStatus = db.prepare(`
  INSERT INTO ai_source_status (device_id, source, state, detail_code, checked_at, parser_version)
  VALUES (@deviceId, @source, @state, @detailCode, @checkedAt, @parserVersion)
  ON CONFLICT(device_id, source) DO UPDATE SET
    state=excluded.state, detail_code=excluded.detail_code,
    checked_at=excluded.checked_at, parser_version=excluded.parser_version
`);
const storeTokenBatch = db.transaction((deviceId, events, statuses, receivedAt) => {
  let inserted = 0;
  for (const event of events) inserted += insertTokenEvent.run({ deviceId, ...event, receivedAt }).changes;
  for (const status of statuses) upsertSourceStatus.run({ deviceId, ...status });
  return inserted;
});

app.post('/api/ai-token-events', auth, (req, res) => {
  const { deviceId, deviceName, events, statuses = [] } = req.body || {};
  if (!safeText(deviceId, 200, { allowEmpty: false }) || !safeText(deviceName, 200, { allowEmpty: false }) ||
      !Array.isArray(events) || events.length > MAX_TOKEN_EVENTS ||
      !Array.isArray(statuses) || statuses.length > tokenAgg.SOURCES.length) {
    return res.status(400).json({ error: 'bad_request' });
  }
  const normalizedEvents = events.map(normalizeTokenEvent);
  const normalizedStatuses = statuses.map(normalizeSourceStatus);
  if (normalizedEvents.some(event => !event) || normalizedStatuses.some(status => !status) ||
      new Set(normalizedStatuses.map(status => status.source)).size !== normalizedStatuses.length) {
    return res.status(400).json({ error: 'invalid_token_payload' });
  }

  const receivedAt = new Date().toISOString();
  const paused = registerDevice(deviceId, deviceName, receivedAt);
  if (paused) return res.json({
    ok: true,
    received: 0,
    inserted: 0,
    duplicates: 0,
    statuses: 0,
    skipped: normalizedEvents.length,
    paused: true,
  });
  const inserted = storeTokenBatch(deviceId, normalizedEvents, normalizedStatuses, receivedAt);
  res.json({
    ok: true,
    received: normalizedEvents.length,
    inserted,
    duplicates: normalizedEvents.length - inserted,
    statuses: normalizedStatuses.length,
  });
});

/* ---------- 查询（与前端 data.js 同构） ---------- */
// 未提供 apps = 不筛选；显式 apps= = 空集合（白名单清空后应返回零数据）。
const csv = s => s === undefined
  ? undefined
  : String(s).split(',').map(x => x.trim()).filter(Boolean);

app.get('/api/devices', (req, res) => res.json(agg.devices()));
app.patch('/api/devices/:id', (req, res) => {
  const deviceId = String(req.params.id || '');
  if (!db.prepare('SELECT 1 FROM devices WHERE device_id=?').get(deviceId)) {
    return res.status(404).json({ error: 'device_not_found' });
  }

  const updates = [];
  const params = [];
  if (Object.hasOwn(req.body || {}, 'name')) {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 200) return res.status(400).json({ error: 'invalid_device_name' });
    updates.push('custom_name=?');
    params.push(name);
  }
  if (Object.hasOwn(req.body || {}, 'paused')) {
    if (typeof req.body.paused !== 'boolean') return res.status(400).json({ error: 'invalid_paused_state' });
    updates.push('paused=?');
    params.push(req.body.paused ? 1 : 0);
  }
  if (!updates.length) return res.status(400).json({ error: 'no_device_changes' });
  params.push(deviceId);
  db.prepare(`UPDATE devices SET ${updates.join(', ')} WHERE device_id=?`).run(...params);
  res.json(agg.devices().find(device => device.id === deviceId));
});
app.get('/api/year', (req, res) =>
  res.json(agg.yearSeries(req.query.device || 'all', csv(req.query.apps), parseInt(req.query.year, 10) || new Date().getFullYear())));
app.get('/api/trend', (req, res) =>
  res.json(agg.trendSeries(
    req.query.device || 'all', csv(req.query.apps), req.query.range || 'daily', req.query.date,
    req.query.startDate, req.query.endDate
  )));
app.get('/api/app-totals', (req, res) =>
  res.json(agg.appTotals(
    req.query.device || 'all', csv(req.query.apps), req.query.range || 'daily', req.query.date,
    req.query.startDate, req.query.endDate
  )));
app.get('/api/app-weekday', (req, res) =>
  res.json(agg.appWeekday(req.query.device || 'all', req.query.app || '')));
app.get('/api/range', (req, res) => res.json(agg.rangeInfo()));

const tokenFilters = query => ({
  sources: csv(query.sources),
  providers: csv(query.providers),
  models: csv(query.models),
});
const tokenRange = value => ['daily', 'weekly', 'monthly', 'custom', 'total'].includes(value) ? value : 'daily';
app.get('/api/ai-tokens/summary', (req, res) =>
  res.json(tokenAgg.summary(
    req.query.device || 'all', tokenFilters(req.query), tokenRange(req.query.range), req.query.date,
    req.query.startDate, req.query.endDate
  )));
app.get('/api/ai-tokens/trend', (req, res) =>
  res.json(tokenAgg.trend(
    req.query.device || 'all', tokenFilters(req.query), tokenRange(req.query.range), req.query.date,
    req.query.groupBy === 'model', req.query.startDate, req.query.endDate
  )));
app.get('/api/ai-tokens/year', (req, res) =>
  res.json(tokenAgg.yearSeries(
    req.query.device || 'all', tokenFilters(req.query), parseInt(req.query.year, 10) || new Date().getFullYear()
  )));
app.get('/api/ai-tokens/breakdown', (req, res) =>
  res.json(tokenAgg.breakdown(
    req.query.device || 'all', tokenFilters(req.query), tokenRange(req.query.range), req.query.dimension || 'source',
    req.query.date, req.query.startDate, req.query.endDate
  )));
app.get('/api/ai-tokens/sources', (req, res) =>
  res.json(tokenAgg.sourceStatuses(req.query.device || 'all')));
app.get('/api/ai-tokens/dimensions', (req, res) =>
  res.json(tokenAgg.dimensions(req.query.device || 'all')));

/* ---------- 单用户面板设置（SQLite 为唯一数据源，localStorage 仅作缓存） ---------- */
const getSettings = db.prepare(
  'SELECT data_json, updated_at FROM dashboard_settings WHERE settings_id = 1'
);
const upsertSettings = db.prepare(`
  INSERT INTO dashboard_settings (settings_id, data_json, updated_at) VALUES (1, ?, ?)
  ON CONFLICT(settings_id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
`);

const validStringArray = value => Array.isArray(value) && value.length <= 2000 &&
  value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 260);

function normalizeSettings(value) {
  if (!value || typeof value !== 'object') return null;
  const { whitelist, customApps, removedApps, offApps } = value;
  if (!validStringArray(whitelist) || !validStringArray(removedApps) || !validStringArray(offApps) ||
      !Array.isArray(customApps) || customApps.length > 1000) return null;

  const normalizedApps = [];
  const appIds = new Set();
  for (const appRow of customApps) {
    if (!appRow || typeof appRow !== 'object' ||
        typeof appRow.id !== 'string' || !appRow.id || appRow.id.length > 260 ||
        typeof appRow.name !== 'string' || appRow.name.length > 200 ||
        typeof appRow.icon !== 'string' || appRow.icon.length > 32 ||
        typeof appRow.category !== 'string' || appRow.category.length > 50 ||
        typeof appRow.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(appRow.color)) return null;
    if (appIds.has(appRow.id)) continue;
    appIds.add(appRow.id);
    normalizedApps.push({
      id: appRow.id,
      name: appRow.name,
      icon: appRow.icon,
      color: appRow.color,
      category: appRow.category,
    });
  }
  return {
    whitelist: [...new Set(whitelist)],
    customApps: normalizedApps,
    removedApps: [...new Set(removedApps)],
    offApps: [...new Set(offApps)],
  };
}

app.get('/api/settings', (req, res) => {
  const row = getSettings.get();
  if (!row) return res.json({ settings: null, updatedAt: null });
  try {
    return res.json({ settings: JSON.parse(row.data_json), updatedAt: row.updated_at });
  } catch {
    return res.status(500).json({ error: 'settings_corrupted' });
  }
});

app.put('/api/settings', (req, res) => {
  const settings = normalizeSettings(req.body);
  if (!settings) return res.status(400).json({ error: 'invalid_settings' });
  const updatedAt = new Date().toISOString();
  upsertSettings.run(JSON.stringify(settings), updatedAt);
  res.json({ ok: true, settings, updatedAt });
});

/* ---------- 静态托管前端（严格白名单，禁止暴露 server/config.json 与数据库） ---------- */
const WEB_ROOT = path.join(__dirname, '..');
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(WEB_ROOT, 'index.html')));
app.use('/css', express.static(path.join(WEB_ROOT, 'css'), { index: false }));
app.use('/js', express.static(path.join(WEB_ROOT, 'js'), { index: false }));

if (require.main === module) {
  const PORT = config.port || 8788;
  const HOST = config.host || '0.0.0.0';
  app.listen(PORT, HOST, () => {
    console.log(`[simmer] 后端已启动：http://localhost:${PORT}`);
    console.log('[simmer] 前端预览（真数据）：http://localhost:' + PORT + '/index.html');
  });
}

module.exports = app;
