/* ============================================================
 * Simmer · 应用主逻辑
 *  - 全局状态：当前设备 / 时间范围 / 白名单 / 展开的软件
 *  - 所有统计均基于白名单过滤后实时重算
 * ============================================================ */
const $ = s => document.querySelector(s);

let DB = MockDB;   // 启动时尝试切换为 LiveDB（见 DOMContentLoaded）

/* ---------------- localStorage 统一读写层（所有持久化必经之路） ----------------
 * 键名一律内联字面量、不依赖任何外部常量——彻底免疫"常量声明在 state
 * 之后导致 TDZ 静默失败"类问题（历史上已踩坑两次：WL_KEY / APPS_KEY）。
 * 写入带回读校验：损坏立即在控制台报错，绝不静默丢数据。 */
function loadJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return (v === null || v === undefined) ? fallback : v;
  } catch (e) { return fallback; }
}
function saveJSON(key, val) {
  try {
    const s = JSON.stringify(val);
    localStorage.setItem(key, s);
    if (localStorage.getItem(key) !== s) console.error('[simmer] 存储写入校验失败：', key);
  } catch (e) { console.error('[simmer] 存储不可用：', key, e); }
}

function loadWhitelist() {
  const saved = loadJSON('simmer.whitelist', null);
  if (Array.isArray(saved)) return new Set(saved);   // 原样恢复，不做清单过滤（live/mock 两套命名体系）
  return new Set(MockDB.apps.map(a => a.id));
}
function saveWhitelist() { saveJSON('simmer.whitelist', [...state.whitelist]); }

function loadCustomApps() {
  const a = loadJSON('simmer.apps', []);
  return Array.isArray(a) ? a : [];
}
function loadRemovedApps() {
  const a = loadJSON('simmer.appsRemoved', []);
  return new Set(Array.isArray(a) ? a : []);
}
function loadOffApps() {
  const a = loadJSON('simmer.appsOff', []);
  return new Set(Array.isArray(a) ? a : []);
}
function saveAppsState() {
  saveJSON('simmer.apps', state.customApps);
  saveJSON('simmer.appsRemoved', [...state.removedApps]);
  saveJSON('simmer.appsOff', [...state.offApps]);
}

const state = {
  device: 'all',                                        // all | desktop | laptop | htpc
  range: 'daily',                                       // daily | weekly | total
  whitelist: loadWhitelist(),                           // 白名单（开启统计的软件，localStorage 持久化）
  openApp: null,                                        // 当前展开的软件 id（切换设备/范围后自动恢复）
  year: new Date().getFullYear(),                       // 点阵图所选年份
  customApps: loadCustomApps(),                         // 自定义软件条目 / 元数据覆盖（localStorage）
  removedApps: loadRemovedApps(),                       // 已删除的软件 id（localStorage）
  offApps: loadOffApps(),                               // 添加过但开关关闭的软件 id（localStorage）
};

const RANGE_LABEL = { daily: '今日', weekly: '近 7 天', total: '累计' };
const wlIds = () => [...state.whitelist];

/* ---------------- 软件清单：分类 / 色板 / 合并与覆盖 ---------------- */
const CATEGORIES = ['开发工具', '浏览器', '游戏', '社交', '音乐', '设计', '效率', '系统', '其他'];
const CAT_META = {
  '开发工具': { icon: '🧩', color: '#3b82f6' },
  '浏览器':   { icon: '🌐', color: '#f59e0b' },
  '游戏':     { icon: '🎮', color: '#66c0f4' },
  '社交':     { icon: '💬', color: '#07c160' },
  '音乐':     { icon: '🎵', color: '#1db954' },
  '设计':     { icon: '🎨', color: '#a259ff' },
  '效率':     { icon: '📝', color: '#8b949e' },
  '系统':     { icon: '🖥️', color: '#e3b341' },
  '其他':     { icon: '📦', color: '#8b949e' },
};
const PALETTE = [
  // 第 1–2 行：基础色系
  '#3b82f6', '#58a6ff', '#39d0d8', '#66c0f4', '#1db954', '#39d353', '#07c160', '#a259ff',
  '#bc8cff', '#f778ba', '#ff6b9d', '#eb4d3d', '#f85149', '#ffa657', '#e3b341', '#f59e0b',
  '#8b949e', '#c9d1d9',
  // 第 3–4 行：扩展色系
  '#0ea5e9', '#22d3ee', '#2dd4bf', '#4ade80', '#84cc16', '#a3e635', '#facc15', '#fde047',
  '#fb923c', '#f97316', '#ef4444', '#e11d48', '#be123c', '#d946ef', '#c026d3', '#9333ea',
  '#7c3aed', '#6366f1', '#818cf8', '#f472b6', '#fb7185', '#a8a29e',
];

