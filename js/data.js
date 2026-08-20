/* ============================================================
 * Simmer · 假数据模块（Mock Data Layer）
 * - 使用固定种子的伪随机数，保证每次刷新页面数据一致
 * - 后续接入真实后端时，仅需替换本文件中的数据获取函数
 * ============================================================ */
const DB = (() => {

  /* ---------- 可复现随机数 ---------- */
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(20260820);

  /* ---------- 基础常量 ---------- */
  const DAYS = 365;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const DAY_MS = 86400000;

  const devices = [
    { id: 'desktop', name: '主力台式机', host: 'DESKTOP-K3', os: 'Windows 11 Pro', perf: 1.00, powerMin: 165, powerMax: 520 },
    { id: 'laptop',  name: '办公笔记本', host: 'X1-CARBON',  os: 'Windows 11',     perf: 0.62, powerMin: 14,  powerMax: 64  },
    { id: 'htpc',    name: '客厅主机',   host: 'HTPC-01',    os: 'Windows 11',     perf: 0.40, powerMin: 32,  powerMax: 118 },
  ];

  const apps = [
    { id: 'vscode',  name: 'Visual Studio Code', icon: '🧩', color: '#3b82f6', base: 215, category: '开发工具' },
    { id: 'chrome',  name: 'Google Chrome',      icon: '🌐', color: '#f59e0b', base: 188, category: '浏览器'   },
    { id: 'spotify', name: 'Spotify',            icon: '🎵', color: '#1db954', base: 152, category: '音乐'     },
    { id: 'steam',   name: 'Steam',              icon: '🎮', color: '#66c0f4', base: 118, category: '游戏'     },
    { id: 'wechat',  name: '微信',               icon: '💬', color: '#07c160', base: 96,  category: '社交'     },
    { id: 'ps',      name: 'Photoshop 2026',     icon: '🎨', color: '#31a8ff', base: 72,  category: '设计'     },
    { id: 'yuzu',    name: 'yuzu 模拟器',        icon: '🕹️', color: '#f7ce46', base: 56,  category: '游戏'     },
    { id: 'qq',      name: 'QQ',                 icon: '🐧', color: '#eb4d3d', base: 42,  category: '社交'     },
    { id: 'unity',   name: 'Unity Editor',       icon: '🛠️', color: '#57a0d3', base: 66,  category: '开发工具' },
    { id: 'figma',   name: 'Figma',              icon: '✏️', color: '#a259ff', base: 48,  category: '设计'     },
    { id: 'notion',  name: 'Notion',             icon: '📝', color: '#e6e6e6', base: 44,  category: '效率'     },
    { id: 'discord', name: 'Discord',            icon: '🎧', color: '#5865f2', base: 31,  category: '社交'     },
    { id: 'typora',  name: 'Typora',             icon: '📄', color: '#9aa4b2', base: 26,  category: '效率'     },
  ];

  const metricDefs = [
    { id: 'cpu',     name: 'CPU 占用',  unit: '%',  color: '#58a6ff' },
    { id: 'gpu',     name: 'GPU 占用',  unit: '%',  color: '#bc8cff' },
    { id: 'mem',     name: '内存占用',  unit: '%',  color: '#1db954' },
    { id: 'vram',    name: '显存占用',  unit: '%',  color: '#39d0d8' },
    { id: 'cpuTemp', name: 'CPU 温度',  unit: '°C', color: '#f778ba' },
    { id: 'gpuTemp', name: 'GPU 温度',  unit: '°C', color: '#ffa657' },
    { id: 'power',   name: '整机功耗',  unit: 'W',  color: '#e3b341' },
    { id: 'disk',    name: '硬盘占用',  unit: '%',  color: '#8b949e' },
  ];

  /* 一天内活跃曲线：凌晨低、上午/下午/晚上三个高峰 */
  function dayCurve(h) {
    const g = (c, w) => Math.exp(-((h - c) ** 2) / (2 * w * w));
    return 0.12 + g(10, 2.2) * 0.9 + g(15.5, 2.4) * 1.0 + g(21, 2.6) * 1.15;
  }

  const dateOf = idx => new Date(today.getTime() - (DAYS - 1 - idx) * DAY_MS);

  /* ---------- 软件使用时长（分钟） ---------- */
  // usage[deviceId][appId] = Float32Array(DAYS)
  const usage = {};
  devices.forEach(d => {
    usage[d.id] = {};
    // 每台设备约有 9% 的天数处于"未开机"状态（出差、休假等）
    const offDay = new Float32Array(DAYS);
    for (let i = 0; i < DAYS; i++) offDay[i] = rand() < 0.09 ? 0.04 : 1;
    apps.forEach(a => {
      const arr = new Float32Array(DAYS);
      const phase = rand() * Math.PI * 2;
      for (let i = 0; i < DAYS; i++) {
        const dow = dateOf(i).getDay();
        const weekend = (dow === 0 || dow === 6) ? 1.4 : 1.0;
        const seasonal = 0.7 + 0.45 * Math.sin(phase + i / 28);
        const noise = 0.12 + rand() * 1.85;
        let v = a.base * d.perf * weekend * seasonal * noise * offDay[i];
        if (rand() < 0.16) v *= 0.06;  // 偶尔几乎没开机
        if (rand() < 0.05) v *= 2.3;   // 偶尔爆肝
        arr[i] = Math.max(0, Math.round(v));
      }
      usage[d.id][a.id] = arr;
    });
  });

  // hourlyUsage[deviceId][appId] = Float32Array(24) —— 今天各小时分钟数
  const hourlyUsage = {};
  devices.forEach(d => {
    hourlyUsage[d.id] = {};
    apps.forEach(a => {
      const arr = new Float32Array(24);
      for (let h = 0; h < 24; h++) {
        arr[h] = Math.max(0, Math.round(a.base * d.perf * dayCurve(h) * (0.4 + rand() * 1.1) / 5.2));
      }
      hourlyUsage[d.id][a.id] = arr;
    });
  });

  /* ---------- 硬件指标 ---------- */
  // metricHourly[deviceId][metricId] = Float32Array(24)  今日逐小时
  // metricDaily [deviceId][metricId] = Float32Array(DAYS) 每日均值
  const metricHourly = {}, metricDaily = {};
  const metricBase = { cpu: 34, gpu: 26, mem: 54, vram: 37, cpuTemp: 56, gpuTemp: 53, disk: 73 };

  devices.forEach(d => {
    metricHourly[d.id] = {}; metricDaily[d.id] = {};
    metricDefs.forEach(m => {
      const hArr = new Float32Array(24);
      const dArr = new Float32Array(DAYS);
      if (m.id === 'power') {
        for (let h = 0; h < 24; h++) {
          hArr[h] = Math.round(d.powerMin + (d.powerMax - d.powerMin) * Math.min(1, dayCurve(h) * 0.62) * (0.75 + rand() * 0.4));
        }
        for (let i = 0; i < DAYS; i++) {
          dArr[i] = Math.round(d.powerMin + (d.powerMax - d.powerMin) * (0.3 + rand() * 0.45));
        }
      } else if (m.id === 'disk') {
        const start = 58 + rand() * 8;
        for (let i = 0; i < DAYS; i++) dArr[i] = +(start + i * 0.045 + rand() * 0.4).toFixed(1);
        for (let h = 0; h < 24; h++) hArr[h] = dArr[DAYS - 1];
      } else {
        const base = metricBase[m.id] * (m.id.includes('Temp') ? (0.9 + d.perf * 0.18) : 1);
        for (let h = 0; h < 24; h++) {
          const v = base * (0.55 + dayCurve(h) * 0.55) + (rand() - 0.5) * base * 0.24;
          hArr[h] = +Math.max(2, Math.min(98, v)).toFixed(1);
        }
        for (let i = 0; i < DAYS; i++) {
          const seasonal = 0.8 + 0.3 * Math.sin(i / 31 + rand());
          const v = base * seasonal * (0.8 + rand() * 0.45);
          dArr[i] = +Math.max(2, Math.min(98, v)).toFixed(1);
        }
      }
      metricHourly[d.id][m.id] = hArr;
      metricDaily[d.id][m.id] = dArr;
    });
  });

  /* ---------- 查询辅助 ---------- */
  const selDevices = deviceId => deviceId === 'all' ? devices : devices.filter(d => d.id === deviceId);

  // 某日各设备各软件合计分钟
  function sumDay(deviceId, appIds, dayIdx) {
    let s = 0;
    selDevices(deviceId).forEach(d => appIds.forEach(a => { s += usage[d.id][a][dayIdx]; }));
    return s;
  }
  function sumHour(deviceId, appIds, h) {
    let s = 0;
    selDevices(deviceId).forEach(d => appIds.forEach(a => { s += hourlyUsage[d.id][a][h]; }));
    return s;
  }

  /* 年度点阵数据：[{date, minutes}] */
  function yearSeries(deviceId, appIds) {
    const out = [];
    for (let i = 0; i < DAYS; i++) out.push({ date: dateOf(i), minutes: sumDay(deviceId, appIds, i) });
    return out;
  }

  /* 总时长趋势：按 range 返回 {labels, values(小时)} */
  function trendSeries(deviceId, appIds, range) {
    if (range === 'daily') {
      const labels = [], values = [];
      for (let h = 0; h < 24; h++) { labels.push(h + ':00'); values.push(+(sumHour(deviceId, appIds, h) / 60).toFixed(2)); }
      return { labels, values, unit: 'h' };
    }
    if (range === 'weekly') {
      const labels = [], values = [], wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      for (let i = DAYS - 7; i < DAYS; i++) {
        const d = dateOf(i);
        labels.push(wd[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate());
        values.push(+(sumDay(deviceId, appIds, i) / 60).toFixed(2));
      }
      return { labels, values, unit: 'h' };
    }
    // total：近 12 个月
    const map = new Map();
    for (let i = 0; i < DAYS; i++) {
      const d = dateOf(i);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      map.set(key, (map.get(key) || 0) + sumDay(deviceId, appIds, i));
    }
    const labels = [...map.keys()].map(k => (+k.split('-')[1]) + '月');
    const values = [...map.values()].map(v => +(v / 60).toFixed(1));
    return { labels, values, unit: 'h' };
  }

  /* 每个软件在指定范围的合计分钟（降序行数据） */
  function appTotals(deviceId, appIds, range) {
    const rows = apps.filter(a => appIds.includes(a.id)).map(a => {
      let minutes = 0;
      selDevices(deviceId).forEach(d => {
        if (range === 'daily') {
          for (let h = 0; h < 24; h++) minutes += hourlyUsage[d.id][a.id][h];
        } else if (range === 'weekly') {
          for (let i = DAYS - 7; i < DAYS; i++) minutes += usage[d.id][a.id][i];
        } else {
          for (let i = 0; i < DAYS; i++) minutes += usage[d.id][a.id][i];
        }
      });
      return { ...a, minutes };
    });
    return rows.sort((x, y) => y.minutes - x.minutes);
  }

  /* 单个软件：星期均值柱状图（分钟） */
  function appWeekday(deviceId, appId) {
    const sums = [0, 0, 0, 0, 0, 0, 0], cnt = [0, 0, 0, 0, 0, 0, 0];
    selDevices(deviceId).forEach(d => {
      for (let i = 0; i < DAYS; i++) {
        const w = dateOf(i).getDay();
        sums[w] += usage[d.id][appId][i]; cnt[w]++;
      }
    });
    const order = [1, 2, 3, 4, 5, 6, 0];
    return {
      labels: order.map(w => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][w]),
      values: order.map(w => Math.round(sums[w] / Math.max(1, cnt[w]))),
    };
  }

  /* 硬件指标序列：{labels, values, unit} */
  function metricSeries(deviceId, metricId, range) {
    const devs = selDevices(deviceId);
    const agg = (get) => {
      const vals = devs.map(get);
      return metricId === 'power'
        ? vals.reduce((a, b) => a + b, 0)                       // 功耗：多设备求和
        : vals.reduce((a, b) => a + b, 0) / vals.length;        // 其余：取平均
    };
    if (range === 'daily') {
      const labels = [], values = [];
      for (let h = 0; h < 24; h++) { labels.push(h + ':00'); values.push(+agg(d => metricHourly[d.id][metricId][h]).toFixed(1)); }
      return { labels, values };
    }
    if (range === 'weekly') {
      const labels = [], values = [], wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      for (let i = DAYS - 7; i < DAYS; i++) {
        const d = dateOf(i);
        labels.push(wd[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate());
        values.push(+agg(dd => metricDaily[dd.id][metricId][i]).toFixed(1));
      }
      return { labels, values };
    }
    const map = new Map();
    for (let i = 0; i < DAYS; i++) {
      const d = dateOf(i);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(agg(dd => metricDaily[dd.id][metricId][i]));
    }
    const labels = [...map.keys()].map(k => (+k.split('-')[1]) + '月');
    const values = [...map.values()].map(arr => +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1));
    return { labels, values };
  }

  /* 当前值（今日当前小时） */
  function metricCurrent(deviceId, metricId) {
    const h = now.getHours();
    const devs = selDevices(deviceId);
    const vals = devs.map(d => metricHourly[d.id][metricId][h]);
    const v = metricId === 'power' ? vals.reduce((a, b) => a + b, 0) : vals.reduce((a, b) => a + b, 0) / vals.length;
    return +v.toFixed(1);
  }

  /* 范围总分钟（白名单过滤后） */
  function rangeTotalMinutes(deviceId, appIds, range) {
    if (range === 'daily') { let s = 0; for (let h = 0; h < 24; h++) s += sumHour(deviceId, appIds, h); return s; }
    if (range === 'weekly') { let s = 0; for (let i = DAYS - 7; i < DAYS; i++) s += sumDay(deviceId, appIds, i); return s; }
    let s = 0; for (let i = 0; i < DAYS; i++) s += sumDay(deviceId, appIds, i); return s;
  }

  return {
    devices, apps, metricDefs, DAYS, dateOf, today,
    yearSeries, trendSeries, appTotals, appWeekday,
    metricSeries, metricCurrent, rangeTotalMinutes,
  };
})();
