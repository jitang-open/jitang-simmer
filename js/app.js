/* ============================================================
 * Simmer · 应用主逻辑
 *  - 全局状态：当前设备 / 时间范围 / 白名单 / 展开的软件
 *  - 所有统计均基于白名单过滤后实时重算
 * ============================================================ */
const $ = s => document.querySelector(s);

/* ---------------- 白名单持久化（localStorage） ---------------- */
const WL_KEY = 'simmer.whitelist';
function loadWhitelist() {
  try {
    const raw = localStorage.getItem(WL_KEY);
    if (raw !== null) {
      const saved = JSON.parse(raw);
      if (Array.isArray(saved)) return new Set(saved.filter(id => DB.apps.some(a => a.id === id)));
    }
  } catch (e) { /* file:// 或隐私模式下 localStorage 可能不可用，回退默认全选 */ }
  return new Set(DB.apps.map(a => a.id));
}
function saveWhitelist() {
  try { localStorage.setItem(WL_KEY, JSON.stringify([...state.whitelist])); } catch (e) {}
}

const state = {
  device: 'all',                                        // all | desktop | laptop | htpc
  range: 'daily',                                       // daily | weekly | total
  whitelist: loadWhitelist(),                           // 白名单（localStorage 持久化，默认全选）
  openApp: null,                                        // 当前展开的软件 id（切换设备/范围后自动恢复）
};

const RANGE_LABEL = { daily: '今日', weekly: '近 7 天', total: '近一年' };
const wlIds = () => [...state.whitelist];

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

/* ---------------- 概览卡片 ---------------- */
function renderOverview() {
  const ids = wlIds();
  const totalMin = DB.rangeTotalMinutes(state.device, ids, state.range);
  const activeApps = DB.appTotals(state.device, ids, state.range).filter(r => r.minutes > 0).length;
  const cpu = DB.metricCurrent(state.device, 'cpu');
  const temp = ((DB.metricCurrent(state.device, 'cpuTemp') + DB.metricCurrent(state.device, 'gpuTemp')) / 2).toFixed(1);
  const power = DB.metricCurrent(state.device, 'power');

  const th = Math.floor(totalMin / 60), tm = Math.round(totalMin % 60);
  const cards = [
    { label: RANGE_LABEL[state.range] + '总时长', value: `${th}<small> 小时 </small>${tm}<small> 分</small>`, extra: `白名单内 ${ids.length} 款软件`, icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 10.6l4.2 2.5-.8 1.3L11 13.5V7h2v5.6z' },
    { label: '活跃软件', value: activeApps + ' <small>款</small>', extra: RANGE_LABEL[state.range] + '内有使用记录', icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
    { label: 'CPU 占用', value: cpu + ' <small>%</small>', extra: '当前时刻 · 实时采集', icon: 'M9 9h6v6H9zM12 1v4M12 19v4M1 12h4M19 12h4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M19.8 4.2L17 7M7 17l-2.8 2.8' },
    { label: '核心温度', value: temp + ' <small>°C</small>', extra: 'CPU / GPU 平均', icon: 'M14 14.8V5a2 2 0 10-4 0v9.8a4.5 4.5 0 104 0z' },
    { label: '整机功耗', value: power + ' <small>W</small>', extra: state.device === 'all' ? '全部设备合计' : '当前设备', icon: 'M13 2L4 14h6v8l9-12h-6V2z' },
  ];

  $('#sec-overview').innerHTML = cards.map(c => `
    <div class="ov-card">
      <div class="ov-label"><svg viewBox="0 0 24 24"><path d="${c.icon}"/></svg>${c.label}</div>
      <div class="ov-value">${c.value}</div>
      <div class="ov-extra">${c.extra}</div>
    </div>`).join('');
}

/* ---------------- 总时长：点阵图 + 趋势折线 ---------------- */
function renderTotal() {
  const ids = wlIds();
  const year = DB.yearSeries(state.device, ids);
  const totalMin = year.reduce((s, d) => s + d.minutes, 0);
  const activeDays = year.filter(d => d.minutes > 0).length;
  $('#totalSub').textContent =
    `过去一年共 ${Math.floor(totalMin / 60).toLocaleString()} 小时 · ${activeDays} 天有使用记录 · 仅统计白名单软件`;

  Charts.heatmap($('#heatmapWrap'), year);

  const trend = DB.trendSeries(state.device, ids, state.range);
  $('#trendHint').textContent = { daily: '今日 24 小时分布', weekly: '近 7 天每日合计', total: '近 12 个月每月合计' }[state.range];
  Charts.line($('#trendWrap'), {
    labels: trend.labels, values: trend.values,
    color: '#1db954', unit: ' h', height: 180,
  });
}

/* ---------------- 软件时长：横向柱状图 + 展开详情（>10 折叠） ---------------- */
const COLLAPSE_AT = 10;   // 超过 10 款软件时默认折叠

function renderApps() {
  const rows = DB.appTotals(state.device, wlIds(), state.range);
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
      openDetail(rows[idx], wrap.querySelectorAll('.hbar-row')[idx]);
    } else {
      drawList(rows, false);                        // 展开的软件在折叠区，先展开完整列表
      openDetail(rows[idx], wrap.querySelectorAll('.hbar-row')[idx]);
    }
  }

  function onAppRow(app, rowEl) {
    if (state.openApp === app.id) {                 // 再点一次收起
      document.querySelectorAll('.app-detail').forEach(d => d.remove());
      state.openApp = null;
      return;
    }
    openDetail(app, rowEl);
  }

  function openDetail(app, rowEl) {
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
    const wd = DB.appWeekday(state.device, app.id);
    Charts.vbars(bodies[0], { labels: wd.labels, values: wd.values, color: app.color, unit: ' 分钟（日均）' });
    const t = DB.trendSeries(state.device, [app.id], state.range);
    Charts.line(bodies[1], { labels: t.labels, values: t.values, color: app.color, unit: ' h', height: 200 });
    Charts.heatmap(bodies[2], DB.yearSeries(state.device, [app.id]));
  }
}

