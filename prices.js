// REAL Pune mandi prices from the Government of India's open data (AGMARKNET via data.gov.in).
// - Daily prices for Tomato, Onion and Potato from every Pune-district mandi are stored in our
//   database (table mandi_prices), so charts have history and we don't hit the API on every visit.
// - When a visitor loads prices and the newest days aren't stored yet (checked at most every 30 min),
//   the server fetches them. Admins can backfill older days (see backfill()).
// - Prices from the API are ₹ per quintal (100 kg); we show ₹ per kg.
// - The 14-day forecast and buy/wait signal are simple statistical ESTIMATES from that real history.
const db = require('./db');

const API = 'https://api.data.gov.in/resource/35985678-0d79-46b4-9ed6-6f13308a1d24'; // variety-wise daily prices (has history)
// data.gov.in's public sample key (10 rows/request). Set DATA_GOV_API_KEY to your own free key for more headroom.
const API_KEY = process.env.DATA_GOV_API_KEY || '579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b';
const VEG = { tomato: 'Tomato', onion: 'Onion', potato: 'Potato' };
const MAIN_MARKET = 'APMC Pune'; // Gultekdi market yard — the chart follows this mandi
const HISTORY_DAYS = 90;
const HORIZON = 14;
const STALE_MS = 15 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');
const istToday = () => { const d = new Date(Date.now() + 5.5 * 3600 * 1000); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const apiDate = (isoDay) => { const [y, m, d] = isoDay.split('-'); return `${d}/${m}/${y}`; };
const r2 = (n) => Math.round(n * 100) / 100;
// "Pune(Pimpri) APMC" and "Pune(Pimpri) " are the same mandi
const cleanMarket = (m) => String(m || '').replace(/\s+APMC\s*$/i, '').trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// one page of results, retrying politely when data.gov.in says "too many requests"
async function fetchPage(name, isoDay, offset) {
  const u = new URL(API);
  u.search = new URLSearchParams({
    'api-key': API_KEY, format: 'json', limit: '10', offset: String(offset),
    'filters[State]': 'Maharashtra', 'filters[District]': 'Pune', 'filters[Commodity]': name, 'filters[Arrival_Date]': apiDate(isoDay),
  });
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetch(u, { signal: AbortSignal.timeout(15000) }); } catch (e) {
      const why = (e.cause && (e.cause.code || e.cause.message)) || e.name || e.message;
      if (attempt < 2) { await sleep(800 * (attempt + 1)); continue; }
      throw new Error('cannot reach data.gov.in: ' + why);
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(2000 * (attempt + 1) + Math.random() * 800); continue; }
    throw new Error(`data.gov.in ${res.status}`);
  }
}

async function fetchDay(name, isoDay) {
  // the public key returns at most 10 rows per request, so page through (a day has ~7–15 rows)
  let all = []; let offset = 0; let total = Infinity;
  while (offset < total && offset < 40) {
    const page = await fetchPage(name, isoDay, offset);
    total = Number(page.total) || 0;
    all = all.concat(page.records || []);
    offset += 10;
  }
  const rows = all.filter((r) => r.Commodity === name);
  // one row per mandi: average the varieties, widest min–max
  const byMarket = new Map();
  for (const r of rows) {
    const m = cleanMarket(r.Market); const modal = Number(r.Modal_Price); const min = Number(r.Min_Price); const max = Number(r.Max_Price);
    if (!m || !(modal > 0)) continue;
    const a = byMarket.get(m) || { sum: 0, n: 0, min: Infinity, max: 0 };
    a.sum += modal; a.n += 1; a.min = Math.min(a.min, min > 0 ? min : modal); a.max = Math.max(a.max, max || modal);
    byMarket.set(m, a);
  }
  return [...byMarket].map(([market, a]) => ({ market, modal: a.sum / a.n / 100, min: a.min / 100, max: a.max / 100 }));
}

