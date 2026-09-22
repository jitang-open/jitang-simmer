#!/usr/bin/env node
/* ============================================================
 * Simmer macOS Collector · macOS 采集代理
 *
 * 在 macOS 上复刻 Windows C# 采集器（collector/SimmerCollector）的两条通道：
 *
 *  ① 软件使用时长（新增）
 *     simmer-fg-probe（Swift 原生探针）→ 每 2 秒一次（前台应用 + 空闲）采样
 *     → MinuteAggregator 等价实现按本地分钟聚合 → 断网队列 → POST /api/ingest
 *     对照：NativeMethods.cs / MinuteAggregator.cs / LocalStore.cs / Uploader.FlushAsync
 *
 *  ② AI Token 统计（已有）
 *     发现 AI 工具数据目录 → simmer-token-scan → 校验 → POST /api/ai-token-events
 *     对照：TokenScannerManager.cs / TokenSourceDiscovery.cs / Uploader.FlushTokenAsync
 *
 * 两条通道共用同一 deviceId、同一上报 token 与同一心跳。
 *
 * 用法：
 *   node simmer-collector.js                       # 常驻：采样 + 定时上报 + Token 扫描
 *   node simmer-collector.js --once                # 单次：上报队列 + 扫描 Token + 心跳后退出
 *   node simmer-collector.js --upload-interval 5   # 上报间隔（分钟，默认 5）
 *   node simmer-collector.js --token-interval 15   # Token 扫描间隔（分钟，默认 15）
 *   node simmer-collector.js --idle-threshold 5    # 空闲阈值（分钟，默认 5）
 *   node simmer-collector.js --no-usage            # 只采集 Token
 *   node simmer-collector.js --no-token            # 只采集软件时长
 *   node simmer-collector.js --server https://<聚合服务器>/simmer
 * 环境变量：
 *   SIMMER_SERVER_URL   服务器地址（默认 http://127.0.0.1:8788）
 *   SIMMER_TOKEN        上报 Bearer Token（默认读安装配置或本机 server/config.json）
 *   SIMMER_COLLECTOR_CONFIG  采集端配置文件路径
 *   CODEX_HOME / DSH_HOME / WORKBUDDY_HOME  数据目录覆盖（与 Windows 采集器一致）
 *
 * 配置文件 collector/macos/collector-config.json（安装包写入，可选）：
 *   { "serverUrl": "https://119.45.179.55/simmer", "token": "...",
 *     "uploadIntervalMinutes": 5, "tokenIntervalMinutes": 15,
 *     "idleThresholdMinutes": 5 }
 * 存在且 serverUrl 非本机地址时即为「聚合模式」：不再依赖本机后端。
 * ============================================================ */
'use strict';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIST_ROOT = path.resolve(__dirname, '..', '..');
const SCANNER = path.join(DIST_ROOT, 'collector', 'simmer-token-scan');
const PROBE = path.join(DIST_ROOT, 'collector', 'simmer-fg-probe');
const HW_PROBE = path.join(DIST_ROOT, 'collector', 'simmer-hw-probe');
const DEFAULT_SERVER = 'http://127.0.0.1:8788';
const SERVER_CONFIG = path.join(DIST_ROOT, 'server', 'config.json');
/* 采集端配置：安装包会写入本文件指向聚合服务器；不存在则为「本机模式」
 * （服务器地址取本机 127.0.0.1:8788，token 取本机 server/config.json）。
 * 解析优先级：命令行参数 > 环境变量 > 本配置文件 > 默认值。
 */
const COLLECTOR_CONFIG = process.env.SIMMER_COLLECTOR_CONFIG ||
  path.join(DIST_ROOT, 'collector', 'macos', 'collector-config.json');

function readCollectorConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(COLLECTOR_CONFIG, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
const STATE_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'SimmerCollector');
const STATE_FILE = path.join(STATE_DIR, 'mac-collector.json');
/* 旧版 token-uploader.js 的状态文件：迁移 deviceId，避免同一台机器出现两台设备 */
const LEGACY_STATE_FILE = path.join(STATE_DIR, 'mac-uploader.json');
const USAGE_QUEUE_FILE = path.join(STATE_DIR, 'usage-queue.json');
const HARDWARE_QUEUE_FILE = path.join(STATE_DIR, 'hardware-queue.json');
const LOG_FILE = path.join(STATE_DIR, 'mac-collector.log');

