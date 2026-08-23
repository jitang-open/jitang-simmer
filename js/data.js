/* ============================================================
 * Simmer · 假数据模块（Mock Data Layer）
 * - 使用固定种子的伪随机数，保证每次刷新页面数据一致
 * - 后端不可用时作为回退数据源（见 js/live.js 与 app.js 启动逻辑）
 * ============================================================ */
const MockDB = (() => {

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
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const DAY_MS = 86400000;
  // 数据起点 2022-01-01，覆盖到今天，支持按自然年选择点阵图
  const START = new Date(2022, 0, 1);
  const DAYS = Math.round((today.getTime() - START.getTime()) / DAY_MS) + 1;
  const yearList = [];
  for (let y = START.getFullYear(); y <= today.getFullYear(); y++) yearList.push(y);

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

  const dateOf = idx => new Date(START.getTime() + idx * DAY_MS);

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
        for (let i = 0; i < DAYS; i++) dArr[i] = +Math.min(95, start + i * 0.011 + rand() * 0.4).toFixed(1);
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
  const isoDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const parseDay = value => {
    const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!matched) return new Date(today);
    return new Date(+matched[1], +matched[2] - 1, +matched[3]);
  };
  const indexOfDay = date => Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()) - START) / DAY_MS);
  function selectedDays(range, anchor, startValue, endValue) {
    const selected = parseDay(anchor);
    let start = selected, end = selected;
    if (range === 'custom') {
      start = parseDay(startValue);
      end = parseDay(endValue);
      if (start > end) [start, end] = [end, start];
    } else if (range === 'weekly') {
      if (anchor) start = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() - (selected.getDay() + 6) % 7);
      else start = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate() - 6);
      end = anchor ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6) : selected;
    } else if (range === 'monthly') {
      start = new Date(selected.getFullYear(), selected.getMonth(), 1);
      end = new Date(selected.getFullYear(), selected.getMonth() + 1, 0);
    }
    const out = [];
    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) out.push(new Date(date));
    return out;
  }

  // 某日各设备各软件合计分钟
  function sumDay(deviceId, appIds, dayIdx) {
    if (dayIdx < 0 || dayIdx >= DAYS) return 0;
    let s = 0;
    selDevices(deviceId).forEach(d => appIds.forEach(a => { s += usage[d.id][a][dayIdx]; }));
    return s;
  }
  function sumHour(deviceId, appIds, h) {
    let s = 0;
    selDevices(deviceId).forEach(d => appIds.forEach(a => { s += hourlyUsage[d.id][a][h]; }));
    return s;
  }

  /* 某年点阵数据：[{date, minutes}]（完整自然年 1/1–12/31，未来日期 minutes 为 null） */
  function yearSeries(deviceId, appIds, year) {
    const out = [];
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);
    const baseIdx = Math.round((start.getTime() - START.getTime()) / DAY_MS);
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
      const d = new Date(t);
      const idx = baseIdx + Math.round((t - start.getTime()) / DAY_MS);
      out.push({
        date: d,
        minutes: d.getTime() > today.getTime() ? null : sumDay(deviceId, appIds, idx),
      });
    }
    return out;
  }

  /* 总时长趋势：按 range 返回 {labels, values(小时)} */
  function trendSeries(deviceId, appIds, range, anchor, startDate, endDate) {
    if (range === 'daily') {
      const labels = [], values = [];
      const selected = parseDay(anchor);
      const isToday = isoDay(selected) === isoDay(today);
      const total = sumDay(deviceId, appIds, indexOfDay(selected));
      const weights = Array.from({ length: 24 }, (_, hour) => dayCurve(hour));
      const weightTotal = weights.reduce((sum, value) => sum + value, 0);
      for (let h = 0; h < 24; h++) {
        labels.push(h + ':00');
        const minutes = (!anchor || isToday) ? sumHour(deviceId, appIds, h) : total * weights[h] / weightTotal;
        values.push(+(minutes / 60).toFixed(2));
      }
      return { labels, values, unit: 'h' };
    }
    if (range === 'weekly' || range === 'monthly' || range === 'custom') {
      const labels = [], values = [], wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      const days = selectedDays(range, anchor, startDate, endDate);
      if (range === 'custom' && days.length > 62) {
        const months = new Map();
        for (const d of days) {
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          months.set(key, (months.get(key) || 0) + sumDay(deviceId, appIds, indexOfDay(d)));
        }
        return {
          labels: [...months].map(([key]) => {
            const [year, month] = key.split('-');
            return `${year}/${+month}`;
          }),
          values: [...months.values()].map(minutes => +(minutes / 60).toFixed(2)),
          unit: 'h',
        };
      }
      for (const d of days) {
        labels.push(range === 'weekly'
          ? wd[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate()
          : (d.getMonth() + 1) + '/' + d.getDate());
        values.push(+(sumDay(deviceId, appIds, indexOfDay(d)) / 60).toFixed(2));
      }
      return { labels, values, unit: 'h' };
    }
    // total：近 12 个月（与"累计=全部历史"的柱状/饼图区分开）
    const map = new Map();
    for (let i = Math.max(0, DAYS - 365); i < DAYS; i++) {
      const d = dateOf(i);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      map.set(key, (map.get(key) || 0) + sumDay(deviceId, appIds, i));
    }
    const labels = [...map.keys()].map(k => (+k.split('-')[1]) + '月');
    const values = [...map.values()].map(v => +(v / 60).toFixed(1));
    return { labels, values, unit: 'h' };
  }

  /* 每个软件在指定范围的合计分钟（降序行数据） */
  function appTotals(deviceId, appIds, range, anchor, startDate, endDate) {
    const rows = apps.filter(a => appIds.includes(a.id)).map(a => {
      let minutes = 0;
      selDevices(deviceId).forEach(d => {
        if (range === 'daily') {
          if (anchor) minutes += usage[d.id][a.id][indexOfDay(parseDay(anchor))] || 0;
          else for (let h = 0; h < 24; h++) minutes += hourlyUsage[d.id][a.id][h];
        } else if (range === 'weekly' || range === 'monthly' || range === 'custom') {
          for (const selected of selectedDays(range, anchor, startDate, endDate)) {
            minutes += usage[d.id][a.id][indexOfDay(selected)] || 0;
          }
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
    for (let i = Math.max(0, DAYS - 365); i < DAYS; i++) {
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
    live: false,
    devices, apps, metricDefs, DAYS, yearList, dateOf, today,
    yearSeries, trendSeries, appTotals, appWeekday,
    metricSeries, metricCurrent, rangeTotalMinutes,
    updateDevice: (deviceId, changes) => {
      const device = devices.find(row => row.id === deviceId);
      if (!device) throw new Error('device_not_found');
      if (changes.name) device.name = String(changes.name);
      if (typeof changes.paused === 'boolean') device.paused = changes.paused;
      return { ...device };
    },
    allApps: async () => apps.map(a => ({ id: a.id, minutes: Math.round(a.base) })),
  };
})();