// The "current daily prices" feed gets the newest day first (the history feed catches up later).
const CURRENT_API = 'https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070';
async function storeCurrent(key) {
  const name = VEG[key]; let all = []; let offset = 0; let total = Infinity;
  while (offset < total && offset < 40) {
    const u = new URL(CURRENT_API);
    u.search = new URLSearchParams({ 'api-key': API_KEY, format: 'json', limit: '10', offset: String(offset), 'filters[state.keyword]': 'Maharashtra', 'filters[district]': 'Pune', 'filters[commodity]': name });
    let page;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (res.ok) { page = await res.json(); break; }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(1200 * (attempt + 1)); continue; }
      throw new Error(`data.gov.in ${res.status}`);
    }
    total = Number(page.total) || 0; all = all.concat(page.records || []); offset += 10;
  }
  const byDayMarket = new Map();
  for (const r of all.filter((x) => x.commodity === name)) {
    const [d, m, y] = String(r.arrival_date || '').split('/'); if (!y) continue;
    const day = `${y}-${m}-${d}`; const market = cleanMarket(r.market); const modal = Number(r.modal_price);
    if (!market || !(modal > 0)) continue;
    const k = day + '|' + market; const a = byDayMarket.get(k) || { day, market, sum: 0, n: 0, min: Infinity, max: 0 };
    a.sum += modal; a.n += 1; a.min = Math.min(a.min, Number(r.min_price) || modal); a.max = Math.max(a.max, Number(r.max_price) || modal);
    byDayMarket.set(k, a);
  }
  const stmts = [...byDayMarket.values()].map((a) => ['INSERT OR REPLACE INTO mandi_prices(day, veg, market, modal, min, max) VALUES (?,?,?,?,?,?)', a.day, key, a.market, r2(a.sum / a.n / 100), r2(a.min / 100), r2(a.max / 100)]);
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

async function storeDay(key, isoDay) {
  const rows = await fetchDay(VEG[key], isoDay);
  const stmts = rows.map((r) => ['INSERT OR REPLACE INTO mandi_prices(day, veg, market, modal, min, max) VALUES (?,?,?,?,?,?)', isoDay, key, r.market, r2(r.modal), r2(r.min), r2(r.max)]);
  // remember we checked this day even if nothing was traded (Sundays, holidays)
  stmts.push(['INSERT OR REPLACE INTO mandi_checked(day, veg, rows, at) VALUES (?,?,?,?)', isoDay, key, rows.length, new Date().toISOString()]);
  await db.batch(stmts);
  return rows.length;
}

// run tasks a few at a time
async function pool(tasks, size = 3) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (i < tasks.length) { const t = tasks[i++]; try { out.push(await t()); } catch (e) { out.push(e); } } }));
  return out;
}

// Fetch any of the last `days` days we haven't checked yet (today and yesterday are always re-checked,
// because data.gov.in fills them in during the day).
// At most `maxTasks` day-fetches per call, so one call stays well inside the server's time limit;
// call again until `remaining` is 0.
async function backfill(days = HISTORY_DAYS, maxTasks = 45, recheckRecent = true) {
  const today = istToday();
  const want = Array.from({ length: days }, (_, k) => iso(addDays(today, -k)));
  const done = new Set((await db.all('SELECT day || veg AS k FROM mandi_checked WHERE day >= ?', want[want.length - 1])).map((r) => r.k));
  const todo = [];
  for (const day of want) for (const key of Object.keys(VEG)) {
    const recent = recheckRecent && day >= iso(addDays(today, -1));
    if (recent || !done.has(day + key)) todo.push(() => storeDay(key, day));
  }
  const batch = todo.slice(0, maxTasks);
  // one request at a time with a short pause: the shared public key gets throttled by bursts
  const results = [];
  for (const t of batch) { try { results.push(await t()); } catch (e) { results.push(e); } await sleep(600); }
  const failed = results.filter((r) => r instanceof Error);
  if (failed.length) console.error('[prices] fetch errors:', [...new Set(failed.map((e) => e.message))].join(', '));
  return { fetched: batch.length - failed.length, failed: failed.length, remaining: todo.length - batch.length };
}

let lastRefresh = 0;
async function refreshIfStale() {
  if (Date.now() - lastRefresh < STALE_MS) return;
  const meta = await db.get("SELECT value FROM app_meta WHERE key = 'prices_checked_at'");
  if (meta && Date.now() - Date.parse(meta.value) < STALE_MS) { lastRefresh = Date.parse(meta.value); return; }
  lastRefresh = Date.now();
  await db.run("INSERT OR REPLACE INTO app_meta(key, value) VALUES ('prices_checked_at', ?)", new Date().toISOString());
  // top up today + yesterday, but never make a visitor wait more than a few seconds for data.gov.in
  const work = Promise.all([
    ...Object.keys(VEG).map((k) => storeCurrent(k)),
    backfill(2, 6),
  ]).catch((e) => console.error('[prices] refresh failed:', e.message));
  await Promise.race([work, sleep(6000)]);
}