const PARSER_VERSION = 'tokscale-b069c85-wb1';
const COLLECTOR_VERSION = 'simmer-macos-collector/0.11.0';
const SOURCES = ['codex', 'zcode', 'dsh', 'workbuddy'];
const SAMPLE_INTERVAL_SECONDS = 2;   // 与 Windows _sampleTimer 一致
const USAGE_BATCH_SIZE = 500;
const HARDWARE_BATCH_SIZE = 2000;    // 与 C# Peek(2000) 一致
const TOKEN_BATCH_SIZE = 2000;       // 与 C# Peek(2000) 一致
const FULL_SCAN_EVERY_HOURS = 24;
const INCREMENTAL_WINDOW_HOURS = 48;
const MAX_TOKEN_EVENTS = 5000;       // 服务器单请求上限

/* ---------- 通用 ---------- */
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* 日志失败不阻塞采集 */ }
}

/* ---------- 本地状态（deviceId 等） ---------- */
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/* 稳定 deviceId：与 Windows 采集器同理，每台机器只生成一次 */
function ensureDeviceId() {
  const state = readState();
  if (state.deviceId) return state.deviceId;

  // 从旧版 mac-uploader.json 迁移，保持同一台机器沿用同一个 deviceId
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf8'));
    if (legacy.deviceId) {
      writeState({ ...legacy, deviceId: legacy.deviceId, deviceName: legacy.deviceName || os.hostname() });
      log('已从旧状态文件迁移 deviceId: ' + legacy.deviceId);
      return legacy.deviceId;
    }
  } catch { /* 无旧状态文件，正常新建 */ }

  const deviceId = crypto.randomUUID();
  writeState({ ...state, deviceId, deviceName: os.hostname() });
  log('已生成新 deviceId: ' + deviceId);
  return deviceId;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/* ---------- 单实例锁 ----------
 * 采集器同时只能有一个实例：两个实例会各自结算同一分钟（同一分钟产生多条不同
 * 应用的记录，分钟数虚增）、并同时读写同一份队列文件，污染统计。
 * 锁文件记录 pid，并用 ps 校验该 pid 确实是采集器进程，避免 pid 被系统复用后误判。
 */
const LOCK_FILE = path.join(STATE_DIR, 'collector.lock');

function processIsCollector(pid) {
  try {
    process.kill(pid, 0);   // 存活探测：ESRCH=不存在，EPERM=存在但属其他用户
  } catch (err) {
    if (err.code === 'ESRCH') return false;
  }
  const result = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return (result.stdout || '').includes('simmer-collector.js');
}

function acquireSingleInstanceLock() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    const pid = Number(raw && raw.pid);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && processIsCollector(pid)) {
      return { ok: false, pid };
    }
  } catch { /* 无锁文件或内容损坏，视为可获取 */ }
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
      pid: process.pid, startedAt: new Date().toISOString(),
    }));
  } catch (err) {
    log('写入单实例锁失败（继续运行）: ' + err.message);
  }
  return { ok: true };
}

function releaseSingleInstanceLock() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (Number(raw && raw.pid) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* 无锁或已被清理 */ }
}

function resolveToken() {
  if (process.env.SIMMER_TOKEN) return process.env.SIMMER_TOKEN;
  // 聚合模式：安装包写入的配置文件里带 token，无需本机后端
  const configured = readCollectorConfig();
  if (configured.token) return String(configured.token);
  // 本机模式：等待本机后端首启生成 server/config.json
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const cfg = JSON.parse(fs.readFileSync(SERVER_CONFIG, 'utf8'));
      if (cfg.token) return cfg.token;
    } catch { /* server 首启尚未生成 config.json，稍候 */ }
    sleepSync(1000);
  }
  throw new Error('未找到上报 token：请设置 SIMMER_TOKEN、配置 collector-config.json，' +
    '或先启动本机后端（server/config.json）');
}