/* ---------------- 饼图（图例 >10 折叠） ---------------- */
function renderPie() {
  const rows = DB.appTotals(state.device, wlIds(), state.range).filter(r => r.minutes > 0);
  Charts.donut($('#pieWrap'), $('#pieLegend'), rows);

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
function renderHardware() {
  const grid = $('#hwGrid');
  grid.innerHTML = '';
  DB.metricDefs.forEach(m => {
    const cur = DB.metricCurrent(state.device, m.id);
    const card = document.createElement('div');
    card.className = 'hw-card';
    card.innerHTML = `
      <div class="hw-head">
        <span class="hw-name"><i style="background:${m.color}"></i>${m.name}</span>
        <span class="hw-val">${cur}<small> ${m.unit}</small></span>
      </div>
      <div class="hw-chart"></div>`;
    grid.appendChild(card);
    const s = DB.metricSeries(state.device, m.id, state.range);
    Charts.line(card.querySelector('.hw-chart'), {
      labels: s.labels, values: s.values, color: m.color, unit: ' ' + m.unit, height: 120,
    });
  });
}

/* ---------------- 白名单 ---------------- */
function renderWhitelist() {
  const grid = $('#wlGrid');
  grid.innerHTML = '';
  DB.apps.forEach(a => {
    const on = state.whitelist.has(a.id);
    const item = document.createElement('div');
    item.className = 'wl-item' + (on ? '' : ' off');
    item.innerHTML = `
      <div class="wl-icon">${a.icon}</div>
      <div class="wl-info">
        <div class="wl-name">${a.name}</div>
        <div class="wl-cat">${a.category}</div>
      </div>
      <button class="wl-toggle ${on ? 'on' : ''}" aria-label="切换白名单"></button>`;
    item.querySelector('.wl-toggle').addEventListener('click', () => {
      on ? state.whitelist.delete(a.id) : state.whitelist.add(a.id);
      saveWhitelist();
      renderAll();
    });
    grid.appendChild(item);
  });
}

/* ---------------- 总渲染入口 ---------------- */
function renderAll() {
  renderOverview();
  renderTotal();
  renderApps();
  renderPie();
  renderHardware();
  renderWhitelist();
}

/* ---------------- 启动 ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  Charts.init();
  buildDeviceSelect();
  buildRangeTabs();
  buildSidebar();
  renderSideDevices();
  renderAll();

  $('#wlAll').addEventListener('click', () => { DB.apps.forEach(a => state.whitelist.add(a.id)); saveWhitelist(); renderAll(); });
  $('#wlNone').addEventListener('click', () => { state.whitelist.clear(); saveWhitelist(); renderAll(); });
});
