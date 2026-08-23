const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simmer-hardware-'));
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

const pad = value => String(value).padStart(2, '0');
const now = new Date();
const minute = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
const row = overrides => ({
  t: minute,
  cpu: null, gpu: null, mem: null, vram: null,
  cpuTemp: null, gpuTemp: null, power: null, disk: null,
  ...overrides,
});

test('硬件上报鉴权并拒绝空样本或越界值', async () => {
  const payload = { deviceId: 'pc-1', deviceName: 'PC 1', samples: [row({ cpu: 40 })] };
  assert.equal((await request('/api/hardware-samples', { method: 'POST', body: payload })).status, 401);
  assert.equal((await request('/api/hardware-samples', {
    method: 'POST', authorized: true,
    body: { ...payload, samples: [row({})] },
  })).status, 400);
  assert.equal((await request('/api/hardware-samples', {
    method: 'POST', authorized: true,
    body: { ...payload, samples: [row({ cpu: 101 })] },
  })).status, 400);
  assert.equal((await request('/api/hardware-samples', {
    method: 'POST', authorized: true,
    body: { ...payload, samples: [row({ t: '2026-08-24T25:00', cpu: 10 })] },
  })).status, 400);
});

test('同分钟幂等合并传感器，跨设备按指标语义聚合', async () => {
  const post = (deviceId, deviceName, sample) => request('/api/hardware-samples', {
    method: 'POST', authorized: true, body: { deviceId, deviceName, samples: [sample] },
  });
  assert.equal((await post('pc-1', 'PC 1', row({ cpu: 40, power: 100 }))).body.received, 1);
  assert.equal((await post('pc-1', 'PC 1', row({ cpu: 50 }))).body.received, 1);
  assert.equal((await post('pc-2', 'PC 2', row({ cpu: 70, power: 50 }))).body.received, 1);

  assert.equal(db.prepare('SELECT COUNT(*) FROM hardware_samples').pluck().get(), 2);
  const merged = db.prepare('SELECT cpu_load, power_watts FROM hardware_samples WHERE device_id=?').get('pc-1');
  assert.deepEqual(merged, { cpu_load: 50, power_watts: 100 });

  assert.equal((await request('/api/hardware/current?device=all&metric=cpu')).body.value, 60);
  assert.equal((await request('/api/hardware/current?device=all&metric=power')).body.value, 150);
  const cpuSeries = await request('/api/hardware/series?device=all&metric=cpu&range=daily');
  assert.equal(cpuSeries.body.values[now.getHours()], 60);
  const powerSeries = await request('/api/hardware/series?device=all&metric=power&range=daily');
  assert.equal(powerSeries.body.values[now.getHours()], 150);
});

test('暂停设备后服务端跳过硬件样本', async () => {
  await request('/api/devices/pc-1', { method: 'PATCH', body: { paused: true } });
  const nextMinute = row({ t: minute.slice(0, -2) + pad((now.getMinutes() + 1) % 60), cpu: 20 });
  const response = await request('/api/hardware-samples', {
    method: 'POST', authorized: true,
    body: { deviceId: 'pc-1', deviceName: 'PC 1', samples: [nextMinute] },
  });
  assert.equal(response.body.paused, true);
  assert.equal(response.body.received, 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM hardware_samples').pluck().get(), 2);
});