/* ---------- 待上报队列（对应 LocalStore.cs） ---------- */
const UsageQueue = {
  load() {
    try {
      const rows = JSON.parse(fs.readFileSync(USAGE_QUEUE_FILE, 'utf8'));
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }   // 队列损坏时重新开始，不影响主流程
  },
  persist(rows) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const tmp = USAGE_QUEUE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(rows));   // 原子写：先临时文件再替换
      fs.renameSync(tmp, USAGE_QUEUE_FILE);
    } catch (err) { log('队列写入失败: ' + err.message); }
  },
  enqueue(row) {
    const rows = this.load();
    rows.push(row);
    this.persist(rows);
  },
  peek(max) { return this.load().slice(0, max); },
  dequeue(count) {
    const rows = this.load();
    this.persist(rows.slice(count));
  },
  count() { return this.load().length; },
};

/* ---------- 硬件样本队列（对应 HardwareLocalStore.cs） ----------
 * 一分钟一条，按 t 去重覆盖（Upsert），断网时保留、上报成功后出队。
 */
const HW_FIELDS = Object.freeze({
  cpu: ['cpuLoad', 0, 100],
  gpu: ['gpuLoad', 0, 100],
  mem: ['memoryLoad', 0, 100],
  vram: ['vramLoad', 0, 100],
  cpuTemp: ['cpuTemp', 1, 150],
  gpuTemp: ['gpuTemp', 1, 150],
  power: ['powerWatts', 0, 5000],
  disk: ['diskLoad', 0, 100],
});
const MINUTE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** 与服务端 normalizeHardwareSample 同规则的本地校验：越界即视为无效样本 */
function isValidHardwareSample(sample) {
  if (!sample || typeof sample !== 'object' || !MINUTE_RE.test(sample.t || '')) return false;
  let populated = false;
  for (const [wire, [, min, max]] of Object.entries(HW_FIELDS)) {
    const value = sample[wire];
    if (value === null || value === undefined) continue;
    if (wire === 'cpuTemp' || wire === 'gpuTemp') {
      if (value === 0) continue;   // 0 表示“无读数”，服务端会归一为 null
    }
    if (!Number.isFinite(value) || value < min || value > max) return false;
    populated = true;
  }
  return populated;   // 全空的样本没有上报价值
}

const HardwareQueue = {
  load() {
    try {
      const rows = JSON.parse(fs.readFileSync(HARDWARE_QUEUE_FILE, 'utf8'));
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  },
  persist(rows) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const tmp = HARDWARE_QUEUE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(rows));
      fs.renameSync(tmp, HARDWARE_QUEUE_FILE);
    } catch (err) { log('硬件队列写入失败: ' + err.message); }
  },
  /** 按分钟覆盖同一条（对应 HardwareLocalStore.Upsert） */
  upsert(sample) {
    const rows = this.load();
    const index = rows.findIndex((row) => row.t === sample.t);
    if (index >= 0) rows[index] = sample;
    else rows.push(sample);
    this.persist(rows);
  },
  peek(max) { return this.load().slice(0, max); },
  dequeue(count) { this.persist(this.load().slice(count)); },
  count() { return this.load().length; },
};

/* ---------- 分钟聚合（对应 MinuteAggregator.cs） ----------
 * 每 2 秒一次采样；每分钟结算一次——非空闲采样过半且存在主导进程时产出
 * 一条 { t: 'yyyy-MM-ddTHH:mm'(本地时间), app } 记录。
 */
function minuteKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

class MinuteAggregator {
  constructor(onMinuteCompleted) {
    this.onMinuteCompleted = onMinuteCompleted;
    this.currentKey = '';
    this.idleSamples = 0;
    this.appSamples = new Map();
  }

