/* ============================================================
 * Simmer · 图表渲染引擎（纯手写 SVG / DOM，无第三方依赖）
 *  - heatmap : GitHub 风格点阵贡献图（悬停放大 + 光晕 + 跟随 tooltip）
 *  - line    : 平滑折线图（渐变面积 + 描边动画 + 悬停十字线）
 *  - hbars   : 横向柱状图（软件时长排行）
 *  - donut   : 环形占比图
 *  - vbars   : 竖向柱状图（星期分布）
 * ============================================================ */
/*
 * 为每张点阵图独立建立比例色阶。
 * 使用最近秩 P95 作为满色上限，避免极少数异常高值压暗其余日期。
 */
function buildHeatmapScale(days, valueKey = 'minutes', hardCap = Infinity) {
  const values = days
    .map(day => day && day[valueKey])
    .filter(minutes => Number.isFinite(minutes) && minutes > 0)
    .sort((a, b) => a - b);
  const p95 = values.length
    ? values[Math.ceil(values.length * 0.95) - 1]
    : 0;
  const capMinutes = Number.isFinite(hardCap) && hardCap > 0 ? Math.min(p95, hardCap) : p95;
  const thresholds = capMinutes > 0
    ? Array.from({ length: 8 }, (_, index) => capMinutes * (index + 1) / 8)
    : [];

  function level(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0 || capMinutes <= 0) return 0;
    let result = 1;
    thresholds.forEach(threshold => { if (minutes >= threshold) result += 1; });
    return Math.min(result, 9);
  }

  return { capMinutes, thresholds, level };
}

