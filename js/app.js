/* ============================================================
 * Simmer · 应用主逻辑
 *  - 全局状态：当前设备 / 时间范围 / 白名单 / 展开的软件
 *  - 所有统计均基于白名单过滤后实时重算
 * ============================================================ */
const $ = s => document.querySelector(s);
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
const safeColor = value => /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#8b949e';


let DB = MockDB;   // 启动时尝试切换为 LiveDB（见 DOMContentLoaded）
let settingsSyncReady = false;
let settingsSaveQueued = false;
let settingsSaveRunning = false;
let settingsDirty = false;

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
function saveWhitelist() {
  saveJSON('simmer.whitelist', [...state.whitelist]);
  queueServerSettingsSave();
}

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
  queueServerSettingsSave();
}

function localISODate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
  usageRange: 'daily',                                  // 软件卡片独立日 / 周 / 月范围
  usageDate: localISODate(),                            // 软件卡片所选锚点日期
  usageStartDate: localISODate(new Date(new Date().getFullYear(), new Date().getMonth(), 1)),
  usageEndDate: localISODate(),
  tokenSource: '',                                      // AI Token 来源筛选
  tokenProvider: '',                                    // AI Token provider 筛选
  tokenModels: [],                                      // AI Token 多模型筛选（空数组=全部）
  tokenRange: 'daily',                                  // Token 卡片独立日 / 周 / 月范围
  tokenDate: localISODate(),                            // Token 卡片所选锚点日期
  tokenStartDate: localISODate(new Date(new Date().getFullYear(), new Date().getMonth(), 1)),
  tokenEndDate: localISODate(),
  usageTrendOpen: false,                                // 总时长趋势默认收起
  tokenTrendOpen: false,                                // Token 趋势默认收起
};

const RANGE_LABEL = { daily: '今日', weekly: '近 7 天', monthly: '本月', total: '累计' };
const TOKEN_SOURCE_NAME = { codex: 'Codex', zcode: 'ZCode', dsh: 'DeepSeek Harness', workbuddy: 'WorkBuddy' };
const TOKEN_STATUS = {
  ready: ['可用', 'ok'],
  installed_no_data: ['已安装，暂无数据', 'muted'],
  history_only: ['历史已保存', 'warn'],
  not_found: ['未找到', 'muted'],
  incompatible: ['解析器不可用', 'bad'],
  error: ['扫描失败', 'bad'],
};
const wlIds = () => [...state.whitelist];

/* ---------------- 统一下拉组件（设备 / 年份 / Token / 表单共用） ---------------- */
function closeCustomSelects(except = null) {
  document.querySelectorAll('.device-select.open').forEach(select => {
    if (select === except) return;
    select.classList.remove('open');
    select.querySelector('.ds-btn')?.setAttribute('aria-expanded', 'false');
  });
}

function mountCustomSelect(wrap, { options, value, onChange, showDot = false, disabled = false }) {
  if (!wrap) return;
  const normalized = options.map(option => typeof option === 'object'
    ? { ...option, key: String(option.value ?? '') }
    : { value: option, key: String(option), label: String(option) });
  const selected = normalized.find(option => option.key === String(value ?? '')) || normalized[0];
  let currentKey = selected?.key || '';
  wrap.classList.add('device-select');
  wrap.classList.remove('open');
  wrap.innerHTML = `
    <button type="button" class="ds-btn" aria-haspopup="listbox" aria-expanded="false" ${disabled ? 'disabled' : ''}
      title="${escapeHTML(selected?.label || '')}">
      ${showDot ? '<span class="sd-dot"></span>' : ''}<span class="ds-name">${escapeHTML(selected?.label || '')}</span><span class="caret">▼</span>
    </button>
    <div class="ds-list" role="listbox"></div>`;
  const button = wrap.querySelector('.ds-btn');
  const list = wrap.querySelector('.ds-list');

  normalized.forEach(option => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ds-opt' + (option === selected ? ' sel' : '');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', option === selected ? 'true' : 'false');
    item.innerHTML = `${showDot ? '<span class="sd-dot"></span>' : ''}<span class="ds-opt-label">${escapeHTML(option.label)}</span>${option.meta ? `<small>${escapeHTML(option.meta)}</small>` : ''}`;
    item.addEventListener('click', event => {
      event.stopPropagation();
      wrap.classList.remove('open');
      button.setAttribute('aria-expanded', 'false');
      const changed = option.key !== currentKey;
      currentKey = option.key;
      button.querySelector('.ds-name').textContent = option.label;
      button.title = option.label;
      list.querySelectorAll('.ds-opt').forEach(candidate => {
        candidate.classList.toggle('sel', candidate === item);
        candidate.setAttribute('aria-selected', candidate === item ? 'true' : 'false');
      });
      if (changed) onChange(option.value);
    });
    list.appendChild(item);
  });

  button.addEventListener('click', event => {
    event.stopPropagation();
    const opening = !wrap.classList.contains('open');
    closeCustomSelects(wrap);
    wrap.classList.toggle('open', opening);
    button.setAttribute('aria-expanded', opening ? 'true' : 'false');
  });
}

function formatTokens(value, compact = false) {
  const number = Number(value) || 0;
  if (!compact) return Math.round(number).toLocaleString('zh-CN');
  if (number >= 1e9) return (number / 1e9).toFixed(number >= 1e10 ? 1 : 2).replace(/\.0+$/, '') + 'B';
  if (number >= 1e6) return (number / 1e6).toFixed(number >= 1e7 ? 1 : 2).replace(/\.0+$/, '') + 'M';
  if (number >= 1e3) return (number / 1e3).toFixed(number >= 1e4 ? 1 : 2).replace(/\.0+$/, '') + 'K';
  return Math.round(number).toLocaleString('zh-CN');
}

function settingsPayload() {
  return {
    whitelist: [...state.whitelist],
    customApps: state.customApps.map(appRow => ({ ...appRow })),
    removedApps: [...state.removedApps],
    offApps: [...state.offApps],
  };
}

function applySettings(settings) {
  state.whitelist = new Set(settings.whitelist);
  state.customApps = settings.customApps.map(appRow => ({ ...appRow }));
  state.removedApps = new Set(settings.removedApps);
  state.offApps = new Set(settings.offApps);
}

function hasMeaningfulSettings(settings) {
  return settings.whitelist.length > 0 || settings.customApps.length > 0 ||
    settings.removedApps.length > 0 || settings.offApps.length > 0;
}

function mergeSettings(serverSettings, localSettings) {
  const customApps = new Map(serverSettings.customApps.map(appRow => [appRow.id, appRow]));
  localSettings.customApps.forEach(appRow => customApps.set(appRow.id, appRow));
  const removedApps = new Set([...serverSettings.removedApps, ...localSettings.removedApps]);
  const offApps = new Set([...serverSettings.offApps, ...localSettings.offApps]);
  const whitelist = new Set([...serverSettings.whitelist, ...localSettings.whitelist]);
  removedApps.forEach(id => { whitelist.delete(id); offApps.delete(id); customApps.delete(id); });
  offApps.forEach(id => whitelist.delete(id));
  return {
    whitelist: [...whitelist],
    customApps: [...customApps.values()].map(appRow => ({ ...appRow })),
    removedApps: [...removedApps],
    offApps: [...offApps],
  };
}