  addSample(idle, app) {
    const key = minuteKey(new Date());
    if (key !== this.currentKey) {
      const completed = this.settle(this.currentKey);
      this.currentKey = key;
      this.idleSamples = 0;
      this.appSamples.clear();
      if (completed) this.onMinuteCompleted(completed);
    }
    if (idle) { this.idleSamples++; return; }
    if (app) this.appSamples.set(app, (this.appSamples.get(app) || 0) + 1);
  }

  /** 结算一分钟：非空闲采样未过半、或无任何进程采样时丢弃该分钟 */
  settle(key) {
    if (!key || this.appSamples.size === 0) return null;
    let total = this.idleSamples;
    for (const value of this.appSamples.values()) total += value;
    if (total === 0) return null;
    if (this.idleSamples * 2 >= total) return null;   // 过半时间空闲 → 不计
    let topApp = null;
    let topCount = -1;
    for (const [app, count] of this.appSamples) {
      if (count > topCount) { topApp = app; topCount = count; }
    }
    return { t: key, app: topApp };
  }
}

/* ---------- 探针子进程托管（前台探针与硬件探针共用） ----------
 * 负责启动、按行解析 NDJSON、异常退出后的指数退避重启。
 */
class ProbeStream {
  constructor({ binary, args, label, onMessage, onUnavailable }) {
    this.binary = binary;
    this.args = args;
    this.label = label;
    this.onMessage = onMessage;
    this.onUnavailable = onUnavailable;
    this.child = null;
    this.buffer = '';
    this.stopping = false;
    this.restartDelayMs = 1000;
  }

  start() {
    if (!fs.existsSync(this.binary)) {
      log(`未找到 ${path.basename(this.binary)}，${this.label}不可用`);
      if (this.onUnavailable) this.onUnavailable();
      return false;
    }
    this.child = spawn(this.binary, this.args, { stdio: ['ignore', 'pipe', 'pipe'] });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (text) => log(`${this.label} stderr: ` + text.trim()));

    this.child.on('exit', (code) => {
      this.child = null;
      if (this.stopping) return;
      log(`${this.label}退出（code ${code}），${this.restartDelayMs / 1000} 秒后重启`);
      setTimeout(() => this.start(), this.restartDelayMs);
      this.restartDelayMs = Math.min(this.restartDelayMs * 2, 60_000);
    });
    log(`${this.label}已启动`);
    return true;
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.type === 'hello') {
        this.restartDelayMs = 1000;
        if (message.smcAvailable === false) {
          log(`${this.label}：SMC 不可用，温度与功耗将显示为不可用（不影响其余指标）`);
        }
        continue;
      }
      this.onMessage(message);
    }
  }

  stop() {
    this.stopping = true;
    if (this.child) {
      try { this.child.kill('SIGTERM'); } catch { /* 已退出 */ }
    }
  }
}

/* ---------- 来源发现（对应 TokenSourceDiscovery，macOS 等价实现） ---------- */
function resolveRoot(envName, defaultFolder) {
  if (envName && process.env[envName] && process.env[envName].trim()) {
    return path.resolve(process.env[envName].trim());
  }
  return path.join(os.homedir(), defaultFolder);
}

function hasFilesDeep(root, subdirs, predicate) {
  // 有界探测：与 C# HasFiles 相同的子目录范围，不递归整个磁盘
  for (const sub of subdirs) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      let entries;
      try { entries = fs.readdirSync(current, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (predicate(full)) return true;
      }
    }
  }
  return false;
}

function commandExists(name) {
  const r = spawnSync('/bin/zsh', ['-lc', `command -v ${JSON.stringify(name)}`], { stdio: 'ignore' });
  return r.status === 0;
}