function forecastFrom(series) {
  // simple, honest estimate: recent trend that fades + pull back toward the 30-day average
  const closes = series.map((c) => c.close);
  const last = closes[closes.length - 1];
  const mean30 = closes.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, closes.length);
  const back = closes[Math.max(0, closes.length - 8)];
  const momentum = Math.log(last / back) / 7;
  const rets = closes.slice(-31).map((c, i, a) => (i ? Math.log(c / a[i - 1]) : 0)).slice(1);
  const vol = Math.max(0.02, Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / Math.max(1, rets.length)));
  const lastDay = new Date(series[series.length - 1].time + 'T00:00:00Z');
  const out = []; let lp = Math.log(last);
  for (let h = 1; h <= HORIZON; h++) {
    lp += 0.06 * (Math.log(mean30) - lp) + momentum * Math.pow(0.85, h);
    const band = vol * Math.sqrt(h) * 1.28;
    out.push({ time: iso(addDays(lastDay, h)), value: r2(Math.exp(lp)), lo: r2(Math.exp(lp - band)), hi: r2(Math.exp(lp + band)) });
  }
  return { forecast: out, vol };
}

async function buildVeg(key, rows) {
  const mine = rows.filter((r) => r.veg === key);
  const main = mine.filter((r) => r.market === MAIN_MARKET);
  // chart: APMC Pune each day; on days it didn't report, the average of the other Pune mandis —
  // but only if enough of them reported (data.gov.in fills a day in gradually; one small mandi early in
  // the morning would otherwise make the price and signal jump). Such days are skipped until complete.
  const MIN_FALLBACK_MANDIS = 4;
  const days = [...new Set(mine.map((r) => r.day))].sort();
  const series = [];
  for (const day of days) {
    let r = main.find((x) => x.day === day);
    if (!r) {
      const others = mine.filter((x) => x.day === day);
      if (others.length < MIN_FALLBACK_MANDIS) continue;
      r = { modal: others.reduce((a, x) => a + x.modal, 0) / others.length, min: Math.min(...others.map((x) => x.min)), max: Math.max(...others.map((x) => x.max)) };
    }
    const prev = series.length ? series[series.length - 1].close : r.modal;
    series.push({ time: day, open: r2(prev), high: r2(Math.max(r.max, prev, r.modal)), low: r2(Math.min(r.min, prev, r.modal)), close: r2(r.modal), markets: mine.filter((x) => x.day === day).length });
  }
  if (!series.length) return null;
  const lastDay = series[series.length - 1].time;
  const today = series[series.length - 1].close;
  const prevC = series.length > 1 ? series[series.length - 2].close : today;
  const wk = series[Math.max(0, series.length - 7)].close;
  const { forecast, vol } = forecastFrom(series);
  const next7 = forecast.slice(0, 7).reduce((a, f) => a + f.value, 0) / 7;
  const expected = (next7 - today) / today;
  const signal = expected > 0.04 ? 'buy' : expected < -0.04 ? 'wait' : 'steady';
  const confidence = Math.max(50, Math.min(85, Math.round(88 - vol * 400)));
  const notes = {
    buy: `Our estimate: prices may rise about ${Math.round(expected * 100)}% this week. Consider stocking up for the next few days.`,
    wait: `Our estimate: prices may fall about ${Math.round(-expected * 100)}% this week. Consider buying only what you need today.`,
    steady: 'Our estimate: prices look flat this week. Buy as usual.',
  };
  const markets = mine.filter((r) => r.day === lastDay).map((r) => ({ market: r.market, modal: r.modal, min: r.min, max: r.max })).sort((a, b) => a.modal - b.modal);
  return {
    key, name: VEG[key], unit: '₹/kg', asOf: lastDay,
    today, change1d: r2(((today - prevC) / prevC) * 100), change7d: r2(((today - wk) / wk) * 100),
    expected7d: r2(expected * 100), signal, confidence, note: notes[signal],
    candles: series, forecast, markets,
  };
}

async function getPrices() {
  await refreshIfStale();
  const since = iso(addDays(istToday(), -HISTORY_DAYS));
  const rows = await db.all('SELECT day, veg, market, modal, min, max FROM mandi_prices WHERE day >= ? ORDER BY day', since);
  const veg = (await Promise.all(Object.keys(VEG).map((k) => buildVeg(k, rows)))).filter(Boolean);
  const asOf = veg.reduce((a, v) => (v.asOf > a ? v.asOf : a), '');
  return {
    sample: false, source: 'AGMARKNET (data.gov.in), Govt. of India', market: 'Pune mandis (chart: APMC Pune, Gultekdi)',
    asOf, veg,
  };
}

module.exports = { getPrices, backfill, storeCurrent };