const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  // 10 色（空 + 9 档）纯绿梯度，暗 → 亮（#03301a → #39d353 线性插值）
  const LEVELS = ['#161b22', '#03301a', '#0a4421', '#115928', '#176d30', '#1e8237', '#25963e', '#2cab45', '#32bf4c', '#39d353'];
  let tip = null;
  let gradSeq = 0;
  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
  const safeColor = value => /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#8b949e';

  /* ---------- 全局 tooltip ---------- */
  function init() {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    document.body.appendChild(tip);
  }
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.classList.add('show');
    moveTip(x, y);
  }
  function moveTip(x, y) {   // 仅重定位已显示的 tooltip，不重写内容
    if (!tip.classList.contains('show')) return;
    const r = tip.getBoundingClientRect();
    let left = x + 14, top = y + 14;
    if (left + r.width > window.innerWidth - 10) left = x - r.width - 12;
    if (top + r.height > window.innerHeight - 10) top = y - r.height - 12;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function hideTip() { tip.classList.remove('show'); }

  function el(tag, attrs) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  const fmtDate = d => `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${['周日','周一','周二','周三','周四','周五','周六'][d.getDay()]}`;
  const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fmtMin = m => {
    const h = Math.floor(m / 60), mm = Math.round(m % 60);
    return h > 0 ? `${h} 小时 ${mm} 分钟` : `${mm} 分钟`;
  };

  /* ============================================================
   * GitHub 风格点阵图
   * days: [{date:Date, minutes:Number}]（minutes 为 null 表示未来日期）
   * 分档：每张图按自身有效数据的 P95 独立建立比例色阶
   * ============================================================ */
  function heatmap(container, days, config = {}) {
    container.innerHTML = '';
    const valueKey = config.valueKey || 'minutes';
    const valueLabel = config.valueLabel || '使用时长';
    const formatValue = config.formatValue || fmtMin;
    const cell = 11, gap = 3, rows = 7, left = 30, top = 18;
    const n = days.length;
    const firstDow = days[0].date.getDay();
    const cols = Math.ceil((firstDow + n) / rows);
    const W = left + cols * (cell + gap) + 8;
    const H = top + rows * (cell + gap) + 2;
    const scale = buildHeatmapScale(days, valueKey, config.maxValue);

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'hm-svg' });
    svg.style.width = '100%';
    svg.style.minWidth = Math.min(W, 820) + 'px';

    // 星期标签（Mon / Wed / Fri，与 GitHub 一致）
    [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']].forEach(([r, t]) => {
      const tx = el('text', { x: 0, y: top + r * (cell + gap) + 9, class: 'hm-day' });
      tx.textContent = t;
      svg.appendChild(tx);
    });

    // 月份标签
    let lastMonth = -1;
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let c = 0; c < cols; c++) {
      const idx = c * 7 - firstDow;
      if (idx < 0 || idx >= n) continue;
      const m = days[idx].date.getMonth();
      if (m !== lastMonth) {
        const tx = el('text', { x: left + c * (cell + gap), y: 10, class: 'hm-month' });
        tx.textContent = MONTHS[m];
        svg.appendChild(tx);
        lastMonth = m;
      }
    }

    // 点阵格
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const idx = c * 7 + r - firstDow;
        if (idx < 0 || idx >= n) continue;
        const d = days[idx];
        const value = d[valueKey];
        const lv = scale.level(value);
        const rect = el('rect', {
          x: left + c * (cell + gap), y: top + r * (cell + gap),
          width: cell, height: cell, rx: 2.5,
          fill: LEVELS[lv], class: 'hm-cell',
        });
        const selected = config.selectedDate && isoDate(d.date) === config.selectedDate;
        if (selected) rect.classList.add('selected');
        if (lv === 0) rect.setAttribute('stroke', '#21262d');
        rect.style.animationDelay = Math.min(c * 14 + r * 12, 1100) + 'ms';
        rect.addEventListener('mouseenter', e => {
          const tip = value == null
            ? `<span class="tip-date">${fmtDate(d.date)}</span><br><b>暂无数据</b> · 未来日期`
            : `<span class="tip-date">${fmtDate(d.date)}</span><br><b>${escapeHTML(formatValue(value))}</b> · ${escapeHTML(valueLabel)}`;
          showTip(tip, e.clientX, e.clientY);
        });
        rect.addEventListener('mousemove', e => moveTip(e.clientX, e.clientY));
        rect.addEventListener('mouseleave', hideTip);
        if (typeof config.onSelect === 'function' && value !== null) {
          rect.setAttribute('role', 'button');
          rect.setAttribute('tabindex', '0');
          rect.setAttribute('aria-label', `${fmtDate(d.date)}，${formatValue(value)}`);
          const select = () => config.onSelect({ ...d, date: new Date(d.date) });
          rect.addEventListener('click', select);
          rect.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); }
          });
        }
        svg.appendChild(rect);
      }
    }
    container.appendChild(svg);
  }

  /* ============================================================
   * 平滑折线图
   * cfg: {labels, values, color, unit, height}
   * ============================================================ */
  function line(container, cfg) {
    container.innerHTML = '';
    const { labels, values, unit } = cfg;
    const rawValues = Array.isArray(cfg.rawValues) ? cfg.rawValues : values;
    const color = safeColor(cfg.color);
    const W = 640, H = cfg.height || 180, P = { l: 38, r: 12, t: 14, b: 24 };
    const n = values.length;
    const max = Math.max(...values, 0.001) * 1.15;
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const X = i => P.l + (n === 1 ? iw / 2 : i * iw / (n - 1));
    const Y = v => P.t + ih - (v / max) * ih;
    const pts = values.map((v, i) => [X(i), Y(v)]);

    const gid = 'lg' + (++gradSeq);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
    svg.style.width = '100%';

    // 渐变定义
    const defs = el('defs', {});
    const grad = el('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(el('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.32 }));
    grad.appendChild(el('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0.01 }));
    defs.appendChild(grad);
    svg.appendChild(defs);

    // 网格 + Y 轴标签
    for (let g = 0; g <= 3; g++) {
      const yv = (max / 1.15) * (g / 3);
      const y = Y(yv * 1.15 / 1.15);
      svg.appendChild(el('line', { x1: P.l, x2: W - P.r, y1: y, y2: y, class: 'lc-grid' }));
      const tx = el('text', { x: P.l - 7, y: y + 3, 'text-anchor': 'end', class: 'lc-axis' });
      tx.textContent = yv >= 100 ? Math.round(yv) : +yv.toFixed(1);
      svg.appendChild(tx);
    }
    // X 轴标签（稀疏）
    const step = Math.ceil(n / 8);
    for (let i = 0; i < n; i += step) {
      const tx = el('text', { x: X(i), y: H - 7, 'text-anchor': 'middle', class: 'lc-axis' });
      tx.textContent = labels[i].length > 6 ? labels[i].slice(0, 6) : labels[i];
      svg.appendChild(tx);
    }

    // Catmull-Rom 平滑路径
    function smooth(p) {
      if (p.length < 3) return `M${p.map(q => q.join(',')).join(' L')}`;
      let d = `M${p[0][0]},${p[0][1]}`;
      for (let i = 0; i < p.length - 1; i++) {
        const p0 = p[Math.max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(p.length - 1, i + 2)];
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
        const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
      }
      return d;
    }
    const linePath = smooth(pts);

    // 面积
    const area = el('path', {
      d: linePath + ` L${pts[n - 1][0]},${P.t + ih} L${pts[0][0]},${P.t + ih} Z`,
      fill: `url(#${gid})`, class: 'lc-area',
    });
    svg.appendChild(area);
    // 主线
    svg.appendChild(el('path', { d: linePath, stroke: color, class: 'lc-line' }));

    // 悬停辅助
    const guide = el('line', { y1: P.t, y2: P.t + ih, class: 'lc-guide' });
    const dot = el('circle', { r: 4.5, fill: color, class: 'lc-dot', style: `color:${color}` });
    dot.setAttribute('stroke', '#0d1117'); dot.setAttribute('stroke-width', '2');
    svg.appendChild(guide); svg.appendChild(dot);

    const overlay = el('rect', { x: P.l, y: P.t, width: iw, height: ih, fill: 'transparent' });
    let lastIdx = -1;
    overlay.addEventListener('mousemove', e => {
      const rectBox = svg.getBoundingClientRect();
      const mx = (e.clientX - rectBox.left) * (W / rectBox.width);
      let i = Math.round((mx - P.l) / (iw / (n - 1 || 1)));
      i = Math.max(0, Math.min(n - 1, i));
      guide.setAttribute('x1', X(i)); guide.setAttribute('x2', X(i));
      guide.style.opacity = 1;
      dot.setAttribute('cx', X(i)); dot.setAttribute('cy', Y(values[i]));
      dot.style.opacity = 1;
      if (i !== lastIdx) {   // 仅在数据点变化时重建内容，移动时只重定位
        lastIdx = i;
        const displayed = typeof cfg.valueFormatter === 'function'
          ? cfg.valueFormatter(rawValues[i])
          : `${values[i]}${unit}`;
        showTip(`<span class="tip-date">${escapeHTML(labels[i])}</span><br><b>${escapeHTML(displayed)}</b>`, e.clientX, e.clientY);
      } else {
        moveTip(e.clientX, e.clientY);
      }
    });
    overlay.addEventListener('mouseleave', () => { guide.style.opacity = 0; dot.style.opacity = 0; hideTip(); });
    svg.appendChild(overlay);

    container.appendChild(svg);
  }

  /* ============================================================
   * 多序列折线图：同一横轴同时对比多个模型
   * cfg.series: [{id,label,color,values,rawValues}]
   * ============================================================ */
  function multiline(container, cfg) {
    container.innerHTML = '';
    const labels = Array.isArray(cfg.labels) ? cfg.labels : [];
    const series = (cfg.series || []).filter(item => Array.isArray(item.values));
    if (!labels.length || !series.length) {
      container.innerHTML = '<div class="token-rank-empty">当前范围暂无可绘制的模型趋势</div>';
      return;
    }

    const legend = document.createElement('div');
    legend.className = 'multi-line-legend';
    legend.innerHTML = series.map(item =>
      `<span title="${escapeHTML(item.label || item.id)}"><i style="background:${safeColor(item.color)}"></i>${escapeHTML(item.label || item.id)}</span>`
    ).join('');
    container.appendChild(legend);

    const W = 640, H = cfg.height || 190, P = { l: 42, r: 12, t: 14, b: 24 };
    const n = labels.length;
    const allValues = series.flatMap(item => item.values).map(Number).filter(Number.isFinite);
    const peak = Math.max(...allValues, 0.001);
    const max = peak * 1.15;
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const X = index => P.l + (n === 1 ? iw / 2 : index * iw / (n - 1));
    const Y = value => P.t + ih - ((Number(value) || 0) / max) * ih;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
    svg.style.width = '100%';

    for (let grid = 0; grid <= 3; grid++) {
      const value = peak * grid / 3;
      const y = Y(value);
      svg.appendChild(el('line', { x1: P.l, x2: W - P.r, y1: y, y2: y, class: 'lc-grid' }));
      const textNode = el('text', { x: P.l - 7, y: y + 3, 'text-anchor': 'end', class: 'lc-axis' });
      textNode.textContent = value >= 100 ? Math.round(value) : +value.toFixed(1);
      svg.appendChild(textNode);
    }
    const step = Math.ceil(n / 8);
    for (let index = 0; index < n; index += step) {
      const textNode = el('text', { x: X(index), y: H - 7, 'text-anchor': 'middle', class: 'lc-axis' });
      textNode.textContent = String(labels[index]).slice(0, 6);
      svg.appendChild(textNode);
    }

    const smooth = points => {
      if (points.length < 3) return `M${points.map(point => point.join(',')).join(' L')}`;
      let path = `M${points[0][0]},${points[0][1]}`;
      for (let index = 0; index < points.length - 1; index++) {
        const p0 = points[Math.max(0, index - 1)], p1 = points[index];
        const p2 = points[index + 1], p3 = points[Math.min(points.length - 1, index + 2)];
        const lowY = Math.min(p1[1], p2[1]), highY = Math.max(p1[1], p2[1]);
        const c1 = [
          p1[0] + (p2[0] - p0[0]) / 6,
          Math.max(lowY, Math.min(highY, p1[1] + (p2[1] - p0[1]) / 6)),
        ];
        const c2 = [
          p2[0] - (p3[0] - p1[0]) / 6,
          Math.max(lowY, Math.min(highY, p2[1] - (p3[1] - p1[1]) / 6)),
        ];
        path += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
      }
      return path;
    };

    series.forEach(item => {
      const points = labels.map((_, index) => [X(index), Y(item.values[index])]);
      svg.appendChild(el('path', {
        d: smooth(points), stroke: safeColor(item.color), fill: 'none', class: 'lc-line',
        'stroke-width': 2.2,
      }));
    });

    const guide = el('line', { y1: P.t, y2: P.t + ih, class: 'lc-guide' });
    svg.appendChild(guide);
    const dots = series.map(item => {
      const dot = el('circle', { r: 4, fill: safeColor(item.color), class: 'lc-dot' });
      dot.setAttribute('stroke', '#0d1117'); dot.setAttribute('stroke-width', '2');
      svg.appendChild(dot);
      return dot;
    });
    const overlay = el('rect', { x: P.l, y: P.t, width: iw, height: ih, fill: 'transparent' });
    let lastIndex = -1;
    overlay.addEventListener('mousemove', event => {
      const rectBox = svg.getBoundingClientRect();
      const mouseX = (event.clientX - rectBox.left) * (W / rectBox.width);
      let index = Math.round((mouseX - P.l) / (iw / (n - 1 || 1)));
      index = Math.max(0, Math.min(n - 1, index));
      guide.setAttribute('x1', X(index)); guide.setAttribute('x2', X(index)); guide.style.opacity = 1;
      dots.forEach((dot, seriesIndex) => {
        dot.setAttribute('cx', X(index)); dot.setAttribute('cy', Y(series[seriesIndex].values[index]));
        dot.style.opacity = 1;
      });
      if (index !== lastIndex) {
        lastIndex = index;
        const rows = series.map(item => {
          const raw = Array.isArray(item.rawValues) ? item.rawValues[index] : item.values[index];
          const formatted = typeof cfg.valueFormatter === 'function' ? cfg.valueFormatter(raw) : `${raw}${cfg.unit || ''}`;
          return `<span style="color:${safeColor(item.color)}">●</span> ${escapeHTML(item.label || item.id)}：<b>${escapeHTML(formatted)}</b>`;
        }).join('<br>');
        showTip(`<span class="tip-date">${escapeHTML(labels[index])}</span><br>${rows}`, event.clientX, event.clientY);
      } else moveTip(event.clientX, event.clientY);
    });
    overlay.addEventListener('mouseleave', () => {
      guide.style.opacity = 0;
      dots.forEach(dot => { dot.style.opacity = 0; });
      hideTip();
    });
    svg.appendChild(overlay);
    container.appendChild(svg);
  }

  /* ============================================================
   * 横向柱状图（软件时长排行）
   * rows: [{id,icon,name,category,color,minutes}]
   * ============================================================ */
  function hbars(container, rows, onRow) {
    container.innerHTML = '';
    const max = Math.max(...rows.map(r => r.minutes), 1);
    rows.forEach(r => {
      const row = document.createElement('div');
      row.className = 'hbar-row';
      row.innerHTML = `
        <div class="hbar-icon">${escapeHTML(r.icon)}</div>
        <div class="hbar-name">${escapeHTML(r.name)}<small>${escapeHTML(r.category || '')}</small></div>
        <div class="hbar-track"><div class="hbar-fill" style="background:${safeColor(r.color)};color:${safeColor(r.color)}"></div></div>
        <div class="hbar-val">${fmtMin(r.minutes)}</div>`;
      row.addEventListener('click', () => onRow(r, row));
      container.appendChild(row);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        row.querySelector('.hbar-fill').style.width = (r.minutes / max * 100).toFixed(1) + '%';
      }));
    });
  }

  /* ============================================================
   * 环形占比图
   * ============================================================ */
  function donut(container, legendEl, rows) {
    container.innerHTML = ''; legendEl.innerHTML = '';
    const total = rows.reduce((s, r) => s + r.minutes, 0) || 1;
    const R = 64, C = 2 * Math.PI * R, cx = 95, cy = 95;
    const svg = el('svg', { viewBox: '0 0 190 190' });
    svg.style.width = '190px'; svg.style.flexShrink = '0';

    let acc = 0;
    rows.forEach(r => {
      const frac = r.minutes / total;
      if (frac <= 0) return;
      const seg = el('circle', {
        cx, cy, r: R, fill: 'none',
        stroke: safeColor(r.color), 'stroke-width': 22,
        'stroke-dasharray': `${Math.max(frac * C - 2.5, 0.5)} ${C - frac * C + 2.5}`,
        'stroke-dashoffset': -acc * C,
        transform: `rotate(-90 ${cx} ${cy})`,
        class: 'pie-seg', style: `color:${safeColor(r.color)}`,
      });
      const pct = (frac * 100).toFixed(1);
      seg.addEventListener('mouseenter', e => showTip(`${escapeHTML(r.icon)} ${escapeHTML(r.name)}<br><b>${fmtMin(r.minutes)}</b> · ${pct}%`, e.clientX, e.clientY));
      seg.addEventListener('mousemove', e => moveTip(e.clientX, e.clientY));
      seg.addEventListener('mouseleave', hideTip);
      svg.appendChild(seg);
      acc += frac;

      const li = document.createElement('li');
      li.innerHTML = `<span class="pl-dot" style="background:${safeColor(r.color)}"></span>
        <span class="pl-name">${escapeHTML(r.name)}</span><span class="pl-pct">${pct}%</span>`;
      legendEl.appendChild(li);
    });

    const th = Math.floor(total / 60);
    const t1 = el('text', { x: cx, y: cy - 1, 'text-anchor': 'middle', class: 'pie-center-num' });
    t1.textContent = th >= 1000 ? (th / 1000).toFixed(1) + 'k' : th;
    const t2 = el('text', { x: cx, y: cy + 15, 'text-anchor': 'middle', class: 'pie-center-label' });
    t2.textContent = '总时长 · 小时';
    svg.appendChild(t1); svg.appendChild(t2);
    container.appendChild(svg);
  }

  /* ============================================================
   * 竖向柱状图（星期分布）
   * ============================================================ */
  function vbars(container, cfg) {
    container.innerHTML = '';
    const { labels, values, unit } = cfg;
    const color = safeColor(cfg.color);
    // 与折线图相同的 640×200 viewBox，保证并排时高度严格对齐
    const W = 640, H = 200, P = { l: 10, r: 10, t: 14, b: 26 };
    const n = values.length;
    const max = Math.max(...values, 1) * 1.12;
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const bw = iw / n * 0.5;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}` });
    svg.style.width = '100%';

    values.forEach((v, i) => {
      const x = P.l + iw / n * (i + 0.5) - bw / 2;
      const h = v / max * ih;
      const rect = el('rect', {
        x, y: P.t + ih - h, width: bw, height: Math.max(h, 2), rx: 3.5,
        fill: color, opacity: 0.9,
      });
      rect.style.transformBox = 'fill-box';
      rect.style.transformOrigin = 'bottom';
      rect.style.transition = 'transform .5s cubic-bezier(.22,.8,.35,1) ' + (i * 55) + 'ms, opacity .2s';
      rect.style.transform = 'scaleY(0)';
      rect.addEventListener('mouseenter', e => { rect.setAttribute('opacity', 1); showTip(`${escapeHTML(labels[i])}<br><b>${escapeHTML(v)}${escapeHTML(unit)}</b>`, e.clientX, e.clientY); });
      rect.addEventListener('mousemove', e => moveTip(e.clientX, e.clientY));
      rect.addEventListener('mouseleave', () => { rect.setAttribute('opacity', 0.9); hideTip(); });
      svg.appendChild(rect);
      const tx = el('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle', class: 'lc-axis' });
      tx.textContent = labels[i].slice(-1);
      svg.appendChild(tx);
    });
    container.appendChild(svg);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      svg.querySelectorAll('rect').forEach(r => { r.style.transform = 'scaleY(1)'; });
    }));
  }

  return { init, heatmap, line, multiline, hbars, donut, vbars, fmtMin, showTip, hideTip };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { buildHeatmapScale };