function discoverSources() {
  const defs = [
    {
      source: 'codex', root: resolveRoot('CODEX_HOME', '.codex'), executable: 'codex',
      hasData: (root) => hasFilesDeep(root, ['sessions', 'archived_sessions'],
        (f) => f.endsWith('.jsonl')),
    },
    {
      source: 'zcode', root: resolveRoot(null, '.zcode'), executable: 'zcode',
      hasData: (root) => fs.existsSync(path.join(root, 'cli', 'db', 'db.sqlite')),
    },
    {
      source: 'dsh', root: resolveRoot('DSH_HOME', '.dsh'), executable: 'dsh',
      // 与扫描器 DSH 过滤规则一致：session.jsonl / session.jsonl.zstd /
      // session.v3.jsonl.zstd …（排除同目录的 session.lock）
      hasData: (root) => hasFilesDeep(root, ['sessions'], (f) => {
        const name = path.basename(f);
        return name.startsWith('session.') &&
          (name.endsWith('.jsonl') || name.endsWith('.jsonl.zstd'));
      }),
    },
    {
      source: 'workbuddy', root: resolveRoot('WORKBUDDY_HOME', '.workbuddy'), executable: 'workbuddy',
      hasData: (root) => hasFilesDeep(root, ['projects'], (f) => f.endsWith('.jsonl')),
    },
  ];
  const now = new Date().toISOString();
  return defs.map(({ source, root, executable, hasData }) => {
    let hasDataSafe = false;
    try { hasDataSafe = hasData(root); } catch { /* 探测失败按无数据处理 */ }
    let hasApp = false;
    try { hasApp = commandExists(executable); } catch { /* 忽略 */ }
    let state, detailCode;
    if (hasDataSafe && hasApp) { state = 'ready'; detailCode = 'data_and_app'; }
    else if (hasDataSafe) { state = 'history_only'; detailCode = 'data_only'; }
    else if (hasApp) { state = 'installed_no_data'; detailCode = 'app_only'; }
    else { state = 'not_found'; detailCode = 'no_data_or_app'; }
    return {
      source, root, hasData: hasDataSafe,
      status: { source, state, detailCode, checkedAt: now, parserVersion: PARSER_VERSION },
    };
  });
}

/* ---------- Token 扫描（对应 InvokeScannerAsync） ---------- */
function runScanner(discoveries, fullScan) {
  const args = [];
  for (const d of discoveries) args.push('--' + d.source + '-root', d.root);
  if (!fullScan) {
    args.push('--modified-since-ms', String(Date.now() - INCREMENTAL_WINDOW_HOURS * 3600 * 1000));
  }
  const r = spawnSync(SCANNER, args, {
    maxBuffer: 512 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
    encoding: 'utf8',
  });
  if (r.error) throw new Error('scanner_spawn_failed:' + r.error.message);
  if (r.status !== 0) {
    throw new Error('scanner_exit_' + r.status + ':' + (r.stderr || '').slice(0, 200));
  }
  const output = JSON.parse(r.stdout);
  if (output.parserVersion !== PARSER_VERSION) throw new Error('parser_version_mismatch');
  return output;
}

/* ---------- 事件校验（对应 TokenEvent.IsValid；服务器整批校验，必须先过滤） ---------- */
const SOURCE_EVENT_ID_RE = /^[a-f0-9]{64}$/;
function isValidEvent(e) {
  if (!e || typeof e !== 'object') return false;
  if (!SOURCES.includes(e.source)) return false;
  if (typeof e.sourceEventId !== 'string' || !SOURCE_EVENT_ID_RE.test(e.sourceEventId)) return false;
  for (const field of ['provider', 'model', 'occurredAt', 'parserVersion']) {
    if (typeof e[field] !== 'string' || !e[field]) return false;
  }
  if ((e.provider || '').length > 200 || (e.model || '').length > 200 ||
      (e.parserVersion || '').length > 80) return false;
  if (Number.isNaN(Date.parse(e.occurredAt))) return false;
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
    'reasoningTokens', 'totalTokens'];
  for (const field of fields) {
    if (!Number.isSafeInteger(e[field]) || e[field] < 0) return false;
  }
  const sum = e.inputTokens + e.outputTokens + e.cacheReadTokens +
    e.cacheWriteTokens + e.reasoningTokens;
  return Number.isSafeInteger(sum) && sum === e.totalTokens;
}

/* ---------- 上报（对应 Uploader） ---------- */
async function post(serverUrl, token, endpoint, body) {
  const res = await fetch(serverUrl.replace(/\/$/, '') + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text || '{}');
}

