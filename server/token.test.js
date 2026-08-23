const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simmer-token-'));
process.env.SIMMER_DATA_DIR = path.join(tempDir, 'data');
process.env.SIMMER_CONFIG_PATH = path.join(tempDir, 'config.json');
fs.writeFileSync(process.env.SIMMER_CONFIG_PATH, JSON.stringify({ token: 'test-token', port: 0 }));

const app = require('./index');
const db = require('./db');
let server;

test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function request(pathname, { method = 'GET', body, authorized = false } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (authorized) headers.Authorization = 'Bearer test-token';
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, res => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: responseBody ? JSON.parse(responseBody) : null,
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const eventId = value => crypto.createHash('sha256').update(value).digest('hex');
const now = new Date();
const events = [
  {
    sourceEventId: eventId('codex-request-1'),
    source: 'codex',
    provider: 'openai',
    model: 'gpt-5.6-sol',
    occurredAt: now.toISOString(),
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    reasoningTokens: 10,
    totalTokens: 180,
    parserVersion: 'test-1',
  },
  {
    sourceEventId: eventId('zcode-request-1'),
    source: 'zcode',
    provider: 'z.ai',
    model: 'glm-5.3',
    occurredAt: now.toISOString(),
    inputTokens: 40,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 45,
    parserVersion: 'test-1',
  },
  {
    sourceEventId: eventId('workbuddy-request-1'),
    source: 'workbuddy',
    provider: 'moonshot',
    model: 'kimi-k3-1',
    occurredAt: now.toISOString(),
    inputTokens: 60,
    outputTokens: 15,
    cacheReadTokens: 25,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 100,
    parserVersion: 'test-1',
  },
];
const statuses = [
  { source: 'codex', state: 'ready', detailCode: 'sessions_found', checkedAt: now.toISOString(), parserVersion: 'test-1' },
  { source: 'zcode', state: 'ready', detailCode: 'database_found', checkedAt: now.toISOString(), parserVersion: 'test-1' },
  { source: 'dsh', state: 'not_found', detailCode: 'home_missing', checkedAt: now.toISOString(), parserVersion: 'test-1' },
  { source: 'workbuddy', state: 'ready', detailCode: 'data_and_app', checkedAt: now.toISOString(), parserVersion: 'test-1' },
];
const payload = { deviceId: 'test-pc', deviceName: 'Test PC', events, statuses };

test('Token 上报需要鉴权，并拒绝总数不一致的事件', async () => {
  assert.equal((await request('/api/ai-token-events', { method: 'POST', body: payload })).status, 401);
  const invalid = structuredClone(payload);
  invalid.events[0].totalTokens++;
  assert.equal((await request('/api/ai-token-events', {
    method: 'POST', body: invalid, authorized: true,
  })).status, 400);
});

test('Token 请求级事件按稳定 ID 幂等写入', async () => {
  const first = await request('/api/ai-token-events', { method: 'POST', body: payload, authorized: true });
  assert.deepEqual(first.body, { ok: true, received: 3, inserted: 3, duplicates: 0, statuses: 4 });
  const second = await request('/api/ai-token-events', { method: 'POST', body: payload, authorized: true });
  assert.deepEqual(second.body, { ok: true, received: 3, inserted: 0, duplicates: 3, statuses: 4 });
  assert.equal(db.prepare('SELECT COUNT(*) FROM ai_token_events').pluck().get(), 3);
});

test('Token 汇总、筛选、分组、热力图和来源状态返回一致数据', async () => {
  const total = await request('/api/ai-tokens/summary?device=test-pc&range=total');
  assert.deepEqual(total.body, {
    inputTokens: 200,
    outputTokens: 70,
    cacheReadTokens: 45,
    cacheWriteTokens: 0,
    reasoningTokens: 10,
    totalTokens: 325,
    eventCount: 3,
  });

  const codex = await request('/api/ai-tokens/summary?device=test-pc&range=total&sources=codex');
  assert.equal(codex.body.totalTokens, 180);
  const breakdown = await request('/api/ai-tokens/breakdown?device=test-pc&range=total&dimension=source');
  assert.deepEqual(breakdown.body.map(row => [row.id, row.tokens]), [['codex', 180], ['workbuddy', 100], ['zcode', 45]]);

  const year = await request(`/api/ai-tokens/year?device=test-pc&year=${now.getFullYear()}`);
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.equal(year.body.find(day => day.date === today).tokens, 325);

  const dimensions = await request('/api/ai-tokens/dimensions?device=test-pc');
  assert.deepEqual(dimensions.body.sources, ['codex', 'workbuddy', 'zcode']);
  assert.deepEqual(dimensions.body.models, ['glm-5.3', 'gpt-5.6-sol', 'kimi-k3-1']);

  const sourceRows = await request('/api/ai-tokens/sources?device=test-pc');
  assert.equal(sourceRows.body.length, 4);
  assert.equal(sourceRows.body.find(row => row.source === 'dsh').state, 'not_found');

  const selectedDay = await request(`/api/ai-tokens/summary?device=test-pc&range=daily&date=${today}`);
  assert.equal(selectedDay.body.totalTokens, 325);
  const modelTrend = await request(`/api/ai-tokens/trend?device=test-pc&range=daily&date=${today}&groupBy=model`);
  assert.deepEqual(modelTrend.body.series.map(series => series.id), ['glm-5.3', 'gpt-5.6-sol', 'kimi-k3-1']);
  assert.equal(modelTrend.body.series.reduce(
    (sum, series) => sum + series.values.reduce((inner, value) => inner + value, 0), 0
  ), 325);

  const custom = await request(
    `/api/ai-tokens/summary?device=test-pc&range=custom&startDate=${today}&endDate=${today}`
  );
  assert.equal(custom.body.totalTokens, 325);
  const customTrend = await request(
    `/api/ai-tokens/trend?device=test-pc&range=custom&startDate=${today}&endDate=${today}&groupBy=model`
  );
  assert.equal(customTrend.body.labels.length, 1);
  assert.equal(customTrend.body.series.reduce(
    (sum, series) => sum + series.values.reduce((inner, value) => inner + value, 0), 0
  ), 325);
});

test('本地来源消失后累计历史仍保留，并显示历史已保存', async () => {
  const missingPayload = {
    deviceId: 'test-pc',
    deviceName: 'Test PC',
    events: [],
    statuses: [
      { ...statuses[0], state: 'not_found', detailCode: 'no_data_or_app' },
      { ...statuses[1], state: 'installed_no_data', detailCode: 'app_only' },
      statuses[2],
      { ...statuses[3], state: 'not_found', detailCode: 'no_data_or_app' },
    ],
  };
  const update = await request('/api/ai-token-events', {
    method: 'POST', body: missingPayload, authorized: true,
  });
  assert.deepEqual(update.body, { ok: true, received: 0, inserted: 0, duplicates: 0, statuses: 4 });

  const total = await request('/api/ai-tokens/summary?device=test-pc&range=total');
  assert.equal(total.body.totalTokens, 325);
  assert.equal(total.body.eventCount, 3);

  const sourceRows = await request('/api/ai-tokens/sources?device=test-pc');
  const codex = sourceRows.body.find(row => row.source === 'codex');
  const zcode = sourceRows.body.find(row => row.source === 'zcode');
  const dsh = sourceRows.body.find(row => row.source === 'dsh');
  const workbuddy = sourceRows.body.find(row => row.source === 'workbuddy');
  assert.equal(codex.state, 'history_only');
  assert.equal(codex.detailCode, 'server_history_only');
  assert.equal(zcode.state, 'history_only');
  assert.equal(zcode.detailCode, 'server_history_only');
  assert.equal(dsh.state, 'not_found');
  assert.equal(workbuddy.state, 'history_only');
  assert.equal(workbuddy.detailCode, 'server_history_only');
});

test('设备可改名、暂停并恢复软件与 Token 统计', async () => {
  const renamed = await request('/api/devices/test-pc', {
    method: 'PATCH', body: { name: '腾讯云开发机', paused: true },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, '腾讯云开发机');
  assert.equal(renamed.body.reportedName, 'Test PC');
  assert.equal(renamed.body.paused, true);

  const minute = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T12:00`;
  const pausedUsage = await request('/api/ingest', {
    method: 'POST', authorized: true,
    body: { deviceId: 'test-pc', deviceName: 'Test PC', minutes: [{ t: minute, app: 'Code.exe' }] },
  });
  assert.deepEqual(pausedUsage.body, { ok: true, received: 0, skipped: 1, paused: true });

  const pausedToken = await request('/api/ai-token-events', {
    method: 'POST', authorized: true,
    body: {
      deviceId: 'test-pc', deviceName: 'Test PC',
      events: [{ ...events[0], sourceEventId: eventId('paused-token-event') }], statuses: [],
    },
  });
  assert.equal(pausedToken.body.paused, true);
  assert.equal(db.prepare('SELECT COUNT(*) FROM ai_token_events').pluck().get(), 3);

  const resumed = await request('/api/devices/test-pc', { method: 'PATCH', body: { paused: false } });
  assert.equal(resumed.body.paused, false);
  const resumedUsage = await request('/api/ingest', {
    method: 'POST', authorized: true,
    body: { deviceId: 'test-pc', deviceName: 'Collector Name', minutes: [{ t: minute, app: 'Code.exe' }] },
  });
  assert.equal(resumedUsage.body.received, 1);
  const devices = await request('/api/devices');
  assert.equal(devices.body[0].name, '腾讯云开发机');
  assert.equal(devices.body[0].reportedName, 'Collector Name');
});