function queueServerSettingsSave() {
  if (!settingsSyncReady || !DB.live || typeof DB.saveSettings !== 'function') return;
  settingsDirty = true;
  if (settingsSaveQueued || settingsSaveRunning) return;
  settingsSaveQueued = true;
  queueMicrotask(() => {
    settingsSaveQueued = false;
    void flushServerSettings();
  });
}

async function flushServerSettings() {
  if (settingsSaveRunning) return;
  settingsSaveRunning = true;
  try {
    while (settingsDirty) {
      settingsDirty = false;
      await DB.saveSettings(settingsPayload());
      localStorage.setItem('simmer.settingsBackendVersion', '1');
    }
  } catch (e) {
    console.error('[simmer] 后端设置同步失败，本地缓存已保留：', e);
  } finally {
    settingsSaveRunning = false;
    if (settingsDirty) queueServerSettingsSave();
  }
}

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

function modelColor(model) {
  const colors = PALETTE.filter(color => !['#8b949e', '#c9d1d9', '#a8a29e'].includes(color));
  let hash = 2166136261;
  for (const char of String(model)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return colors[(hash >>> 0) % colors.length];
}

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
  const opts = [{ id: 'all', name: '全部设备', host: '汇总统计' }, ...DB.devices];
  mountCustomSelect($('#deviceSelect'), {
    options: opts.map(option => ({
      value: option.id,
      label: option.name,
      meta: option.paused ? `已暂停 · ${option.host}` : option.host,
    })),
    value: state.device,
    showDot: true,
    onChange: value => { state.device = value; renderAll(); },
  });
}

/* ---------------- 顶部：每日 / 每周 / 累计 ---------------- */
function syncRangeTabs() {
  document.querySelectorAll('[data-range-tabs] button').forEach(button => {
    button.classList.toggle('on', button.dataset.range === state.range);
  });
}

function setRange(range) {
  if (!Object.hasOwn(RANGE_LABEL, range)) return;
  const changed = state.range !== range;
  state.range = range;
  syncRangeTabs();
  if (changed) renderAll();
}

function buildRangeTabs() {
  document.querySelectorAll('[data-range-tabs] button').forEach(button => {
    button.addEventListener('click', () => setRange(button.dataset.range));
  });
  syncRangeTabs();
}

/* ---------------- 软件 / Token 独立日、周、月选择 ---------------- */
function parseLocalDate(value) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return matched ? new Date(+matched[1], +matched[2] - 1, +matched[3]) : new Date();
}

function periodBounds(range, dateValue, startValue = null, endValue = null) {
  if (range === 'custom') {
    const left = parseLocalDate(startValue);
    const right = parseLocalDate(endValue);
    return left <= right ? { start: left, end: right } : { start: right, end: left };
  }
  const selected = parseLocalDate(dateValue);
  if (range === 'weekly') {
    const start = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() - (selected.getDay() + 6) % 7);
    return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6) };
  }
  if (range === 'monthly') return {
    start: new Date(selected.getFullYear(), selected.getMonth(), 1),
    end: new Date(selected.getFullYear(), selected.getMonth() + 1, 0),
  };
  return { start: selected, end: selected };
}

function periodLabel(range, dateValue, startValue = null, endValue = null) {
  if (range === 'total') return '累计全部历史';
  const { start, end } = periodBounds(range, dateValue, startValue, endValue);
  const short = date => `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  if (range === 'daily') return `${start.getFullYear()} 年 ${short(start)}`;
  if (range === 'monthly') return `${start.getFullYear()} 年 ${start.getMonth() + 1} 月`;
  if (range === 'custom') return `${start.getFullYear()} 年 ${short(start)} – ${end.getFullYear()} 年 ${short(end)}`;
  return `${start.getFullYear()} 年 ${short(start)} – ${short(end)}`;
}

function compactPeriodLabel(range, dateValue, startValue = null, endValue = null) {
  if (range === 'total') return '全部历史';
  const { start, end } = periodBounds(range, dateValue, startValue, endValue);
  const short = date => `${date.getMonth() + 1}/${date.getDate()}`;
  if (range === 'daily') return `${start.getFullYear()}/${short(start)}`;
  if (range === 'monthly') return `${start.getFullYear()} 年 ${start.getMonth() + 1} 月`;
  if (range === 'custom') return `${start.getFullYear()}/${short(start)} – ${end.getFullYear()}/${short(end)}`;
  return `${start.getFullYear()} · ${short(start)} – ${short(end)}`;
}

function mountPeriodPicker(scope) {
  const wrap = $(`#${scope}DatePicker`);
  if (!wrap) return;
  const range = state[`${scope}Range`];
  const selectedDate = parseLocalDate(state[`${scope}Date`]);
  const startDate = state[`${scope}StartDate`];
  const endDate = state[`${scope}EndDate`];
  let viewDate = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1);
  wrap.classList.remove('open');
  wrap.innerHTML = `
    <button type="button" class="ds-btn period-select-btn" aria-haspopup="dialog" aria-expanded="false">
      <span class="calendar-icon">▦</span><span class="ds-name">${escapeHTML(compactPeriodLabel(range, state[`${scope}Date`], startDate, endDate))}</span><span class="caret">▼</span>
    </button>
    <div class="ds-list period-calendar" role="dialog" aria-label="选择统计时间范围"></div>`;
  const button = wrap.querySelector('.ds-btn');
  const panel = wrap.querySelector('.period-calendar');

  const renderPanel = () => {
    const today = parseLocalDate(localISODate());
    if (range === 'custom' || range === 'total') {
      panel.innerHTML = `
        <div class="calendar-custom">
          <strong>${range === 'total' ? '从累计切换为自定义范围' : '自定义起止日期'}</strong>
          <label><span>开始日期</span><input type="date" data-range-start value="${escapeHTML(startDate)}" max="${localISODate()}"></label>
          <label><span>结束日期</span><input type="date" data-range-end value="${escapeHTML(endDate)}" max="${localISODate()}"></label>
          <p class="calendar-error" role="alert" hidden></p>
          <button type="button" class="calendar-apply">应用范围</button>
        </div>`;
      panel.querySelector('.calendar-apply').addEventListener('click', event => {
        event.stopPropagation();
        const from = panel.querySelector('[data-range-start]').value;
        const to = panel.querySelector('[data-range-end]').value;
        const error = panel.querySelector('.calendar-error');
        if (!isValidLocalDate(from) || !isValidLocalDate(to)) {
          error.textContent = '请选择有效的开始和结束日期';
          error.hidden = false;
          return;
        }
        wrap.classList.remove('open');
        button.setAttribute('aria-expanded', 'false');
        selectCustomPeriod(scope, from, to);
      });
      return;
    }
    const selectedBounds = periodBounds(range, state[`${scope}Date`], startDate, endDate);
    const inSelectedRange = date => date >= selectedBounds.start && date <= selectedBounds.end;
    if (range === 'monthly') {
      panel.innerHTML = `
        <div class="calendar-head">
          <button type="button" data-calendar-nav="-1" aria-label="上一年">‹</button>
          <strong>${viewDate.getFullYear()} 年</strong>
          <button type="button" data-calendar-nav="1" aria-label="下一年">›</button>
        </div>
        <div class="calendar-months">${Array.from({ length: 12 }, (_, month) => {
          const date = new Date(viewDate.getFullYear(), month, 1);
          const future = date > new Date(today.getFullYear(), today.getMonth(), 1);
          const selected = selectedDate.getFullYear() === date.getFullYear() && selectedDate.getMonth() === month;
          return `<button type="button" data-calendar-date="${localISODate(date)}" class="${selected ? 'sel' : ''}" ${future ? 'disabled' : ''}>${month + 1} 月</button>`;
        }).join('')}</div>`;
    } else {
      const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
      const gridStart = new Date(first.getFullYear(), first.getMonth(), first.getDate() - (first.getDay() + 6) % 7);
      panel.innerHTML = `
        <div class="calendar-head">
          <button type="button" data-calendar-nav="-1" aria-label="上个月">‹</button>
          <strong>${viewDate.getFullYear()} 年 ${viewDate.getMonth() + 1} 月</strong>
          <button type="button" data-calendar-nav="1" aria-label="下个月">›</button>
        </div>
        <div class="calendar-weekdays">${['一','二','三','四','五','六','日'].map(day => `<span>${day}</span>`).join('')}</div>
        <div class="calendar-days">${Array.from({ length: 42 }, (_, index) => {
          const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
          const outside = date.getMonth() !== viewDate.getMonth();
          const future = date > today;
          const selected = inSelectedRange(date);
          const exact = localISODate(date) === state[`${scope}Date`];
          return `<button type="button" data-calendar-date="${localISODate(date)}" class="${outside ? 'outside ' : ''}${selected ? 'in-range ' : ''}${exact ? 'sel' : ''}" ${future ? 'disabled' : ''}>${date.getDate()}</button>`;
        }).join('')}</div>`;
    }

    panel.querySelectorAll('[data-calendar-nav]').forEach(nav => nav.addEventListener('click', event => {
      event.stopPropagation();
      const amount = Number(nav.dataset.calendarNav);
      viewDate = range === 'monthly'
        ? new Date(viewDate.getFullYear() + amount, viewDate.getMonth(), 1)
        : new Date(viewDate.getFullYear(), viewDate.getMonth() + amount, 1);
      renderPanel();
    }));
    panel.querySelectorAll('[data-calendar-date]').forEach(day => day.addEventListener('click', event => {
      event.stopPropagation();
      if (day.disabled) return;
      wrap.classList.remove('open');
      button.setAttribute('aria-expanded', 'false');
      selectPeriod(scope, range, day.dataset.calendarDate);
    }));
  };

  button.addEventListener('click', event => {
    event.stopPropagation();
    const opening = !wrap.classList.contains('open');
    closeCustomSelects(wrap);
    if (opening) renderPanel();
    wrap.classList.toggle('open', opening);
    button.setAttribute('aria-expanded', opening ? 'true' : 'false');
  });
  panel.addEventListener('click', event => event.stopPropagation());
}