/** 清单 = 用户主动添加（whitelist）或添加后关闭（offApps）的软件；预添加未观测的自定义条目也显示。
 *  从未接触过的新检测进程不出现在面板，只在「添加」候选列表中出现。 */
function mergedApps() {
  const customMap = new Map(state.customApps.map(a => [a.id, a]));
  const out = [];
  DB.apps.forEach(a => {
    if (state.removedApps.has(a.id)) return;
    if (!state.whitelist.has(a.id) && !state.offApps.has(a.id)) return;
    const c = customMap.get(a.id);
    out.push(c ? { ...a, ...c } : { ...a });
  });
  state.customApps.forEach(c => {
    if (state.removedApps.has(c.id)) return;
    if (!DB.apps.some(a => a.id === c.id)) out.push({ ...c });   // 预添加、尚未被观测到的软件
  });
  return out;
}

/** 给查询结果行应用自定义元数据（名称 / 分类 / 图标 / 颜色） */
function applyMeta(rows) {
  const m = new Map(state.customApps.map(a => [a.id, a]));
  return rows.map(r => (m.has(r.id) ? { ...r, ...m.get(r.id) } : r));
}

/* ---------------- 顶部：设备选择器 ---------------- */
function buildDeviceSelect() {
  const wrap = $('#deviceSelect');
  const opts = [{ id: 'all', name: '全部设备', host: '汇总统计' }, ...DB.devices];
  wrap.innerHTML = `
    <button class="ds-btn"><span class="sd-dot"></span><span class="ds-name">全部设备</span><span class="caret">▼</span></button>
    <div class="ds-list"></div>`;
  const list = wrap.querySelector('.ds-list');
  opts.forEach(o => {
    const b = document.createElement('button');
    b.className = 'ds-opt' + (o.id === state.device ? ' sel' : '');
    b.innerHTML = `<span class="sd-dot"></span>${o.name}<small>${o.host}</small>`;
    b.addEventListener('click', () => {
      state.device = o.id;
      wrap.querySelector('.ds-name').textContent = o.name;
      wrap.classList.remove('open');
      list.querySelectorAll('.ds-opt').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
      renderAll();
    });
    list.appendChild(b);
  });
  wrap.querySelector('.ds-btn').addEventListener('click', e => {
    e.stopPropagation();
    wrap.classList.toggle('open');
  });
  document.addEventListener('click', () => wrap.classList.remove('open'));
}

/* ---------------- 顶部：每日 / 每周 / 累计 ---------------- */
function buildRangeTabs() {
  $('#rangeTabs').querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      state.range = b.dataset.range;
      $('#rangeTabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      renderAll();
    });
  });
}

/* ---------------- 侧边栏：滚动高亮（scroll-spy）+ 移动端抽屉 ---------------- */
function closeDrawer() {
  document.querySelector('.sidebar').classList.remove('open');
  $('#backdrop').classList.remove('show');
}

function buildSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const links = [...document.querySelectorAll('.nav-item')];

  // 点击导航：立即高亮；移动端同时收起抽屉
  links.forEach(l => l.addEventListener('click', () => {
    links.forEach(x => x.classList.toggle('on', x === l));
    closeDrawer();
  }));

  // 滚动时高亮跟随当前区块
  const secs = links.map(l => document.querySelector(l.getAttribute('href'))).filter(Boolean);
  const spy = () => {
    const line = Math.max(120, window.innerHeight * 0.25);
    let cur = secs[0];
    secs.forEach(s => { if (s.getBoundingClientRect().top <= line) cur = s; });
    // 已滚到页面底部时点亮最后一项（最后一节可能短于视口）
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 40) cur = secs[secs.length - 1];
    links.forEach(l => l.classList.toggle('on', l.getAttribute('href') === '#' + cur.id));
  };
  window.addEventListener('scroll', spy, { passive: true });
  spy();

  // 窄屏汉堡按钮 + 遮罩
  $('#menuBtn').addEventListener('click', e => {
    e.stopPropagation();
    sidebar.classList.toggle('open');
    $('#backdrop').classList.toggle('show', sidebar.classList.contains('open'));
  });
  $('#backdrop').addEventListener('click', closeDrawer);
}

