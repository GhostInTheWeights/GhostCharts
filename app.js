'use strict';
/* Ghost Charts: TradingView-style chart, drawings, bar replay and simulated orders. */

const LWC = LightweightCharts;
const TF_ORDER = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];
const CHUNK = 5000;              // bars added to the chart window at a time
const HIT = 6;                   // px tolerance for hit testing
const COLORS = ['#2962ff', '#f23645', '#089981', '#ff9800', '#e040fb', '#d1d4dc'];

const S = {
  manifest: null, sym: null, tf: 'H1', stepTf: 'same', tz: 'local',
  cache: new Map(), loading: new Map(),
  winStart: 0, winEnd: 0, partial: null,
  replay: { on: false, selecting: false, T: null, timer: null, speed: 1000 },
  tool: 'cursor', magnet: false, drawings: [], sel: null, creating: null, drag: null, pick: null,
  mouse: null, acct: null, useSpread: true,
  ticket: { side: 'buy', type: 'market', sizeMode: 'lots' },
  plines: [], previewLines: [], extending: false,
};

/* ---------- utils ---------- */
const $ = id => document.getElementById(id);
function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
function upperBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; }
function lsGet(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } }
const symInfo = () => S.manifest.symbols[S.sym];
const dec = () => symInfo().decimals;
const fmtP = p => (p == null || isNaN(p)) ? '—' : Number(p).toFixed(dec());
const roundP = p => Math.round(p * 10 ** dec()) / 10 ** dec();
function fmtMoney(v) { const s = v < 0 ? '-' : (v > 0 ? '+' : ''); return s + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
const cls = v => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
function toast(msg) {
  let el = $('toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.style.opacity = 1; clearTimeout(el._t); el._t = setTimeout(() => el.style.opacity = 0, 2200);
}

/* ---------- time zones ---------- */
const fmtCache = {};
function tzParts(t) {
  const key = S.tz;
  if (!fmtCache[key]) fmtCache[key] = new Intl.DateTimeFormat('en-GB', {
    ...(key === 'local' ? {} : { timeZone: key }), year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const o = {}; for (const p of fmtCache[key].formatToParts(new Date(t * 1000))) o[p.type] = p.value;
  return o;
}
function fmtTime(t) { const p = tzParts(t); return `${p.weekday} ${p.day} ${p.month} '${p.year.slice(2)}  ${p.hour}:${p.minute}`; }
function tzOffsetAt(t) {
  const n = new Intl.DateTimeFormat('en-US', { ...(S.tz === 'local' ? {} : { timeZone: S.tz }), year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(t * 1000));
  const o = {}; for (const p of n) o[p.type] = +p.value;
  return Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute) / 1000 - Math.floor(t / 60) * 60;
}
function wallToUtc(str) { // 'YYYY-MM-DDTHH:MM' in the chosen zone -> unix seconds
  if (!str) return null;
  const [d, tm] = str.split('T'); const [Y, M, D] = d.split('-').map(Number); const [h, m] = (tm || '00:00').split(':').map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m) / 1000;
  let t = guess - tzOffsetAt(guess); t = guess - tzOffsetAt(t);
  return t;
}
function utcToWall(t) {
  const w = new Date((t + tzOffsetAt(t)) * 1000).toISOString();
  return w.slice(0, 16);
}

/* ---------- data ---------- */
async function ensure(tf, sym = S.sym) {
  const key = sym + '_' + tf;
  if (S.cache.has(key)) return S.cache.get(key);
  if (S.loading.has(key)) return S.loading.get(key);
  const info = S.manifest.symbols[sym].tfs[tf];
  const p = (async () => {
    showLoading(true);
    try {
      const buf = await (await fetch('data/' + info.file, { cache: 'no-cache' })).arrayBuffer();
      const n = buf.byteLength / 28, i32 = new Int32Array(buf), f32 = new Float32Array(buf);
      const d = { tf, sec: info.sec, n, t: new Int32Array(n), o: new Float32Array(n), h: new Float32Array(n),
        l: new Float32Array(n), c: new Float32Array(n), v: new Float32Array(n), s: new Float32Array(n) };
      for (let i = 0, k = 0; i < n; i++, k += 7) {
        d.t[i] = i32[k]; d.o[i] = f32[k + 1]; d.h[i] = f32[k + 2]; d.l[i] = f32[k + 3];
        d.c[i] = f32[k + 4]; d.v[i] = f32[k + 5]; d.s[i] = f32[k + 6];
      }
      S.cache.set(key, d);
      return d;
    } finally { S.loading.delete(key); showLoading(false); }
  })();
  S.loading.set(key, p);
  return p;
}
const cur = () => S.cache.get(S.sym + '_' + S.tf);
const hasTf = tf => !!symInfo().tfs[tf];
function baseTfName() {
  const st = stepTfName();
  return hasTf('M1') && (S.tf === 'M1' || st === 'M1') ? 'M1' : 'M5';
}
const base = () => S.cache.get(S.sym + '_' + baseTfName());
const stepTfName = () => S.stepTf === 'same' ? S.tf : S.stepTf;
function showLoading(on) { $('loading').classList.toggle('hidden', !on); }

/* ---------- chart ---------- */
let chart, candles, volume;
function initChart() {
  chart = LWC.createChart($('chart'), {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#131722' }, textColor: '#b2b5be', fontSize: 12,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif' },
    grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
    crosshair: { mode: LWC.CrosshairMode.Normal,
      vertLine: { color: '#758696', style: LWC.LineStyle.Dashed, labelBackgroundColor: '#2a2e39' },
      horzLine: { color: '#758696', style: LWC.LineStyle.Dashed, labelBackgroundColor: '#2a2e39' } },
    rightPriceScale: { borderColor: '#2a2e39', scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false, rightOffset: 12, barSpacing: 8,
      tickMarkFormatter: (t, type) => {
        const p = tzParts(t);
        if (type === 0) return p.year; if (type === 1) return p.month; if (type === 2) return String(+p.day);
        return `${p.hour}:${p.minute}`;
      } },
    localization: { timeFormatter: t => fmtTime(t) },
  });
  volume = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
  candles = chart.addCandlestickSeries({ upColor: '#089981', downColor: '#f23645', borderVisible: false,
    wickUpColor: '#089981', wickDownColor: '#f23645' });

  chart.subscribeCrosshairMove(p => updateLegend(p));
  chart.timeScale().subscribeVisibleLogicalRangeChange(r => {
    if (!r || S.extending || S.winStart <= 0 || r.from > 50) return;
    S.extending = true;
    const add = Math.min(S.winStart, CHUNK);
    S.winStart -= add;
    setChartData();
    chart.timeScale().setVisibleLogicalRange({ from: r.from + add, to: r.to + add });
    S.extending = false;
  });
}

function barAt(d, i) { return { time: d.t[i], open: d.o[i], high: d.h[i], low: d.l[i], close: d.c[i] }; }
function volAt(d, i) { return { time: d.t[i], value: d.v[i], color: d.c[i] >= d.o[i] ? 'rgba(8,153,129,.45)' : 'rgba(242,54,69,.45)' }; }
function aggregate(b, i0, i1, time) {
  let h = -Infinity, l = Infinity, v = 0;
  for (let i = i0; i < i1; i++) { if (b.h[i] > h) h = b.h[i]; if (b.l[i] < l) l = b.l[i]; v += b.v[i]; }
  return { time, open: b.o[i0], high: h, low: l, close: b.c[i1 - 1], volume: v };
}

// Which bars of the current timeframe are visible: all of them, or those closed by replay time T plus a forming bar.
function computeEnd() {
  const d = cur();
  if (!S.replay.on) return { end: d.n, partial: null };
  const T = S.replay.T;
  const end = upperBound(d.t, T - d.sec);
  let partial = null;
  if (end < d.n && d.t[end] < T) {
    const b = base();
    if (b === d) return { end, partial };
    const i0 = lowerBound(b.t, d.t[end]), i1 = lowerBound(b.t, T);
    if (i1 > i0) partial = aggregate(b, i0, i1, d.t[end]);
  }
  return { end, partial };
}

function setChartData() {
  const d = cur();
  const bars = [], vols = [];
  for (let i = S.winStart; i < S.winEnd; i++) { bars.push(barAt(d, i)); vols.push(volAt(d, i)); }
  if (S.partial) { bars.push(S.partial); vols.push(partialVol(S.partial)); }
  candles.setData(bars); volume.setData(vols);
  refreshMarkers();
}
const partialVol = p => ({ time: p.time, value: p.volume, color: p.close >= p.open ? 'rgba(8,153,129,.45)' : 'rgba(242,54,69,.45)' });

// Rebuild the chart for the current symbol/timeframe/replay time. focusTime: scroll so this time is visible.
async function fullRender(focusTime) {
  const d = await ensure(S.tf);
  if (S.replay.on) await ensure(baseTfName());
  const { end, partial } = computeEnd();
  S.winEnd = end; S.partial = partial;
  let focusIdx = focusTime != null ? Math.max(0, upperBound(d.t, focusTime) - 1) : end - 1;
  focusIdx = Math.min(focusIdx, Math.max(0, end - 1));
  S.winStart = Math.max(0, Math.min(end - CHUNK, focusIdx - CHUNK / 2));
  S.extending = true;
  setChartData();
  const len = S.winEnd - S.winStart + (partial ? 1 : 0);
  const fl = focusTime != null && !S.replay.on ? focusIdx - S.winStart : len - 1;
  chart.timeScale().setVisibleLogicalRange({ from: fl - 120, to: fl + 25 });
  S.extending = false;
  refreshPriceLines(); updateLegend(); updateTicketPrices();
}

// Push newly revealed bars to the chart without resetting the view.
function replayRefresh() {
  const d = cur();
  const { end, partial } = computeEnd();
  if (end < S.winEnd) return fullRender();
  for (let i = S.winEnd; i < end; i++) { candles.update(barAt(d, i)); volume.update(volAt(d, i)); }
  if (partial) { candles.update(partial); volume.update(partialVol(partial)); }
  S.winEnd = end; S.partial = partial;
}

function updateLegend(p) {
  const d = cur(); if (!d) return;
  let bar = p && p.time != null ? p.seriesData.get(candles) : null;
  if (!bar) bar = S.partial || (S.winEnd > 0 ? barAt(d, S.winEnd - 1) : null);
  if (!bar) return;
  const ch = bar.close - bar.open, c = ch >= 0 ? '#089981' : '#f23645';
  const v = x => `<span style="color:${c}">${fmtP(x)}</span>`;
  $('legend').innerHTML = `<span class="sym">${S.sym} · ${S.tf}</span>` +
    `<span class="k">O</span>${v(bar.open)}<span class="k">H</span>${v(bar.high)}<span class="k">L</span>${v(bar.low)}` +
    `<span class="k">C</span>${v(bar.close)} <span style="color:${c}">${ch >= 0 ? '+' : ''}${fmtP(ch)} (${(ch / bar.open * 100).toFixed(2)}%)</span>` +
    (S.replay.on && !S.replay.selecting ? `<span class="rp">REPLAY</span>` : '');
}

/* ---------- coordinates (time-anchored so drawings survive timeframe changes) ---------- */
function lastIdx() { return S.winEnd - 1 + (S.partial ? 1 : 0); }
function timeToLogical(t) {
  const d = cur(), li = lastIdx(); if (li < 0) return null;
  const lastT = d.t[li];
  if (t >= lastT + d.sec) return (li - S.winStart) + (t - lastT) / d.sec;
  const firstT = d.t[S.winStart];
  if (t < firstT) return (t - firstT) / d.sec;
  const i = upperBound(d.t, t) - 1;
  return (i - S.winStart) + Math.min(1, (t - d.t[i]) / d.sec);
}
function logicalToTime(L) {
  const d = cur(), li = lastIdx(), i = Math.round(L) + S.winStart;
  if (i > li) return d.t[li] + (i - li) * d.sec;
  if (i < 0) return d.t[0] + i * d.sec;
  return d.t[i];
}
const xOfTime = t => { const L = timeToLogical(t); return L == null ? null : chart.timeScale().logicalToCoordinate(L); };
const yOfPrice = p => candles.priceToCoordinate(p);
function paneSize() {
  const el = $('chartWrap');
  return { w: chart.timeScale().width(), h: el.clientHeight - chart.timeScale().height() };
}
function pointFromMouse(x, y, useMagnet = true) {
  const L = chart.timeScale().coordinateToLogical(x);
  if (L == null) return null;
  const t = logicalToTime(L);
  let p = candles.coordinateToPrice(y);
  if (S.magnet && useMagnet) {
    const d = cur(), i = Math.round(L) + S.winStart;
    let bar = null;
    if (i >= S.winStart && i < S.winEnd) bar = barAt(d, i); else if (S.partial && i === S.winEnd) bar = S.partial;
    if (bar) {
      let best = p, bd = Infinity;
      for (const v of [bar.open, bar.high, bar.low, bar.close]) { const dy = Math.abs(yOfPrice(v) - y); if (dy < bd) { bd = dy; best = v; } }
      p = best;
    }
  }
  return { t, p: roundP(p) };
}

/* ---------- overlay drawing ---------- */
const cv = $('overlay'), ctx = cv.getContext('2d');
function resizeOverlay() {
  const el = $('chartWrap'), dpr = window.devicePixelRatio || 1;
  cv.width = el.clientWidth * dpr; cv.height = el.clientHeight * dpr;
  cv.style.width = el.clientWidth + 'px'; cv.style.height = el.clientHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function shapeCoords(dr) {
  if (dr.type === 'hline') return { y: yOfPrice(dr.p1.p) };
  return { x1: xOfTime(dr.p1.t), y1: yOfPrice(dr.p1.p), x2: xOfTime(dr.p2.t), y2: yOfPrice(dr.p2.p) };
}
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }

function render() {
  requestAnimationFrame(render);
  if (!chart || !cur()) return;
  const W = cv.clientWidth, H = cv.clientHeight; ctx.clearRect(0, 0, W, H);
  const { w, h } = paneSize();
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();

  // closed trades: dotted entry -> exit
  for (const tr of S.acct.closed) {
    const x1 = xOfTime(tr.openTime), x2 = xOfTime(tr.closeTime), y1 = yOfPrice(tr.entry), y2 = yOfPrice(tr.exit);
    if ([x1, x2, y1, y2].some(v => v == null) || Math.max(x1, x2) < 0 || Math.min(x1, x2) > w) continue;
    ctx.strokeStyle = tr.pnl >= 0 ? '#089981' : '#f23645'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
  }

  const all = S.creating ? [...S.drawings, S.creating] : S.drawings;
  for (const dr of all) {
    const c = shapeCoords(dr), col = dr.color;
    ctx.strokeStyle = col; ctx.lineWidth = dr === S.sel ? 2 : 1.5;
    if (dr.type === 'hline') {
      if (c.y == null) continue;
      ctx.beginPath(); ctx.moveTo(0, c.y); ctx.lineTo(w, c.y); ctx.stroke();
      const txt = fmtP(dr.p1.p); ctx.font = '11px sans-serif';
      const tw = ctx.measureText(txt).width + 8;
      ctx.fillStyle = col; ctx.fillRect(w - tw - 4, c.y - 9, tw, 16); ctx.fillStyle = '#fff'; ctx.fillText(txt, w - tw, c.y + 3);
    } else {
      if ([c.x1, c.y1, c.x2, c.y2].some(v => v == null)) continue;
      if (dr.type === 'trend') { ctx.beginPath(); ctx.moveTo(c.x1, c.y1); ctx.lineTo(c.x2, c.y2); ctx.stroke(); }
      else {
        ctx.fillStyle = hexA(col, 0.18);
        const x = Math.min(c.x1, c.x2), y = Math.min(c.y1, c.y2), rw = Math.abs(c.x2 - c.x1), rh = Math.abs(c.y2 - c.y1);
        ctx.fillRect(x, y, rw, rh); ctx.strokeRect(x, y, rw, rh);
      }
    }
    if (dr === S.sel) for (const hd of handles(dr)) {
      ctx.fillStyle = '#131722'; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(hd.x, hd.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  // replay start picker: vertical line with dimmed future
  if (S.replay.selecting && S.mouse && S.mouse.x < w) {
    const L = Math.round(chart.timeScale().coordinateToLogical(S.mouse.x));
    const x = chart.timeScale().logicalToCoordinate(L) - 0.5 * chart.timeScale().options().barSpacing;
    ctx.fillStyle = 'rgba(41,98,255,.08)'; ctx.fillRect(x, 0, w - x, h);
    ctx.strokeStyle = '#2962ff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  ctx.restore();
}

function handles(dr) {
  const c = shapeCoords(dr);
  if (dr.type === 'trend') return [
    { x: c.x1, y: c.y1, apply: pt => { dr.p1 = pt; } }, { x: c.x2, y: c.y2, apply: pt => { dr.p2 = pt; } }];
  if (dr.type === 'rect') return [
    { x: c.x1, y: c.y1, apply: pt => { dr.p1 = pt; } },
    { x: c.x2, y: c.y2, apply: pt => { dr.p2 = pt; } },
    { x: c.x2, y: c.y1, apply: pt => { dr.p2 = { ...dr.p2, t: pt.t }; dr.p1 = { ...dr.p1, p: pt.p }; } },
    { x: c.x1, y: c.y2, apply: pt => { dr.p1 = { ...dr.p1, t: pt.t }; dr.p2 = { ...dr.p2, p: pt.p }; } }];
  return [];
}
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  let u = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; u = Math.max(0, Math.min(1, u));
  return Math.hypot(px - x1 - u * dx, py - y1 - u * dy);
}
function hitTest(x, y) {
  // order/position lines first
  for (const pl of S.plines) {
    if (!pl.drag) continue;
    const py = yOfPrice(pl.ref[pl.field]);
    if (py != null && Math.abs(py - y) <= HIT) return { kind: 'pline', pl };
  }
  if (S.sel) for (const hd of handles(S.sel)) if (Math.hypot(hd.x - x, hd.y - y) <= HIT + 2) return { kind: 'handle', dr: S.sel, hd };
  for (let i = S.drawings.length - 1; i >= 0; i--) {
    const dr = S.drawings[i], c = shapeCoords(dr);
    if (dr.type === 'hline') { if (c.y != null && Math.abs(c.y - y) <= HIT) return { kind: 'body', dr }; continue; }
    if ([c.x1, c.y1, c.x2, c.y2].some(v => v == null)) continue;
    if (dr.type === 'trend' && distSeg(x, y, c.x1, c.y1, c.x2, c.y2) <= HIT) return { kind: 'body', dr };
    if (dr.type === 'rect') {
      const x0 = Math.min(c.x1, c.x2) - HIT, x1 = Math.max(c.x1, c.x2) + HIT, y0 = Math.min(c.y1, c.y2) - HIT, y1 = Math.max(c.y1, c.y2) + HIT;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return { kind: 'body', dr };
    }
  }
  return null;
}

/* ---------- mouse ---------- */
function localXY(e) { const r = $('chartWrap').getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function inPane(p) { const { w, h } = paneSize(); return p.x >= 0 && p.x < w && p.y >= 0 && p.y < h; }
function captureChart(on) { chart.applyOptions({ handleScroll: !on, handleScale: !on }); S.captured = on; }

function onPointerDown(e) {
  if (e.button !== 0) return;
  const m = localXY(e); if (!inPane(m)) return;
  let handled = false;
  if (S.replay.selecting) {
    const L = Math.round(chart.timeScale().coordinateToLogical(m.x)), i = L + S.winStart, d = cur();
    if (i >= 0 && i < d.n) startReplay(d.t[Math.min(i, S.winEnd - 1 + (S.partial ? 1 : 0))]);
    handled = true;
  } else if (S.pick) {
    const pt = pointFromMouse(m.x, m.y); $(S.pick).value = pt.p;
    if (S.pick === 'tkSl') $('tkSlOn').checked = true;
    if (S.pick === 'tkTp') { $('tkTpOn').checked = true; $('tkRR').value = ''; }
    setPick(null); updateTicket(); handled = true;
  } else if (S.tool !== 'cursor') {
    const pt = pointFromMouse(m.x, m.y);
    if (S.tool === 'hline') { finishDrawing({ type: 'hline', p1: pt, color: COLORS[0] }); }
    else if (!S.creating) { S.creating = { type: S.tool, p1: pt, p2: pt, color: COLORS[0], down: m }; }
    else { if (pt) S.creating.p2 = pt; finishDrawing(S.creating); }
    handled = true;
  } else {
    const hit = hitTest(m.x, m.y);
    if (hit) {
      handled = true;
      if (hit.kind === 'pline') S.drag = { kind: 'pline', pl: hit.pl };
      else {
        select(hit.dr);
        if (hit.kind === 'handle') S.drag = { kind: 'handle', hd: hit.hd };
        else {
          const L0 = chart.timeScale().coordinateToLogical(m.x), p0 = candles.coordinateToPrice(m.y);
          S.drag = { kind: 'move', dr: hit.dr, L0, p0,
            orig: ['p1', 'p2'].filter(k => hit.dr[k]).map(k => ({ k, L: timeToLogical(hit.dr[k].t), p: hit.dr[k].p })) };
        }
      }
    } else select(null);
  }
  if (handled) { e.preventDefault(); e.stopPropagation(); captureChart(true); }
}
function onPointerMove(e) {
  const m = localXY(e); S.mouse = m;
  if (S.creating) { const pt = pointFromMouse(m.x, m.y); if (pt) S.creating.p2 = pt; return; }
  if (S.drag) {
    const dg = S.drag;
    if (dg.kind === 'pline') {
      const pl = dg.pl, p = roundP(candles.coordinateToPrice(m.y));
      pl.ref[pl.field] = p; pl.line.applyOptions({ price: p, title: pl.title() });
    } else if (dg.kind === 'handle') { const pt = pointFromMouse(m.x, m.y); if (pt) dg.hd.apply(pt); }
    else {
      const dL = Math.round(chart.timeScale().coordinateToLogical(m.x) - dg.L0), dP = candles.coordinateToPrice(m.y) - dg.p0;
      for (const o of dg.orig) dg.dr[o.k] = { t: logicalToTime(o.L + dL), p: roundP(o.p + dP) };
    }
    return;
  }
  const wrap = $('chartWrap');
  wrap.classList.remove('hov-move', 'hov-ns', 'hov-cross');
  if (!inPane(m)) return;
  if (S.tool !== 'cursor' || S.pick || S.replay.selecting) { wrap.classList.add('hov-cross'); return; }
  const hit = hitTest(m.x, m.y);
  if (hit) wrap.classList.add(hit.kind === 'pline' ? 'hov-ns' : 'hov-move');
}
function onPointerUp(e) {
  const m = localXY(e);
  if (S.creating && Math.hypot(m.x - S.creating.down.x, m.y - S.creating.down.y) > 6) finishDrawing(S.creating);
  if (S.drag) {
    if (S.drag.kind === 'pline') { refreshPriceLines(); renderTabs(); saveSession(); } else saveDrawings();
    S.drag = null;
  }
  if (S.captured && !S.creating) captureChart(false);
}
function finishDrawing(dr) {
  delete dr.down; S.creating = null;
  S.drawings.push(dr); select(dr); setTool('cursor'); saveDrawings();
  captureChart(false);
}
function select(dr) {
  S.sel = dr;
  const bar = $('drawBar');
  if (!dr) { bar.classList.add('hidden'); return; }
  bar.innerHTML = COLORS.map(c => `<div class="sw${c === dr.color ? ' active' : ''}" data-c="${c}" style="background:${c}"></div>`).join('') +
    `<button id="delDraw" title="Delete (Del)">🗑</button>`;
  bar.classList.remove('hidden');
}
function deleteSelected() { if (!S.sel) return; S.drawings = S.drawings.filter(d => d !== S.sel); select(null); saveDrawings(); }
function setTool(t) {
  S.tool = t; S.creating = null;
  document.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
}
function setPick(id) {
  S.pick = id;
  document.querySelectorAll('.pick').forEach(b => b.classList.toggle('armed', b.dataset.pick === id));
}

/* ---------- replay ---------- */
function openReplaySelect() {
  stopPlay();
  S.replay.selecting = true;
  const sess = lsGet('bt_sess_' + S.sym, null);
  $('rbContinueBtn').classList.toggle('hidden', !(sess && sess.T && !S.replay.on));
  if (sess && sess.T) $('rbContinueBtn').textContent = 'Continue at ' + fmtTime(sess.T);
  $('replayBar').classList.remove('hidden'); $('replayBar').classList.add('selecting');
  $('replayBtn').classList.add('active');
  if (!$('rbDate').value) { const d = cur(); $('rbDate').value = utcToWall(d.t[Math.max(0, d.n - 2000)]); }
}
async function startReplay(T) {
  if (S.replay.on && (S.acct.positions.length || S.acct.orders.length)) {
    if (!confirm('Jumping will close open positions at the current price and cancel pending orders. Continue?')) return;
    for (const p of [...S.acct.positions]) closePosition(p, exitPrice(p), S.replay.T, 'Jump');
    S.acct.orders = [];
  }
  const d = cur();
  T = d.t[Math.max(0, upperBound(d.t, T) - 1)];  // align to the start of a chart bar
  S.replay = { ...S.replay, on: true, selecting: false, T };
  $('replayBar').classList.remove('selecting', 'hidden');
  $('replayBtn').classList.add('active');
  await fullRender();
  afterReplayChange();
}
function exitReplay() {
  stopPlay();
  S.replay.on = false; S.replay.selecting = false;
  $('replayBar').classList.add('hidden'); $('replayBtn').classList.remove('active');
  saveSession(); fullRender(); afterReplayChange();
}
function cancelSelecting() {
  S.replay.selecting = false;
  if (S.replay.on) $('replayBar').classList.remove('selecting');
  else { $('replayBar').classList.add('hidden'); $('replayBtn').classList.remove('active'); }
}
async function step() {
  if (!S.replay.on || S.replay.selecting) return false;
  const sd = await ensure(stepTfName()), b = await ensure(baseTfName());
  const T = S.replay.T;
  const i = lowerBound(sd.t, T) - 1;
  let target;
  if (i >= 0 && sd.t[i] + sd.sec > T) target = sd.t[i] + sd.sec;
  else if (i + 1 < sd.n) target = sd.t[i + 1] + sd.sec;
  else { stopPlay(); toast('End of data'); return false; }
  const j0 = lowerBound(b.t, T), j1 = lowerBound(b.t, target);
  let changed = false;
  for (let j = j0; j < j1; j++) changed = processBar(b, j) || changed;
  S.replay.T = target;
  replayRefresh();
  if (changed) { refreshMarkers(); refreshPriceLines(); }
  afterReplayChange(changed);
  return true;
}
function afterReplayChange(full = true) {
  $('rbTime').textContent = S.replay.on ? fmtTime(S.replay.T) : '';
  updateLegend(); updateTicketPrices(); updateTicket();
  $('ticketOff').classList.toggle('hidden', S.replay.on); $('ticketOn').classList.toggle('hidden', !S.replay.on);
  if (full) renderTabs(); else renderLive();
  saveSessionSoon();
}
function togglePlay() { S.replay.timer ? stopPlay() : startPlay(); }
function startPlay() {
  if (!S.replay.on || S.replay.selecting) return;
  let busy = false;
  S.replay.timer = setInterval(async () => { if (busy) return; busy = true; try { await step(); } finally { busy = false; } }, S.replay.speed);
  $('playIcon').innerHTML = '<path fill="currentColor" d="M6 4h4v16H6zM14 4h4v16h-4z"/>';
}
function stopPlay() {
  clearInterval(S.replay.timer); S.replay.timer = null;
  $('playIcon').innerHTML = '<path fill="currentColor" d="M7 4l13 8-13 8z"/>';
}

/* ---------- trading simulation ---------- */
function newAcct(balance0 = 10000) { return { balance0, nextId: 1, orders: [], positions: [], closed: [] }; }
const balance = () => S.acct.balance0 + S.acct.closed.reduce((a, t) => a + t.pnl, 0);
const contract = () => symInfo().contract;
function lastBaseIdx() { const b = base(); return b ? lowerBound(b.t, S.replay.T) - 1 : -1; }
function quote() {
  const b = base(), j = lastBaseIdx(); if (!b || j < 0) return null;
  const bid = b.c[j], sp = S.useSpread ? b.s[j] : 0;
  return { bid, ask: bid + sp, spread: sp };
}
const exitPrice = p => { const q = quote(); return p.side === 'buy' ? q.bid : q.ask; };
const floating = p => (exitPrice(p) - p.entry) * (p.side === 'buy' ? 1 : -1) * p.qty * contract();

function openPosition(o, price, t) {
  const p = { id: o.id, side: o.side, qty: o.qty, entry: price, sl: o.sl, tp: o.tp, initSl: o.sl, openTime: t, justOpened: true };
  S.acct.positions.push(p); return p;
}
function closePosition(p, price, t, reason) {
  const dir = p.side === 'buy' ? 1 : -1;
  const pnl = (price - p.entry) * dir * p.qty * contract();
  const risk = p.initSl != null ? Math.abs(p.entry - p.initSl) * p.qty * contract() : 0;
  S.acct.positions = S.acct.positions.filter(x => x !== p);
  S.acct.closed.push({ id: p.id, side: p.side, qty: p.qty, entry: p.entry, sl: p.initSl, tp: p.tp, openTime: p.openTime,
    exit: price, closeTime: t, reason, pnl, r: risk > 0 ? pnl / risk : null });
}
// Simulate one base bar. Longs fill/exit on bid+spread / bid, shorts the other way round.
function processBar(b, j) {
  const o = b.o[j], h = b.h[j], l = b.l[j], s = S.useSpread ? b.s[j] : 0, t = b.t[j];
  let changed = false;
  for (const ord of [...S.acct.orders]) {
    let fill = null; const px = ord.price;
    if (ord.side === 'buy') {
      const ao = o + s, ah = h + s, al = l + s;
      if (ord.type === 'limit') fill = ao <= px ? ao : al <= px ? px : null;
      else fill = ao >= px ? ao : ah >= px ? px : null;
    } else {
      if (ord.type === 'limit') fill = o >= px ? o : h >= px ? px : null;
      else fill = o <= px ? o : l <= px ? px : null;
    }
    if (fill != null) { S.acct.orders = S.acct.orders.filter(x => x !== ord); openPosition(ord, fill, t); changed = true; }
  }
  for (const p of [...S.acct.positions]) {
    const fresh = p.justOpened; p.justOpened = false;
    let exit = null, reason = null;
    if (p.side === 'buy') {
      if (!fresh && p.sl != null && o <= p.sl) { exit = o; reason = 'SL'; }
      else if (!fresh && p.tp != null && o >= p.tp) { exit = o; reason = 'TP'; }
      else if (p.sl != null && l <= p.sl) { exit = p.sl; reason = 'SL'; }
      else if (p.tp != null && h >= p.tp) { exit = p.tp; reason = 'TP'; }
    } else {
      const ao = o + s, ah = h + s, al = l + s;
      if (!fresh && p.sl != null && ao >= p.sl) { exit = ao; reason = 'SL'; }
      else if (!fresh && p.tp != null && ao <= p.tp) { exit = ao; reason = 'TP'; }
      else if (p.sl != null && ah >= p.sl) { exit = p.sl; reason = 'SL'; }
      else if (p.tp != null && al <= p.tp) { exit = p.tp; reason = 'TP'; }
    }
    if (exit != null) { closePosition(p, exit, t, reason); changed = true; }
  }
  return changed;
}

/* ---------- order ticket ---------- */
function ticketEntry() {
  const q = quote(); if (!q) return null;
  if (S.ticket.type === 'market') return S.ticket.side === 'buy' ? q.ask : q.bid;
  const v = parseFloat($('tkPrice').value); return isNaN(v) ? null : v;
}
function ticketValues() {
  const entry = ticketEntry();
  const sl = $('tkSlOn').checked ? parseFloat($('tkSl').value) : NaN;
  let tp = $('tkTpOn').checked ? parseFloat($('tkTp').value) : NaN;
  const rr = parseFloat($('tkRR').value), dir = S.ticket.side === 'buy' ? 1 : -1;
  if (!isNaN(rr) && rr > 0 && !isNaN(sl) && entry != null) tp = roundP(entry + dir * Math.abs(entry - sl) * rr);
  let qty = parseFloat($('tkSize').value);
  if (S.ticket.sizeMode === 'risk') {
    qty = (!isNaN(sl) && entry != null && Math.abs(entry - sl) > 0)
      ? Math.floor(balance() * qty / 100 / (Math.abs(entry - sl) * contract()) * 100) / 100 : NaN;
  }
  return { entry, sl: isNaN(sl) ? null : sl, tp: isNaN(tp) ? null : tp, qty, dir };
}
function updateTicket() {
  if (!S.replay.on) return;
  const tk = S.ticket, v = ticketValues();
  $('sellSide').classList.toggle('active', tk.side === 'sell'); $('buySide').classList.toggle('active', tk.side === 'buy');
  document.querySelectorAll('#typeSeg button').forEach(b => b.classList.toggle('active', b.dataset.type === tk.type));
  document.querySelectorAll('#sizeSeg button').forEach(b => b.classList.toggle('active', b.dataset.mode === tk.sizeMode));
  $('tkPrice').disabled = tk.type === 'market'; $('tkSl').disabled = !$('tkSlOn').checked; $('tkTp').disabled = !$('tkTpOn').checked;
  if (!isNaN(parseFloat($('tkRR').value)) && v.tp != null) { $('tkTpOn').checked = true; $('tkTp').disabled = false; $('tkTp').value = v.tp; }
  const cs = contract();
  $('sizeHint').textContent = isNaN(v.qty) ? (tk.sizeMode === 'risk' ? 'Set a stop loss to size by risk' : '')
    : `${v.qty.toFixed(2)} lots` + (tk.sizeMode === 'risk' ? ` · risk ${fmtMoney(-balance() * parseFloat($('tkSize').value) / 100)}` : '');
  $('slHint').textContent = v.sl != null && v.entry != null && !isNaN(v.qty)
    ? `${fmtP(Math.abs(v.entry - v.sl))} away · ${fmtMoney(-Math.abs(v.entry - v.sl) * v.qty * cs)}` : '';
  $('tpHint').textContent = v.tp != null && v.entry != null && !isNaN(v.qty)
    ? `${fmtP(Math.abs(v.tp - v.entry))} away · ${fmtMoney(Math.abs(v.tp - v.entry) * v.qty * cs)}` +
      (v.sl != null ? ` · ${(Math.abs(v.tp - v.entry) / Math.abs(v.entry - v.sl)).toFixed(2)}R` : '') : '';
  const lbl = tk.side === 'buy' ? 'Buy' : 'Sell';
  $('placeBtn').className = 'place ' + tk.side;
  $('placeBtn').textContent = `${lbl} ${isNaN(v.qty) ? '' : v.qty.toFixed(2)} ${tk.type === 'market' ? 'MKT' : tk.type.toUpperCase() + ' @ ' + fmtP(v.entry)}`;
  refreshPreview(v);
}
function updateTicketPrices() {
  $('tkSym').textContent = S.sym;
  const q = S.replay.on ? quote() : null;
  $('bidPx').textContent = q ? fmtP(q.bid) : '—'; $('askPx').textContent = q ? fmtP(q.ask) : '—';
  $('spreadPx').textContent = q ? fmtP(q.spread) : '';
}
function placeOrder() {
  const v = ticketValues(), tk = S.ticket;
  if (v.entry == null) return toast('Enter an order price');
  if (isNaN(v.qty) || v.qty <= 0) return toast('Invalid size');
  if (v.sl != null && (v.sl - v.entry) * v.dir >= 0) return toast('Stop loss is on the wrong side of entry');
  if (v.tp != null && (v.tp - v.entry) * v.dir <= 0) return toast('Take profit is on the wrong side of entry');
  const ord = { id: S.acct.nextId++, side: tk.side, type: tk.type, price: roundP(v.entry), qty: v.qty, sl: v.sl, tp: v.tp, time: S.replay.T };
  if (tk.type === 'market') { const p = openPosition(ord, v.entry, S.replay.T); p.justOpened = false; toast(`${tk.side.toUpperCase()} ${v.qty} filled @ ${fmtP(v.entry)}`); }
  else { S.acct.orders.push(ord); toast(`${tk.side.toUpperCase()} ${tk.type.toUpperCase()} placed @ ${fmtP(ord.price)}`); }
  refreshPriceLines(); refreshMarkers(); renderTabs(); saveSession();
}

/* ---------- price lines on the chart ---------- */
function refreshPriceLines() {
  for (const pl of S.plines) candles.removePriceLine(pl.line);
  S.plines = [];
  if (!S.replay.on) return;
  const add = (ref, field, color, style, titleFn, drag) => {
    const line = candles.createPriceLine({ price: ref[field], color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: titleFn() });
    S.plines.push({ line, ref, field, title: titleFn, drag });
  };
  const cs = contract();
  for (const p of S.acct.positions) {
    const dir = p.side === 'buy' ? 1 : -1;
    add(p, 'entry', p.side === 'buy' ? '#2962ff' : '#f23645', LWC.LineStyle.Solid, () => `${p.side.toUpperCase()} ${p.qty}`, false);
    if (p.sl != null) add(p, 'sl', '#f23645', LWC.LineStyle.Dashed, () => `SL ${fmtMoney((p.sl - p.entry) * dir * p.qty * cs)}`, true);
    if (p.tp != null) add(p, 'tp', '#089981', LWC.LineStyle.Dashed, () => `TP ${fmtMoney((p.tp - p.entry) * dir * p.qty * cs)}`, true);
  }
  for (const o of S.acct.orders) {
    add(o, 'price', o.side === 'buy' ? '#2962ff' : '#f23645', LWC.LineStyle.Dotted, () => `${o.side.toUpperCase()} ${o.type.toUpperCase()} ${o.qty}`, true);
    if (o.sl != null) add(o, 'sl', '#f23645', LWC.LineStyle.Dotted, () => 'SL', true);
    if (o.tp != null) add(o, 'tp', '#089981', LWC.LineStyle.Dotted, () => 'TP', true);
  }
}
function refreshPreview(v) {
  for (const l of S.previewLines) candles.removePriceLine(l);
  S.previewLines = [];
  if (!S.replay.on || !v) return;
  const mk = (price, title, color) => S.previewLines.push(candles.createPriceLine({ price, title, color, lineWidth: 1, lineStyle: LWC.LineStyle.SparseDotted, axisLabelVisible: false }));
  if (S.ticket.type !== 'market' && v.entry != null) mk(v.entry, 'entry', '#787b86');
  if (v.sl != null) mk(v.sl, 'new SL', '#b2465a');
  if (v.tp != null) mk(v.tp, 'new TP', '#2c8a73');
}
function refreshMarkers() {
  const d = cur(); if (!d || S.winEnd === 0) { candles.setMarkers([]); return; }
  const first = d.t[S.winStart], li = lastIdx();
  const barOf = t => { const i = upperBound(d.t, t) - 1; return i >= S.winStart && i <= li ? d.t[i] : null; };
  const ms = [];
  const all = [...S.acct.closed, ...S.acct.positions];
  for (const tr of all) {
    if (tr.openTime < first) continue;
    const t1 = barOf(tr.openTime);
    if (t1 != null) ms.push({ time: t1, position: tr.side === 'buy' ? 'belowBar' : 'aboveBar', color: tr.side === 'buy' ? '#2962ff' : '#f23645',
      shape: tr.side === 'buy' ? 'arrowUp' : 'arrowDown', text: `${tr.side === 'buy' ? 'B' : 'S'} ${tr.qty}` });
    if (tr.closeTime != null) {
      const t2 = barOf(tr.closeTime);
      if (t2 != null) ms.push({ time: t2, position: tr.side === 'buy' ? 'aboveBar' : 'belowBar', color: tr.pnl >= 0 ? '#089981' : '#f23645',
        shape: 'circle', text: fmtMoney(tr.pnl) });
    }
  }
  ms.sort((a, b) => a.time - b.time);
  candles.setMarkers(ms);
}

/* ---------- bottom tabs ---------- */
let activeTab = 'positions';
function renderLive() { // cheap refresh while playing: P&L figures only
  updateAcctLine();
  if (activeTab === 'positions' && S.acct.positions.length) renderTabs();
  for (const pl of S.plines) pl.line.applyOptions({ title: pl.title() });
}
function updateAcctLine() {
  const fl = S.replay.on ? S.acct.positions.reduce((a, p) => a + floating(p), 0) : 0, bal = balance();
  $('acctLine').innerHTML = `Balance <b>${fmtMoney(bal).replace('+', '')}</b> · Equity <b>${fmtMoney(bal + fl).replace('+', '')}</b> · Open P&L <b class="${cls(fl)}">${fmtMoney(fl)}</b>`;
  $('posCount').textContent = S.acct.positions.length || ''; $('ordCount').textContent = S.acct.orders.length || '';
  $('histCount').textContent = S.acct.closed.length || '';
}
function renderTabs() {
  updateAcctLine();
  const A = S.acct, el = $('tabBody');
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));
  const inp = (kind, id, field, val) => `<input type="number" step="any" data-k="${kind}" data-id="${id}" data-f="${field}" value="${val == null ? '' : val}" placeholder="—">`;
  if (activeTab === 'positions') {
    if (!A.positions.length) { el.innerHTML = '<div class="empty">No open positions</div>'; return; }
    el.innerHTML = `<table><tr><th>Side</th><th>Qty</th><th>Opened</th><th>Entry</th><th>Stop loss</th><th>Take profit</th><th>Price</th><th>P&L</th><th></th></tr>` +
      A.positions.map(p => { const f = S.replay.on ? floating(p) : 0; return `<tr><td class="${p.side === 'buy' ? 'pos' : 'neg'}">${p.side.toUpperCase()}</td><td>${p.qty}</td>
      <td>${fmtTime(p.openTime)}</td><td>${fmtP(p.entry)}</td><td>${inp('pos', p.id, 'sl', p.sl)}</td><td>${inp('pos', p.id, 'tp', p.tp)}</td>
      <td>${S.replay.on ? fmtP(exitPrice(p)) : '—'}</td><td class="${cls(f)}">${fmtMoney(f)}</td>
      <td><button class="mini-btn" data-close="${p.id}">Close</button></td></tr>`; }).join('') + '</table>';
  } else if (activeTab === 'orders') {
    if (!A.orders.length) { el.innerHTML = '<div class="empty">No pending orders</div>'; return; }
    el.innerHTML = `<table><tr><th>Side</th><th>Type</th><th>Qty</th><th>Placed</th><th>Price</th><th>Stop loss</th><th>Take profit</th><th></th></tr>` +
      A.orders.map(o => `<tr><td class="${o.side === 'buy' ? 'pos' : 'neg'}">${o.side.toUpperCase()}</td><td>${o.type.toUpperCase()}</td><td>${o.qty}</td>
      <td>${fmtTime(o.time)}</td><td>${inp('ord', o.id, 'price', o.price)}</td><td>${inp('ord', o.id, 'sl', o.sl)}</td><td>${inp('ord', o.id, 'tp', o.tp)}</td>
      <td><button class="mini-btn" data-cancel="${o.id}">Cancel</button></td></tr>`).join('') + '</table>';
  } else if (activeTab === 'history') {
    if (!A.closed.length) { el.innerHTML = '<div class="empty">No closed trades yet</div>'; return; }
    el.innerHTML = `<table><tr><th>#</th><th>Side</th><th>Qty</th><th>Opened</th><th>Entry</th><th>Closed</th><th>Exit</th><th>Reason</th><th>P&L</th><th>R</th></tr>` +
      [...A.closed].reverse().map(t => `<tr data-goto="${t.openTime}" style="cursor:pointer"><td>${t.id}</td><td class="${t.side === 'buy' ? 'pos' : 'neg'}">${t.side.toUpperCase()}</td>
      <td>${t.qty}</td><td>${fmtTime(t.openTime)}</td><td>${fmtP(t.entry)}</td><td>${fmtTime(t.closeTime)}</td><td>${fmtP(t.exit)}</td><td>${t.reason}</td>
      <td class="${cls(t.pnl)}">${fmtMoney(t.pnl)}</td><td class="${cls(t.r)}">${t.r == null ? '—' : t.r.toFixed(2)}</td></tr>`).join('') + '</table>';
  } else renderStats(el);
}
function renderStats(el) {
  const T = S.acct.closed, n = T.length, wins = T.filter(t => t.pnl > 0), losses = T.filter(t => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
  let eq = S.acct.balance0, peak = eq, mdd = 0; const curve = [eq];
  for (const t of T) { eq += t.pnl; curve.push(eq); peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); }
  const rs = T.filter(t => t.r != null);
  const k = (l, v, c = '') => `<div class="kpi"><div class="l">${l}</div><div class="v ${c}">${v}</div></div>`;
  el.innerHTML = `<div class="stats"><div class="kpis">
    ${k('Net P&L', fmtMoney(gw - gl), cls(gw - gl))}${k('Trades', n)}${k('Win rate', n ? (wins.length / n * 100).toFixed(1) + '%' : '—')}
    ${k('Profit factor', gl > 0 ? (gw / gl).toFixed(2) : n ? '∞' : '—')}
    ${k('Avg win', wins.length ? fmtMoney(gw / wins.length) : '—', 'pos')}${k('Avg loss', losses.length ? fmtMoney(-gl / losses.length) : '—', 'neg')}
    ${k('Avg R', rs.length ? (rs.reduce((a, t) => a + t.r, 0) / rs.length).toFixed(2) : '—')}${k('Max drawdown', fmtMoney(-mdd), 'neg')}
    </div><canvas id="eqCanvas" width="360" height="130"></canvas>
    <div class="stats-actions"><button class="mini-btn" id="exportBtn">Export trades CSV</button>
    <label class="tb-lbl">Starting balance</label><input type="number" id="bal0" value="${S.acct.balance0}">
    <button class="mini-btn" id="resetBtn">Reset account &amp; trades</button></div></div>`;
  const c = $('eqCanvas'), g = c.getContext('2d'), mn = Math.min(...curve), mx = Math.max(...curve), W = c.width, H = c.height;
  g.strokeStyle = '#2a2e39'; g.beginPath(); const y0 = H - 8 - (S.acct.balance0 - mn) / ((mx - mn) || 1) * (H - 16); g.moveTo(0, y0); g.lineTo(W, y0); g.stroke();
  g.strokeStyle = '#2962ff'; g.lineWidth = 2; g.beginPath();
  curve.forEach((v, i) => { const x = curve.length > 1 ? i / (curve.length - 1) * (W - 10) + 5 : W / 2, y = H - 8 - (v - mn) / ((mx - mn) || 1) * (H - 16); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.stroke();
}
function exportCsv() {
  const rows = [['id', 'symbol', 'side', 'qty', 'open_time_utc', 'entry', 'sl', 'tp', 'close_time_utc', 'exit', 'reason', 'pnl', 'r']];
  for (const t of S.acct.closed) rows.push([t.id, S.sym, t.side, t.qty, new Date(t.openTime * 1000).toISOString(), t.entry, t.sl ?? '', t.tp ?? '',
    new Date(t.closeTime * 1000).toISOString(), t.exit, t.reason, t.pnl.toFixed(2), t.r == null ? '' : t.r.toFixed(3)]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' }));
  a.download = `ghostcharts_${S.sym}_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
}

/* ---------- data update (needs server.py) ---------- */
function showDataUpTo() {
  const tfs = symInfo().tfs, last = Math.max(...Object.values(tfs).map(t => t.to));
  $('dataUpTo').textContent = 'Data to ' + fmtTime(last);
}
async function updateData() {
  const btn = $('updateBtn');
  btn.disabled = true; btn.classList.add('spinning'); btn.querySelector('span').textContent = 'Updating…';
  try {
    const r = await fetch('api/update', { method: 'POST' });
    if (r.status === 501 || r.status === 404) throw new Error('This needs the app started with start.bat (server.py). Close the old server window and run start.bat again.');
    const res = await r.json();
    if (!res.ok) throw new Error(res.log || 'Update failed');
    if (!S.sym) return location.reload();  // first download: start the app properly
    stopPlay();
    S.manifest = await (await fetch('data/manifest.json', { cache: 'no-cache' })).json();
    S.cache.clear();
    const keepView = !S.replay.on;
    await fullRender();
    if (S.replay.on) afterReplayChange();
    showDataUpTo();
    const added = (res.log.match(/\+\d+ bars/g) || []).reduce((a, s) => a + parseInt(s.slice(1)), 0);
    toast(added ? `Updated: ${added.toLocaleString()} new candles` : 'Already up to date');
    if (keepView) chart.timeScale().scrollToRealTime();
  } catch (e) {
    alert('Data update failed:\n\n' + String(e.message || e).split('\n').slice(-12).join('\n'));
  } finally {
    btn.disabled = false; btn.classList.remove('spinning'); btn.querySelector('span').textContent = 'Update data';
  }
}
function showWelcome() {
  $('welcome').classList.remove('hidden');
  $('updateBtn').onclick = updateData;
  $('welcomeBtn').onclick = () => { $('welcomeBtn').disabled = true; $('welcomeBusy').classList.remove('hidden'); updateData().finally(() => {
    $('welcomeBtn').disabled = false; $('welcomeBusy').classList.add('hidden'); }); };
}

/* ---------- persistence ---------- */
function saveDrawings() { lsSet('bt_draw_' + S.sym, S.drawings); }
function saveSession() { lsSet('bt_sess_' + S.sym, { T: S.replay.T, acct: S.acct }); lsSet('bt_ui', { sym: S.sym, tf: S.tf, tz: S.tz, stepTf: S.stepTf, speed: S.replay.speed, useSpread: S.useSpread, magnet: S.magnet }); }
let saveTimer; function saveSessionSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveSession, 800); }
function loadSymbolState() {
  S.drawings = lsGet('bt_draw_' + S.sym, []); select(null);
  const sess = lsGet('bt_sess_' + S.sym, null);
  S.acct = sess && sess.acct ? sess.acct : newAcct();
  S.replay.T = sess ? sess.T : null;
}

/* ---------- UI wiring ---------- */
function buildTfButtons() {
  $('tfBtns').innerHTML = TF_ORDER.map(tf => `<button data-tf="${tf}" ${hasTf(tf) ? '' : 'disabled'} class="${tf === S.tf ? 'active' : ''}">${tf}</button>`).join('');
  const steps = ['same', ...TF_ORDER.filter(hasTf)];
  if (!steps.includes(S.stepTf)) S.stepTf = 'same';
  $('rbStepTf').innerHTML = steps.map(t => `<option value="${t}" ${t === S.stepTf ? 'selected' : ''}>${t === 'same' ? 'Chart TF' : t}</option>`).join('');
}
async function setTf(tf) {
  if (!hasTf(tf)) return;
  S.tf = tf; buildTfButtons();
  candles.applyOptions({ priceFormat: { type: 'price', precision: dec(), minMove: 1 / 10 ** dec() } });
  await fullRender(); saveSessionSoon();
}
async function setSymbol(sym) {
  if (S.replay.on) { saveSession(); stopPlay(); }
  S.sym = sym; S.replay.on = false; S.replay.selecting = false;
  $('replayBar').classList.add('hidden'); $('replayBtn').classList.remove('active');
  if (!hasTf(S.tf)) S.tf = 'H1';
  loadSymbolState(); buildTfButtons();
  candles.applyOptions({ priceFormat: { type: 'price', precision: dec(), minMove: 1 / 10 ** dec() } });
  await fullRender(); afterReplayChange(); showDataUpTo();
}

function wire() {
  $('symSel').onchange = e => setSymbol(e.target.value);
  $('updateBtn').onclick = updateData;
  $('tfBtns').onclick = e => { const b = e.target.closest('button[data-tf]'); if (b) setTf(b.dataset.tf); };
  $('tzSel').onchange = e => { S.tz = e.target.value; chart.applyOptions({}); fullRender(); renderTabs(); showDataUpTo(); saveSessionSoon(); };
  $('replayBtn').onclick = () => S.replay.selecting ? cancelSelecting() : openReplaySelect();
  $('rbStartBtn').onclick = () => { const t = wallToUtc($('rbDate').value); if (t) startReplay(t); };
  $('rbContinueBtn').onclick = () => { const s = lsGet('bt_sess_' + S.sym, null); if (s && s.T) startReplay(s.T); };
  $('rbSelectBtn').onclick = openReplaySelect;
  $('rbPlayBtn').onclick = togglePlay;
  $('rbStepBtn').onclick = () => { stopPlay(); step(); };
  $('rbExitBtn').onclick = exitReplay;
  $('rbSpeed').onchange = e => { S.replay.speed = +e.target.value; if (S.replay.timer) { stopPlay(); startPlay(); } saveSessionSoon(); };
  $('rbStepTf').onchange = async e => { S.stepTf = e.target.value; await ensure(baseTfName()); replayRefresh(); saveSessionSoon(); };
  $('gotoBtn').onclick = () => {
    const t = wallToUtc($('gotoInput').value); if (!t) return;
    if (S.replay.on) { if (t > S.replay.T) return toast('That date is in the replay future'); }
    fullRender(t).then(() => {
      if (S.replay.on) { const L = timeToLogical(t); chart.timeScale().setVisibleLogicalRange({ from: L - 100, to: L + 40 }); }
    });
  };

  document.querySelectorAll('.tool[data-tool]').forEach(b => b.onclick = () => setTool(S.tool === b.dataset.tool ? 'cursor' : b.dataset.tool));
  $('magnetBtn').onclick = () => { S.magnet = !S.magnet; $('magnetBtn').classList.toggle('active', S.magnet); saveSessionSoon(); };
  $('clearDrawBtn').onclick = () => { if (S.drawings.length && confirm(`Remove all ${S.drawings.length} drawings on ${S.sym}?`)) { S.drawings = []; select(null); saveDrawings(); } };
  $('drawBar').onclick = e => {
    const sw = e.target.closest('.sw'); if (sw && S.sel) { S.sel.color = sw.dataset.c; select(S.sel); saveDrawings(); }
    if (e.target.closest('#delDraw')) deleteSelected();
  };

  const wrap = $('chartWrap');
  wrap.addEventListener('pointerdown', onPointerDown, true);
  wrap.addEventListener('mousedown', e => { if (S.captured) { e.stopPropagation(); e.preventDefault(); } }, true);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  wrap.addEventListener('pointerleave', () => { S.mouse = null; });
  new ResizeObserver(resizeOverlay).observe(wrap);

  window.addEventListener('keydown', e => {
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.key === 'Escape') { setPick(null); if (S.creating) { S.creating = null; captureChart(false); } setTool('cursor'); select(null); if (S.replay.selecting) cancelSelecting(); return; }
    if (typing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { deleteSelected(); e.preventDefault(); }
    else if (e.key === 'ArrowRight' && S.replay.on) { stopPlay(); step(); e.preventDefault(); }
    else if (e.key === ' ' && S.replay.on) { togglePlay(); e.preventDefault(); }
    else if (e.altKey && e.key.toLowerCase() === 't') { setTool('trend'); e.preventDefault(); }
    else if (e.altKey && e.key.toLowerCase() === 'h') { setTool('hline'); e.preventDefault(); }
    else if (e.altKey && e.key.toLowerCase() === 'r') { setTool('rect'); e.preventDefault(); }
  });

  // ticket
  $('buySide').onclick = () => { S.ticket.side = 'buy'; updateTicket(); };
  $('sellSide').onclick = () => { S.ticket.side = 'sell'; updateTicket(); };
  $('typeSeg').onclick = e => {
    const b = e.target.closest('button'); if (!b) return; S.ticket.type = b.dataset.type;
    if (b.dataset.type !== 'market' && !$('tkPrice').value) { const q = quote(); if (q) $('tkPrice').value = roundP(q.bid); }
    updateTicket();
  };
  $('sizeSeg').onclick = e => {
    const b = e.target.closest('button'); if (!b || b.dataset.mode === S.ticket.sizeMode) return; S.ticket.sizeMode = b.dataset.mode;
    $('tkSize').value = b.dataset.mode === 'risk' ? 1 : 1; updateTicket();
  };
  ['tkPrice', 'tkSize', 'tkSl', 'tkTp', 'tkRR', 'tkSlOn', 'tkTpOn'].forEach(id => $(id).addEventListener('input', updateTicket));
  $('tkTp').addEventListener('input', () => { $('tkRR').value = ''; });
  $('tkTpOn').addEventListener('change', () => { if (!$('tkTpOn').checked) { $('tkRR').value = ''; updateTicket(); } });
  document.querySelectorAll('.pick').forEach(b => b.onclick = () => setPick(S.pick === b.dataset.pick ? null : b.dataset.pick));
  $('placeBtn').onclick = placeOrder;
  $('spreadOn').onchange = e => { S.useSpread = e.target.checked; updateTicketPrices(); updateTicket(); renderTabs(); saveSessionSoon(); };

  // tabs
  $('tabs').onclick = e => { const b = e.target.closest('.tab'); if (b) { activeTab = b.dataset.tab; renderTabs(); } };
  $('tabBody').addEventListener('click', e => {
    const c = e.target.closest('[data-close]'), x = e.target.closest('[data-cancel]'), g = e.target.closest('[data-goto]');
    if (c && S.replay.on) { const p = S.acct.positions.find(p => p.id == c.dataset.close); closePosition(p, exitPrice(p), S.replay.T, 'Manual'); }
    else if (x) S.acct.orders = S.acct.orders.filter(o => o.id != x.dataset.cancel);
    else if (g && !e.target.closest('input')) {
      const t = +g.dataset.goto; fullRender(t).then(() => { const L = timeToLogical(t); chart.timeScale().setVisibleLogicalRange({ from: L - 80, to: L + 60 }); });
      return;
    }
    else if (e.target.id === 'exportBtn') return exportCsv();
    else if (e.target.id === 'resetBtn') {
      if (!confirm('Delete all trades, orders and positions for ' + S.sym + '?')) return;
      S.acct = newAcct(parseFloat($('bal0').value) || 10000);
    } else return;
    refreshPriceLines(); refreshMarkers(); renderTabs(); saveSession();
  });
  $('tabBody').addEventListener('change', e => {
    const i = e.target.closest('input[data-k]');
    if (i) {
      const list = i.dataset.k === 'pos' ? S.acct.positions : S.acct.orders, item = list.find(o => o.id == i.dataset.id);
      const v = parseFloat(i.value); item[i.dataset.f] = isNaN(v) ? (i.dataset.f === 'price' ? item.price : null) : roundP(v);
      refreshPriceLines(); saveSession(); renderTabs();
    } else if (e.target.id === 'bal0') { S.acct.balance0 = parseFloat(e.target.value) || 10000; renderTabs(); saveSession(); }
  });
}

async function main() {
  if (location.protocol === 'file:') {
    document.body.innerHTML = '<p style="padding:30px">Start the app with <code>start.bat</code> (or <code>python server.py</code>) and open http://localhost:8765. It cannot run as a file opened directly.</p>';
    return;
  }
  try { S.manifest = await (await fetch('data/manifest.json', { cache: 'no-cache' })).json(); }
  catch { S.manifest = { symbols: {} }; }
  const syms = Object.keys(S.manifest.symbols);
  if (!syms.length) return showWelcome();
  const ui = lsGet('bt_ui', {});
  S.sym = syms.includes(ui.sym) ? ui.sym : syms[0];
  S.tf = ui.tf || 'H1'; S.tz = ui.tz || 'local'; S.stepTf = ui.stepTf || 'same';
  S.replay.speed = ui.speed || 1000; S.useSpread = ui.useSpread !== false; S.magnet = !!ui.magnet;
  $('symSel').innerHTML = syms.map(s => `<option ${s === S.sym ? 'selected' : ''}>${s}</option>`).join('');
  $('tzSel').value = S.tz; $('rbSpeed').value = S.replay.speed; $('spreadOn').checked = S.useSpread;
  $('magnetBtn').classList.toggle('active', S.magnet);
  initChart(); wire(); resizeOverlay();
  await setSymbol(S.sym);
  requestAnimationFrame(render);
}
main();
