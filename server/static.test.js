const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simmer-static-'));
process.env.SIMMER_DATA_DIR = path.join(tempDir, 'data');
process.env.SIMMER_CONFIG_PATH = path.join(tempDir, 'config.json');
fs.writeFileSync(process.env.SIMMER_CONFIG_PATH, JSON.stringify({ token: 'test-token', port: 0 }));

const app = require('./index');
let server;

test.before(async () => {
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  require('./db').close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function request(pathname, { method = 'GET', body } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
    }, res => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => {
        const isJson = String(res.headers['content-type'] || '').includes('application/json');
        resolve({
          status: res.statusCode,
          body: responseBody ? (isJson ? JSON.parse(responseBody) : responseBody) : null,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('只托管前端白名单路径，不暴露配置和数据库', async () => {
  assert.equal((await request('/index.html')).status, 200);
  assert.equal((await request('/server/config.json')).status, 404);
  assert.equal((await request('/server/data/simmer.db')).status, 404);
});

test('面板设置持久化到 SQLite 并可跨浏览器读取', async () => {
  assert.equal((await request('/api/settings')).body.settings, null);
  const settings = {
    whitelist: ['Code.exe'],
    customApps: [{ id: 'Code.exe', name: 'Code', icon: '🧩', color: '#3b82f6', category: '开发工具' }],
    removedApps: [],
    offApps: ['chrome.exe'],
  };
  const saved = await request('/api/settings', { method: 'PUT', body: settings });
  assert.equal(saved.status, 200);
  assert.deepEqual((await request('/api/settings')).body.settings, settings);
  assert.equal((await request('/api/settings', { method: 'PUT', body: { whitelist: [] } })).status, 400);
});