function syncPeriodControl(scope) {
  const rangeKey = `${scope}Range`;
  document.querySelectorAll(`[data-period-tabs="${scope}"] button`).forEach(button => {
    button.classList.toggle('on', button.dataset.period === state[rangeKey]);
  });
  mountPeriodPicker(scope);
}

function selectPeriod(scope, range, dateValue = null) {
  if (!['daily', 'weekly', 'monthly', 'custom', 'total'].includes(range)) return;
  state[`${scope}Range`] = range;
  if (dateValue) state[`${scope}Date`] = dateValue;
  syncPeriodControl(scope);
  renderAll();
}

function isValidLocalDate(value) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!matched) return false;
  const date = new Date(+matched[1], +matched[2] - 1, +matched[3]);
  return date.getFullYear() === +matched[1] && date.getMonth() === +matched[2] - 1 && date.getDate() === +matched[3];
}

function selectCustomPeriod(scope, startValue, endValue) {
  let start = startValue;
  let end = endValue;
  if (parseLocalDate(start) > parseLocalDate(end)) [start, end] = [end, start];
  state[`${scope}StartDate`] = start;
  state[`${scope}EndDate`] = end;
  state[`${scope}Range`] = 'custom';
  syncPeriodControl(scope);
  renderAll();
}

function buildPeriodControls() {
  for (const scope of ['usage', 'token']) {
    document.querySelectorAll(`[data-period-tabs="${scope}"] button`).forEach(button => {
      button.addEventListener('click', () => selectPeriod(scope, button.dataset.period));
    });
    syncPeriodControl(scope);
  }
}

/* ---------------- 侧边栏：滚动高亮（scroll-spy）+ 移动端抽屉 ---------------- */

const TREND_CONTROLS = {
  usage: { stateKey: 'usageTrendOpen', target: '#trendWrap' },
  token: { stateKey: 'tokenTrendOpen', target: '#tokenTrend' },
};

function syncTrendToggles() {
  document.querySelectorAll('[data-trend-toggle]').forEach(button => {
    const control = TREND_CONTROLS[button.dataset.trendToggle];
    if (!control) return;
    const open = !!state[control.stateKey];
    const content = $(control.target);
    if (content) content.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    button.innerHTML = `${open ? '收起趋势' : '展开趋势'} <span class="caret">▼</span>`;
  });
}

function buildTrendToggles() {
  document.querySelectorAll('[data-trend-toggle]').forEach(button => {
    button.addEventListener('click', () => {
      const control = TREND_CONTROLS[button.dataset.trendToggle];
      if (!control) return;
      state[control.stateKey] = !state[control.stateKey];
      syncTrendToggles();
      // 展开后重新绘制，确保隐藏容器恢复时使用真实宽度。
      if (state[control.stateKey]) renderAll();
    });
  });
  syncTrendToggles();
}
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
  const EDIT_PATH = 'M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zM20.7 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z';
  const PAUSE_PATH = 'M6 5h4v14H6zm8 0h4v14h-4z';
  const PLAY_PATH = 'M8 5v14l11-7z';
  const wrap = $('#sideDevices');
  wrap.innerHTML = '<div class="side-dev-title">我的设备</div>' + DB.devices.map(d => `
    <div class="side-dev ${d.paused ? 'paused' : ''}" data-device-id="${escapeHTML(d.id)}">
      <span class="sd-dot"></span>
      <div class="side-dev-copy"><div class="sd-name">${escapeHTML(d.name)}</div><div class="sd-host">${escapeHTML(d.paused ? '已暂停统计' : d.host)}</div></div>
      <div class="side-dev-actions">
        <button type="button" class="side-dev-action" data-device-action="rename" title="修改设备名"><svg viewBox="0 0 24 24"><path d="${EDIT_PATH}"/></svg></button>
        <button type="button" class="side-dev-action ${d.paused ? 'resume' : ''}" data-device-action="pause" title="${d.paused ? '恢复统计' : '暂停统计'}"><svg viewBox="0 0 24 24"><path d="${d.paused ? PLAY_PATH : PAUSE_PATH}"/></svg></button>
      </div>
    </div>`).join('');
  wrap.querySelectorAll('.side-dev').forEach(row => {
    const device = DB.devices.find(item => item.id === row.dataset.deviceId);
    row.querySelector('[data-device-action="rename"]').addEventListener('click', () => openDeviceRename(device));
    row.querySelector('[data-device-action="pause"]').addEventListener('click', () => updateDevice(device, { paused: !device.paused }));
  });
}

