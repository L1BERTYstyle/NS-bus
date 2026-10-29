'use strict';
/* NS Bus — карта автобусов Нови-Сада. Данные: NSmart (через локальный сервер server.py). */

// ======================================================================= utils
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const REFRESH_MS = 15000;
const MAP_LANG = LANG === 'sr' ? 'sr-Latn' : 'ru'; // язык подписей на Google-карте ('sr-Latn', 'en', ...)

function hav(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const CYR = { 'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'ђ': 'dj', 'е': 'e', 'ж': 'z', 'з': 'z', 'и': 'i', 'ј': 'j', 'к': 'k', 'л': 'l', 'љ': 'lj', 'м': 'm', 'н': 'n', 'њ': 'nj', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'ћ': 'c', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'c', 'џ': 'dz', 'ш': 's', 'й': 'j', 'ы': 'y', 'э': 'e', 'ю': 'ju', 'я': 'ja', 'ь': '', 'ъ': '', 'щ': 's', 'ё': 'e', 'đ': 'dj' };
function norm(s) {
  let o = '';
  for (const ch of String(s).toLowerCase()) o += CYR[ch] ?? ch;
  return o.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
const PALETTE = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00897b', '#d81b60', '#3949ab', '#6d4c41', '#0097a7', '#689f38', '#f4511e', '#5e35b1', '#c62828', '#0277bd', '#2e7d32', '#ad1457', '#ef6c00'];
function lineColor(num) {
  const base = (String(num).match(/^\d+/) || [num])[0];
  let h = 7;
  for (const c of base) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const badge = (num, sm) => `<span class="badge${sm ? ' sm' : ''}" style="background:${lineColor(num)}">${esc(num)}</span>`;
function fmtEta(sec) {
  if (sec < 45) return t('now');
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} ${t('min')}`;
  return `${Math.floor(m / 60)} ${t('h')} ${m % 60} ${t('min')}`;
}
const fmtClock = (sec) => new Date(Date.now() + sec * 1000).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
const stopsWord = (n) => plural(n, 'stop');
let toastT;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), ms);
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ======================================================================= state
const S = {
  stations: new Map(),   // id -> {id,n,la,lo,c,l}
  lines: [],             // [{id,n,t,d,ty,s:[ids]}]
  lineById: new Map(),
  lineByNum: new Map(),
  me: null,
  timers: [],
  view: null,
  token: 0,              // защита от гонок при смене экрана
  news: [],              // новости GSPNS об изменениях трасс
  mapPick: null,         // функция, вызываемая при клике по карте (режим выбора точки)
};
const stack = [];

// ======================================================================= map
const map = L.map('map', { zoomControl: true, preferCanvas: true, zoomSnap: 0.5 }).setView([45.2551, 19.8452], 13);
map.zoomControl.setPosition('bottomright');
const gUrl = (lyr) => `https://{s}.google.com/vt/lyrs=${lyr}&hl=${MAP_LANG}&x={x}&y={y}&z={z}`;
const tileLayers = {
  map: L.tileLayer(gUrl('m'), { subdomains: ['mt0', 'mt1', 'mt2', 'mt3'], maxZoom: 20, attribution: t('attrMap') }),
  hybrid: L.tileLayer(gUrl('y'), { subdomains: ['mt0', 'mt1', 'mt2', 'mt3'], maxZoom: 20, attribution: t('attrSat') }),
  // слой с пробками: красные/тёмно-красные участки и значки перекрытий (ремонтов) от Google
  traffic: L.tileLayer(gUrl('m,traffic'), { subdomains: ['mt0', 'mt1', 'mt2', 'mt3'], maxZoom: 20, attribution: t('attrTraffic') }),
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: t('attrOsm') }),
};
let curTiles = localStorage.getItem('nsbus.layer') || 'map';
if (!tileLayers[curTiles]) curTiles = 'map';
tileLayers[curTiles].addTo(map);

map.createPane('routes').style.zIndex = 410;
map.createPane('stops').style.zIndex = 420;
const stopsRenderer = L.canvas({ pane: 'stops', padding: 0.3 });
const routeRenderer = L.canvas({ pane: 'routes', padding: 0.3 });

const allStopsLayer = L.layerGroup();
const modeLayer = L.layerGroup().addTo(map);   // маршрут/остановки текущего экрана
const busLayer = L.layerGroup().addTo(map);    // автобусы
let meMarker = null;

function updateAllStopsVisibility() {
  const show = map.getZoom() >= 14.5 && (!S.view || S.view.type === 'home' || S.view.type === 'stop');
  if (show && !map.hasLayer(allStopsLayer)) allStopsLayer.addTo(map);
  if (!show && map.hasLayer(allStopsLayer)) map.removeLayer(allStopsLayer);
}
map.on('zoomend', updateAllStopsVisibility);
map.on('click', (e) => {
  $('#results').classList.add('hidden'); $('#layerMenu').classList.add('hidden');
  if (S.mapPick) { S.mapPick([e.latlng.lat, e.latlng.lng]); return; }
  setSheet('peek');
});
// долгое нажатие / правый клик — «Маршрут сюда» (как в Яндекс Картах)
map.on('contextmenu', (e) => {
  const p = [e.latlng.lat, e.latlng.lng];
  L.popup({ closeButton: false, offset: [0, -4] }).setLatLng(e.latlng)
    .setContent(`<div style="display:flex;flex-direction:column;gap:6px"><button class="tab" id="ctxTo">🏁 ${t('routeTo')}</button><button class="tab" id="ctxFrom">🚩 ${t('routeFrom')}</button></div>`)
    .openOn(map);
  setTimeout(() => {
    $('#ctxTo')?.addEventListener('click', () => { map.closePopup(); openPlanner({ to: p }); });
    $('#ctxFrom')?.addEventListener('click', () => { map.closePopup(); openPlanner({ from: p }); });
  }, 0);
});

// ---- bus markers with smooth movement
const BUS_SVG = '<svg viewBox="0 0 24 24"><path d="M4 16c0 .9.4 1.7 1 2.2V20c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1h8v1c0 .6.4 1 1 1h1c.6 0 1-.4 1-1v-1.8c.6-.5 1-1.3 1-2.2V6c0-3.5-3.6-4-8-4S4 2.5 4 6v10zm3.5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm9 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM18 11H6V6h12v5z"/></svg>';
const busMarkers = new Map();
function busIcon(num, sel) {
  return L.divIcon({ className: 'bus-icon' + (sel ? ' sel' : ''), iconSize: [0, 0], html: `<div class="body" style="background:${lineColor(num)}">${BUS_SVG}${esc(num)}</div>` });
}
function animateTo(m, to) {
  const from = m.getLatLng();
  if (hav([from.lat, from.lng], to) > 3000) { m.setLatLng(to); return; }
  const t0 = performance.now(), D = 1200;
  cancelAnimationFrame(m._raf);
  const step = (t) => {
    const k = clamp((t - t0) / D, 0, 1), e = k * (2 - k);
    m.setLatLng([from.lat + (to[0] - from.lat) * e, from.lng + (to[1] - from.lng) * e]);
    if (k < 1) m._raf = requestAnimationFrame(step);
  };
  m._raf = requestAnimationFrame(step);
}
/** items: [{key, num, lat, lng, sel, onClick, tip}] */
function setBuses(items) {
  const keep = new Set();
  for (const it of items) {
    keep.add(it.key);
    let m = busMarkers.get(it.key);
    if (!m) {
      m = L.marker([it.lat, it.lng], { icon: busIcon(it.num, it.sel), zIndexOffset: it.sel ? 1000 : 500, keyboard: false });
      m.addTo(busLayer);
      busMarkers.set(it.key, m);
    } else {
      animateTo(m, [it.lat, it.lng]);
      if (m._sel !== !!it.sel) { m.setIcon(busIcon(it.num, it.sel)); m.setZIndexOffset(it.sel ? 1000 : 500); }
    }
    m._sel = !!it.sel;
    m.off('click');
    if (it.onClick) m.on('click', (e) => { L.DomEvent.stop(e); it.onClick(); });
    if (it.tip) m.bindTooltip(it.tip, { direction: 'top', offset: [0, -14], className: 'stop-tip' });
  }
  for (const [k, m] of busMarkers) if (!keep.has(k)) { busLayer.removeLayer(m); busMarkers.delete(k); }
}

// ---- road geometry
const routeCache = new Map();
async function roadLegs(pts) {
  const key = pts.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(';');
  if (routeCache.has(key)) return routeCache.get(key);
  const p = api('/api/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pts }) })
    .then((j) => j.legs).catch((e) => { routeCache.delete(key); throw e; });
  routeCache.set(key, p);
  return p;
}
const joinLegs = (legs) => {
  const out = [];
  for (const g of legs) for (const p of g) { const l = out[out.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p); }
  return out;
};

// ======================================================================= bottom sheet
const sheet = $('#sheet');
const isDesktop = () => window.matchMedia('(min-width: 820px)').matches;
/* Шторка как в Яндекс Картах: идёт за пальцем, 3 положения (свёрнута / половина / почти весь экран),
   учитывает скорость смахивания; список внутри прокручивается в любом положении. */
const SHEET = { state: 'peek', h: 150, drag: null };
const viewH = () => window.innerHeight;
const SH = {
  peek: () => {
    const hh = ($('#grip').offsetHeight || 17) + ($('#sheetHead').offsetHeight || 80) + 6;
    return Math.round(clamp(hh, 96, viewH() * 0.42));
  },
  half: () => Math.round(viewH() * 0.5),
  full: () => {
    const sb = document.querySelector('#topbar .search');
    const top = sb ? sb.getBoundingClientRect().bottom + 8 : 66;
    return Math.round(viewH() - top);
  },
};
function applySheetH(px, animate) {
  SHEET.h = px;
  sheet.classList.toggle('dragging', !animate);
  sheet.style.setProperty('--sh', px + 'px');
  const half = SH.half();
  document.documentElement.style.setProperty('--fab-b', Math.min(px, half) + 'px');
  $('#fabs').classList.toggle('fab-hide', px > half + 40);
}
function setSheet(state) {
  if (isDesktop()) return;
  SHEET.state = state;
  sheet.classList.remove('peek', 'half', 'full');
  sheet.classList.add(state);
  applySheetH(SH[state](), true);
}
const sheetH = () => (isDesktop() ? 0 : SH[SHEET.state]());
(function sheetDrag() {
  const order = ['peek', 'half', 'full'];
  const begin = (y) => {
    SHEET.drag = { y0: y, h0: SHEET.h, lastY: y, lastT: performance.now(), v: 0, moved: false };
  };
  const moveTo = (y) => {
    const d = SHEET.drag;
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    d.v = 0.7 * ((d.lastY - y) / dt) + 0.3 * d.v;   // px/ms, «+» — вверх
    d.lastY = y; d.lastT = now;
    if (Math.abs(y - d.y0) > 5) d.moved = true;
    const lo = 70, hi = SH.full();
    let h = d.h0 + (d.y0 - y);
    if (h > hi) h = hi + (h - hi) * 0.25;            // «резинка» за краями
    if (h < lo) h = lo - (lo - h) * 0.25;
    applySheetH(Math.round(h), false);
  };
  const finish = () => {
    const d = SHEET.drag;
    SHEET.drag = null;
    if (!d) return false;
    if (!d.moved) { applySheetH(SH[SHEET.state](), true); return false; }
    if (performance.now() - d.lastT > 120) d.v = 0;  // палец остановился перед отпусканием
    const h = SHEET.h;
    const hs = order.map((k) => [k, SH[k]()]);
    let best;
    if (d.v > 0.4) best = (hs.find(([, v]) => v > h + 8) || hs[hs.length - 1])[0];
    else if (d.v < -0.4) best = ([...hs].reverse().find(([, v]) => v < h - 8) || hs[0])[0];
    else best = hs.reduce((a, b) => (Math.abs(b[1] - h) < Math.abs(a[1] - h) ? b : a))[0];
    setSheet(best);
    return true;
  };

  // 1) ручка и шапка: тянем всегда (кнопки нажимаются, если палец не сдвинулся)
  let pid = null, suppressClick = false;
  const handle = [$('#grip'), $('#sheetHead')];
  for (const el of handle) {
    el.addEventListener('pointerdown', (e) => {
      if (isDesktop() || e.button > 0 || e.target.closest('input, select, textarea')) return;
      pid = e.pointerId; begin(e.clientY);
    });
    el.addEventListener('pointermove', (e) => {
      if (pid !== e.pointerId || !SHEET.drag) return;
      if (!SHEET.drag.moved && Math.abs(e.clientY - SHEET.drag.y0) > 5) el.setPointerCapture?.(e.pointerId);
      moveTo(e.clientY);
    });
    const up = (e) => {
      if (pid !== e.pointerId) return;
      pid = null;
      const wasTap = SHEET.drag && !SHEET.drag.moved;
      if (finish()) suppressClick = true;
      else if (wasTap && e.type === 'pointerup' && (el.id === 'grip' || (SHEET.state === 'peek' && !e.target.closest('button, a, [data-f], .tab')))) {
        setSheet(SHEET.state === 'peek' ? 'half' : SHEET.state === 'half' ? 'full' : 'half');
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  sheet.addEventListener('click', (e) => { if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); } }, true);

  // 2) список: обычная прокрутка; шторка тянется, когда прокручивать нечего / список в самом верху
  const body = $('#sheetBody');
  let t = null;
  body.addEventListener('touchstart', (e) => {
    if (isDesktop() || e.touches.length > 1) { t = null; return; }
    t = { y0: e.touches[0].clientY, mode: null };
  }, { passive: true });
  body.addEventListener('touchmove', (e) => {
    if (!t) return;
    const y = e.touches[0].clientY;
    const dy = y - t.y0;                              // «+» — палец вниз
    if (t.mode === null) {
      if (dy === 0) return;
      const atTop = body.scrollTop <= 0;
      const canScroll = body.scrollHeight > body.clientHeight + 2;
      const small = SHEET.h < SH.half() - 20;
      if (!e.cancelable) t.mode = 'scroll';
      else if (small) t.mode = 'drag';                       // свёрнута — любое движение тянет шторку
      else if (dy > 0 && atTop) t.mode = 'drag';             // тянем вниз, список уже вверху
      else if (dy < 0 && SHEET.state !== 'full' && (!canScroll || atTop)) t.mode = 'drag'; // вверх — раскрываем
      else t.mode = 'scroll';
      if (t.mode === 'drag') begin(t.y0);
    } else if (t.mode === 'scroll' && dy > 0 && body.scrollTop <= 0 && e.cancelable) {
      t.mode = 'drag'; begin(y);                              // докрутили до верха и тянем дальше
    }
    if (t.mode === 'drag') { e.preventDefault(); moveTo(y); }
  }, { passive: false });
  const tend = () => { if (t && t.mode === 'drag') { if (finish()) suppressClick = true; } t = null; };
  body.addEventListener('touchend', tend);
  body.addEventListener('touchcancel', tend);

  // свёрнутое положение подстраивается под высоту шапки; при повороте экрана — пересчёт
  if (window.ResizeObserver) new ResizeObserver(() => { if (!SHEET.drag && SHEET.state === 'peek' && !isDesktop()) applySheetH(SH.peek(), true); }).observe($('#sheetHead'));
  window.addEventListener('resize', () => { if (!isDesktop()) setSheet(SHEET.state); });
})();

// ======================================================================= navigation
function go(v) {
  stack.push(v);
  history.pushState({ d: stack.length }, '');
  show(v);
}
function back() { if (stack.length > 1) history.back(); else show({ type: 'home' }); }
window.addEventListener('popstate', () => {
  if (stack.length > 1) stack.pop();
  show(stack[stack.length - 1] || { type: 'home' });
});
function every(ms, fn) { S.timers.push(setInterval(fn, ms)); }
function clearView() {
  S.timers.forEach(clearInterval); S.timers = [];
  modeLayer.clearLayers();
  setBuses([]);
  S.mapPick = null;
  map.getContainer().style.cursor = '';
  S.token++;
}
function show(v) {
  clearView();
  S.view = v;
  $('#results').classList.add('hidden');
  updateAllStopsVisibility();
  if (v.type === 'home') return showHome();
  if (v.type === 'stop') return showStop(v);
  if (v.type === 'line') return showLine(v);
  if (v.type === 'trip') return showTrip(v);
  if (v.type === 'plan') return showPlan(v);
  if (v.type === 'news') return showNews(v);
}

/** Перерисовка тела шторки с сохранением прокрутки и раскрытых предупреждений. */
function setBody(html) {
  const sb = $('#sheetBody');
  const keep = sb.scrollTop;
  const open = new Set([...sb.querySelectorAll('.warn.open')].map((w) => w.dataset.w));
  sb.innerHTML = html;
  sb.querySelectorAll('.warn').forEach((w) => {
    if (open.has(w.dataset.w)) { w.classList.add('open'); const m = w.querySelector('.more'); if (m) m.textContent = t('collapse'); }
  });
  sb.scrollTop = keep;
}

// ======================================================================= предупреждения (новости GSPNS)
function newsFor(lineNums) {
  const set = new Set(lineNums.map((n) => String(n).toUpperCase()));
  return S.news.filter((it) => it.kind === 'changes' && isFresh(it) && it.lines.some((l) => set.has(l)));
}
const isFresh = (it) => it.active !== false;
function warnHtml(items, ctx) {
  if (!items.length) return '';
  return items.slice(0, 3).map((it, i) => `<div class="warn" data-w="${i}"${it.restored ? ' style="background:#e6f4ea;border-color:#b7dfc3;color:#14532d"' : ''}>
    <b${it.restored ? ' style="color:#137333"' : ''}>${it.restored ? '✓ ' + (ctx ? esc(ctx) + ': ' : '') + t('restored') : '⚠ ' + (ctx ? esc(ctx) + ': ' : '') + t('changed')}</b>
    ${esc(it.title)}${it.date ? ` <span style="color:#a16207">(${esc(it.date)}${it.until ? ` — ${t('until')} ${esc(it.until)}` : ''})</span>` : ''}
    <div class="wt">${esc(it.text)}\n\n<a href="${esc(it.url)}" target="_blank" rel="noopener">${t('source')}: gspns.co.rs</a>${S.newsTr ? `<br><i>${t('translated')}</i>` : ''}</div>
    <button class="more">${t('more')}</button></div>`).join('');
}
$('#sheet').addEventListener('click', (e) => {
  const m = e.target.closest('.warn .more');
  if (!m) return;
  e.stopPropagation();
  const w = m.closest('.warn');
  w.classList.toggle('open');
  m.textContent = w.classList.contains('open') ? t('collapse') : t('more');
});
async function loadNews() {
  try {
    const j = await api(`/api/news?lang=${LANG}`);
    S.news = j.items || [];
    S.newsTr = !!j.translated;
    if (S.view?.type === 'home') showHome();
  } catch (e) { /* без новостей */ }
}
function showNews() {
  $('#sheetHead').innerHTML = `<div class="h-row">${backBtn()}<div class="grow"><div class="h-title">${t('trafficChanges')}</div>
    <div class="h-sub">${t('newsSub')}</div></div></div>`;
  const rows = S.news.map((it) => `<div class="news-item"${isFresh(it) ? '' : ' style="opacity:.55"'}><div class="d">${esc(it.date)} · ${it.kind === 'changes' ? t('routeChanges') : t('important')}${it.until ? ` · ${t('until')} ${esc(it.until)}` : ''}${isFresh(it) ? '' : ` · <b>${t('inactive')}</b>`}</div>
    <div class="tt">${esc(it.title)}</div><div class="chips">${it.lines.map((n) => badge(n, true)).join(' ')}</div>
    <details style="margin-top:6px;font-size:13px"><summary style="cursor:pointer;color:#1a73e8">${t('read')}</summary><div style="white-space:pre-line;margin-top:6px">${esc(it.text)}</div>
    <a href="${esc(it.url)}" target="_blank" rel="noopener" style="font-size:12.5px">${t('openOn')} gspns.co.rs</a>${S.newsTr ? ` · <i>${t('translated')}</i>` : ''}</details></div>`).join('');
  $('#sheetBody').innerHTML = rows || `<div class="empty">${t('noNews')}</div>`;
  setSheet('full');
}
const backBtn = () => `<button class="back" data-act="back" title="${t('back')}">←</button>`;
$('#sheet').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'back') back();
  else if (act === 'stop') go({ type: 'stop', id: +b.dataset.id });
  else if (act === 'line') go({ type: 'line', id: b.dataset.id, focusStop: b.dataset.stop ? +b.dataset.stop : undefined });
  else if (act === 'news') go({ type: 'news' });
  else if (act === 'plan') openPlanner({});
});

// ======================================================================= HOME
function lineGroups() {
  const sortNum = (a, b) => (parseInt(a.n) || 999) - (parseInt(b.n) || 999) || a.n.localeCompare(b.n);
  const g = { '1': [], '2': [], '3': [] };
  for (const l of S.lines) (g[l.ty] || g['1']).push(l);
  Object.values(g).forEach((a) => a.sort(sortNum));
  return g;
}
function nearbyStops(lat, lng, n = 8) {
  return [...S.stations.values()].map((s) => [s, hav([lat, lng], [s.la, s.lo])]).sort((a, b) => a[1] - b[1]).slice(0, n);
}
function stopRow(s, extra = '') {
  const chips = s.l.slice(0, 10).map((n) => badge(n, true)).join(' ');
  return `<div class="res" data-act="stop" data-id="${s.id}"><div class="stopico">${BUS_SVG.replace('<svg', '<svg width="16" height="16" fill="#1a73e8"')}</div>
    <div style="flex:1;min-width:0"><div>${esc(s.n)}</div><div class="sub">${extra}${esc(s.c)}</div><div class="chips" style="margin-top:5px">${chips}${s.l.length > 10 ? ' …' : ''}</div></div></div>`;
}
function showHome() {
  $('#sheetHead').innerHTML = `<div class="h-row"><div class="grow"><div class="h-title">${t('appTitle')}</div>
    <div class="h-sub">${t('homeSub', S.lines.length, S.stations.size)}</div></div>${langSwitch()}</div>`;
  const g = lineGroups();
  const grid = (arr) => `<div class="grid-lines">${arr.map((l) => `<button class="chip-btn" data-act="line" data-id="${l.id}" title="${esc(l.t)}">${badge(l.n)}${newsFor([l.n]).some((x) => !x.restored) ? `<span class="warn-badge" title="${t('changedShort')}">!</span>` : ''}</button>`).join('')}</div>`;
  let html = `<div style="padding:4px 16px 2px"><button class="tab" data-act="plan" style="background:#1a73e8;color:#fff;border-color:#1a73e8;font-weight:600">🏁 ${t('howToGetBtn')}</button></div>`;
  const changes = S.news.filter((it) => it.kind === 'changes' && isFresh(it) && !it.restored);
  if (changes.length) {
    html += `<div class="warn" style="cursor:pointer" data-act="news"><b>⚠ ${t('trafficChanges')}: ${changes.length}</b>${esc(changes[0].title)}${changes.length > 1 ? ` ${t('andMore', changes.length - 1)}` : ''}</div>`;
  }
  if (S.me) {
    html += `<div class="section-title">${t('nearby')}</div>`;
    html += nearbyStops(S.me[0], S.me[1], 6).map(([s, d]) => stopRow(s, `${Math.round(d)} ${t('m')} · `)).join('');
  } else {
    html += `<div class="note">${t('homeNote')}</div>`;
  }
  html += `<div class="section-title">${t('cityLines')}</div>` + grid(g['1']);
  html += `<div class="section-title">${t('suburbanLines')}</div>` + grid(g['2']);
  if (g['3'].length) html += `<div class="section-title">${t('intercityLines')}</div>` + grid(g['3']);
  $('#sheetBody').innerHTML = html;
}

// ======================================================================= STOP
function arrivalsRows(st, items, ts) {
  if (!items.length) return `<div class="empty">${t('noArrivals')}</div>`;
  const now = Date.now();
  return items.map((it, i) => {
    const sec = Math.max(0, it.sec - (now - ts) / 1000);
    const meta = it.live
      ? `<span class="live-dot"></span> ${t('online')} · ${it.between != null ? `${it.between + 1} ${stopsWord(it.between + 1)}` : t('onWay')}${it.garage ? ` · №${esc(it.garage)}` : ''}`
      : `<span class="sched-dot"></span> ${t('schedNotOut')}`;
    return `<div class="arr" data-idx="${i}">${badge(it.line)}
      <div class="mid"><div class="ttl">${esc(it.title)}</div><div class="meta">${meta}</div></div>
      <div class="eta${sec < 45 ? ' now' : ''}"><b data-eta="${i}">${fmtEta(sec)}</b><small>${fmtClock(sec)}</small></div></div>`;
  }).join('');
}
async function showStop(v) {
  const st = S.stations.get(v.id);
  if (!st) return back();
  const tok = S.token;
  const chips = st.l.map((n) => {
    const l = S.lineByNum.get(n);
    return l ? `<button class="chip-btn" data-act="line" data-id="${l.id}" data-stop="${st.id}">${badge(n, true)}</button>` : badge(n, true);
  }).join('');
  $('#sheetHead').innerHTML = `<div class="h-row">${backBtn()}<div class="grow">
    <div class="h-title">${esc(st.n)}</div><div class="h-sub">${esc(st.c)} · ${t('stopWord')}</div>
    <div class="chips" style="margin-top:8px">${chips}</div></div></div>`;
  $('#sheetBody').innerHTML = `<div class="empty">${t('loadingArr')}</div>`;
  setSheet('half');

  L.marker([st.la, st.lo], { icon: L.divIcon({ className: '', html: '<div class="stop-pin big"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 2000 }).addTo(modeLayer);
  if (!v.noFly) {
    const z = Math.max(map.getZoom(), 15.5);
    map.flyTo(offsetForSheet([st.la, st.lo], z), z, { duration: 0.6 });
  }

  let data = null, ts = 0;
  const render = () => {
    if (tok !== S.token || !data) return;
    setBody(`${warnHtml(newsFor(st.l), t('linesOfStop'))}<div class="section-title">${t('nextBuses')}</div>${arrivalsRows(st, data.items, ts)}
      <div class="updated">${t('updated')} ${new Date(ts).toLocaleTimeString(LOCALE)} · ${t('autoRefresh')}</div>`);
    $('#sheetBody').querySelectorAll('.arr').forEach((row) => row.addEventListener('click', () => {
      const it = data.items[+row.dataset.idx];
      if (it.trip.length) go({ type: 'trip', entry: it, ts, anchor: st.id });
      else { const l = S.lineByNum.get(it.line); if (l) go({ type: 'line', id: l.id, focusStop: st.id }); }
    }));
    setBuses(data.items.filter((i) => i.live).map((i, k) => ({
      key: i.garage || `${i.line}-${k}`, num: i.line, lat: i.lat, lng: i.lng,
      tip: `${i.line} · ${fmtEta(i.sec)}`,
      onClick: () => go({ type: 'trip', entry: i, ts, anchor: st.id }),
    })));
  };
  const load = async () => {
    try {
      const j = await api(`/api/arrivals?station=${st.id}`);
      if (tok !== S.token) return;
      data = j; ts = Date.now() - j.age * 1000;
      render();
      if (v.open != null && data.items[v.open]?.trip.length) {
        const it = data.items[v.open]; v.open = null;
        go({ type: 'trip', entry: it, ts, anchor: st.id });
      }
    } catch (e) {
      if (tok === S.token && !data) $('#sheetBody').innerHTML = `<div class="empty">${t('fetchFail')}: ${esc(e.message)}</div>`;
    }
  };
  await load();
  every(REFRESH_MS, load);
  every(1000, () => {
    if (!data) return;
    const now = Date.now();
    data.items.forEach((it, i) => {
      const b = document.querySelector(`[data-eta="${i}"]`);
      if (b) b.textContent = fmtEta(Math.max(0, it.sec - (now - ts) / 1000));
    });
  });
}
function offsetForSheet(ll, z) {
  // на мобильном сдвигаем центр карты, чтобы точка не пряталась под шторкой
  if (isDesktop()) {
    const p = map.project(ll, z).subtract([200, 0]);
    return map.unproject(p, z);
  }
  const p = map.project(ll, z).add([0, Math.min(sheetH(), window.innerHeight * 0.55) / 2]);
  return map.unproject(p, z);
}
function fitWithSheet(bounds) {
  if (isDesktop()) map.fitBounds(bounds, { paddingTopLeft: [440, 40], paddingBottomRight: [60, 40] });
  else map.fitBounds(bounds, { paddingTopLeft: [20, 70], paddingBottomRight: [20, Math.min(sheetH(), window.innerHeight * 0.55) + 10] });
}

// ======================================================================= ETA estimation along a trip
/** Возвращает массив оценок (сек) до каждой остановки рейса начиная с e.next. */
function tripEtas(e) {
  const tr = e.trip;
  if (!tr || !tr.length || e.t == null || e.next == null) return null;
  const d = new Array(tr.length).fill(null);
  let acc = e.live ? hav([e.lat, e.lng], [tr[e.next][1], tr[e.next][2]]) : 0;
  d[e.next] = acc;
  for (let i = e.next + 1; i < tr.length; i++) { acc += hav([tr[i - 1][1], tr[i - 1][2]], [tr[i][1], tr[i][2]]); d[i] = acc; }
  const dt = d[e.t];
  let v = dt > 200 && e.sec > 30 ? dt / e.sec : 5.5;   // м/с
  v = clamp(v, 3, 13);
  const out = new Array(tr.length).fill(null);
  for (let i = e.next; i < tr.length; i++) {
    if (i === e.t) out[i] = e.sec;
    else if (i < e.t) out[i] = dt > 200 ? e.sec * d[i] / dt : d[i] / v;
    else out[i] = e.sec + (d[i] - dt) / v;
  }
  return out;
}

// ======================================================================= LINE
function splitDirections(line) {
  const ids = line.s;
  if (ids.length < 6) return [ids];
  const parts = line.t.split(/\s+[-–]\s+|\s*[-–]\s*/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const loop = parts.length > 2 && parts[0] === parts[parts.length - 1];
  const P = (id) => { const s = S.stations.get(id); return [s.la, s.lo]; };
  const first = P(ids[0]), last = P(ids[ids.length - 1]);
  if (loop || hav(first, last) > 1500) return [ids];
  let k = 0, best = -1;
  ids.forEach((id, i) => { const d = hav(first, P(id)); if (d > best) { best = d; k = i; } });
  if (k < 2 || k > ids.length - 3) return [ids];
  return [ids.slice(0, k + 1), ids.slice(k + 1)];
}
// В сети NSmart порядок остановок иногда записан задом наперёд. Определяем реальное
// направление по живым рейсам и запоминаем его.
const orientKey = (lineId, i) => `nsbus.o.${lineId}.${i}`;
function applyOrientation(lineId, dirs, trips) {
  let changed = false;
  dirs.forEach((d, i) => {
    let vote = 0;
    if (trips) {
      const pos = new Map(d.map((id, k) => [id, k]));
      for (const tr of trips) {
        let prev = null;
        for (const s of tr) {
          const k = pos.get(s[0]);
          if (k == null) continue;
          if (prev != null && k !== prev) vote += k > prev ? 1 : -1;
          prev = k;
        }
      }
    }
    let rev;
    if (vote !== 0) { rev = vote < 0; try { localStorage.setItem(orientKey(lineId, i), rev ? '1' : '0'); } catch (e) { /* */ } }
    else rev = localStorage.getItem(orientKey(lineId, i)) === '1';
    if (rev !== !!d._rev) { d.reverse(); d._rev = rev; changed = true; }
  });
  return changed;
}
async function showLine(v) {
  const line = S.lineById.get(v.id);
  if (!line) return back();
  const tok = S.token;
  const color = lineColor(line.n);
  const dirs = splitDirections(line);
  if (v.dir == null) {
    v.dir = 0;
    if (v.focusStop && dirs.length > 1 && dirs[1].includes(v.focusStop) && !dirs[0].includes(v.focusStop)) v.dir = 1;
  }
  const nm = (id) => S.stations.get(id)?.n || '?';
  applyOrientation(line.id, dirs, null);
  $('#sheetHead').innerHTML = `<div class="h-row">${backBtn()}<div class="grow">
    <div class="h-title">${badge(line.n)} <span style="font-size:15px;font-weight:600">${esc(line.t)}</span></div>
    <div class="h-sub" id="lineSub">${line.s.length} ${stopsWord(line.s.length)} · ${t('searchingBuses')}</div><div id="lineTabs"></div></div></div>`;
  const renderTabs = () => {
    $('#lineTabs').innerHTML = dirs.length > 1 ? `<div class="tabs">${dirs.map((d, i) => `<button class="tab${i === v.dir ? ' active' : ''}" data-dir="${i}">→ ${esc(nm(d[d.length - 1]))}</button>`).join('')}</div>` : '';
    $('#lineTabs').querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => { v.dir = +b.dataset.dir; renderTimeline(); drawDir(); }));
  };
  renderTabs();
  setSheet('half');

  // --- карта: маршрут
  const allPts = line.s.map((id) => { const s = S.stations.get(id); return [s.la, s.lo]; });
  const dirLayer = L.layerGroup().addTo(modeLayer);
  let legs = null;
  const drawDir = () => {
    dirLayer.clearLayers();
    const off = v.dir === 1 ? dirs[0].length : 0;
    const ids = dirs[v.dir];
    const segOf = (from, to) => (legs ? joinLegs(legs.slice(from, to)) : allPts.slice(from, to + 1));
    // всё направление полупрозрачно, выбранное — ярко
    L.polyline(legs ? joinLegs(legs) : allPts, { color, weight: 4, opacity: 0.25, renderer: routeRenderer, interactive: false }).addTo(dirLayer);
    L.polyline(segOf(off, off + ids.length - 1), { color: '#fff', weight: 9, opacity: 0.9, renderer: routeRenderer, interactive: false }).addTo(dirLayer);
    L.polyline(segOf(off, off + ids.length - 1), { color, weight: 6, opacity: 0.95, renderer: routeRenderer, interactive: false }).addTo(dirLayer);
    ids.forEach((id, i) => {
      const s = S.stations.get(id);
      const end = i === 0 || i === ids.length - 1;
      L.circleMarker([s.la, s.lo], { renderer: stopsRenderer, radius: end ? 7 : 5, color, weight: 3, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(s.n, { className: 'stop-tip', direction: 'top' })
        .on('click', () => go({ type: 'stop', id }))
        .addTo(dirLayer);
    });
  };
  drawDir();
  if (v.focusStop && S.stations.get(v.focusStop)) {
    const s = S.stations.get(v.focusStop);
    L.marker([s.la, s.lo], { icon: L.divIcon({ className: '', html: '<div class="stop-pin big"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 2000 }).addTo(modeLayer);
  }
  fitWithSheet(L.latLngBounds(allPts));
  roadLegs(allPts).then((lg) => { if (tok !== S.token) return; legs = lg; drawDir(); }).catch(() => {});

  // --- автобусы и таймлайн
  let veh = [], ts = Date.now();
  const renderTimeline = () => {
    if (tok !== S.token) return;
    $('#sheetHead').querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', +b.dataset.dir === v.dir));
    const ids = dirs[v.dir];
    const pos = new Map(ids.map((id, i) => [id, i]));
    const best = new Map(); // stopId -> sec
    const marks = new Map(); // index -> [veh]
    const el = (Date.now() - ts) / 1000;
    for (const e of veh) {
      const et = tripEtas(e);
      const nextId = e.trip[e.next]?.[0];
      if (pos.has(nextId)) {
        const i = pos.get(nextId);
        (marks.get(i) || marks.set(i, []).get(i)).push(e);
      }
      if (!et) continue;
      for (let i = e.next; i < e.trip.length; i++) {
        const id = e.trip[i][0];
        if (!pos.has(id) || et[i] == null) continue;
        const sec = Math.max(0, et[i] - el);
        if (!best.has(id) || best.get(id) > sec) best.set(id, sec);
      }
    }
    const html = ids.map((id, i) => {
      const s = S.stations.get(id);
      const sec = best.get(id);
      const m = (marks.get(i) || []).map((e) => `<span class="busmark before" style="background:${color}" title="№${esc(e.garage)}">${BUS_SVG.replace('<svg', '<svg width="13" height="13" fill="#fff"')}</span>`).join('');
      const tm = sec != null ? `<b>${fmtEta(sec)}</b><br>${fmtClock(sec)}` : '';
      return `<div class="ts${i === 0 ? ' first' : ''}${i === ids.length - 1 ? ' last' : ''}${id === v.focusStop ? ' sel' : ''}" style="--lc:${color}" data-sid="${id}">
        ${m}<span class="dot"></span><div class="nm">${esc(s.n)}</div><div class="tm">${tm}</div></div>`;
    }).join('');
    setBody(`${warnHtml(newsFor([line.n]), t('line') + ' ' + line.n)}<div class="timeline">${html}</div>
      <div class="note">${t('lineNote')}</div>`);
    $('#sheetBody').querySelectorAll('.ts').forEach((r) => r.addEventListener('click', () => go({ type: 'stop', id: +r.dataset.sid })));
    if (v.focusStop && !v._scrolled) {
      const r = $('#sheetBody').querySelector('.ts.sel');
      if (r) { r.scrollIntoView({ block: 'center' }); v._scrolled = true; }
    }
  };
  renderTimeline();
  const load = async () => {
    try {
      const j = await api(`/api/vehicles?line=${encodeURIComponent(line.id)}`);
      if (tok !== S.token) return;
      veh = j.vehicles; ts = Date.now();
      if (applyOrientation(line.id, dirs, veh.map((x) => x.trip))) { renderTabs(); drawDir(); }
      $('#lineSub').innerHTML = veh.length
        ? `<span class="live-dot"></span> ${t('onLine')} ${veh.length} ${plural(veh.length, 'bus')} · ${line.s.length} ${stopsWord(line.s.length)}`
        : `${line.s.length} ${stopsWord(line.s.length)} · ${t('noOnline')}`;
      setBuses(veh.map((e) => ({
        key: e.garage || `${e.lat},${e.lng}`, num: line.n, lat: e.lat, lng: e.lng,
        tip: `${line.n} · №${e.garage} → ${S.stations.get(e.trip[e.trip.length - 1]?.[0])?.n || ''}`,
        onClick: () => go({ type: 'trip', entry: e, ts: Date.now() - (e.age || 0) * 1000, anchor: e.stop }),
      })));
      renderTimeline();
    } catch (e) {
      if (tok === S.token) $('#lineSub').textContent = `${line.s.length} ${stopsWord(line.s.length)} · ${t('noNsmart')}`;
    }
  };
  load();
  every(REFRESH_MS, load);
  every(20000, renderTimeline);
}

// ======================================================================= TRIP (конкретный автобус)
async function showTrip(v) {
  const tok = S.token;
  let e = v.entry, ts = v.ts || Date.now();
  const color = lineColor(e.line);
  const tr = e.trip;
  const pts = tr.map((s) => [s[1], s[2]]);
  const lineEntry = S.lineByNum.get(e.line);
  const lastName = S.stations.get(tr[tr.length - 1]?.[0])?.n || '';

  $('#sheetHead').innerHTML = `<div class="h-row">${backBtn()}<div class="grow">
    <div class="h-title">${badge(e.line)} <span style="font-size:15px;font-weight:600">→ ${esc(lastName)}</span></div>
    <div class="h-sub" id="tripSub"></div>
    ${lineEntry ? `<div class="tabs"><button class="tab" data-act="line" data-id="${lineEntry.id}" data-stop="${v.anchor}">${t('wholeLine')} ${esc(e.line)}</button></div>` : ''}</div></div>`;
  setSheet('half');

  const routeL = L.layerGroup().addTo(modeLayer);
  let legs = null;
  const drawRoute = () => {
    routeL.clearLayers();
    const nx = e.next ?? 0;
    const cut = Math.max(0, nx - 1);
    const passed = legs ? joinLegs(legs.slice(0, cut + (e.live ? 0 : 0))) : pts.slice(0, cut + 1);
    const ahead = legs ? joinLegs(legs.slice(cut)) : pts.slice(cut);
    if (passed.length > 1) L.polyline(passed, { color: '#9aa0a6', weight: 5, opacity: 0.7, renderer: routeRenderer, interactive: false }).addTo(routeL);
    L.polyline(ahead, { color: '#fff', weight: 9, opacity: 0.9, renderer: routeRenderer, interactive: false }).addTo(routeL);
    L.polyline(ahead, { color, weight: 6, opacity: 0.95, renderer: routeRenderer, interactive: false }).addTo(routeL);
    tr.forEach((s, i) => {
      const isA = s[0] === v.anchor;
      L.circleMarker([s[1], s[2]], { renderer: stopsRenderer, radius: isA ? 8 : 5, color: i < nx ? '#9aa0a6' : color, weight: 3, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(S.stations.get(s[0])?.n || '', { className: 'stop-tip', direction: 'top' })
        .on('click', () => go({ type: 'stop', id: s[0] }))
        .addTo(routeL);
    });
  };
  drawRoute();
  const b = L.latLngBounds(pts);
  if (e.live) b.extend([e.lat, e.lng]);
  fitWithSheet(b);
  roadLegs(pts).then((lg) => { if (tok !== S.token) return; legs = lg; drawRoute(); }).catch(() => {});

  let scrolled = false;
  const render = () => {
    if (tok !== S.token) return;
    const et = tripEtas(e);
    const el = (Date.now() - ts) / 1000;
    const nx = e.next ?? 0;
    $('#tripSub').innerHTML = (e.live ? `<span class="live-dot"></span> ${t('online')}` : `<span class="sched-dot"></span> ${t('bySchedule')}`)
      + (e.garage ? ` · ${t('busNo')} №${esc(e.garage)}` : '') + ` · ${t('updatedL')} ${new Date(ts).toLocaleTimeString(LOCALE)}`;
    const html = tr.map((s, i) => {
      const st = S.stations.get(s[0]);
      const passed = i < nx;
      let tm = '';
      if (!passed && et && et[i] != null) {
        const sec = Math.max(0, et[i] - el);
        tm = `<b>${i === e.t ? '' : '≈'}${fmtEta(sec)}</b><br>${fmtClock(sec)}`;
      }
      const bm = i === nx && e.live ? `<span class="busmark before" style="background:${color}">${BUS_SVG.replace('<svg', '<svg width="13" height="13" fill="#fff"')}</span>` : '';
      return `<div class="ts${i === 0 ? ' first' : ''}${i === tr.length - 1 ? ' last' : ''}${passed ? ' passed' : ''}${s[0] === v.anchor ? ' sel' : ''}" style="--lc:${passed ? '#9aa0a6' : color}" data-sid="${s[0]}">
        ${bm}<span class="dot"></span><div class="nm">${esc(st?.n || t('stopWordCap') + ' ' + s[0])}</div><div class="tm">${tm}</div></div>`;
    }).join('');
    const sb = $('#sheetBody');
    setBody(`${warnHtml(newsFor([e.line]), t('line') + ' ' + e.line)}<div class="timeline">${html}</div>
      <div class="note">${t('tripNote')}</div>`);
    sb.querySelectorAll('.ts').forEach((r) => r.addEventListener('click', () => go({ type: 'stop', id: +r.dataset.sid })));
    if (!scrolled) { sb.querySelector('.busmark, .ts.sel')?.closest('.ts')?.scrollIntoView({ block: 'center' }); scrolled = true; }
    if (e.live) setBuses([{ key: 'trip', num: e.line, lat: e.lat, lng: e.lng, sel: true }]);
  };
  render();

  // обновление: перезапрашиваем прибытия на «якорной» остановке и находим тот же автобус
  const refresh = async () => {
    const tryAnchor = async (anchor) => {
      const j = await api(`/api/arrivals?station=${anchor}`);
      const cand = j.items.filter((x) => x.line === e.line && (e.garage ? x.garage === e.garage : !x.live));
      return cand.length ? [cand.sort((a, b2) => a.sec - b2.sec)[0], j.age] : null;
    };
    try {
      let r = await tryAnchor(v.anchor);
      if (!r) {
        // автобус уже проехал якорную остановку — берём остановку дальше по рейсу
        const idx = tr.findIndex((s) => s[0] === v.anchor);
        for (const k of [Math.min(tr.length - 1, Math.max(idx, e.next ?? 0) + 4), tr.length - 1]) {
          if (k > idx && tr[k]) { r = await tryAnchor(tr[k][0]); if (r) { v.anchor = tr[k][0]; break; } }
        }
      }
      if (tok !== S.token) return;
      if (!r) { $('#tripSub').innerHTML = t('tripEnded'); return; }
      e = r[0]; v.entry = e; ts = Date.now() - r[1] * 1000; v.ts = ts;
      drawRoute(); render();
    } catch (err) { /* оставляем старые данные */ }
  };
  every(REFRESH_MS, refresh);
  every(5000, render);
}

// ======================================================================= PLANNER («Как добраться»)
const WALK_SVG = '<svg viewBox="0 0 24 24"><path d="M13.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3A7.3 7.3 0 0 0 19 13v-2a5 5 0 0 1-4.3-2.4l-1-1.6a2 2 0 0 0-2.4-.9L6 8.3V13h2V9.6l1.8-.7"/></svg>';
const FLAG_COLORS = { from: '#34a853', to: '#e53935' };
function flagIcon(kind) {
  const c = FLAG_COLORS[kind];
  return L.divIcon({
    className: '', iconSize: [34, 46], iconAnchor: [17, 44],
    html: `<div class="flag"><svg viewBox="0 0 34 46"><path d="M17 45C17 45 3 28 3 17a14 14 0 0 1 28 0c0 11-14 28-14 28z" fill="${c}" stroke="#fff" stroke-width="2.5"/></svg><b>${kind === 'from' ? t('A') : t('B')}</b></div>`,
  });
}
const fmtDur = (sec) => { const m = Math.max(1, Math.round(sec / 60)); return m < 60 ? `${m} ${t('min')}` : `${Math.floor(m / 60)} ${t('h')} ${m % 60} ${t('min')}`; };
const fmtKm = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} ${t('m')}` : `${(m / 1000).toFixed(1).replace('.', ',')} ${t('km')}`);
const placeName = (p) => {
  if (!p) return null;
  const [s, d] = nearbyStops(p[0], p[1], 1)[0] || [];
  return s ? (d < 60 ? `${t('stopAbbr')} ${s.n}` : `${t('pointNear')} «${s.n}» (${fmtKm(d)})`) : `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`;
};
const PL = { from: null, to: null };   // сохраняются между открытиями
function openPlanner(o) {
  if (o.from !== undefined && o.from) PL.from = o.from;
  if (o.to !== undefined && o.to) PL.to = o.to;
  if (!PL.from && S.me) PL.from = [...S.me];
  if (S.view?.type === 'plan') show(S.view); else go({ type: 'plan' });
}
function showPlan(v) {
  const tok = S.token;
  let active = !PL.to ? 'to' : !PL.from ? 'from' : null;
  let result = null, selIdx = 0, ts = Date.now(), loading = false, err = null;
  const markers = {};
  const optLayer = L.layerGroup().addTo(modeLayer);
  setSheet('half');

  const head = () => {
    const f = (k, lbl) => {
      const val = k === 'from' && PL.from && S.me && hav(PL.from, S.me) < 30 ? t('myLocation') : placeName(PL[k]);
      return `<div class="rp-field${active === k ? ' active' : ''}" data-f="${k}">
        <span class="lbl" style="background:${FLAG_COLORS[k]}">${lbl}</span>
        <span class="val${val ? '' : ' ph'}">${esc(val || (active === k ? t('tapMap') : k === 'from' ? t('from') : t('to')))}</span>
        <button data-pick="${k}">${active === k ? t('picking') : t('onMap')}</button></div>`;
    };
    $('#sheetHead').innerHTML = `<div class="h-row">${backBtn()}<div class="grow">
      <div class="h-title">${t('howToGet')}</div>
      <div class="rp-fields">${f('from', t('A'))}${f('to', t('B'))}</div>
      <div class="rp-actions"><button id="rpSwap">⇅ ${t('swap')}</button>${S.me ? `<button id="rpMe">◎ ${t('fromMe')}</button>` : ''}</div></div></div>`;
    $('#sheetHead').querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => setActive(b.dataset.pick)));
    $('#sheetHead').querySelectorAll('.rp-field').forEach((b) => b.addEventListener('click', (e) => { if (!e.target.closest('button')) setActive(b.dataset.f); }));
    $('#rpSwap').addEventListener('click', () => { [PL.from, PL.to] = [PL.to, PL.from]; placeFlags(); plan(); });
    $('#rpMe')?.addEventListener('click', () => { PL.from = [...S.me]; placeFlags(); plan(); });
  };
  const setActive = (k) => {
    active = active === k ? null : k;
    S.mapPick = active ? (p) => { PL[active] = p; active = !PL.to ? 'to' : !PL.from ? 'from' : null; placeFlags(); plan(); } : null;
    map.getContainer().style.cursor = active ? 'crosshair' : '';
    if (active && !isDesktop()) setSheet('peek');
    if (active) toast(active === 'to' ? t('tapTo') : t('tapFrom'), 2500);
    head();
  };
  const placeFlags = () => {
    for (const k of ['from', 'to']) {
      if (!PL[k]) { if (markers[k]) { modeLayer.removeLayer(markers[k]); delete markers[k]; } continue; }
      if (!markers[k]) {
        markers[k] = L.marker(PL[k], { icon: flagIcon(k), draggable: true, zIndexOffset: 4000, autoPan: true }).addTo(modeLayer);
        markers[k].on('dragend', () => { const ll = markers[k].getLatLng(); PL[k] = [ll.lat, ll.lng]; plan(); });
      } else markers[k].setLatLng(PL[k]);
    }
    head();
  };

  const busStatus = (l, el) => {
    const w = Math.max(0, l.wait - el);
    if (l.status === 'live') return `<span class="live-dot"></span> ${t('in')} ${fmtEta(l.dep - el)} · ${fmtClock(l.dep - el)}`;
    if (l.status === 'sched') return `<span class="sched-dot"></span> ${t('bySchedule')} ${t('in')} ${fmtEta(l.dep - el)}`;
    if (l.status === 'none') return `<span class="sched-dot"></span> ${t('noTrips')}`;
    return `<span class="sched-dot"></span> ${t('wait')} ≈${fmtDur(w)}`;
  };
  const optionCard = (op, i, el) => {
    const chain = op.legs.map((l) => (l.type === 'walk'
      ? `<span class="walk">${WALK_SVG}${Math.max(1, Math.round(l.sec / 60))} ${t('min')}</span>`
      : `${badge(l.line, true)}${(l.alts || []).map((a) => badge(a.line, true)).join('')}`)).join('<span class="sep">›</span>');
    const first = op.legs.find((l) => l.type === 'bus');
    const walkBefore = op.legs[0].type === 'walk' ? op.legs[0].sec : 0;
    const leaveIn = first && first.status === 'live' ? first.dep - el - walkBefore : null;
    const warnLines = newsFor(op.legs.filter((l) => l.type === 'bus').map((l) => l.line)).filter((it) => !it.restored);
    const tags = [];
    if (i === 0) tags.push(`<span class="opt-tag">${t('optimal')}</span>`);
    if (op.transfers === 0 && op.legs.some((l) => l.type === 'bus')) tags.push(`<span class="opt-tag" style="background:#e8f0fe;color:#1a56c4">${t('noTransfers')}</span>`);
    return `<div class="opt${i === selIdx ? ' sel' : ''}" data-opt="${i}">
      <div class="opt-top"><span class="tt">${fmtDur(op.total - Math.min(el, first?.wait || 0))}</span><span class="km">${fmtKm(op.dist_m)}</span>${tags.join('')}
        <span class="arrive">${t('arrival')} ≈${fmtClock(op.total - Math.min(el, first?.wait || 0))}</span></div>
      <div class="opt-chain">${chain}</div>
      ${first ? `<div class="opt-sub">${busStatus(first, el)} <span class="muted">· ${t('fromStop')} «${esc(S.stations.get(first.from)?.n || '')}»</span></div>` : ''}
      <div class="opt-sub muted" style="color:var(--muted)">${t('walkL')} ${fmtKm(op.walk_m)} · ${op.transfers ? `${op.transfers} ${t('transfer')}` : t('noTransfersL')}${leaveIn != null ? ` · ${leaveIn > 60 ? `${t('leaveIn')} ${fmtEta(leaveIn)}` : `<b style="color:#e8453c">${t('leaveNow')}</b>`}` : ''}</div>
      ${warnLines.length ? `<div class="opt-warn">⚠ ${t('line')} ${warnLines[0].lines.filter((x) => op.legs.some((l) => l.line === x)).join(', ') || ''}: ${t('possibleChange')}</div>` : ''}
    </div>`;
  };
  const stepsHtml = (op, el) => {
    let h = '<div class="steps">';
    op.legs.forEach((l, k) => {
      if (l.type === 'walk') {
        const target = l.toStop ? `${t('toStop')} «${esc(S.stations.get(l.toStop)?.n || '')}»` : t('toDest');
        h += `<div class="step"><span class="ic">${WALK_SVG}</span><div class="t1">${t('walkC')} ${fmtKm(l.m)} · ${fmtDur(l.sec)}</div><div class="t2">${target}</div></div>`;
      } else {
        const c = lineColor(l.line);
        const head2 = S.stations.get(l.head)?.n;
        const alts = (l.alts || []).length ? ` <span style="color:var(--muted);font-weight:400">${t('or')} ${l.alts.map((a) => esc(a.line)).join(', ')}</span>` : '';
        const mids = l.stops.slice(1, -1).map((id) => esc(S.stations.get(id)?.n || id)).join('<br>');
        h += `<div class="step bus" style="--lc:${c}"><span class="ic">${BUS_SVG}</span>
          <div class="t1">${badge(l.line, true)} ${esc(S.stations.get(l.from)?.n || '')}${alts}</div>
          <div class="t2">${head2 ? `${t('towards')} «${esc(head2)}» · ` : ''}${busStatus(l, el)}${l.garage ? ` · №${esc(l.garage)}` : ''}</div>
          ${l.next?.length ? `<div class="t2">${t('nextOnes')}: ${l.next.map((s) => fmtEta(s - el)).join(', ')}</div>` : ''}
          <div class="t2">${l.hops} ${stopsWord(l.hops)} · ${fmtDur(l.ride)} · ${fmtKm(l.dist)}${l.verified ? '' : ` · <span title="${t('unverifiedT')}">${t('unverified')}</span>`}</div>
          ${mids ? `<details class="stoplist"><summary>${t('midStops')}</summary>${mids}</details>` : ''}
          <div class="t1" style="margin-top:6px">${t('exit')}: ${esc(S.stations.get(l.to)?.n || '')}</div></div>`;
      }
      if (k === op.legs.length - 1) h += `<div class="step"><span class="ic" style="background:#e53935"><svg viewBox="0 0 24 24" style="fill:#fff"><path d="M14.4 6 14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg></span><div class="t1">${t('arrived')}</div></div>`;
    });
    return h + '</div>';
  };

  const drawOption = async (op) => {
    optLayer.clearLayers();
    if (!op) return;
    const bounds = L.latLngBounds([PL.from, PL.to]);
    for (const l of op.legs) {
      if (l.type === 'walk') {
        const wl = L.layerGroup().addTo(optLayer);
        const drawWalk = (geo) => {
          wl.clearLayers();
          L.polyline(geo, { color: '#fff', weight: 7, opacity: 0.9, renderer: routeRenderer, interactive: false }).addTo(wl);
          L.polyline(geo, { color: '#1a73e8', weight: 4.5, dashArray: '1 9', lineCap: 'round', renderer: routeRenderer, interactive: false }).addTo(wl);
        };
        if (l.geo && l.geo.length > 1) { l.geo.forEach((p) => bounds.extend(p)); drawWalk(l.geo); continue; }
        drawWalk([l.from, l.to]);
        if (l.street !== false || !l.geoTried) {
          l.geoTried = true;
          api(`/api/walk?from=${l.from[0]},${l.from[1]}&to=${l.to[0]},${l.to[1]}`)
            .then((j) => { if (j.street) l.geo = j.geo; if (tok === S.token && optLayer.hasLayer(wl)) drawWalk(j.geo); })
            .catch(() => {});
        }
        continue;
      }
      const pts = l.stops.map((id) => { const s = S.stations.get(id); return [s.la, s.lo]; });
      pts.forEach((p) => bounds.extend(p));
      const c = lineColor(l.line);
      const lineL = L.layerGroup().addTo(optLayer);
      const drawLine = (geo) => {
        lineL.clearLayers();
        L.polyline(geo, { color: '#fff', weight: 10, opacity: 0.95, renderer: routeRenderer, interactive: false }).addTo(lineL);
        L.polyline(geo, { color: c, weight: 6.5, renderer: routeRenderer, interactive: false }).addTo(lineL);
        l.stops.forEach((id, k) => {
          const s = S.stations.get(id);
          const end = k === 0 || k === l.stops.length - 1;
          L.circleMarker([s.la, s.lo], { renderer: stopsRenderer, radius: end ? 7 : 4, color: c, weight: end ? 3.5 : 2.5, fillColor: '#fff', fillOpacity: 1 })
            .bindTooltip(`${end ? (k === 0 ? t('board') + ': ' : t('exit') + ': ') : ''}${s.n}`, { className: 'stop-tip', direction: 'top', permanent: end && isDesktop() })
            .on('click', () => go({ type: 'stop', id }))
            .addTo(lineL);
        });
      };
      drawLine(pts);
      roadLegs(pts).then((lg) => { if (tok === S.token && result?.options[selIdx] === op) drawLine(joinLegs(lg)); }).catch(() => {});
    }
    fitWithSheet(bounds.pad(0.05));
  };

  const render = () => {
    if (tok !== S.token) return;
    const el = (Date.now() - ts) / 1000;
    if (!PL.to || !PL.from) {
      setBody(`<div class="note">${!PL.to ? t('planHintTo') : t('planHintFrom')}<br><br>${t('flagsDrag')}</div>`);
      return;
    }
    if (loading && !result) { setBody(`<div class="empty">${t('searchingPlan')}</div>`); return; }
    if (err) { setBody(`<div class="empty">${t('planFail')}: ${esc(err)}</div>`); return; }
    if (!result) return;
    const ops = result.options;
    let h = '';
    if (!ops.length) {
      h += result.walk ? `<div class="note">${t('walkFaster')}: ${fmtDur(result.walk.total)} (${fmtKm(result.walk.walk_m)}).</div>` : `<div class="empty">${t('noOptions')}</div>`;
    } else {
      h += `<div class="section-title">${t('options')} · ${t('updatedL')} ${new Date(ts).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}</div>`;
      h += ops.map((op, i) => optionCard(op, i, el)).join('');
      if (result.walk) h += `<div class="opt" data-walkopt="1"><div class="opt-top"><span class="tt" style="font-size:16px">${WALK_SVG.replace('<svg', '<svg width="18" height="18" style="vertical-align:-3px;fill:#5f6368"')} ${fmtDur(result.walk.total)}</span><span class="km">${fmtKm(result.walk.walk_m)} ${t('walkL')}</span></div></div>`;
      const op = ops[selIdx];
      if (op) {
        h += `<div class="section-title">${t('details')} ${selIdx + 1}</div>`;
        h += warnHtml(newsFor(op.legs.filter((l) => l.type === 'bus').map((l) => l.line)), t('onThisRoute'));
        h += stepsHtml(op, el);
      }
      h += `<div class="note">${t('planNote')}</div>`;
    }
    setBody(h);
    $('#sheetBody').querySelector('[data-walkopt]')?.addEventListener('click', () => drawOption(result.walk));
    $('#sheetBody').querySelectorAll('[data-opt]').forEach((r) => r.addEventListener('click', () => {
      selIdx = +r.dataset.opt; render(); drawOption(result.options[selIdx]);
      $('#sheetBody').querySelectorAll('.section-title')[1]?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }));
  };

  let reqId = 0;
  const plan = async (keepSel) => {
    render();
    if (!PL.from || !PL.to) { optLayer.clearLayers(); return; }
    const my = ++reqId;
    loading = true; err = null;
    if (!keepSel) { result = null; selIdx = 0; render(); }
    try {
      const j = await api(`/api/plan?from=${PL.from[0].toFixed(6)},${PL.from[1].toFixed(6)}&to=${PL.to[0].toFixed(6)},${PL.to[1].toFixed(6)}`);
      if (tok !== S.token || my !== reqId) return;
      result = j; ts = Date.now();
      if (selIdx >= j.options.length) selIdx = 0;
      loading = false;
      render();
      if (!keepSel) { drawOption(j.options[selIdx] || j.walk); if (!isDesktop()) setSheet('half'); }
      history.replaceState(history.state, '', `?from=${PL.from[0].toFixed(5)},${PL.from[1].toFixed(5)}&to=${PL.to[0].toFixed(5)},${PL.to[1].toFixed(5)}`);
    } catch (e) {
      if (tok !== S.token || my !== reqId) return;
      loading = false; err = e.message; render();
    }
  };

  placeFlags();
  if (active) setActive(active); else head();
  if (PL.from && PL.to) plan();
  else render();
  every(30000, () => plan(true));
  every(10000, render);
}

// ======================================================================= search
const qEl = $('#q');
function doSearch() {
  const q = norm(qEl.value.trim());
  $('#qclear').classList.toggle('hidden', !qEl.value);
  const res = $('#results');
  if (!q) { res.classList.add('hidden'); return; }
  const lines = S.lines.filter((l) => norm(l.n).startsWith(q)).slice(0, 8);
  const words = q.split(/\s+/);
  const stops = [...S.stations.values()].filter((s) => { const n = norm(s.n + ' ' + s.c); return words.every((w) => n.includes(w)); })
    .sort((a, b) => (b.c === 'Novi Sad') - (a.c === 'Novi Sad') || a.n.localeCompare(b.n)).slice(0, 25);
  let html = lines.map((l) => `<div class="res" data-line="${l.id}">${badge(l.n)}<div style="flex:1;min-width:0"><div>${t('busC')} ${esc(l.n)}</div><div class="sub">${esc(l.t)}</div></div></div>`).join('');
  html += stops.map((s) => stopRow(s).replace('data-act="stop"', 'data-stopid')).join('');
  res.innerHTML = html || `<div class="empty">${t('nothingFound')}</div>`;
  res.classList.remove('hidden');
}
qEl.addEventListener('input', doSearch);
qEl.addEventListener('focus', () => { if (qEl.value) doSearch(); });
$('#qclear').addEventListener('click', () => { qEl.value = ''; doSearch(); qEl.focus(); });
$('#results').addEventListener('click', (e) => {
  const r = e.target.closest('.res');
  if (!r) return;
  $('#results').classList.add('hidden');
  qEl.blur();
  if (r.dataset.line) go({ type: 'line', id: r.dataset.line });
  else go({ type: 'stop', id: +r.dataset.id });
});

// ======================================================================= controls
$('#btnRoute').addEventListener('click', () => openPlanner({}));
$('#btnLayers').addEventListener('click', (e) => { e.stopPropagation(); $('#layerMenu').classList.toggle('hidden'); });
$('#layerMenu').querySelectorAll('button').forEach((b) => {
  b.classList.toggle('active', b.dataset.layer === curTiles);
  b.addEventListener('click', () => {
    map.removeLayer(tileLayers[curTiles]);
    curTiles = b.dataset.layer;
    tileLayers[curTiles].addTo(map);
    localStorage.setItem('nsbus.layer', curTiles);
    $('#layerMenu').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    $('#layerMenu').classList.add('hidden');
  });
});
let watching = false;
$('#btnLocate').addEventListener('click', () => {
  if (!navigator.geolocation) return toast(t('geoNA'));
  if (!window.isSecureContext) return toast(t('geoHttps'), 6000);
  const onPos = (p, fly) => {
    S.me = [p.coords.latitude, p.coords.longitude];
    if (!meMarker) meMarker = L.marker(S.me, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 3000, title: t('youHere') }).addTo(map);
    else meMarker.setLatLng(S.me);
    $('#btnLocate').classList.add('on');
    if (fly) map.flyTo(offsetForSheet(S.me, 16), 16, { duration: 0.7 });
    if (S.view?.type === 'home') showHome();
  };
  navigator.geolocation.getCurrentPosition((p) => {
    onPos(p, true);
    if (S.view?.type === 'home') setSheet('half');
    if (!watching) { watching = true; navigator.geolocation.watchPosition((q) => onPos(q, false), () => {}, { enableHighAccuracy: true }); }
  }, (err) => toast(t('geoFail') + ': ' + err.message), { enableHighAccuracy: true, timeout: 15000 });
});

// ======================================================================= boot
async function boot() {
  $('#sheetHead').innerHTML = `<div class="h-title">${t('appTitle')}</div><div class="h-sub">${t('loadingNet')}</div>`;
  let net;
  for (let i = 0; i < 4; i++) {
    try { net = await api('/api/network'); break; } catch (e) {
      $('#sheetHead').querySelector('.h-sub').textContent = `${t('loadErr')} (${e.message}), ${t('retry')}`;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!net) { $('#sheetHead').querySelector('.h-sub').textContent = t('loadFail'); return; }
  for (const s of net.stations) S.stations.set(s.id, s);
  S.lines = net.lines;
  for (const l of S.lines) { S.lineById.set(l.id, l); if (!S.lineByNum.has(l.n)) S.lineByNum.set(l.n, l); }
  const validNums = new Set(S.lines.map((l) => l.n));
  for (const s of S.stations.values()) s.l = s.l.filter((n) => validNums.has(n)).sort((a, b) => (parseInt(a) || 999) - (parseInt(b) || 999) || a.localeCompare(b));
  for (const s of S.stations.values()) {
    if (!s.l.length) continue;
    L.circleMarker([s.la, s.lo], { renderer: stopsRenderer, radius: 5, color: '#1a73e8', weight: 2.5, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(s.n, { className: 'stop-tip', direction: 'top' })
      .on('click', () => go({ type: 'stop', id: s.id, noFly: false }))
      .addTo(allStopsLayer);
  }
  stack.length = 0; stack.push({ type: 'home' });
  history.replaceState({ d: 1 }, '');
  show(stack[0]);
  setSheet(isDesktop() ? 'half' : 'peek');
  loadNews();
  setInterval(loadNews, 30 * 60 * 1000);
  // прямые ссылки: ?stop=6532  ·  ?line=7A  ·  ?from=lat,lng&to=lat,lng
  const qs = new URLSearchParams(location.search);
  const ll = (s) => { const p = (s || '').split(',').map(Number); return p.length === 2 && p.every(Number.isFinite) ? p : null; };
  if (ll(qs.get('to'))) openPlanner({ from: ll(qs.get('from')), to: ll(qs.get('to')) });
  else if (qs.get('stop') && S.stations.has(+qs.get('stop'))) go({ type: 'stop', id: +qs.get('stop'), open: qs.has('open') ? +qs.get('open') : null });
  else if (qs.get('line')) {
    const l = S.lineByNum.get(qs.get('line')) || S.lineById.get(qs.get('line'));
    if (l) go({ type: 'line', id: l.id });
  }
}
boot();

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
