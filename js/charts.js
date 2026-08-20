/* ============================================================
 * Simmer · 图表渲染引擎（纯手写 SVG / DOM，无第三方依赖）
 *  - heatmap : GitHub 风格点阵贡献图（悬停放大 + 光晕 + 跟随 tooltip）
 *  - line    : 平滑折线图（渐变面积 + 描边动画 + 悬停十字线）
 *  - hbars   : 横向柱状图（软件时长排行）
 *  - donut   : 环形占比图
 *  - vbars   : 竖向柱状图（星期分布）
 * ============================================================ */
const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const LEVELS = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'];
  let tip = null;
  let gradSeq = 0;

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
  const fmtMin = m => {
    const h = Math.floor(m / 60), mm = Math.round(m % 60);
    return h > 0 ? `${h} 小时 ${mm} 分钟` : `${mm} 分钟`;
  };

  /* ============================================================
   * GitHub 风格点阵图
   * days: [{date:Date, minutes:Number}]
   * opts.thresholds: [t1,t2,t3] 分档阈值（小时）
   * ============================================================ */
  function heatmap(container, days, opts = {}) {
    container.innerHTML = '';
    const cell = 11, gap = 3, rows = 7, left = 30, top = 18;
    const n = days.length;
    const firstDow = days[0].date.getDay();
    const cols = Math.ceil((firstDow + n) / rows);
    const W = left + cols * (cell + gap) + 8;
    const H = top + rows * (cell + gap) + 2;
    const maxH = Math.max(...days.map(d => d.minutes / 60), 0.1);
    // 默认按分位数分档（与 GitHub 贡献图一致），保证深绿/浅绿/空格自然分布
    let th = opts.thresholds;
    if (!th) {
      const sorted = days.map(d => d.minutes / 60).filter(v => v > 0).sort((a, b) => a - b);
      const q = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : maxH;
      th = [q(0.35), q(0.62), q(0.86)];
    }

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
        const hours = d.minutes / 60;
        let lv = 0;
        if (hours > 0) lv = 1;
        if (hours >= th[0]) lv = 2;
        if (hours >= th[1]) lv = 3;
        if (hours >= th[2]) lv = 4;
        const rect = el('rect', {
          x: left + c * (cell + gap), y: top + r * (cell + gap),
          width: cell, height: cell, rx: 2.5,
          fill: LEVELS[lv], class: 'hm-cell',
        });
        if (lv === 0) rect.setAttribute('stroke', '#21262d');
        rect.style.animationDelay = Math.min(c * 14 + r * 12, 1100) + 'ms';
        rect.addEventListener('mouseenter', e => {
          const tip = d.minutes == null
            ? `<span class="tip-date">${fmtDate(d.date)}</span><br><b>暂无数据</b> · 未来日期`
            : `<span class="tip-date">${fmtDate(d.date)}</span><br><b>${fmtMin(d.minutes)}</b> · 使用时长`;
          showTip(tip, e.clientX, e.clientY);
        });
        rect.addEventListener('mousemove', e => moveTip(e.clientX, e.clientY));
        rect.addEventListener('mouseleave', hideTip);
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
    const { labels, values, color, unit } = cfg;
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
        showTip(`<span class="tip-date">${labels[i]}</span><br><b>${values[i]}${unit}</b>`, e.clientX, e.clientY);
      } else {
        moveTip(e.clientX, e.clientY);
      }
    });
    overlay.addEventListener('mouseleave', () => { guide.style.opacity = 0; dot.style.opacity = 0; hideTip(); });
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
        <div class="hbar-icon">${r.icon}</div>
        <div class="hbar-name">${r.name}<small>${r.category || ''}</small></div>
        <div class="hbar-track"><div class="hbar-fill" style="background:${r.color};color:${r.color}"></div></div>
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
        stroke: r.color, 'stroke-width': 22,
        'stroke-dasharray': `${Math.max(frac * C - 2.5, 0.5)} ${C - frac * C + 2.5}`,
        'stroke-dashoffset': -acc * C,
        transform: `rotate(-90 ${cx} ${cy})`,
        class: 'pie-seg', style: `color:${r.color}`,
      });
      const pct = (frac * 100).toFixed(1);
      seg.addEventListener('mouseenter', e => showTip(`${r.icon} ${r.name}<br><b>${fmtMin(r.minutes)}</b> · ${pct}%`, e.clientX, e.clientY));
      seg.addEventListener('mousemove', e => moveTip(e.clientX, e.clientY));
      seg.addEventListener('mouseleave', hideTip);
      svg.appendChild(seg);
      acc += frac;

      const li = document.createElement('li');
      li.innerHTML = `<span class="pl-dot" style="background:${r.color}"></span>
        <span class="pl-name">${r.name}</span><span class="pl-pct">${pct}%</span>`;
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
    const { labels, values, color, unit } = cfg;
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
      rect.addEventListener('mouseenter', e => { rect.setAttribute('opacity', 1); showTip(`${labels[i]}<br><b>${v}${unit}</b>`, e.clientX, e.clientY); });
      rect.addEventListener('mousemove', e => showTip(tip.innerHTML, e.clientX, e.clientY));
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

  return { init, heatmap, line, hbars, donut, vbars, fmtMin, showTip, hideTip };
})();
