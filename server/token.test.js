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
];
const statuses = [
  { source: 'codex', state: 'ready', detailCode: 'sessions_found', checkedAt: now.toISOString(), parserVersion: 'test-1' },
  { source: 'zcode', state: 'ready', detailCode: 'database_found', checkedAt: now.toISOString(), parserVersion: 'test-1' },
  { source: 'dsh', state: 'not_found', detailCode: 'home_missing', checkedAt: now.toISOString(), parserVersion: 'test-1' },
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
  assert.deepEqual(first.body, { ok: true, received: 2, inserted: 2, duplicates: 0, statuses: 3 });
  const second = await request('/api/ai-token-events', { method: 'POST', body: payload, authorized: true });
  assert.deepEqual(second.body, { ok: true, received: 2, inserted: 0, duplicates: 2, statuses: 3 });
  assert.equal(db.prepare('SELECT COUNT(*) FROM ai_token_events').pluck().get(), 2);
});

test('Token 汇总、筛选、分组、热力图和来源状态返回一致数据', async () => {
  const total = await request('/api/ai-tokens/summary?device=test-pc&range=total');
  assert.deepEqual(total.body, {
    inputTokens: 140,
    outputTokens: 55,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    reasoningTokens: 10,
    totalTokens: 225,
    eventCount: 2,
  });

  const codex = await request('/api/ai-tokens/summary?device=test-pc&range=total&sources=codex');
  assert.equal(codex.body.totalTokens, 180);
  const breakdown = await request('/api/ai-tokens/breakdown?device=test-pc&range=total&dimension=source');
  assert.deepEqual(breakdown.body.map(row => [row.id, row.tokens]), [['codex', 180], ['zcode', 45]]);

  const year = await request(`/api/ai-tokens/year?device=test-pc&year=${now.getFullYear()}`);
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.equal(year.body.find(day => day.date === today).tokens, 225);

  const dimensions = await request('/api/ai-tokens/dimensions?device=test-pc');
  assert.deepEqual(dimensions.body.sources, ['codex', 'zcode']);
  assert.deepEqual(dimensions.body.models, ['glm-5.3', 'gpt-5.6-sol']);

  const sourceRows = await request('/api/ai-tokens/sources?device=test-pc');
  assert.equal(sourceRows.body.length, 3);
  assert.equal(sourceRows.body.find(row => row.source === 'dsh').state, 'not_found');
});
