/* ============================================================
 * Simmer Server · HTTP 入口
 *  - POST /api/ingest   采集端上报（Bearer token 鉴权，幂等）
 *  - GET  /api/devices  设备列表
 *  - GET  /api/year?device=&year=&apps=        年度逐日分钟数
 *  - GET  /api/trend?device=&range=&apps=      趋势（daily/weekly/total）
 *  - GET  /api/app-totals?device=&range=&apps= 软件时长合计
 *  - GET  /api/app-weekday?device=&app=        单软件星期分布
 *  - GET  /api/range                           数据日期范围（SRV-04）
 *  - 静态托管前端（http://localhost:8788/ 直接真数据预览）
 * ============================================================ */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const db = require('./db');
const agg = require('./aggregate');

/* ---------- 配置（首启自动生成 token） ---------- */
const CONFIG_PATH = process.env.SIMMER_CONFIG_PATH || path.join(__dirname, 'config.json');
let config;
if (fs.existsSync(CONFIG_PATH)) {
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
  upsertDevice.run({ id: deviceId, name: deviceName, now: nowIso });
  insertBatch(deviceId, minutes);
  res.json({ ok: true, received: minutes.length });
});

/* ---------- 查询（与前端 data.js 同构） ---------- */
// 未提供 apps = 不筛选；显式 apps= = 空集合（白名单清空后应返回零数据）。
const csv = s => s === undefined
  ? undefined
  : String(s).split(',').map(x => x.trim()).filter(Boolean);

app.get('/api/devices', (req, res) => res.json(agg.devices()));
app.get('/api/year', (req, res) =>
  res.json(agg.yearSeries(req.query.device || 'all', csv(req.query.apps), parseInt(req.query.year, 10) || new Date().getFullYear())));
app.get('/api/trend', (req, res) =>
  res.json(agg.trendSeries(req.query.device || 'all', csv(req.query.apps), req.query.range || 'daily')));
app.get('/api/app-totals', (req, res) =>
  res.json(agg.appTotals(req.query.device || 'all', csv(req.query.apps), req.query.range || 'daily')));
app.get('/api/app-weekday', (req, res) =>
  res.json(agg.appWeekday(req.query.device || 'all', req.query.app || '')));
app.get('/api/range', (req, res) => res.json(agg.rangeInfo()));

/* ---------- 静态托管前端（严格白名单，禁止暴露 server/config.json 与数据库） ---------- */
const WEB_ROOT = path.join(__dirname, '..');
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(WEB_ROOT, 'index.html')));
app.use('/css', express.static(path.join(WEB_ROOT, 'css'), { index: false }));
app.use('/js', express.static(path.join(WEB_ROOT, 'js'), { index: false }));

if (require.main === module) {
  const PORT = config.port || 8788;
  app.listen(PORT, () => {
    console.log(`[simmer] 后端已启动：http://localhost:${PORT}`);
    console.log('[simmer] 前端预览（真数据）：http://localhost:' + PORT + '/index.html');
  });
}

module.exports = app;
