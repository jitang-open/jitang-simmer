/* ============================================================
 * Simmer · 实时数据源（对接 Simmer Server 后端）
 *  - 接口与 data.js（MockDB）同构：调用返回 Promise，
 *    app.js 统一用 await 接收（await 同步值同样成立，两库通用）
 *  - M1.5 已增加 AI Token 统计；硬件指标（metricDefs）仍为空，
 *    metricCurrent 返回 null，由界面提示 M2 支持
 *  - APP_META 为内置进程映射表（CAP-02 第一版）
 * ============================================================ */
const LiveDB = (() => {
  const BASE = location.port === '8788' ? location.origin : 'http://localhost:8788';

  const APP_META = {
    'Code.exe':            { name: 'Visual Studio Code', icon: '🧩', color: '#3b82f6', category: '开发工具' },
    'chrome.exe':          { name: 'Google Chrome',      icon: '🌐', color: '#f59e0b', category: '浏览器'   },
    'msedge.exe':          { name: 'Microsoft Edge',     icon: '🌐', color: '#0ea5e9', category: '浏览器'   },
    'firefox.exe':         { name: 'Firefox',            icon: '🦊', color: '#ff7139', category: '浏览器'   },
    'Spotify.exe':         { name: 'Spotify',            icon: '🎵', color: '#1db954', category: '音乐'     },
    'steam.exe':           { name: 'Steam',              icon: '🎮', color: '#66c0f4', category: '游戏'     },
    'steamwebhelper.exe':  { name: 'Steam',              icon: '🎮', color: '#66c0f4', category: '游戏'     },
    'WeChat.exe':          { name: '微信',               icon: '💬', color: '#07c160', category: '社交'     },
    'Photoshop.exe':       { name: 'Photoshop',          icon: '🎨', color: '#31a8ff', category: '设计'     },
    'QQ.exe':              { name: 'QQ',                 icon: '🐧', color: '#eb4d3d', category: '社交'     },
    'Unity.exe':           { name: 'Unity Editor',       icon: '🛠️', color: '#57a0d3', category: '开发工具' },
    'Figma.exe':           { name: 'Figma',              icon: '✏️', color: '#a259ff', category: '设计'     },
    'Notion.exe':          { name: 'Notion',             icon: '📝', color: '#e6e6e6', category: '效率'     },
    'Discord.exe':         { name: 'Discord',            icon: '🎧', color: '#5865f2', category: '社交'     },
    'Typora.exe':          { name: 'Typora',             icon: '📄', color: '#9aa4b2', category: '效率'     },
    'idea64.exe':          { name: 'IntelliJ IDEA',      icon: '☕', color: '#f97e50', category: '开发工具' },
    'pycharm64.exe':       { name: 'PyCharm',            icon: '🐍', color: '#4d9fde', category: '开发工具' },
    'devenv.exe':          { name: 'Visual Studio',      icon: '🧱', color: '#a259ff', category: '开发工具' },
    'WindowsTerminal.exe': { name: 'Windows Terminal',   icon: '⌨️', color: '#8b949e', category: '效率'     },
    'explorer.exe':        { name: '文件资源管理器',      icon: '📁', color: '#e3b341', category: '系统'     },
  };
  const meta = exe => APP_META[exe] ||
    { name: exe.replace(/\.exe$/i, ''), icon: '📦', color: '#8b949e', category: '其他' };

  async function j(path, options) {
    const r = await fetch(BASE + path, options);
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }
  const q = (device, appIds) =>
    `device=${encodeURIComponent(device || 'all')}` +
    (Array.isArray(appIds) ? `&apps=${encodeURIComponent(appIds.join(','))}` : '');
  const tokenQ = (device, range, filters = {}) => {
    let query = `device=${encodeURIComponent(device || 'all')}`;
    if (range) query += `&range=${encodeURIComponent(range)}`;
    if (filters.source) query += `&sources=${encodeURIComponent(filters.source)}`;
    if (filters.provider) query += `&providers=${encodeURIComponent(filters.provider)}`;
    if (filters.model) query += `&models=${encodeURIComponent(filters.model)}`;
    return query;
  };

  async function create() {
    const [devicesRaw, range, totals, settingsRaw] = await Promise.all([
      j('/api/devices'), j('/api/range'), j('/api/app-totals?range=total'), j('/api/settings'),
    ]);
    if (!devicesRaw.length) throw new Error('后端暂无设备数据');

    const nowYear = new Date().getFullYear();
    const yearList = [];
    const y0 = range.minDate ? +String(range.minDate).slice(0, 4) : nowYear;
    for (let y = Math.min(y0, nowYear); y <= nowYear; y++) yearList.push(y);

    return {
      live: true,
      yearList,
      apps: totals.map(r => ({ id: r.id, ...meta(r.id) })),
      devices: devicesRaw.map(d => ({ id: d.id, name: d.name, host: d.id, os: '' })),
      metricDefs: [],                                    // 硬件指标 M2 支持
      serverSettings: settingsRaw.settings,
      saveSettings: settings => j('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      }),
      yearSeries: (device, appIds, year) =>
        j(`/api/year?${q(device, appIds)}&year=${year}`)
          .then(rows => rows.map(r => ({ date: new Date(r.date), minutes: r.minutes }))),
      trendSeries: (device, appIds, range2) =>
        j(`/api/trend?${q(device, appIds)}&range=${range2}`),
      appTotals: (device, appIds, range2) =>
        j(`/api/app-totals?${q(device, appIds)}&range=${range2}`)
          .then(rows => rows.map(r => ({ id: r.id, minutes: r.minutes, ...meta(r.id) }))
            .sort((a, b) => b.minutes - a.minutes)),
      appWeekday: (device, appId) =>
        j(`/api/app-weekday?device=${encodeURIComponent(device || 'all')}&app=${encodeURIComponent(appId)}`),
      /* 全部已观测进程（不受白名单限制），供「添加软件」选择 */
      allApps: () =>
        j('/api/app-totals?range=total')
          .then(rows => rows.map(r => ({ id: r.id, minutes: r.minutes }))),
      metricSeries: async () => ({ labels: [], values: [] }),
      metricCurrent: async () => null,
      rangeTotalMinutes: async (device, appIds, range2) => {
        const rows = await j(`/api/app-totals?${q(device, appIds)}&range=${range2}`);
        return rows.reduce((s, r) => s + r.minutes, 0);
      },
      tokenDimensions: device =>
        j(`/api/ai-tokens/dimensions?device=${encodeURIComponent(device || 'all')}`),
      tokenSummary: (device, range2, filters) =>
        j(`/api/ai-tokens/summary?${tokenQ(device, range2, filters)}`),
      tokenTrend: (device, range2, filters) =>
        j(`/api/ai-tokens/trend?${tokenQ(device, range2, filters)}`),
      tokenYear: (device, year, filters) =>
        j(`/api/ai-tokens/year?${tokenQ(device, null, filters)}&year=${year}`)
          .then(rows => rows.map(row => ({
            date: new Date(row.date + 'T00:00:00'),
            tokens: row.tokens,
          }))),
      tokenBreakdown: (device, range2, filters, dimension) =>
        j(`/api/ai-tokens/breakdown?${tokenQ(device, range2, filters)}&dimension=${encodeURIComponent(dimension)}`),
      tokenSources: device =>
        j(`/api/ai-tokens/sources?device=${encodeURIComponent(device || 'all')}`),
    };
  }

  return { create, BASE };
})();