const ctx = {
  serverUrl: DEFAULT_SERVER, token: '', deviceId: '', deviceName: os.hostname(),
  syncIntervalMinutes: 5,
};

/** 上报软件时长队列（对应 Uploader.FlushAsync）：成功一批删除一批，失败保留重试 */
async function flushUsage() {
  let uploaded = 0;
  for (;;) {
    const batch = UsageQueue.peek(USAGE_BATCH_SIZE);
    if (!batch.length) break;
    await post(ctx.serverUrl, ctx.token, '/api/ingest', {
      deviceId: ctx.deviceId,
      deviceName: ctx.deviceName,
      syncIntervalMinutes: ctx.syncIntervalMinutes,
      collectorVersion: COLLECTOR_VERSION,
      minutes: batch,
    });
    UsageQueue.dequeue(batch.length);
    uploaded += batch.length;
    if (batch.length < USAGE_BATCH_SIZE) break;
  }
  return uploaded;
}

/** 上报硬件样本队列（对应 Uploader.FlushHardwareAsync）：成功一批删除一批 */
async function flushHardware() {
  let uploaded = 0;
  for (;;) {
    const batch = HardwareQueue.peek(HARDWARE_BATCH_SIZE);
    if (!batch.length) break;
    await post(ctx.serverUrl, ctx.token, '/api/hardware-samples', {
      deviceId: ctx.deviceId,
      deviceName: ctx.deviceName,
      syncIntervalMinutes: ctx.syncIntervalMinutes,
      collectorVersion: COLLECTOR_VERSION,
      samples: batch,
    });
    HardwareQueue.dequeue(batch.length);
    uploaded += batch.length;
    if (batch.length < HARDWARE_BATCH_SIZE) break;
  }
  return uploaded;
}

/** 上报 Token 事件与来源状态（对应 Uploader.FlushTokenAsync） */
async function flushToken(events, statuses) {
  if (!events.length && !statuses.length) return 0;
  let statusesSent = false;
  let uploaded = 0;
  const batches = Math.max(1, Math.ceil(events.length / TOKEN_BATCH_SIZE));
  for (let i = 0; i < batches; i++) {
    const batch = events.slice(i * TOKEN_BATCH_SIZE, (i + 1) * TOKEN_BATCH_SIZE);
    if (!batch.length && statusesSent) break;
    const result = await post(ctx.serverUrl, ctx.token, '/api/ai-token-events', {
      deviceId: ctx.deviceId,
      deviceName: ctx.deviceName,
      syncIntervalMinutes: ctx.syncIntervalMinutes,
      collectorVersion: COLLECTOR_VERSION,
      events: batch,
      statuses: statusesSent ? [] : statuses,
    });
    statusesSent = true;
    uploaded += result.inserted ?? 0;
  }
  return uploaded;
}

async function heartbeat() {
  return post(ctx.serverUrl, ctx.token, '/api/device-heartbeat', {
    deviceId: ctx.deviceId,
    deviceName: ctx.deviceName,
    syncIntervalMinutes: ctx.syncIntervalMinutes,
    collectorVersion: COLLECTOR_VERSION,
  });
}

/* ---------- Token 扫描一轮（对应 ScanAndUploadAsync） ---------- */
async function scanTokens() {
  const discoveries = discoverSources();
  const statuses = discoveries.map((d) => d.status);
  const state = readState();
  const lastFull = state.lastFullScanAt ? Date.parse(state.lastFullScanAt) : 0;
  const fullScan = !lastFull || Date.now() - lastFull >= FULL_SCAN_EVERY_HOURS * 3600 * 1000;

  let events = [];
  if (!fs.existsSync(SCANNER)) {
    log('未找到 simmer-token-scan，跳过 Token 扫描');
    return { events, statuses };
  }
  try {
    const output = runScanner(discoveries, fullScan);
    events = (output.events || []).filter(isValidEvent);
    const d = output.diagnostics || {};
    log(`Token 扫描完成(${fullScan ? 'full' : '48h'})：Codex ${d.codexFiles || 0} 文件，` +
      `ZCode ${d.zcodeDatabases || 0} 库，DSH ${d.dshFiles || 0} 文件，` +
      `WorkBuddy ${d.workBuddyFiles || 0} 文件，事件 ${events.length} 条`);
    if (fullScan) writeState({ ...state, lastFullScanAt: new Date().toISOString() });
  } catch (err) {
    log('Token 扫描失败（不影响软件时长与心跳）: ' + err.message);
  }
  return { events, statuses };
}