async function updateDevice(device, changes) {
  if (!device || typeof DB.updateDevice !== 'function') return;
  try {
    const updated = await DB.updateDevice(device.id, changes);
    Object.assign(device, updated, { host: device.host || device.id, paused: !!updated.paused });
    buildDeviceSelect();
    renderSideDevices();
    renderAll();
  } catch (error) {
    console.error('[simmer] 设备设置保存失败：', error);
    window.alert('设备设置保存失败，请确认后端正在运行。');
  }
}

function openDeviceRename(device) {
  document.querySelectorAll('.app-form-overlay').forEach(dialog => dialog.remove());
  const overlay = document.createElement('div');
  overlay.className = 'app-form-overlay';
  overlay.innerHTML = `
    <div class="app-form" role="dialog" aria-modal="true" aria-labelledby="deviceFormTitle">
      <h3 id="deviceFormTitle">修改设备名称</h3>
      <label>显示名称</label>
      <input class="device-name-input" maxlength="200" value="${escapeHTML(device.name)}" autocomplete="off">
      <div class="hint-inline">采集端仍使用设备 ID ${escapeHTML(device.id)}；新名称不会被后续上报覆盖。</div>
      <div class="af-btns">
        <button class="btn-ghost af-cancel">取消</button>
        <button class="btn-ghost device-save" style="border-color:var(--green);color:var(--green-hi)">保存</button>
      </div>
    </div>`;
  const input = overlay.querySelector('.device-name-input');
  const save = async () => {
    const name = input.value.trim();
    if (!name) { input.classList.add('af-invalid'); input.focus(); return; }
    overlay.querySelector('.device-save').disabled = true;
    await updateDevice(device, { name });
    overlay.remove();
  };
  overlay.querySelector('.af-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.device-save').addEventListener('click', save);
  input.addEventListener('keydown', event => { if (event.key === 'Enter') save(); });
  overlay.addEventListener('click', event => { if (event.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  input.select();
}

/* ---------------- 总时长卡片：年份选择器（与设备选择器同款 UI） ---------------- */
function buildYearSelect() {
  const currentYear = new Date().getFullYear();
  mountCustomSelect($('#yearSelect'), {
    options: [...DB.yearList].reverse().map(year => ({
      value: year,
      label: String(year),
      meta: year === currentYear ? '今年' : '',
    })),
    value: state.year,
    onChange: value => { state.year = value; renderAll(); },
  });
}

/* ---------------- 概览卡片 ---------------- */
let renderGeneration = 0;
const snapshotRenderState = () => ({
  device: state.device,
  range: state.range,
  year: state.year,
  appIds: wlIds(),
  usageRange: state.usageRange,
  usageDate: state.usageDate,
  usageStartDate: state.usageStartDate,
  usageEndDate: state.usageEndDate,
  tokenSource: state.tokenSource,
  tokenProvider: state.tokenProvider,
  tokenModels: [...state.tokenModels],
  tokenRange: state.tokenRange,
  tokenDate: state.tokenDate,
  tokenStartDate: state.tokenStartDate,
  tokenEndDate: state.tokenEndDate,
});
const isRenderCurrent = token => token === renderGeneration;

async function renderOverview(ctx, token) {
  const [totalMin, totalRows, cpu, tempCpu, tempGpu, power] = await Promise.all([
    DB.rangeTotalMinutes(ctx.device, ctx.appIds, ctx.range),
    DB.appTotals(ctx.device, ctx.appIds, ctx.range),
    DB.metricCurrent(ctx.device, 'cpu'),
    DB.metricCurrent(ctx.device, 'cpuTemp'),
    DB.metricCurrent(ctx.device, 'gpuTemp'),
    DB.metricCurrent(ctx.device, 'power'),
  ]);
  if (!isRenderCurrent(token)) return;
  const activeApps = totalRows.filter(r => r.minutes > 0).length;
  const hwReady = cpu !== null;
  const temp = tempCpu !== null && tempGpu !== null ? ((tempCpu + tempGpu) / 2).toFixed(1) : null;

  const th = Math.floor(totalMin / 60), tm = Math.round(totalMin % 60);
  const cards = [
    { label: RANGE_LABEL[ctx.range] + '总时长', value: `${th}<small> 小时 </small>${tm}<small> 分</small>`, extra: `白名单内 ${ctx.appIds.length} 款软件`, icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 10.6l4.2 2.5-.8 1.3L11 13.5V7h2v5.6z' },
    { label: '活跃软件', value: activeApps + ' <small>款</small>', extra: RANGE_LABEL[ctx.range] + '内有使用记录', icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
    { label: 'CPU 占用', value: hwReady ? cpu + ' <small>%</small>' : '—', extra: hwReady ? '当前时刻 · 实时采集' : '待 M2 硬件采集支持', icon: 'M9 9h6v6H9zM12 1v4M12 19v4M1 12h4M19 12h4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M19.8 4.2L17 7M7 17l-2.8 2.8' },
    { label: '核心温度', value: temp !== null ? temp + ' <small>°C</small>' : '—', extra: temp !== null ? 'CPU / GPU 平均' : '待 M2 硬件采集支持', icon: 'M14 14.8V5a2 2 0 10-4 0v9.8a4.5 4.5 0 104 0z' },
    { label: '整机功耗', value: power !== null ? power + ' <small>W</small>' : '—', extra: power !== null ? (ctx.device === 'all' ? '全部设备合计' : '当前设备') : '待 M2 硬件采集支持', icon: 'M13 2L4 14h6v8l9-12h-6V2z' },
  ];

  $('#sec-overview').innerHTML = cards.map(c => `
    <div class="ov-card">
      <div class="ov-label"><svg viewBox="0 0 24 24"><path d="${c.icon}"/></svg>${c.label}</div>
      <div class="ov-value">${c.value}</div>
      <div class="ov-extra">${c.extra}</div>
    </div>`).join('');
}

/* ---------------- 总时长：点阵图 + 趋势折线 ---------------- */
async function renderTotal(ctx, token) {
  const [year, trend] = await Promise.all([
    DB.yearSeries(ctx.device, ctx.appIds, ctx.year),
    DB.trendSeries(ctx.device, ctx.appIds, ctx.range),
  ]);
  if (!isRenderCurrent(token)) return;
  const totalMin = year.reduce((s, d) => s + (d.minutes || 0), 0);
  const activeDays = year.filter(d => d.minutes > 0).length;
  $('#totalSub').textContent =
    `${ctx.year} 年共 ${Math.floor(totalMin / 60).toLocaleString()} 小时 · ${activeDays} 天有使用记录 · 色阶最高按 5 小时计算`;
  Charts.heatmap($('#heatmapWrap'), year, {
    maxValue: 300,
    selectedDate: ctx.usageDate,
    onSelect: day => selectPeriod('usage', 'daily', localISODate(day.date)),
  });
  $('#trendHint').textContent = { daily: '今日 24 小时分布', weekly: '近 7 天每日合计', total: '近 12 个月每月合计' }[ctx.range];
  Charts.line($('#trendWrap'), {
    labels: trend.labels, values: trend.values,
    color: '#1db954', unit: ' h', height: 180,
  });
}

/* ---------------- 软件时长：横向柱状图 + 展开详情（>10 折叠） ---------------- */
const COLLAPSE_AT = 10;   // 超过 10 款软件时默认折叠

async function renderApps(ctx, token) {
  const rows = applyMeta(await DB.appTotals(
    ctx.device, ctx.appIds, ctx.usageRange, ctx.usageDate, ctx.usageStartDate, ctx.usageEndDate
  ));
  if (!isRenderCurrent(token)) return;
  $('#appsSub').textContent = `${periodLabel(ctx.usageRange, ctx.usageDate, ctx.usageStartDate, ctx.usageEndDate)} · ${rows.length} 款白名单软件 · 按时长降序`;
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
      void openDetail(rows[idx], wrap.querySelectorAll('.hbar-row')[idx], ctx, token);
    } else {
      drawList(rows, false);                        // 展开的软件在折叠区，先展开完整列表
      void openDetail(rows[idx], wrap.querySelectorAll('.hbar-row')[idx], ctx, token);
    }
  }

  function onAppRow(app, rowEl) {
    if (state.openApp === app.id) {                 // 再点一次收起
      document.querySelectorAll('.app-detail').forEach(d => d.remove());
      state.openApp = null;
      return;
    }
    void openDetail(app, rowEl, snapshotRenderState(), renderGeneration);
  }

  async function openDetail(app, rowEl, detailCtx, detailToken) {
    document.querySelectorAll('.app-detail').forEach(d => d.remove());
    state.openApp = app.id;
    const detail = document.createElement('div');
    detail.className = 'app-detail';
    detail.innerHTML = `
      <div class="ad-grid">
        <div class="ad-panel">
          <div class="ad-title"><i style="background:${safeColor(app.color)}"></i>柱状图 · 星期分布</div>
          <div class="ad-body"></div>
        </div>
        <div class="ad-panel">
          <div class="ad-title"><i style="background:${safeColor(app.color)}"></i>折线图 · 时长趋势</div>
          <div class="ad-body"></div>
        </div>
        <div class="ad-panel ad-wide">
          <div class="ad-title"><i style="background:${safeColor(app.color)}"></i>点阵图 · 年度记录</div>
          <div class="ad-body"></div>
        </div>
      </div>`;
    rowEl.after(detail);

    const [wd, t, yearRows] = await Promise.all([
      DB.appWeekday(detailCtx.device, app.id),
      DB.trendSeries(
        detailCtx.device, [app.id], detailCtx.usageRange, detailCtx.usageDate,
        detailCtx.usageStartDate, detailCtx.usageEndDate
      ),
      DB.yearSeries(detailCtx.device, [app.id], detailCtx.year),
    ]);
    if (!isRenderCurrent(detailToken) || !detail.isConnected || state.openApp !== app.id) return;
    const bodies = detail.querySelectorAll('.ad-body');
    Charts.vbars(bodies[0], { labels: wd.labels, values: wd.values, color: app.color, unit: ' 分钟（日均）' });
    Charts.line(bodies[1], { labels: t.labels, values: t.values, color: app.color, unit: ' h', height: 200 });
    Charts.heatmap(bodies[2], yearRows, {
      maxValue: 300,
      selectedDate: detailCtx.usageDate,
      onSelect: day => selectPeriod('usage', 'daily', localISODate(day.date)),
    });
  }
}

/* ---------------- 饼图（图例 >10 折叠） ---------------- */
async function renderPie(ctx, token) {
  const rows = (await DB.appTotals(
    ctx.device, ctx.appIds, ctx.usageRange, ctx.usageDate, ctx.usageStartDate, ctx.usageEndDate
  )).filter(r => r.minutes > 0);
  if (!isRenderCurrent(token)) return;
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

/* ---------------- AI Token 统计（请求级数字元数据） ---------------- */
function fillTokenFilter(selector, values, selected, stateKey, labeler = value => value) {
  mountCustomSelect($(selector), {
    options: [
      { value: '', label: '全部' },
      ...values.map(value => ({ value, label: labeler(value) })),
    ],
    value: selected,
    onChange: value => { state[stateKey] = value; renderAll(); },
  });
}

function mountTokenModelFilter(values, selectedValues) {
  const wrap = $('#tokenModelFilter');
  const wasOpen = wrap.classList.contains('open');
  const selected = new Set(selectedValues);
  const label = selected.size ? `已选 ${selected.size} 个模型` : '全部模型';
  wrap.innerHTML = `
    <button type="button" class="ds-btn" aria-haspopup="listbox" aria-expanded="${wasOpen ? 'true' : 'false'}" title="${escapeHTML(label)}">
      <span class="ds-name">${escapeHTML(label)}</span><span class="caret">▼</span>
    </button>
    <div class="ds-list" role="listbox"></div>`;
  wrap.classList.toggle('open', wasOpen);
  const button = wrap.querySelector('.ds-btn');
  const list = wrap.querySelector('.ds-list');
  const addOption = (value, optionLabel, isSelected, all = false) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = `ds-opt${isSelected ? ' sel' : ''}`;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    option.innerHTML = `<span class="ds-opt-label">${escapeHTML(optionLabel)}</span>`;
    option.addEventListener('click', event => {
      event.stopPropagation();
      if (all) selected.clear();
      else if (selected.has(value)) selected.delete(value);
      else selected.add(value);
      state.tokenModels = [...selected];
      renderAll();
    });
    list.appendChild(option);
  };
  addOption('', '全部模型', selected.size === 0, true);
  values.forEach(value => addOption(value, value, selected.has(value)));
  button.addEventListener('click', event => {
    event.stopPropagation();
    const opening = !wrap.classList.contains('open');
    closeCustomSelects(wrap);
    wrap.classList.toggle('open', opening);
    button.setAttribute('aria-expanded', opening ? 'true' : 'false');
  });
}

function renderTokenRanks(container, rows, labeler = value => value) {
  if (!rows.length) {
    container.innerHTML = '<div class="token-rank-empty">当前筛选范围暂无数据</div>';
    return;
  }
  const max = Math.max(...rows.map(row => row.tokens), 1);
  container.innerHTML = rows.slice(0, 10).map(row => `
    <div class="token-rank-row">
      <div class="token-rank-label" title="${escapeHTML(labeler(row.id))}">${escapeHTML(labeler(row.id))}</div>
      <div class="token-rank-track"><i style="width:${(row.tokens / max * 100).toFixed(1)}%"></i></div>
      <div class="token-rank-value">${formatTokens(row.tokens, true)}<small>${row.eventCount.toLocaleString('zh-CN')} 次</small></div>
    </div>`).join('');
}

async function renderTokens(ctx, token) {
  const summaryWrap = $('#tokenSummary');
  const empty = $('#tokenEmpty');
  const chartGrid = document.querySelector('#sec-tokens .token-chart-grid');
  if (!DB.live || typeof DB.tokenSummary !== 'function') {
    if (!isRenderCurrent(token)) return;
    summaryWrap.hidden = true;
    chartGrid.hidden = true;
    empty.hidden = false;
    empty.textContent = 'AI Token 统计只在连接本地后端时显示；当前演示数据不包含伪造 Token。';
    return;
  }

  const dimensions = await DB.tokenDimensions(ctx.device);
  if (!isRenderCurrent(token)) return;
  const choose = (value, values) => values.includes(value) ? value : '';
  const source = choose(ctx.tokenSource, dimensions.sources);
  const provider = choose(ctx.tokenProvider, dimensions.providers);
  const models = ctx.tokenModels.filter(model => dimensions.models.includes(model));
  state.tokenSource = source;
  state.tokenProvider = provider;
  state.tokenModels = models;
  fillTokenFilter('#tokenSourceFilter', dimensions.sources, source, 'tokenSource', value => TOKEN_SOURCE_NAME[value] || value);
  fillTokenFilter('#tokenProviderFilter', dimensions.providers, provider, 'tokenProvider');
  mountTokenModelFilter(dimensions.models, models);

  const filters = { source, provider, models };
  const [summary, trend, year, sourceRows, modelRows, statuses] = await Promise.all([
    DB.tokenSummary(ctx.device, ctx.tokenRange, filters, ctx.tokenDate, ctx.tokenStartDate, ctx.tokenEndDate),
    DB.tokenTrend(ctx.device, ctx.tokenRange, filters, ctx.tokenDate, ctx.tokenStartDate, ctx.tokenEndDate),
    DB.tokenYear(ctx.device, ctx.year, filters),
    DB.tokenBreakdown(ctx.device, ctx.tokenRange, filters, 'source', ctx.tokenDate, ctx.tokenStartDate, ctx.tokenEndDate),
    DB.tokenBreakdown(ctx.device, ctx.tokenRange, filters, 'model', ctx.tokenDate, ctx.tokenStartDate, ctx.tokenEndDate),
    DB.tokenSources(ctx.device),
  ]);
  if (!isRenderCurrent(token)) return;

  const deviceNames = new Map(DB.devices.map(device => [device.id, device.name]));
  const statusesWrap = $('#tokenStatuses');
  statusesWrap.innerHTML = statuses.length ? statuses.map(row => {
    const [statusLabel, tone] = TOKEN_STATUS[row.state] || [row.state, 'muted'];
    const deviceLabel = ctx.device === 'all' ? `<small>${escapeHTML(deviceNames.get(row.deviceId) || row.deviceId)}</small>` : '';
    return `<div class="token-status ${tone}"><span>${escapeHTML(TOKEN_SOURCE_NAME[row.source] || row.source)}${deviceLabel}</span><b>${escapeHTML(statusLabel)}</b></div>`;
  }).join('') : '<div class="token-status muted"><span>本地来源</span><b>尚未扫描</b></div>';

  const hasData = summary.eventCount > 0;
  summaryWrap.hidden = !hasData;
  chartGrid.hidden = !hasData;
  empty.hidden = hasData;
  if (!hasData) {
    empty.textContent = '当前设备、时间范围或筛选条件下暂无 Token 记录；上方来源状态用于区分“未安装”和“尚无数据”。';
    $('#tokenSub').textContent = `${periodLabel(ctx.tokenRange, ctx.tokenDate, ctx.tokenStartDate, ctx.tokenEndDate)} · 请求级本地用量 · 暂无匹配记录`;
    return;
  }

  const cards = [
    ['总 Token', summary.totalTokens, `${summary.eventCount.toLocaleString('zh-CN')} 次请求`],
    ['非缓存输入', summary.inputTokens, 'input'],
    ['普通输出', summary.outputTokens, 'output（不含推理）'],
    ['缓存读取', summary.cacheReadTokens, 'cache read'],
    ['缓存写入', summary.cacheWriteTokens, 'cache write'],
    ['推理 Token', summary.reasoningTokens, 'reasoning'],
  ];
  summaryWrap.innerHTML = cards.map(([label, value, detail], index) => `
    <div class="token-stat ${index === 0 ? 'primary' : ''}">
      <span>${escapeHTML(label)}</span>
      <strong title="${formatTokens(value)}">${formatTokens(value, true)}</strong>
      <small>${escapeHTML(detail)}</small>
    </div>`).join('');
  $('#tokenSub').textContent = `${periodLabel(ctx.tokenRange, ctx.tokenDate, ctx.tokenStartDate, ctx.tokenEndDate)} · ${formatTokens(summary.totalTokens)} Tokens · ${summary.eventCount.toLocaleString('zh-CN')} 次请求`;

  const yearlyTokens = year.reduce((sum, day) => sum + (day.tokens || 0), 0);
  const activeDays = year.filter(day => day.tokens > 0).length;
  $('#tokenYearHint').textContent = `${ctx.year} 年 ${formatTokens(yearlyTokens, true)} · ${activeDays} 天有记录`;
  Charts.heatmap($('#tokenHeatmap'), year, {
    valueKey: 'tokens',
    valueLabel: 'Tokens',
    maxValue: 100_000_000,
    formatValue: value => `${formatTokens(value)} Tokens`,
    selectedDate: ctx.tokenDate,
    onSelect: day => selectPeriod('token', 'daily', localISODate(day.date)),
  });

  const maxTrend = Math.max(...(trend.series || []).flatMap(series => series.values), 0);
  const divisor = maxTrend >= 1e9 ? 1e9 : maxTrend >= 1e6 ? 1e6 : maxTrend >= 1e3 ? 1e3 : 1;
  const trendUnit = divisor === 1e9 ? ' B' : divisor === 1e6 ? ' M' : divisor === 1e3 ? ' K' : '';
  $('#tokenTrendHint').textContent = `${periodLabel(ctx.tokenRange, ctx.tokenDate, ctx.tokenStartDate, ctx.tokenEndDate)} · ${(trend.series || []).length} 个模型`;
  Charts.multiline($('#tokenTrend'), {
    labels: trend.labels,
    series: (trend.series || []).map(series => ({
      id: series.id,
      label: series.id,
      color: modelColor(series.id),
      values: series.values.map(value => +(value / divisor).toFixed(2)),
      rawValues: series.values,
    })),
    valueFormatter: value => `${formatTokens(value)} Tokens`,
    unit: trendUnit,
    height: 190,
  });
  renderTokenRanks($('#tokenSourceRank'), sourceRows, value => TOKEN_SOURCE_NAME[value] || value);
  renderTokenRanks($('#tokenModelRank'), modelRows);
}

/* ---------------- 硬件监控 ---------------- */
async function renderHardware(ctx, token) {
  const grid = $('#hwGrid');
  if (!DB.metricDefs.length) {                      // M2（CAP-06）补齐硬件采集
    if (isRenderCurrent(token)) grid.innerHTML = '<div class="hw-empty">硬件指标采集将在 M2（CAP-06，基于 LibreHardwareMonitor）接入</div>';
    return;
  }
  const metrics = await Promise.all(DB.metricDefs.map(async m => ({
    m,
    cur: await DB.metricCurrent(ctx.device, m.id),
    series: await DB.metricSeries(ctx.device, m.id, ctx.range),
  })));
  if (!isRenderCurrent(token)) return;
  grid.innerHTML = '';
  metrics.forEach(({ m, cur, series }) => {
    const card = document.createElement('div');
    card.className = 'hw-card';
    card.innerHTML = `
      <div class="hw-head">
        <span class="hw-name"><i style="background:${safeColor(m.color)}"></i>${escapeHTML(m.name)}</span>
        <span class="hw-val">${escapeHTML(cur)}<small> ${escapeHTML(m.unit)}</small></span>
      </div>
      <div class="hw-chart"></div>`;
    grid.appendChild(card);
    Charts.line(card.querySelector('.hw-chart'), {
      labels: series.labels, values: series.values, color: m.color, unit: ' ' + m.unit, height: 120,
    });
  });
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
      <div class="wl-icon">${escapeHTML(a.icon)}</div>
      <div class="wl-info">
        <div class="wl-name">${escapeHTML(a.name)}<code class="wl-id">${escapeHTML(a.id)}</code></div>
        <div class="wl-cat">${escapeHTML(a.category)}</div>
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
function confirmAction({ title, message, confirmText = '确认' }) {
  return new Promise(resolve => {
    document.querySelector('.confirm-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'app-form-overlay confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmTitle" aria-describedby="confirmMessage">
        <div class="confirm-mark">!</div>
        <div class="confirm-copy">
          <h3 id="confirmTitle">${escapeHTML(title)}</h3>
          <p id="confirmMessage">${escapeHTML(message)}</p>
        </div>
        <div class="confirm-btns">
          <button type="button" class="btn-ghost confirm-cancel">取消</button>
          <button type="button" class="btn-ghost confirm-submit">${escapeHTML(confirmText)}</button>
        </div>
      </div>`;
    let settled = false;
    const finish = accepted => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(accepted);
    };
    const onKeydown = event => { if (event.key === 'Escape') finish(false); };
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => finish(false));
    overlay.querySelector('.confirm-submit').addEventListener('click', () => finish(true));
    overlay.addEventListener('click', event => { if (event.target === overlay) finish(false); });
    document.addEventListener('keydown', onKeydown);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.querySelector('.confirm-cancel').focus());
  });
}

async function openAppForm(editing) {
  document.querySelectorAll('.app-form-overlay').forEach(dialog => dialog.remove());
  const isEdit = !!editing;
  const def = isEdit
    ? editing
    : { id: '', name: '', category: '其他', color: PALETTE[Math.floor(Math.random() * PALETTE.length)] };

  // 已观测进程清单（后端记录过的所有 exe，不受白名单限制）
  let known = [];
  try { known = await DB.allApps(); } catch (e) {}
  const knownRows = [...known].sort((a, b) => String(a.id).localeCompare(String(b.id), 'zh-CN'));
  const knownMap = new Map(knownRows.map(row => [String(row.id).toLowerCase(), row]));
  const listedIds = new Set(mergedApps().map(app => app.id.toLowerCase()));

  const overlay = document.createElement('div');
  overlay.className = 'app-form-overlay';
  overlay.innerHTML = `
    <div class="app-form" role="dialog" aria-modal="true" aria-labelledby="appFormTitle">
      <h3 id="appFormTitle">${isEdit ? '编辑软件' : '添加软件'}</h3>
      <label>进程<span class="req">*</span><span class="hint-inline">（选择已检测进程，或搜索后手动使用）</span></label>
      <input type="hidden" class="af-id" value="${escapeHTML(isEdit ? editing.id : '')}">
      <div class="device-select af-process-select${isEdit ? ' is-disabled' : ''}">
        <button type="button" class="ds-btn" aria-haspopup="listbox" aria-expanded="false" ${isEdit ? 'disabled title="如需更换进程，请删除后重新添加"' : ''}>
          <span class="ds-name">${escapeHTML(isEdit ? editing.id : '点击选择已检测到的进程…')}</span><span class="caret">▼</span>
        </button>
        <div class="ds-list" role="listbox">
          <div class="af-process-search-wrap"><input class="af-process-search" autocomplete="off" placeholder="搜索进程，或输入进程名…"></div>
          <div class="af-process-options"></div>
        </div>
      </div>
      <label>显示名称<span class="hint-inline">（留空则用进程名）</span></label>
      <input class="af-name" placeholder="如 Google Chrome" value="${escapeHTML(isEdit ? editing.name : '')}">
      <label>软件类型</label>
      <input type="hidden" class="af-cat" value="${escapeHTML(def.category)}">
      <div class="device-select af-cat-select"></div>
      <label>颜色</label>
      <div class="af-palette">${PALETTE.map(color =>
        `<i class="cp-item ${color === def.color ? 'sel' : ''}" data-color="${color}" style="background:${color}"></i>`).join('')}<i class="cp-item cp-random" title="随机一个颜色">🎲</i></div>
      <div class="af-btns">
        <button class="btn-ghost af-cancel">取消</button>
        <button class="btn-ghost af-save" style="border-color:var(--green);color:var(--green-hi)">${isEdit ? '保存' : '添加'}</button>
      </div>
    </div>`;

  const idInput = overlay.querySelector('.af-id');
  const nameInput = overlay.querySelector('.af-name');
  const catInput = overlay.querySelector('.af-cat');
  const processSelect = overlay.querySelector('.af-process-select');
  const processButton = processSelect.querySelector('.ds-btn');
  const processSearch = overlay.querySelector('.af-process-search');
  const processOptions = overlay.querySelector('.af-process-options');
  let pickedColor = def.color;
  let colorTouched = isEdit;

  const pickProcess = processId => {
    const value = String(processId || '').trim();
    if (!value) return;
    const knownRow = knownMap.get(value.toLowerCase());
    const canonicalId = knownRow ? knownRow.id : value;
    idInput.value = canonicalId;
    processButton.querySelector('.ds-name').textContent = canonicalId;
    processButton.title = canonicalId;
    processButton.classList.remove('af-invalid');
    processSelect.classList.remove('open');
    processButton.setAttribute('aria-expanded', 'false');
    if (knownRow && !nameInput.value.trim()) nameInput.value = canonicalId.replace(/\.exe$/i, '');
  };

  const addProcessOption = (processId, detail, manual = false) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'ds-opt' + (manual ? ' af-process-manual' : '');
    option.innerHTML = `<span class="ds-opt-label">${escapeHTML(manual ? `手动使用 “${processId}”` : processId)}</span><small>${escapeHTML(detail)}</small>`;
    option.addEventListener('click', event => {
      event.stopPropagation();
      pickProcess(processId);
    });
    processOptions.appendChild(option);
  };

  const renderProcessOptions = (query = '') => {
    const keyword = query.trim().toLowerCase();
    const matches = knownRows.filter(row => !keyword || String(row.id).toLowerCase().includes(keyword));
    processOptions.innerHTML = '';
    matches.forEach(row => {
      const minutes = Math.round(Number(row.minutes) || 0).toLocaleString('zh-CN');
      const listed = listedIds.has(String(row.id).toLowerCase());
      addProcessOption(row.id, `${listed ? '已在清单' : '未添加'} · 累计 ${minutes} 分钟`);
    });
    const exact = keyword && knownMap.has(keyword);
    if (keyword && !exact) addProcessOption(query.trim(), '手动添加进程', true);
    if (!matches.length && !keyword) {
      processOptions.innerHTML = '<div class="af-process-empty">尚未检测到进程，可在上方直接输入进程名</div>';
    }
  };

  if (!isEdit) {
    renderProcessOptions();
    processButton.addEventListener('click', event => {
      event.stopPropagation();
      const opening = !processSelect.classList.contains('open');
      closeCustomSelects(processSelect);
      processSelect.classList.toggle('open', opening);
      processButton.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if (opening) {
        processSearch.value = '';
        renderProcessOptions();
        setTimeout(() => processSearch.focus(), 0);
      }
    });
    processSelect.querySelector('.ds-list').addEventListener('click', event => event.stopPropagation());
    processSearch.addEventListener('input', () => renderProcessOptions(processSearch.value));
    processSearch.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const value = processSearch.value.trim();
      if (value) pickProcess(knownMap.get(value.toLowerCase())?.id || value);
    });
  }

  mountCustomSelect(overlay.querySelector('.af-cat-select'), {
    options: CATEGORIES.map(category => ({ value: category, label: category })),
    value: def.category,
    onChange: category => {
      catInput.value = category;
      if (!colorTouched) {
        pickedColor = CAT_META[category].color;
        overlay.querySelectorAll('.cp-item').forEach(item => item.classList.toggle('sel', item.dataset.color === pickedColor));
      }
    },
  });

  overlay.querySelectorAll('.cp-item:not(.cp-random)').forEach(item => item.addEventListener('click', () => {
    colorTouched = true;
    pickedColor = item.dataset.color;
    overlay.querySelectorAll('.cp-item').forEach(option => option.classList.toggle('sel', option === item));
  }));
  overlay.querySelector('.cp-random').addEventListener('click', () => {
    colorTouched = true;
    const colors = overlay.querySelectorAll('.cp-item:not(.cp-random)');
    const chosen = colors[Math.floor(Math.random() * colors.length)];
    pickedColor = chosen.dataset.color;
    overlay.querySelectorAll('.cp-item').forEach(option => option.classList.toggle('sel', option === chosen));
  });
  overlay.querySelector('.af-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', event => { if (event.target === overlay) overlay.remove(); });

  overlay.querySelector('.af-save').addEventListener('click', () => {
    const id = idInput.value.trim();
    if (!id) {
      processButton.classList.add('af-invalid');
      processButton.focus();
      return;
    }
    const category = catInput.value;
    const meta = CAT_META[category];
    state.customApps = state.customApps.filter(app => app.id !== id && app.id !== (isEdit ? editing.id : ''));
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
  (isEdit ? nameInput : processButton).focus();
}
/* ---------------- 总渲染入口 ---------------- */
async function renderAll() {
  const token = ++renderGeneration;
  const ctx = snapshotRenderState();
  renderWhitelist();
  await Promise.all([
    renderOverview(ctx, token),
    renderTotal(ctx, token),
    renderApps(ctx, token),
    renderPie(ctx, token),
    renderTokens(ctx, token),
    renderHardware(ctx, token),
  ]);
}

/* ---------------- 启动 ---------------- */
document.addEventListener('DOMContentLoaded', async () => {
  Charts.init();
  buildRangeTabs();
  buildPeriodControls();
  buildTrendToggles();
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
    // 每个旧浏览器只合并迁移一次；完成标记后，SQLite 是唯一数据源。
    const saved = localStorage.getItem('simmer.whitelist') !== null;
    const migrated = localStorage.getItem('simmer.settingsBackendVersion') === '1';
    const localSettings = settingsPayload();
    const localMeaningful = saved && hasMeaningfulSettings(localSettings);
    let shouldPersistMigration = false;
    if (DB.serverSettings) {
      const selected = !migrated && localMeaningful
        ? mergeSettings(DB.serverSettings, localSettings)
        : DB.serverSettings;
      applySettings(selected);
      shouldPersistMigration = !migrated && localMeaningful;
    } else {
      const ids = new Set([...DB.apps.map(a => a.id), ...state.customApps.map(a => a.id)]);
      const stored = [...state.whitelist];
      const kept = stored.filter(id => ids.has(id));
      const migrate = stored.length > 0 && kept.length === 0;
      if (!saved || migrate) {
        state.whitelist = new Set();
        state.offApps = new Set();
      } else {
        state.whitelist = new Set(kept);
        state.offApps = new Set([...state.offApps].filter(id => ids.has(id)));
      }
      shouldPersistMigration = hasMeaningfulSettings(settingsPayload());
    }
    // 回写当前 origin 的缓存时同步尚未启用，不会触发多余请求。
    saveWhitelist(); saveAppsState();
    settingsSyncReady = true;
    if (shouldPersistMigration) {
      try {
        await DB.saveSettings(settingsPayload());
        localStorage.setItem('simmer.settingsBackendVersion', '1');
      } catch (e) {
        console.error('[simmer] 旧浏览器设置迁移失败，将在下次加载时重试：', e);
      }
    } else if (DB.serverSettings) {
      localStorage.setItem('simmer.settingsBackendVersion', '1');
    }
    document.querySelector('.topbar .sub').textContent = 'Jitang Simmer · ● 实时数据';
  } catch (e) {
    document.querySelector('.topbar .sub').textContent = 'Jitang Simmer · ○ 演示数据（后端未连接）';
    const banner = document.createElement('div');
    banner.className = 'fallback-banner';
    banner.textContent = '⚠ 后端未连接，当前显示的是演示数据——软件清单与真实统计不同。请确认 server 已启动后刷新。';
    document.querySelector('.main').prepend(banner);
  }

  document.addEventListener('click', () => closeCustomSelects());
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
  $('#wlNone').addEventListener('click', async () => {
    const count = state.whitelist.size;
    if (!count) return;
    const accepted = await confirmAction({
      title: '确认清空白名单？',
      message: `将停止统计并清空当前 ${count} 款启用软件。历史使用数据不会被删除，之后仍可重新添加。`,
      confirmText: '确认清空',
    });
    if (!accepted) return;
    state.whitelist.clear();
    saveWhitelist();
    renderAll();
  });
});
