const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simmer-multi-device-'));
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
const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const minute = `${day}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
const identity = (deviceId, deviceName) => ({
  deviceId, deviceName, syncIntervalMinutes: 5, collectorVersion: '0.10.0',
});
const event = (deviceId, totalTokens) => ({
  sourceEventId: crypto.createHash('sha256').update(`${deviceId}-event`).digest('hex'),
  source: 'codex', provider: 'openai', model: 'gpt-test', occurredAt: now.toISOString(),
  inputTokens: totalTokens, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, reasoningTokens: 0, totalTokens, parserVersion: 'multi-device-test',
});
const hardware = (cpu, power) => ({
  t: minute, cpu, gpu: null, mem: null, vram: null,
  cpuTemp: null, gpuTemp: null, power, disk: null,
});

test('两个采集端通过同一服务器注册并维护独立同步状态', async () => {
  for (const [deviceId, deviceName] of [['pc-a', '开发主机'], ['pc-b', '办公笔记本']]) {
    const response = await request('/api/device-heartbeat', {
      method: 'POST', authorized: true, body: identity(deviceId, deviceName),
    });
    assert.deepEqual(response.body, { ok: true, paused: false });
  }
  const devices = (await request('/api/devices')).body;
  assert.deepEqual(devices.map(device => device.id).sort(), ['pc-a', 'pc-b']);
  assert.ok(devices.every(device => device.syncStatus === 'online'));
  assert.ok(devices.every(device => device.syncIntervalMinutes === 5));
  assert.ok(devices.every(device => device.collectorVersion === '0.10.0'));
  assert.ok(devices.every(device => device.lastHeartbeat));
});

test('软件、Token 与硬件同时支持全部设备聚合和单设备查询', async () => {
  const usageA = {
    ...identity('pc-a', '开发主机'),
    minutes: [
      { t: minute, app: 'Code.exe' },
      { t: `${day}T${pad(now.getHours())}:${pad((now.getMinutes() + 1) % 60)}`, app: 'Code.exe' },
    ],
  };
  const usageB = {
    ...identity('pc-b', '办公笔记本'),
    minutes: [{ t: minute, app: 'Code.exe' }, { t: minute, app: 'chrome.exe' }],
  };
  await request('/api/ingest', { method: 'POST', authorized: true, body: usageA });
  await request('/api/ingest', { method: 'POST', authorized: true, body: usageB });

  for (const [deviceId, deviceName, totalTokens] of [
    ['pc-a', '开发主机', 100], ['pc-b', '办公笔记本', 250],
  ]) {
    await request('/api/ai-token-events', {
      method: 'POST', authorized: true,
      body: { ...identity(deviceId, deviceName), events: [event(deviceId, totalTokens)], statuses: [] },
    });
  }
  await request('/api/hardware-samples', {
    method: 'POST', authorized: true,
    body: { ...identity('pc-a', '开发主机'), samples: [hardware(20, 100)] },
  });
  await request('/api/hardware-samples', {
    method: 'POST', authorized: true,
    body: { ...identity('pc-b', '办公笔记本'), samples: [hardware(60, 40)] },
  });

  const allApps = (await request(`/api/app-totals?device=all&range=daily&date=${day}`)).body;
  assert.deepEqual(allApps.map(row => [row.id, row.minutes]), [['Code.exe', 3], ['chrome.exe', 1]]);
  const deviceApps = (await request(`/api/app-totals?device=pc-a&range=daily&date=${day}`)).body;
  assert.deepEqual(deviceApps.map(row => [row.id, row.minutes]), [['Code.exe', 2]]);

  assert.equal((await request('/api/ai-tokens/summary?device=all&range=total')).body.totalTokens, 350);
  assert.equal((await request('/api/ai-tokens/summary?device=pc-b&range=total')).body.totalTokens, 250);
  assert.equal((await request('/api/hardware/current?device=all&metric=cpu')).body.value, 40);
  assert.equal((await request('/api/hardware/current?device=all&metric=power')).body.value, 140);
  assert.equal((await request('/api/hardware/current?device=pc-b&metric=cpu')).body.value, 60);

  const devices = (await request('/api/devices')).body;
  const pcA = devices.find(device => device.id === 'pc-a');
  const pcB = devices.find(device => device.id === 'pc-b');
  assert.deepEqual(
    [pcA.usageMinutes, pcA.tokenEvents, pcA.hardwareSamples, pcA.totalRecords],
    [2, 1, 1, 4]
  );
  assert.deepEqual(
    [pcB.usageMinutes, pcB.tokenEvents, pcB.hardwareSamples, pcB.totalRecords],
    [2, 1, 1, 4]
  );
  assert.ok(pcA.lastUsageSync && pcA.lastTokenSync && pcA.lastHardwareSync);
});

test('超过同步窗口的设备显示离线但历史聚合仍保留', async () => {
  db.prepare("UPDATE devices SET last_seen='2026-01-01T00:00:00.000Z' WHERE device_id='pc-b'").run();
  const devices = (await request('/api/devices')).body;
  assert.equal(devices.find(device => device.id === 'pc-b').syncStatus, 'offline');
  assert.equal((await request('/api/ai-tokens/summary?device=pc-b&range=total')).body.totalTokens, 250);
});