/* ---------------- 侧边栏：设备列表 ---------------- */
function renderSideDevices() {
  $('#sideDevices').innerHTML = '<div class="side-dev-title">我的设备</div>' + DB.devices.map(d => `
    <div class="side-dev">
      <span class="sd-dot"></span>
      <div><div class="sd-name">${d.name}</div><div class="sd-host">${d.host}</div></div>
    </div>`).join('');
}

/* ---------------- 总时长卡片：年份选择器（与设备选择器同款 UI） ---------------- */
function buildYearSelect() {
  const wrap = $('#yearSelect');
  const currentYear = new Date().getFullYear();
  wrap.innerHTML = `
    <button class="ds-btn"><span class="ds-name">${currentYear}</span><span class="caret">▼</span></button>
    <div class="ds-list"></div>`;
  const list = wrap.querySelector('.ds-list');
  [...DB.yearList].reverse().forEach(y => {          // 新年份排在上面
    const b = document.createElement('button');
    b.className = 'ds-opt' + (y === state.year ? ' sel' : '');
    b.innerHTML = `${y}<small>${y === currentYear ? '今年' : ''}</small>`;
    b.addEventListener('click', () => {
      state.year = y;
      wrap.querySelector('.ds-name').textContent = y;
      wrap.classList.remove('open');
      list.querySelectorAll('.ds-opt').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
      renderAll();                                  // 点阵图与详情里的年度点阵都随年份联动
    });
    list.appendChild(b);
  });
  wrap.querySelector('.ds-btn').addEventListener('click', e => {
    e.stopPropagation();
    wrap.classList.toggle('open');
  });
  document.addEventListener('click', () => wrap.classList.remove('open'));
}

