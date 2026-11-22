// Public site + signed-in dashboard. No secrets here: everything sensitive stays on the server.
// User data is always rendered with textContent (never innerHTML).
(function () {
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const LWC = window.LightweightCharts;

  const VEG_META = {
    tomato: { img: '/img/photos/tomato-card.jpg', color: '#e2483a', soft: 'rgba(226,72,58,' },
    onion: { img: '/img/photos/onion-card.jpg', color: '#a24b8f', soft: 'rgba(162,75,143,' },
    potato: { img: '/img/photos/potato-card.jpg', color: '#b98a4e', soft: 'rgba(185,138,78,' },
  };
  const TYPE_ICONS = { 'Independent restaurant': '🍽️', 'Cloud kitchen': '🛵', 'Café': '☕', 'Small food business': '🥘', Other: '✨' };
  const SIGNAL = { buy: { label: 'Buy now ▲', cls: 'buy' }, wait: { label: 'Wait ▼', cls: 'wait' }, steady: { label: 'Steady ●', cls: 'steady' } };

  let me = null; let prices = null; let businessTypes = [];

  async function api(path, body, method = 'POST') {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: Object.assign({ 'X-MB-Request': '1' }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  }

  // ---------- small helpers ----------
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const img = (src, w) => { const i = document.createElement('img'); i.src = src; i.alt = ''; i.width = w; i.height = w; return i; };
  const rupee = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rupee0 = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
  const pct = (n) => (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  const fmtDate = (t) => new Date(t + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const store = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* private mode */ } } };

  function countUp(node, to, { decimals = 0, prefix = '', dur = 1200 } = {}) {
    if (reduceMotion) { node.textContent = prefix + to.toFixed(decimals); return; }
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur); const e = 1 - Math.pow(1 - k, 3);
      node.textContent = prefix + (to * e).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- nav, reveal-on-scroll ----------
  const nav = $('#nav');
  addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 8), { passive: true });

  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      en.target.classList.add('in');
      $$('[data-count]', en.target).forEach((n) => countUp(n, Number(n.dataset.count)));
      io.unobserve(en.target);
    });
  }, { threshold: 0.12 }) : null;
  const observeReveals = (root = document) => $$('[data-reveal]:not(.in)', root).forEach((n) => (io ? io.observe(n) : n.classList.add('in')));
  observeReveals();

  // ---------- hero carousel ----------
  (function carousel() {
    const slides = $$('.slide'); const dots = $$('#dots button'); const pauseBtn = $('#pauseBtn');
    if (!slides.length || !pauseBtn) return; // hero slider replaced by the scroll story
    let i = 0; let timer = null; let paused = reduceMotion;
    const go = (n) => {
      i = (n + slides.length) % slides.length;
      slides.forEach((s, k) => { s.classList.toggle('is-on', k === i); s.setAttribute('aria-hidden', String(k !== i)); });
      dots.forEach((d, k) => d.setAttribute('aria-selected', String(k === i)));
    };
    const play = () => { clearInterval(timer); if (!paused) timer = setInterval(() => go(i + 1), 6000); };
    dots.forEach((d, k) => d.addEventListener('click', () => { go(k); play(); }));
    pauseBtn.addEventListener('click', () => {
      paused = !paused; pauseBtn.textContent = paused ? '▶' : '❚❚';
      pauseBtn.setAttribute('aria-label', paused ? 'Play slides' : 'Pause slides'); play();
    });
    const hero = $('.hero');
    hero.addEventListener('mouseenter', () => clearInterval(timer));
    hero.addEventListener('mouseleave', play);
    let x0 = null;
    hero.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    hero.addEventListener('touchend', (e) => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 40) { go(i + (dx < 0 ? 1 : -1)); play(); } x0 = null; });
    if (paused) pauseBtn.textContent = '▶';
    go(0); play();
  })();

  // ---------- charts (TradingView lightweight-charts) ----------
  function baseChart(container, { compact = false } = {}) {
    return LWC.createChart(container, {
      autoSize: true,
      // attributionLogo off: TradingView is credited in text under each chart and in the footer instead (allowed by its licence)
      layout: { background: { type: 'solid', color: 'rgba(0,0,0,0)' }, textColor: '#8f8f8f', fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 12, attributionLogo: false },
      grid: { vertLines: { color: compact ? 'rgba(0,0,0,0)' : '#1d1d1d' }, horzLines: { color: '#1d1d1d' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: compact ? 0.08 : 0.22 } },
      timeScale: { borderVisible: false, rightOffset: 2, fixLeftEdge: true },
      crosshair: { mode: 0, vertLine: { color: '#555', labelBackgroundColor: '#e2483a' }, horzLine: { color: '#555', labelBackgroundColor: '#e2483a' } },
      localization: { priceFormatter: (p) => '₹' + p.toFixed(2), locale: 'en-IN' },
      handleScroll: !compact, handleScale: !compact,
    });
  }
  const fcLine = (v) => [{ time: v.candles[v.candles.length - 1].time, value: v.today }].concat(v.forecast.map((f) => ({ time: f.time, value: f.value })));
  const fcBand = (v, key) => [{ time: v.candles[v.candles.length - 1].time, value: v.today }].concat(v.forecast.map((f) => ({ time: f.time, value: f[key] })));

  // Draw a series progressively (about 1 s) so the chart visibly grows; instant if reduced motion.
  function growSeries(series, data, onStep, onDone) {
    if (reduceMotion || data.length < 3) { series.setData(data); if (onStep) onStep(); if (onDone) onDone(); return; }
    const t0 = performance.now(); const dur = 1100; let last = -1;
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / dur); const n = Math.max(2, Math.round(data.length * (1 - Math.pow(1 - k, 2))));
      if (n !== last) { series.setData(data.slice(0, n)); last = n; if (onStep) onStep(); }
      if (k < 1) requestAnimationFrame(tick); else if (onDone) onDone();
    };
    requestAnimationFrame(tick);
  }

  // background theme follows the chosen vegetable (tomato red, onion violet/blue, potato gold/brown)
  // chart colours per theme (r,g,b): tomato red, onion violet, potato gold
  const THEME_RGB = { tomato: '226,72,58', onion: '139,92,246', potato: '212,160,23' };
  const themeRgb = (key) => THEME_RGB[key] || THEME_RGB.tomato;
  function setVegTheme(key) {
    window.mbSelectedVeg = key;
    if (!window.mbStoryActive) document.body.dataset.veg = key;
  }
  window.mbSetVegTheme = setVegTheme;

  // public preview chart: 3 months + forecast
  const pub = { chart: null, area: null, fc: null, key: 'tomato' };
  function drawPublic(key) {
    if (!LWC || !prices) return;
    const v = prices.veg.find((x) => x.key === key); const m = VEG_META[key]; pub.key = key;
    setVegTheme(key);
    if (!pub.chart) {
      pub.chart = baseChart($('#pubChart'), { compact: true });
      pub.area = pub.chart.addSeries(LWC.AreaSeries, { lineWidth: 3, priceLineVisible: false });
      pub.fc = pub.chart.addSeries(LWC.LineSeries, { lineWidth: 3, lineStyle: 2, priceLineVisible: false, lastValueVisible: true });
    }
    const rgb = themeRgb(key);
    pub.area.applyOptions({ lineColor: '#ffffff', topColor: `rgba(${rgb},0.38)`, bottomColor: `rgba(${rgb},0)` });
    pub.fc.applyOptions({ color: `rgb(${rgb})` });
    // the line grows from left to right, then the forecast appears
    pub.fc.setData([]);
    growSeries(pub.area, v.candles.slice(-90).map((c) => ({ time: c.time, value: c.close })), () => pub.chart.timeScale().fitContent(), () => { pub.fc.setData(fcLine(v)); pub.chart.timeScale().fitContent(); });

    const pi = $('#pubImg'); pi.src = m.img; pi.classList.remove('swap'); void pi.offsetWidth; pi.classList.add('swap');
    $('#pubName').textContent = v.name;
    countUp($('#pubPrice'), v.today, { decimals: 2, dur: 700 });
    const chg = $('#pubChg'); chg.textContent = `${pct(v.change1d)} today · ${pct(v.change7d)} this week`; chg.className = 'chg ' + (v.change1d >= 0 ? 'up' : 'down');
    const s = SIGNAL[v.signal]; const sig = $('#pubSignal'); sig.replaceChildren(el('span', 'pill ' + s.cls, s.label));
    $('#pubNote').textContent = v.note;
    renderMarkets($('#mktBody'), v);
  }

  // today's real rates in every Pune mandi for one vegetable (rendered with textContent only)
  function renderMarkets(tbody, v) {
    if (!tbody || !v) return;
    $$('.mkt-veg').forEach((n) => { n.textContent = v.name; });
    if (!v.markets.length) { const tr = el('tr'); const td = el('td', 'muted', 'No mandi reported this vegetable today.'); td.colSpan = 4; tr.append(td); tbody.replaceChildren(tr); return; }
    tbody.replaceChildren(...v.markets.map((m) => {
      const tr = el('tr', m.market === 'APMC Pune' ? 'main' : '');
      tr.append(el('td', null, m.market === 'APMC Pune' ? 'APMC Pune (Gultekdi)' : m.market), el('td', 'num strong', rupee(m.modal)), el('td', 'num', rupee(m.min)), el('td', 'num', rupee(m.max)));
      return tr;
    }));
  }

  function vegTabs(container, onPick, selected) {
    container.replaceChildren(...prices.veg.map((v) => {
      const b = el('button'); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.key = v.key;
      b.setAttribute('aria-selected', String(v.key === selected));
      b.append(img(VEG_META[v.key].img, 30), document.createTextNode(v.name));
      b.addEventListener('click', () => { $$('button', container).forEach((x) => x.setAttribute('aria-selected', String(x === b))); onPick(v.key); });
      return b;
    }));
  }

  function renderTicker() {
    const items = prices.veg.map((v) => {
      const s = el('span', 'tk'); s.append(img(VEG_META[v.key].img, 26), el('span', null, v.name), el('span', 'tk-p', rupee(v.today) + '/kg'));
      s.append(el('span', v.change1d >= 0 ? 'up' : 'down', (v.change1d >= 0 ? '▲ ' : '▼ ') + Math.abs(v.change1d).toFixed(2) + '%'));
      s.append(el('span', 'muted', '· APMC Pune · 14-day est. ' + rupee(v.forecast[v.forecast.length - 1].value)));
      return s;
    });
    const track = $('#ticker'); const list = [];
    for (let k = 0; k < 4; k++) items.forEach((n) => list.push(n.cloneNode(true)));
    track.replaceChildren(...list);
    $$('.tk', track).forEach((n, k) => { if (k >= items.length) n.setAttribute('aria-hidden', 'true'); });
  }

  // ---------- dashboard ----------
  const dash = { chart: null, candle: null, area: null, vol: null, fc: null, hi: null, lo: null, key: 'tomato', range: 90, type: 'candles', showFc: true };

  function sparkSvg(v) {
    const pts = v.candles.slice(-30).map((c) => c.close);
    const min = Math.min(...pts); const max = Math.max(...pts); const W = 300; const H = 48;
    const xy = pts.map((p, k) => [(k / (pts.length - 1)) * W, H - 4 - ((p - min) / (max - min || 1)) * (H - 8)]);
    const d = xy.map(([x, y], k) => (k ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join(' ');
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'spark'); svg.setAttribute('aria-hidden', 'true');
    const color = v.change7d >= 0 ? '#3ecf7a' : '#ff5a4d';
    const area = document.createElementNS(NS, 'path'); area.setAttribute('d', d + ` L${W} ${H} L0 ${H} Z`); area.setAttribute('class', 'area'); area.setAttribute('fill', color);
    const line = document.createElementNS(NS, 'path'); line.setAttribute('d', d); line.setAttribute('stroke', color);
    svg.append(area, line); return svg;
  }

  function renderVegCards() {
    $('#vegCards').replaceChildren(...prices.veg.map((v) => {
      const c = el('button', 'vc' + (v.key === dash.key ? ' on' : '')); c.type = 'button'; c.dataset.key = v.key;
      c.setAttribute('aria-label', `${v.name}: show chart`);
      const price = el('p', 'vc-price'); const num = el('span', null, '0'); price.append(num, el('small', null, ' ₹/kg'));
      const chg = el('p', 'chg ' + (v.change1d >= 0 ? 'up' : 'down'), `${pct(v.change1d)} today · ${pct(v.change7d)} 7d`);
      const s = SIGNAL[v.signal];
      c.append(img(VEG_META[v.key].img, 110), el('p', 'vc-name', v.name), price, chg, sparkSvg(v), el('span', 'pill ' + s.cls, s.label));
      c.addEventListener('click', () => { pickDashVeg(v.key); $('.chart-panel').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' }); });
      countUp(num, v.today, { decimals: 2, dur: 900 });
      return c;
    }));
  }

  function pickDashVeg(key) {
    dash.key = key;
    setVegTheme(key);
    $$('#vegCards .vc').forEach((c) => c.classList.toggle('on', c.dataset.key === key));
    $$('#appTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.key === key)));
    drawDash();
  }

  function setOhlc(v, time) {
    const box = $('#ohlc'); const parts = [];
    const c = time ? v.candles.find((x) => x.time === time) : v.candles[v.candles.length - 1];
    const f = time && !c ? v.forecast.find((x) => x.time === time) : null;
    parts.push(el('span', 't', v.name + ' · ' + fmtDate(time || c.time)));
    if (c) {
      const up = c.close >= c.open;
      const add = (label, text, cls) => { const s = el('span', null, label + ' '); s.append(el('b', cls || null, text)); parts.push(s); };
      add('Modal', rupee(c.close) + '/kg', up ? 'up' : 'down');
      add('Day range', rupee(c.low) + ' – ' + rupee(c.high));
      add('Previous', rupee(c.open));
      if (c.markets) add('Mandis reporting', String(c.markets));
    } else if (f) {
      const s = el('span', null, 'Estimate '); s.append(el('b', null, rupee(f.value))); parts.push(s);
      const r = el('span', null, 'Likely range '); r.append(el('b', null, rupee(f.lo) + ' – ' + rupee(f.hi))); parts.push(r);
    }
    box.replaceChildren(...parts);
  }

  function drawDash() {
    if (!LWC || !prices) return;
    const v = prices.veg.find((x) => x.key === dash.key); const m = VEG_META[dash.key];
    if (!dash.chart) {
      dash.chart = baseChart($('#mainChart'));
      dash.candle = dash.chart.addSeries(LWC.CandlestickSeries, { upColor: '#3ecf7a', downColor: '#ff5a4d', borderVisible: false, wickUpColor: '#3ecf7a', wickDownColor: '#ff5a4d' });
      dash.area = dash.chart.addSeries(LWC.AreaSeries, { lineWidth: 2, priceLineVisible: true });
      dash.hi = dash.chart.addSeries(LWC.LineSeries, { lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      dash.lo = dash.chart.addSeries(LWC.LineSeries, { lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      dash.fc = dash.chart.addSeries(LWC.LineSeries, { lineWidth: 3, lineStyle: 2, priceLineVisible: false });
      dash.chart.subscribeCrosshairMove((p) => { const cur = prices.veg.find((x) => x.key === dash.key); setOhlc(cur, p && p.time ? p.time : null); });
    }
    const growDash = !dash.grown || dash.grownKey !== dash.key;
    dash.grown = true; dash.grownKey = dash.key;
    if (growDash) growSeries(dash.candle, v.candles, null, () => applyDashOptions()); else dash.candle.setData(v.candles);
    dash.area.setData(v.candles.map((c) => ({ time: c.time, value: c.close })));
    const rgbD = themeRgb(dash.key);
    dash.area.applyOptions({ lineColor: `rgb(${rgbD})`, topColor: `rgba(${rgbD},0.3)`, bottomColor: `rgba(${rgbD},0)` });
    dash.fc.setData(fcLine(v)); dash.hi.setData(fcBand(v, 'hi')); dash.lo.setData(fcBand(v, 'lo'));
    dash.fc.applyOptions({ color: `rgb(${rgbD})` }); dash.hi.applyOptions({ color: `rgba(${rgbD},0.45)` }); dash.lo.applyOptions({ color: `rgba(${rgbD},0.45)` });
    applyDashOptions();
    setOhlc(v, null);
    renderMarkets($('#appMktBody'), v);
  }

  function applyDashOptions() {
    const v = prices.veg.find((x) => x.key === dash.key);
    const candles = dash.type === 'candles';
    dash.candle.applyOptions({ visible: candles }); dash.area.applyOptions({ visible: !candles });
    [dash.fc, dash.hi, dash.lo].forEach((s) => s.applyOptions({ visible: dash.showFc }));
    const last = new Date(v.candles[v.candles.length - 1].time + 'T00:00:00Z');
    const cutoff = new Date(last.getTime() - dash.range * 86400000).toISOString().slice(0, 10);
    const from = (v.candles.find((c) => c.time >= cutoff) || v.candles[0]).time;
    const to = dash.showFc ? v.forecast[v.forecast.length - 1].time : v.candles[v.candles.length - 1].time;
    dash.chart.timeScale().setVisibleRange({ from, to });
  }

  $('#rangeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $$('#rangeSeg button').forEach((x) => x.classList.toggle('on', x === b)); dash.range = Number(b.dataset.range); applyDashOptions(); });
  $('#typeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $$('#typeSeg button').forEach((x) => x.classList.toggle('on', x === b)); dash.type = b.dataset.type; applyDashOptions(); });
  $('#fcToggle').addEventListener('change', (e) => { dash.showFc = e.target.checked; applyDashOptions(); });

  function renderBrief() {
    $('#briefList').replaceChildren(...prices.veg.map((v) => {
      const li = el('li'); const s = SIGNAL[v.signal];
      const top = el('div', 'bl-top'); top.append(el('span', null, v.name), el('span', 'pill ' + s.cls, s.label));
      const conf = el('div', 'conf'); const bar = el('i'); conf.append(bar);
      requestAnimationFrame(() => setTimeout(() => { bar.style.width = v.confidence + '%'; }, 150));
      const body = el('div'); body.append(top, el('p', null, v.note), conf, el('p', 'conf-l', `${v.confidence}% confident · next 7 days avg ${rupee(v.forecast.slice(0, 7).reduce((a, f) => a + f.value, 0) / 7)}/kg`));
      li.append(img(VEG_META[v.key].img, 52), body);
      return li;
    }));
  }

  const plan = store.get('mb_plan', { tomato: 40, onion: 50, potato: 30 });
  function renderPlanner() {
    $('#planRows').replaceChildren(...prices.veg.map((v) => {
      const row = el('div', 'plan-row');
      const id = 'plan-' + v.key;
      const range = document.createElement('input'); range.type = 'range'; range.min = '0'; range.max = '200'; range.step = '5'; range.id = id;
      range.value = String(plan[v.key] != null ? plan[v.key] : 30); range.setAttribute('aria-label', `${v.name} kg per week`);
      const out = el('output', null, range.value + ' kg'); out.htmlFor = id;
      range.addEventListener('input', () => { plan[v.key] = Number(range.value); out.textContent = range.value + ' kg'; store.set('mb_plan', plan); updatePlanTotals(); });
      row.append(img(VEG_META[v.key].img, 36), el('b', null, v.name), range, out);
      return row;
    }));
    updatePlanTotals();
  }
  function updatePlanTotals() {
    let now = 0; let save = 0;
    prices.veg.forEach((v) => {
      const kg = plan[v.key] || 0; const avg7 = v.forecast.slice(0, 7).reduce((a, f) => a + f.value, 0) / 7;
      now += kg * v.today;
      if (v.signal !== 'steady') save += kg * Math.abs(avg7 - v.today); // buy now before a rise, or wait through a fall
    });
    $('#ptNow').textContent = rupee0(now);
    $('#ptSave').textContent = save >= 1 ? 'Save ~' + rupee0(save) : 'No change';
  }

  function renderDashboard() {
    if (!prices || !me) return;
    const h = new Date().getHours();
    $('#greet').textContent = (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + ', ' + me.name.split(' ')[0];
    $('#bizLine').textContent = [me.business, me.businessType, me.city].filter(Boolean).join(' · ') || 'Add your business details';
    $('#asOf').textContent = prices.asOf ? fmtDate(prices.asOf) : '–';
    if (!prices.veg.some((x) => x.key === dash.key) && prices.veg.length) dash.key = prices.veg[0].key;
    renderVegCards();
    vegTabs($('#appTabs'), pickDashVeg, dash.key);
    drawDash(); renderBrief(); renderPlanner();
    observeReveals($('#app'));
  }

  // ---------- views ----------
  function setView(signedIn) {
    document.body.dataset.view = signedIn ? 'app' : 'site';
    $('#site').hidden = signedIn; $('#app').hidden = !signedIn;
    $$('[data-site]').forEach((n) => { n.hidden = signedIn; });
    $$('[data-app]').forEach((n) => { n.hidden = !signedIn; });
    $('#userMenu').hidden = true;
  }

  function onSignedIn(user) {
    me = user;
    $('#avatar').textContent = (user.name || '?').trim().charAt(0).toUpperCase();
    $('#chipName').textContent = user.name.split(' ')[0];
    $('#umName').textContent = user.name; $('#umMail').textContent = user.email;
    if ($('#authModal').open) $('#authModal').close();
    setView(true);
    scrollTo({ top: 0, behavior: 'auto' });
    renderDashboard();
    if (user.needsProfile) openProfile(true);
  }

  function onSignedOut() {
    me = null; setView(false);
    if (pub.chart) requestAnimationFrame(() => drawPublic(pub.key));
  }

  // ---------- auth modal ----------
  const forms = { signup: $('#signupForm'), login: $('#loginForm') };
  const tabs = { signup: $('#tab-signup'), login: $('#tab-login') };
  function showTab(name) {
    for (const k of Object.keys(forms)) { forms[k].hidden = k !== name; tabs[k].setAttribute('aria-selected', String(k === name)); }
    $('#authTitle').textContent = name === 'signup' ? 'Join MolBhav' : 'Welcome back';
  }
  function openAuth(tab) {
    showTab(tab); const d = $('#authModal');
    if (!d.open) d.showModal();
    const first = forms[tab].querySelector('input'); if (first) first.focus({ preventScroll: true });
  }
  $$('[data-open]').forEach((b) => b.addEventListener('click', () => openAuth(b.dataset.open)));
  Object.entries(tabs).forEach(([k, t]) => t.addEventListener('click', () => showTab(k)));
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#authModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }); // click on backdrop

  async function submit(form, path, errEl) {
    const btn = form.querySelector('button[type="submit"]');
    errEl.textContent = ''; btn.disabled = true;
    try {
      const { user } = await api(path, Object.fromEntries(new FormData(form).entries()));
      form.reset(); onSignedIn(user);
    } catch (e) { errEl.textContent = e.message; } finally { btn.disabled = false; }
  }
  forms.signup.addEventListener('submit', (e) => { e.preventDefault(); submit(forms.signup, '/api/signup', $('#signupError')); });
  forms.login.addEventListener('submit', (e) => { e.preventDefault(); submit(forms.login, '/api/login', $('#loginError')); });
  // Links like /#signup (from the pre-order page) open the sign-up form straight away.
  if (location.hash === '#signup') openAuth('signup');

  // ---------- business details ----------
  let profileRequired = false;
  function buildTypeGrid() {
    const grid = $('#typeGrid'); const legend = $('legend', grid);
    grid.replaceChildren(legend, ...businessTypes.map((t, k) => {
      const lab = el('label', 'type-opt');
      const r = document.createElement('input'); r.type = 'radio'; r.name = 'businessType'; r.value = t; r.id = 'bt' + k;
      const s = el('span'); s.append(el('i', null, TYPE_ICONS[t] || '🏪'), document.createTextNode(t));
      lab.append(r, s); return lab;
    }));
  }
  function openProfile(required) {
    profileRequired = required;
    const f = $('#profileForm');
    f.business.value = (me && me.business) || '';
    f.city.value = (me && me.city) || 'Pune';
    $$('input[name="businessType"]', f).forEach((r) => { r.checked = !!me && r.value === me.businessType; });
    $('#profStep').textContent = required ? 'One last step' : 'Your business';
    $('#profClose').hidden = required;
    $('#profileError').textContent = '';
    $('#profileModal').showModal();
    f.business.focus();
  }
  $('#profileModal').addEventListener('cancel', (e) => { if (profileRequired) e.preventDefault(); }); // Esc can't skip the required step
  $('#profClose').addEventListener('click', () => $('#profileModal').close());
  $('#profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget; const btn = f.querySelector('button[type="submit"]'); const err = $('#profileError');
    const picked = f.querySelector('input[name="businessType"]:checked');
    err.textContent = '';
    if (!f.business.value.trim()) { err.textContent = 'Please enter your business name.'; f.business.focus(); return; }
    if (!picked) { err.textContent = 'Please choose a business type.'; return; }
    btn.disabled = true;
    try {
      const { user } = await api('/api/profile', { business: f.business.value, businessType: picked.value, city: f.city.value });
      me = user; profileRequired = false; $('#profileModal').close(); renderDashboard();
    } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
  });
  $('#editProfileBtn').addEventListener('click', () => { $('#userMenu').hidden = true; openProfile(false); });
  $('#editProfileBtn2').addEventListener('click', () => openProfile(false));

  // ---------- user menu / logout ----------
  $('#userChip').addEventListener('click', (e) => {
    e.stopPropagation(); const m = $('#userMenu'); m.hidden = !m.hidden; $('#userChip').setAttribute('aria-expanded', String(!m.hidden));
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#userMenu')) { $('#userMenu').hidden = true; $('#userChip').setAttribute('aria-expanded', 'false'); } });
  $('#logoutBtn').addEventListener('click', async () => {
    try { await api('/api/logout', {}); } catch (_) { /* ignore */ }
    if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
    onSignedOut();
  });

  // ---------- Google sign-in ----------
  function setupGoogle(clientId) {
    const block = $('#googleBlock'); const errEl = $('#googleError');
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => {
      google.accounts.id.initialize({
        client_id: clientId, ux_mode: 'popup', context: 'signin',
        callback: async ({ credential }) => {
          errEl.textContent = '';
          try { const { user } = await api('/api/google', { credential }); onSignedIn(user); } catch (e) { errEl.textContent = e.message; }
        },
      });
      block.hidden = false;
      google.accounts.id.renderButton($('#googleBtn'), { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: 320 });
    };
    s.onerror = () => { block.hidden = true; };
    document.head.appendChild(s);
  }

  // ---------- live prices: check every 2 minutes and grow the charts when a new day arrives ----------
  let lastChecked = Date.now();
  const sig = (p) => p.veg.map((v) => v.key + ':' + v.asOf + ':' + v.today + ':' + v.candles.length).join('|');
  function setLiveBadges(flash) {
    const mins = Math.round((Date.now() - lastChecked) / 60000);
    const ago = mins < 1 ? 'checked just now' : `checked ${mins} min ago`;
    $$('[data-live-badge]').forEach((b) => {
      $('.ago', b).textContent = `${ago} · latest ${prices && prices.asOf ? fmtDate(prices.asOf) : '–'}`;
      if (flash) { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }
    });
  }
  async function pollPrices() {
    if (document.hidden || !prices) return;
    try {
      const p = await api('/api/prices', null, 'GET');
      lastChecked = Date.now();
      if (p.veg.length && sig(p) !== sig(prices)) {
        prices = p;
        renderTicker();
        $$('.as-of').forEach((n) => { n.textContent = fmtDate(p.asOf); });
        $$('.as-of-long').forEach((n) => { n.textContent = 'as of ' + fmtDate(p.asOf); });
        $$('[data-live]').forEach((n) => { const v = p.veg.find((x) => x.key === n.dataset.live); if (v) n.textContent = rupee(v.today) + '/kg'; });
        if (pub.chart) drawPublic(pub.key);
        if (me) { renderVegCards(); drawDash(); renderBrief(); updatePlanTotals(); }
        setLiveBadges(true);
      } else setLiveBadges(false);
    } catch (_) { /* offline for a moment: try again next time */ }
  }
  setInterval(pollPrices, 120000);
  setInterval(() => setLiveBadges(false), 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastChecked > 120000) pollPrices(); });

  // ---------- start ----------
  const optionsReady = api('/api/options', null, 'GET').then(({ businessTypes: bt, googleClientId }) => {
    businessTypes = bt; buildTypeGrid();
    if (googleClientId) setupGoogle(googleClientId);
  }).catch(() => {});

  // load all three vegetable photos up front, so switching tabs swaps the photo instantly
  Object.values(VEG_META).forEach((m) => { const i = new Image(); i.src = m.img; });

  const pricesReady = api('/api/prices', null, 'GET').then((p) => {
    prices = p;
    if (!p.veg.length) { $('#pubNote').textContent = 'Today’s mandi prices are being fetched. Please refresh in a minute.'; return; }
    $$('.as-of').forEach((n) => { n.textContent = fmtDate(p.asOf); });
    $$('.as-of-long').forEach((n) => { n.textContent = 'as of ' + fmtDate(p.asOf); });
    renderTicker();
    lastChecked = Date.now(); setLiveBadges(false);
    $$('[data-live]').forEach((n) => { const v = p.veg.find((x) => x.key === n.dataset.live); if (v) n.textContent = rupee(v.today) + '/kg'; });
    // the WhatsApp-style examples show this week's real signals
    $$('[data-sig]').forEach((n) => { const v = p.veg.find((x) => x.key === n.dataset.sig); if (v) n.textContent = `${v.name}: ${SIGNAL[v.signal].label}`; });
    $$('[data-tip]').forEach((n) => { const v = p.veg.find((x) => x.key === 'tomato') || p.veg[0]; n.firstChild.textContent = `${v.name} today at APMC Pune: ${rupee(v.today)}/kg. ${v.note.replace('Our estimate: ', '')}`; });
    const first = (p.veg.find((x) => x.key === 'tomato') || p.veg[0]).key;
    vegTabs($('#pubTabs'), drawPublic, first);
    drawPublic(first);
  }).catch(() => { $('#pubNote').textContent = 'Prices could not be loaded. Please refresh.'; });

  Promise.all([optionsReady, pricesReady]).then(() => api('/api/me', null, 'GET'))
    .then(({ user }) => (user ? onSignedIn(user) : setView(false)))
    .catch(() => setView(false));
})();