/* ---------- 一轮完整同步：时长 + Token + 心跳（对应 UploadNow） ---------- */
async function syncOnce({ withToken }) {
  try {
    const minutes = await flushUsage();
    if (minutes) log(`软件时长上报成功：${minutes} 分钟记录`);
  } catch (err) {
    log('软件时长上报失败（队列保留）: ' + err.message);
  }

  try {
    const samples = await flushHardware();
    if (samples) log(`硬件指标上报成功：${samples} 条快照`);
  } catch (err) {
    log('硬件指标上报失败（队列保留）: ' + err.message);
  }

  if (withToken) {
    try {
      const { events, statuses } = await scanTokens();
      const uploaded = await flushToken(events, statuses);
      log(`Token 上报成功：新增 ${uploaded} 条，来源状态 ${statuses.length} 条`);
    } catch (err) {
      log('Token 上报失败: ' + err.message);
    }
  }

  try {
    await heartbeat();
    log(`设备心跳已发送（待上报时长 ${UsageQueue.count()} 分钟，` +
      `硬件 ${HardwareQueue.count()} 条）`);
  } catch (err) {
    log('设备心跳失败: ' + err.message);
  }
}

/* ---------- 参数 ---------- */
function parseArgs(argv) {
  const options = {
    once: false,
    usage: true,
    token: true,
    hardware: true,
    serverUrl: '',
    uploadIntervalMinutes: 5,
    tokenIntervalMinutes: 15,
    idleThresholdMinutes: 5,
    sampleIntervalSeconds: SAMPLE_INTERVAL_SECONDS,
    hardwareIntervalSeconds: 60,   // 与 Windows _hardwareTimer 的一分钟一致
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      return v !== undefined && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
    };
    switch (arg) {
      case '--once': options.once = true; break;
      case '--no-usage': options.usage = false; break;
      case '--no-token': options.token = false; break;
      case '--no-hardware': options.hardware = false; break;
      case '--server': {   // 指定聚合服务器地址（覆盖 collector-config.json）
        const next = argv[++i];
        if (next) options.serverUrl = next;
        break;
      }
      case '--upload-interval': options.uploadIntervalMinutes = value() || 5; break;
      case '--token-interval': options.tokenIntervalMinutes = value() || 15; break;
      case '--idle-threshold': options.idleThresholdMinutes = value() || 5; break;
      case '--sample-interval': options.sampleIntervalSeconds = value() || 2; break;
      case '--hardware-interval': options.hardwareIntervalSeconds = value() || 60; break;
      case '--loop': {   // 兼容旧 token-uploader.js 的 --loop N 写法
        const minutes = value();
        if (!Number.isNaN(minutes)) options.uploadIntervalMinutes = Math.min(1440, Math.max(1, minutes));
        break;
      }
      default: break;
    }
  }
  return options;
}