/* ---------------- 概览卡片 ---------------- */
async function renderOverview() {
  const ids = wlIds();
  const totalMin = await DB.rangeTotalMinutes(state.device, ids, state.range);
  const activeApps = (await DB.appTotals(state.device, ids, state.range)).filter(r => r.minutes > 0).length;
  const cpu = await DB.metricCurrent(state.device, 'cpu');
  const tempCpu = await DB.metricCurrent(state.device, 'cpuTemp');
  const tempGpu = await DB.metricCurrent(state.device, 'gpuTemp');
  const power = await DB.metricCurrent(state.device, 'power');
  const hwReady = cpu !== null;
  const temp = tempCpu !== null && tempGpu !== null ? ((tempCpu + tempGpu) / 2).toFixed(1) : null;

  const th = Math.floor(totalMin / 60), tm = Math.round(totalMin % 60);
  const cards = [
    { label: RANGE_LABEL[state.range] + '总时长', value: `${th}<small> 小时 </small>${tm}<small> 分</small>`, extra: `白名单内 ${ids.length} 款软件`, icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 10.6l4.2 2.5-.8 1.3L11 13.5V7h2v5.6z' },
    { label: '活跃软件', value: activeApps + ' <small>款</small>', extra: RANGE_LABEL[state.range] + '内有使用记录', icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
    { label: 'CPU 占用', value: hwReady ? cpu + ' <small>%</small>' : '—', extra: hwReady ? '当前时刻 · 实时采集' : '待 M1.5 硬件采集支持', icon: 'M9 9h6v6H9zM12 1v4M12 19v4M1 12h4M19 12h4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M19.8 4.2L17 7M7 17l-2.8 2.8' },
    { label: '核心温度', value: temp !== null ? temp + ' <small>°C</small>' : '—', extra: temp !== null ? 'CPU / GPU 平均' : '待 M1.5 硬件采集支持', icon: 'M14 14.8V5a2 2 0 10-4 0v9.8a4.5 4.5 0 104 0z' },
    { label: '整机功耗', value: power !== null ? power + ' <small>W</small>' : '—', extra: power !== null ? (state.device === 'all' ? '全部设备合计' : '当前设备') : '待 M1.5 硬件采集支持', icon: 'M13 2L4 14h6v8l9-12h-6V2z' },
  ];

  $('#sec-overview').innerHTML = cards.map(c => `
    <div class="ov-card">
      <div class="ov-label"><svg viewBox="0 0 24 24"><path d="${c.icon}"/></svg>${c.label}</div>
      <div class="ov-value">${c.value}</div>
      <div class="ov-extra">${c.extra}</div>
    </div>`).join('');
}

/* ---------------- 总时长：点阵图 + 趋势折线 ---------------- */
async function renderTotal() {
  const ids = wlIds();
  const year = await DB.yearSeries(state.device, ids, state.year);
  const totalMin = year.reduce((s, d) => s + (d.minutes || 0), 0);
  const activeDays = year.filter(d => d.minutes > 0).length;
  $('#totalSub').textContent =
    `${state.year} 年共 ${Math.floor(totalMin / 60).toLocaleString()} 小时 · ${activeDays} 天有使用记录 · 仅统计白名单软件`;

  Charts.heatmap($('#heatmapWrap'), year);

  const trend = await DB.trendSeries(state.device, ids, state.range);
  $('#trendHint').textContent = { daily: '今日 24 小时分布', weekly: '近 7 天每日合计', total: '近 12 个月每月合计' }[state.range];
  Charts.line($('#trendWrap'), {
    labels: trend.labels, values: trend.values,
    color: '#1db954', unit: ' h', height: 180,
  });
}

/* ---------------- 软件时长：横向柱状图 + 展开详情（>10 折叠） ---------------- */
const COLLAPSE_AT = 10;   // 超过 10 款软件时默认折叠

async function renderApps() {
  const rows = applyMeta(await DB.appTotals(state.device, wlIds(), state.range));
  $('#appsSub').textContent = `${RANGE_LABEL[state.range]} · ${rows.length} 款白名单软件 · 按时长降序`;
  const wrap = $('#appBars');

  const drawList = (list, collapsed) => {
    Charts.hbars(wrap, list, onAppRow);
    if (rows.length > COLLAPSE_AT) {
      const more = document.createElement('button');
      more.className = 'hb-more';
      more.textContent = collapsed
        ? `展开其余 ${rows.length - COLLAPSE_AT} 款软件 ▾`
        : '收起列表 ▴';
      more.addEventListener('click', () => {
        if (collapsed) {
          drawList(rows, false);
        } else {
          // 收起时若当前展开详情的软件会被折叠隐藏，同步清掉展开状态
          if (state.openApp && rows.findIndex(r => r.id === state.openApp) >= COLLAPSE_AT) state.openApp = null;
          drawList(rows.slice(0, COLLAPSE_AT), true);
        }
      });
      wrap.appendChild(more);
    }
  };
  drawList(rows.slice(0, COLLAPSE_AT), true);

  // 重新渲染后恢复上次展开的软件详情（切换设备 / 时间范围 / 白名单不收起）
  if (state.openApp) {
    const idx = rows.findIndex(r => r.id === state.openApp);
    if (idx < 0) {
      state.openApp = null;                         // 该软件已不在白名单内
    } else if (idx < COLLAPSE_AT) {
      void openDetail(rows[idx], wrap.querySelectorAll('.hbar-row')[idx]);
    } else {
      drawList(rows, false);                        // 展开的软件在折叠区，先展开完整列表
      void openDetail(rows[idx], wrap.querySelectorAll('.hbar-row')[idx]);
    }
  }

  function onAppRow(app, rowEl) {
    if (state.openApp === app.id) {                 // 再点一次收起
      document.querySelectorAll('.app-detail').forEach(d => d.remove());
      state.openApp = null;
      return;
    }
    void openDetail(app, rowEl);
  }

  async function openDetail(app, rowEl) {
    document.querySelectorAll('.app-detail').forEach(d => d.remove());
    state.openApp = app.id;
    const detail = document.createElement('div');
    detail.className = 'app-detail';
    detail.innerHTML = `
      <div class="ad-grid">
        <div class="ad-panel">
          <div class="ad-title"><i style="background:${app.color}"></i>柱状图 · 星期分布</div>
          <div class="ad-body"></div>
        </div>
        <div class="ad-panel">
          <div class="ad-title"><i style="background:${app.color}"></i>折线图 · 时长趋势</div>
          <div class="ad-body"></div>
        </div>
        <div class="ad-panel ad-wide">
          <div class="ad-title"><i style="background:${app.color}"></i>点阵图 · 年度记录</div>
          <div class="ad-body"></div>
        </div>
      </div>`;
    rowEl.after(detail);

    const bodies = detail.querySelectorAll('.ad-body');
    const wd = await DB.appWeekday(state.device, app.id);
    Charts.vbars(bodies[0], { labels: wd.labels, values: wd.values, color: app.color, unit: ' 分钟（日均）' });
    const t = await DB.trendSeries(state.device, [app.id], state.range);
    Charts.line(bodies[1], { labels: t.labels, values: t.values, color: app.color, unit: ' h', height: 200 });
    const yearRows = await DB.yearSeries(state.device, [app.id], state.year);
    Charts.heatmap(bodies[2], yearRows);
  }
}

/* ---------------- 饼图（图例 >10 折叠） ---------------- */
async function renderPie() {
  const rows = (await DB.appTotals(state.device, wlIds(), state.range)).filter(r => r.minutes > 0);
  Charts.donut($('#pieWrap'), $('#pieLegend'), applyMeta(rows));

  const legend = $('#pieLegend');
  const items = [...legend.querySelectorAll('li')];
  if (items.length <= COLLAPSE_AT) return;
  items.slice(COLLAPSE_AT).forEach(li => li.classList.add('pl-hidden'));
  const more = document.createElement('li');
  more.className = 'pl-more';
  const setText = collapsed => more.textContent = collapsed
    ? `▸ 展开其余 ${items.length - COLLAPSE_AT} 款软件`
    : '▾ 收起图例';
  let collapsed = true;
  setText(true);
  more.addEventListener('click', () => {
    collapsed = !collapsed;
    items.slice(COLLAPSE_AT).forEach(li => li.classList.toggle('pl-hidden', collapsed));
    setText(collapsed);
  });
  legend.appendChild(more);
}

/* ---------------- 硬件监控 ---------------- */
async function renderHardware() {
  const grid = $('#hwGrid');
  grid.innerHTML = '';
  if (!DB.metricDefs.length) {                      // M1 无硬件采集，M1.5（CAP-06）补齐
    grid.innerHTML = '<div class="hw-empty">硬件指标采集将在 M1.5（CAP-06，基于 LibreHardwareMonitor）接入</div>';
    return;
  }
  for (const m of DB.metricDefs) {
    const cur = await DB.metricCurrent(state.device, m.id);
    const card = document.createElement('div');
    card.className = 'hw-card';
    card.innerHTML = `
      <div class="hw-head">
        <span class="hw-name"><i style="background:${m.color}"></i>${m.name}</span>
        <span class="hw-val">${cur}<small> ${m.unit}</small></span>
      </div>
      <div class="hw-chart"></div>`;
    grid.appendChild(card);
    const s = await DB.metricSeries(state.device, m.id, state.range);
    Charts.line(card.querySelector('.hw-chart'), {
      labels: s.labels, values: s.values, color: m.color, unit: ' ' + m.unit, height: 120,
    });
  }
}

/* ---------------- 白名单（可添加 / 编辑 / 删除） ---------------- */
const ICON_EDIT = 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z';
const ICON_DEL = 'M6 19a2 2 0 002 2h8a2 2 0 002-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z';

function renderWhitelist() {
  const grid = $('#wlGrid');
  grid.innerHTML = '';
  const list = mergedApps();
  if (!list.length) {
    grid.innerHTML = '<div class="wl-empty">清单还是空的——点击右上角「＋ 添加」，从检测到的进程中选择你想统计的软件</div>';
    return;
  }
  list.forEach(a => {
    const on = state.whitelist.has(a.id);
    const item = document.createElement('div');
    item.className = 'wl-item' + (on ? '' : ' off');
    item.innerHTML = `
      <div class="wl-icon">${a.icon}</div>
      <div class="wl-info">
        <div class="wl-name">${a.name}<code class="wl-id">${a.id}</code></div>
        <div class="wl-cat">${a.category}</div>
      </div>
      <div class="wl-ops">
        <button class="wl-op" data-act="edit" title="编辑名称 / 分类 / 颜色"><svg viewBox="0 0 24 24"><path d="${ICON_EDIT}"/></svg></button>
        <button class="wl-op wl-op-del" data-act="del" title="删除该软件"><svg viewBox="0 0 24 24"><path d="${ICON_DEL}"/></svg></button>
      </div>
      <button class="wl-toggle ${on ? 'on' : ''}" aria-label="切换白名单"></button>`;
    item.querySelector('.wl-toggle').addEventListener('click', () => {
      if (on) { state.whitelist.delete(a.id); state.offApps.add(a.id); }   // 关闭：留在清单，仅停统计
      else { state.whitelist.add(a.id); state.offApps.delete(a.id); }
      saveWhitelist(); saveAppsState();
      renderAll();
    });
    item.querySelector('[data-act="edit"]').addEventListener('click', () => openAppForm(a));
    item.querySelector('[data-act="del"]').addEventListener('click', () => {
      state.removedApps.add(a.id);
      state.customApps = state.customApps.filter(c => c.id !== a.id);
      state.whitelist.delete(a.id);
      state.offApps.delete(a.id);
      saveAppsState(); saveWhitelist();
      renderAll();
    });
    grid.appendChild(item);
  });
}

/* ---------------- 添加 / 编辑软件对话框 ---------------- */
async function openAppForm(editing) {
  document.querySelectorAll('.app-form-overlay').forEach(d => d.remove());
  const isEdit = !!editing;
  // 新添加时默认随机一个颜色（用户可再点 🎲 换或手选）；编辑时保持原色
  const def = isEdit
    ? editing
    : { id: '', name: '', category: '其他', color: PALETTE[Math.floor(Math.random() * PALETTE.length)] };

  // 已观测进程清单（后端记录过的所有 exe，不受白名单限制）
  let known = [];
  try { known = await DB.allApps(); } catch (e) {}
  const knownMap = new Map(known.map(k => [k.id.toLowerCase(), k]));

  const overlay = document.createElement('div');
  overlay.className = 'app-form-overlay';
  overlay.innerHTML = `
    <div class="app-form">
      <h3>${isEdit ? '编辑软件' : '添加软件'}</h3>
      <label>进程<span class="req">*</span><span class="hint-inline">（从检测到的进程中选择，或手动输入）</span></label>
      <input class="af-id" list="af-proc-list" placeholder="点击选择已检测到的进程…" value="${isEdit ? editing.id : ''}" ${isEdit ? 'readonly title="如需更换进程，请删除后重新添加"' : 'autofocus'}>
      <datalist id="af-proc-list">${known.map(k => {
        const cur = mergedApps().some(a => a.id === k.id);
        return `<option value="${k.id}" label="${cur ? '已在清单' : '未添加'} · 累计 ${k.minutes} 分钟"></option>`;
      }).join('')}</datalist>
      <label>显示名称<span class="hint-inline">（留空则用进程名）</span></label>
      <input class="af-name" placeholder="如 Google Chrome" value="${isEdit ? editing.name : ''}">
      <label>软件类型</label>
      <select class="af-cat">${CATEGORIES.map(c => `<option ${c === def.category ? 'selected' : ''}>${c}</option>`).join('')}</select>
      <label>颜色</label>
      <div class="af-palette">${PALETTE.map(c =>
        `<i class="cp-item ${c === def.color ? 'sel' : ''}" data-color="${c}" style="background:${c}"></i>`).join('')}<i class="cp-item cp-random" title="随机一个颜色">🎲</i></div>
      <div class="af-btns">
        <button class="btn-ghost af-cancel">取消</button>
        <button class="btn-ghost af-save" style="border-color:var(--green);color:var(--green-hi)">${isEdit ? '保存' : '添加'}</button>
      </div>
    </div>`;

  const idInput = overlay.querySelector('.af-id');
  const nameInput = overlay.querySelector('.af-name');
  const catSelect = overlay.querySelector('.af-cat');
  let pickedColor = def.color;

  // 选中已知进程时，若显示名仍为空则自动带出（进程名去扩展名）
  idInput.addEventListener('change', () => {
    const k = knownMap.get(idInput.value.trim().toLowerCase());
    if (k && !nameInput.value.trim()) nameInput.value = k.id.replace(/\.exe$/i, '');
    idInput.classList.remove('af-invalid');
  });
  // 分类切换时若未手动选过颜色，跟随分类默认色
  let colorTouched = isEdit;
  catSelect.addEventListener('change', () => {
    if (!colorTouched) {
      pickedColor = CAT_META[catSelect.value].color;
      overlay.querySelectorAll('.cp-item').forEach(i => i.classList.toggle('sel', i.dataset.color === pickedColor));
    }
  });
  overlay.querySelectorAll('.cp-item:not(.cp-random)').forEach(i => i.addEventListener('click', () => {
    colorTouched = true;
    pickedColor = i.dataset.color;
    overlay.querySelectorAll('.cp-item').forEach(x => x.classList.toggle('sel', x === i));
  }));
  // 🎲 随机颜色：从色板随机挑一个并高亮
  overlay.querySelector('.cp-random').addEventListener('click', () => {
    colorTouched = true;
    const pick = overlay.querySelectorAll('.cp-item:not(.cp-random)');
    const chosen = pick[Math.floor(Math.random() * pick.length)];
    pickedColor = chosen.dataset.color;
    overlay.querySelectorAll('.cp-item').forEach(x => x.classList.toggle('sel', x === chosen));
  });
  overlay.querySelector('.af-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector('.af-save').addEventListener('click', () => {
    const id = idInput.value.trim();
    if (!id) { idInput.classList.add('af-invalid'); idInput.focus(); return; }
    const category = catSelect.value;
    const meta = CAT_META[category];
    state.customApps = state.customApps.filter(c => c.id !== id && c.id !== (isEdit ? editing.id : ''));
    state.customApps.push({
      id,
      name: nameInput.value.trim() || id.replace(/\.exe$/i, ''),
      icon: meta.icon,
      color: pickedColor,
      category,
    });
    state.removedApps.delete(id);
    state.offApps.delete(id);
    state.whitelist.add(id);
    saveAppsState(); saveWhitelist();
    overlay.remove();
    renderAll();
  });

  document.body.appendChild(overlay);
  if (!isEdit) idInput.focus();
}

/* ---------------- 总渲染入口 ---------------- */
async function renderAll() {
  await Promise.all([
    renderOverview(),
    renderTotal(),
    renderApps(),
    renderPie(),
    renderHardware(),
  ]);
  renderWhitelist();
}

/* ---------------- 启动 ---------------- */
document.addEventListener('DOMContentLoaded', async () => {
  Charts.init();
  buildRangeTabs();
  buildSidebar();

  // 启动自检：存储与内存状态不一致时在控制台报错（防静默丢失不可见，便于排查）
  (function diagnose() {
    const stored = loadJSON('simmer.apps', []);
    if (Array.isArray(stored) && stored.length && !state.customApps.length) {
      console.error('[simmer] 诊断：存储中有自定义软件但未加载到内存，持久化链路异常');
    }
  })();

  // 优先连接实时后端，失败回退 mock 数据
  try {
    const live = await LiveDB.create();
    DB = live;
    // 白名单适配规则：
    //   首次访问 / 旧数据体系迁移 → 空白名单，由用户在「＋ 添加」中自主挑选
    //   已有存储 → 与当前软件清单取交集（用户关掉/删除的不复活）
    // 新检测到的进程永远不自动入名单，只出现在「添加软件」候选列表中。
    const saved = localStorage.getItem('simmer.whitelist') !== null;
    const ids = new Set(DB.apps.map(a => a.id));
    const stored = [...state.whitelist];
    const kept = stored.filter(id => ids.has(id));
    const migrate = stored.length > 0 && kept.length === 0;   // 存了名单但全部失配 = 跨体系迁移
    if (!saved || migrate) {
      state.whitelist = new Set();
      state.offApps = new Set();
      saveWhitelist(); saveAppsState();
    } else {
      state.whitelist = new Set(kept);
      state.offApps = new Set([...state.offApps].filter(id => ids.has(id)));
    }
    document.querySelector('.topbar .sub').textContent = 'Jitang Simmer · ● 实时数据';
  } catch (e) {
    document.querySelector('.topbar .sub').textContent = 'Jitang Simmer · ○ 演示数据（后端未连接）';
    const banner = document.createElement('div');
    banner.className = 'fallback-banner';
    banner.textContent = '⚠ 后端未连接，当前显示的是演示数据——软件清单与真实统计不同。请确认 server 已启动后刷新。';
    document.querySelector('.main').prepend(banner);
  }

  buildDeviceSelect();
  buildYearSelect();
  renderSideDevices();
  renderAll();

  $('#wlAdd').addEventListener('click', () => openAppForm(null));
  $('#wlAll').addEventListener('click', () => {
    mergedApps().forEach(a => { state.whitelist.add(a.id); state.offApps.delete(a.id); });
    saveWhitelist(); saveAppsState();
    renderAll();
  });
  $('#wlNone').addEventListener('click', () => { state.whitelist.clear(); saveWhitelist(); renderAll(); });
});