/* ---------- 主流程 ---------- */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const configured = readCollectorConfig();

  // 单实例：已在运行时本实例直接退出（避免同分钟重复结算与队列并发写）
  const lock = acquireSingleInstanceLock();
  if (!lock.ok) {
    log(`已有采集器在运行（PID ${lock.pid}），本实例退出以免重复统计`);
    process.exit(0);
  }
  // 只挂 exit 钩子释放锁；信号处理仍交给后面的优雅关闭逻辑
  // （否则会跳过探针清理，留下孤儿进程）
  process.on('exit', releaseSingleInstanceLock);

  // 优先级：命令行 > 环境变量 > collector-config.json > 默认值
  ctx.serverUrl = process.env.SIMMER_SERVER_URL || options.serverUrl ||
    configured.serverUrl || DEFAULT_SERVER;
  if (configured.uploadIntervalMinutes && !process.argv.includes('--upload-interval')) {
    ctx.syncIntervalMinutes = Number(configured.uploadIntervalMinutes) || 5;
    options.uploadIntervalMinutes = ctx.syncIntervalMinutes;
  }
  if (configured.tokenIntervalMinutes && !process.argv.includes('--token-interval')) {
    options.tokenIntervalMinutes = Number(configured.tokenIntervalMinutes) || 15;
  }
  if (configured.idleThresholdMinutes && !process.argv.includes('--idle-threshold')) {
    options.idleThresholdMinutes = Number(configured.idleThresholdMinutes) || 5;
  }
  ctx.token = resolveToken();
  ctx.deviceId = ensureDeviceId();
  if (!ctx.syncIntervalMinutes) ctx.syncIntervalMinutes = options.uploadIntervalMinutes;
  const mode = configured.serverUrl && !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(String(configured.serverUrl))
    ? '聚合模式' : '本机模式';
  log(`运行模式：${mode}（上报地址 ${ctx.serverUrl}）`);

  if (options.once) {
    log('Simmer macOS Collector 单次运行');
    await syncOnce({ withToken: options.token });
    return;
  }

  log(`Simmer macOS Collector 启动：server=${ctx.serverUrl} device=${ctx.deviceName} ` +
    `（时长 ${options.usage ? '开' : '关'} / Token ${options.token ? '开' : '关'} / ` +
    `硬件 ${options.hardware ? '开' : '关'}）`);

  const aggregator = new MinuteAggregator((record) => {
    UsageQueue.enqueue(record);
    log(`完成一分钟：${record.t} → ${record.app}`);
  });

  const probes = [];
  if (options.usage) {
    const probe = new ProbeStream({
      binary: PROBE,
      label: `前台探针（每 ${options.sampleIntervalSeconds} 秒采样，空闲阈值 ${options.idleThresholdMinutes} 分钟）`,
      args: ['--interval', String(options.sampleIntervalSeconds),
        '--idle-threshold-minutes', String(options.idleThresholdMinutes)],
      onMessage: (sample) => aggregator.addSample(Boolean(sample.idle), sample.app || null),
    });
    if (probe.start()) probes.push(probe);
  }
  if (options.hardware) {
    const hardwareProbe = new ProbeStream({
      binary: HW_PROBE,
      label: `硬件探针（每 ${options.hardwareIntervalSeconds} 秒一条快照）`,
      args: ['--interval', String(options.hardwareIntervalSeconds)],
      onMessage: (sample) => {
        if (!isValidHardwareSample(sample)) {
          log(`硬件样本无效已丢弃：${JSON.stringify(sample).slice(0, 160)}`);
          return;
        }
        HardwareQueue.upsert(sample);
      },
    });
    if (hardwareProbe.start()) probes.push(hardwareProbe);
  }

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    log(`收到 ${signal}，正在退出（未满一分钟的片段不入账）`);
    for (const probe of probes) probe.stop();
    // 尽力把已完成的分钟写盘；不满一分钟的片段直接丢弃，避免重启导致分钟虚增
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await syncOnce({ withToken: options.token });

  const uploadTimer = setInterval(
    () => { if (!stopping) syncOnce({ withToken: false }).catch((err) => log('同步异常: ' + err.message)); },
    options.uploadIntervalMinutes * 60 * 1000);
  const tokenTimer = options.token
    ? setInterval(
        () => { if (!stopping) syncOnce({ withToken: true }).catch((err) => log('Token 同步异常: ' + err.message)); },
        options.tokenIntervalMinutes * 60 * 1000)
    : null;

  const keepAlive = setInterval(() => {}, 1 << 30);   // 保持事件循环
  process.on('exit', () => { clearInterval(uploadTimer); if (tokenTimer) clearInterval(tokenTimer); clearInterval(keepAlive); });
}

main().catch((err) => {
  log('运行异常退出: ' + ((err && err.stack) || err));
  process.exit(1);
});
