'use strict';

// Price data is written by the "Collect prices" GitHub Action to the data branch.
// ?data=<url> overrides it (used for local testing).
const DATA_URL = new URLSearchParams(location.search).get('data')
  || 'https://raw.githubusercontent.com/MitoCet/skyblock-forge-flip/data/';
const HYPIXEL = 'https://api.hypixel.net/v2/skyblock';
const COIN = 'SKYBLOCK_COIN';
const HOTM_XP = [0, 3000, 12000, 37000, 97000, 197000, 347000, 557000, 847000, 1247000];
const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8']
  .map((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim());

// ---------- settings (localStorage) ----------
const DEFAULTS = {
  apiKey: '', username: '', profileId: '',
  apiKeySetAt: 0, apiKeyRejected: false, // when the key was entered; Hypixel said it is invalid
  auto: null, // { slots, qfLevel, hotmTier, profileName, fetchedAt }
  manualMode: false, slots: 2, qfLevel: 0, bzTax: 1.25,
  thinVolume: 1000, thinOrders: 5, // Bazaar items under these are marked "az işlem" (0 turns a limit off)
  market: 'all', sort: 'hour', hideMissing: true, hideLoss: false, showQuick: false,
  buyMode: 'instant', sellMode: 'offer', // Bazaar: instant buy | buy order, sell offer | instant sell
  compare: [], overrides: {}, range: 7,
  liveAh: false,
  npcSort: 'diff', npcOnlyNpc: false, npcOnlyFlip: false, npcView: 'all', farmSort: 'diff',
  craftMarket: 'all', craftSort: 'save', craftDeep: false, craftOnlyCheaper: false, craftHideMissing: true,
  scMarket: 'all', scSort: 'diff', scNpc: true, scOnlyCraft: false, scHideMissing: true,
  scCalcId: '', scCalcQty: 1, scCalcUnit: 'out', gemHold: {}, gemCountLow: false,
  metalOwnPlates: false,
  mine: null, mineRoute: {}, mineInTotal: {}, mineView: 'all', // mine: { TUNGSTEN: { raw, ench }, … }
  sackFetch: null, // { profile, sig, changedAt, items, fetchedAt }: the last pull from the sacks
  forging: null, // [{ id, slot, start }]: mining-route items in the forge at the last sack pull
  forgeAll: null, // every forge job at the last sack pull, for the "done" notifications
  forgeNotify: false, forgeNotified: {}, // notify when a forge is done; keys `${slot}:${start}` already notified
};
let S = load();
// gemHold used to hold one { tier, qty } per gemstone; now it holds an amount per tier.
for (const [t, h] of Object.entries(S.gemHold || {})) if (h && h.tier) S.gemHold[t] = { [h.tier]: h.qty || 0 };
// The metal tab had one amount per metal, in raw or Enchanted pieces.
if (!S.mine) {
  S.mine = {};
  for (const [id, k] of [['TUNGSTEN', 'metalTungsten'], ['UMBER', 'metalUmber']]) {
    if (S[k]) S.mine[id] = { [S.metalUnit === 'raw' ? 'raw' : 'ench']: S[k] };
  }
}
function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('forgeflip') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function save() {
  try { localStorage.setItem('forgeflip', JSON.stringify(S)); } catch { /* private mode */ }
}
function effective() {
  const a = !S.manualMode && S.auto;
  return { slots: a ? a.slots : S.slots, qfLevel: a ? a.qfLevel : S.qfLevel };
}
// ---------- view state (survives a page refresh) ----------
// The open tab lives in the URL hash (#mine), so a refresh or a shared link opens the same tab.
// Scroll position, search boxes, open rows and the open detail window are kept in sessionStorage:
// they come back on refresh but a new visit starts clean.
const TABS = ['best', 'compare', 'npc', 'craft', 'sellcraft', 'mine', 'settings'];
const SEARCHES = ['search', 'npcSearch', 'craftSearch', 'scSearch'];
let V = { scroll: {}, search: {}, craftOpen: null, scOpen: null, detail: null };
try { V = { ...V, ...JSON.parse(sessionStorage.getItem('forgeflip-view') || '{}') }; } catch { /* blocked */ }
function saveView() {
  try { sessionStorage.setItem('forgeflip-view', JSON.stringify(V)); } catch { /* blocked */ }
}
const tabFromHash = () => (TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'best');
const activeTab = () => document.querySelector('.tab.active')?.dataset.tab || 'best';
// The browser would restore scroll before the tables are filled; it is done by hand after loading.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

const QUICK_SECONDS = 600; // forges shorter than this are capped by market demand, not time
const qfPercent = (lvl) => (lvl <= 0 ? 0 : lvl >= 20 ? 30 : 10 + lvl * 0.5);

// ---------- formatting ----------
const $ = (s) => document.querySelector(s);
function coins(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v), sign = v < 0 ? '-' : '';
  if (a >= 1e9) return sign + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return sign + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return sign + (a / 1e3).toFixed(1) + 'k';
  return sign + a.toFixed(a < 10 ? 1 : 0);
}
function duration(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.round((sec % 3600) / 60);
  if (sec < 60) return `${Math.round(sec)}sn`;
  if (d) return h ? `${d}g ${h}s` : `${d}g`;
  if (h) return m ? `${h}s ${m}dk` : `${h}s`;
  return `${m}dk`;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeName = (id) => id.replace(/[^A-Za-z0-9_-]/g, '-');

// ---------- data ----------
let recipes = [], names = {}, latest = null;
const histCache = new Map();

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}
async function loadData() {
  const [r, l] = await Promise.all([getJson(DATA_URL + 'recipes.json'), getJson(DATA_URL + 'latest.json')]);
  recipes = r.recipes; names = r.names; latest = l;
}
function priceHistory(id) {
  if (!histCache.has(id)) {
    histCache.set(id, getJson(`${DATA_URL}history/${safeName(id)}.json`).catch(() => null));
  }
  return histCache.get(id);
}
const nameOf = (id) => names[id] || id;

// Crystals (e.g. Ruby Crystal for Perfect gems) can't be traded, so with no
// market price they count as free instead of blocking the profit.
const isFreeCrystal = (id) => /_CRYSTAL$/.test(id);
// Gemstones: ROUGH_RUBY_GEM … PERFECT_RUBY_GEM. `tier` limits to one quality.
const isGem = (id, tier = '(ROUGH|FLAWED|FINE|FLAWLESS|PERFECT)') => new RegExp(`^${tier}_[A-Z]+_GEM$`).test(id);

// Price to buy `qty` of an input: a buy order just above the best one, or an
// instant buy that walks the Bazaar sell orders.
function buyCost(id, qty) {
  if (id === COIN) return { total: qty, unit: 1, src: 'coin' };
  if (S.overrides[id] != null) return { total: S.overrides[id] * qty, unit: S.overrides[id], src: 'manual' };
  const b = latest.bazaar[id];
  if (b && S.buyMode === 'order' && b.bid) {
    const unit = b.bid + 0.1;
    return { total: unit * qty, unit, src: 'bazaar-order' };
  }
  if (b && b.ask) {
    let left = qty, total = 0;
    for (const [price, amount] of b.asks || []) {
      const take = Math.min(left, amount);
      total += take * price; left -= take;
      if (left <= 0) break;
    }
    if (left > 0) total += left * (b.asks?.length ? b.asks[b.asks.length - 1][0] : b.ask);
    return { total, unit: total / qty, src: 'bazaar' };
  }
  const a = latest.ah[id];
  if (a) return { total: a.lbin * qty, unit: a.lbin, src: 'ah' };
  if (isFreeCrystal(id)) return { total: 0, unit: 0, src: 'free' };
  return { total: null, unit: null, src: 'missing' };
}

function ahFee(price) {
  const listing = price < 1e7 ? 0.01 : price < 1e8 ? 0.02 : 0.025;
  const claim = price > 1e6 ? 0.01 : 0;
  return price * (listing + claim);
}

// Bazaar unit sale price: a sell offer undercuts the lowest sell order by 0.1,
// an instant sell fills the highest buy order.
const bzSellUnit = (ask, bid) => (S.sellMode === 'instant' ? bid ?? (ask != null ? ask - 0.1 : null) : ask != null ? ask - 0.1 : bid);
const bzBuyUnit = (ask, bid) => (S.buyMode === 'order' && bid != null ? bid + 0.1 : ask);

// Net coins from selling one forge result on the Bazaar or at AH lowest BIN.
function saleValue(id, count) {
  const b = latest.bazaar[id];
  const manual = S.overrides[id];
  if (b && (b.ask || b.bid || manual != null)) {
    const unit = manual ?? bzSellUnit(b.ask, b.bid);
    return {
      market: 'bazaar', unit, net: unit * count * (1 - S.bzTax / 100),
      // Sell offers are filled by instant buyers; instant sells need buy orders.
      demand: S.sellMode === 'instant' ? b.sellWeek : b.buyWeek,
      src: manual != null ? 'manual' : S.sellMode === 'instant' ? 'bazaar-instant' : 'bazaar',
    };
  }
  const a = latest.ah[id];
  if (a || manual != null) {
    const unit = manual ?? a.lbin;
    const gross = unit * count;
    return { market: 'ah', unit, net: gross - ahFee(gross), demand: a ? a.n : null, src: manual != null ? 'manual' : 'ah' };
  }
  return { market: 'unknown', unit: null, net: null, demand: null, src: 'missing' };
}

// ---------- thin Bazaar markets ----------
// A few orders or little weekly volume make a price easy to skew (one high sell offer
// can inflate a profit), so such items get an "az işlem" tag. Nothing is hidden.
// Hypixel's quick_status: buyMovingWeek / buyOrders are the instant-buy side (sell offers),
// sellMovingWeek / sellOrders the instant-sell side (buy orders).
function bzStats(id) {
  const l = latest?.bazaar?.[id];
  const m = market?.bz?.[id];
  if (!l && !m) return null;
  return {
    buyWeek: l?.buyWeek ?? m?.[2] ?? 0,
    sellWeek: l?.sellWeek ?? m?.[3] ?? 0,
    offers: l?.buyOrders ?? m?.[4] ?? null,
    orders: l?.sellOrders ?? m?.[5] ?? null,
    asks: l?.asks || null,
  };
}
const fmtInt = (n) => (n == null ? 'bilinmiyor' : Math.round(n).toLocaleString('tr-TR'));
function thinInfo(id) {
  const s = bzStats(id);
  if (!s) return null;
  const instant = S.sellMode === 'instant';
  const vol = instant ? s.sellWeek : s.buyWeek;
  const n = instant ? s.orders : s.offers;
  const volName = instant ? 'haftalık anında satış' : 'haftalık anında alım';
  const nName = instant ? 'buy order sayısı' : 'sell offer sayısı';
  const why = [];
  if (S.thinVolume > 0 && vol < S.thinVolume) why.push(`${volName} ${fmtInt(vol)} < sınır ${fmtInt(S.thinVolume)}`);
  if (S.thinOrders > 0 && n != null && n < S.thinOrders) why.push(`${nName} ${fmtInt(n)} < sınır ${fmtInt(S.thinOrders)}`);
  if (!why.length) return null;
  const lines = [
    `Neden: ${why.join('; ')}.`,
    `Sell offer: ${fmtInt(s.offers)} · Buy order: ${fmtInt(s.orders)}`,
    `Haftalık anında alım (buyMovingWeek): ${fmtInt(s.buyWeek)}`,
    `Haftalık anında satış (sellMovingWeek): ${fmtInt(s.sellWeek)}`,
  ];
  if (!instant && s.asks?.length) {
    lines.push(`En ucuz sell offerlar: ${s.asks.slice(0, 3).map(([p, a]) => `${coins(p)} ×${fmtInt(a)}`).join(', ')}`);
  }
  if (s.offers == null) lines.push('Order sayıları fiyat toplayıcının bir sonraki çalışmasından sonra görünecek.');
  lines.push(`Sınırlar: haftalık ${fmtInt(S.thinVolume)} adet, ${fmtInt(S.thinOrders)} order (Profil ve ayarlar).`,
    instant ? 'Anında satışta buy orderlara satıyorsun; hacim anında satış tarafından.' : 'Sell offer ile satışta alıcılar anında alımla gelir; hacim anında alım tarafından.');
  return lines.join('\n');
}
// The tag shown next to a Bazaar item; tap or hover shows why.
function thinTag(id) {
  const tip = thinInfo(id);
  return tip ? ` <span class="tag thin" tabindex="0" title="${esc(tip)}" data-tip="${esc(tip)}">⚠ az işlem</span>` : '';
}

function evaluate(r) {
  const { qfLevel } = effective();
  const time = r.duration * (1 - qfPercent(qfLevel) / 100);
  const inputs = r.inputs.map((i) => ({ ...i, ...buyCost(i.id, i.count) }));
  const missing = inputs.some((i) => i.total == null);
  const cost = missing ? null : inputs.reduce((s, i) => s + i.total, 0);
  const sale = saleValue(r.id, r.count);
  const ok = !missing && sale.net != null;
  const profit = ok ? sale.net - cost : null;
  return {
    r, id: r.id, name: nameOf(r.id), inputs, cost, sale, time, profit,
    perHour: ok ? profit / (time / 3600) : null,
    margin: ok && cost > 0 ? (profit / cost) * 100 : null,
    missing: !ok,
  };
}

// ---------- best table ----------
const demandText = (e) => (e.sale.demand == null ? '—'
  : e.sale.market === 'ah' ? `${e.sale.demand} ilan` : `${coins(e.sale.demand)}/hf`);

function rows() {
  const q = $('#search').value.trim().toLowerCase();
  let list = recipes.map(evaluate);
  if (S.market !== 'all') list = list.filter((e) => e.sale.market === S.market);
  if (S.hideMissing) list = list.filter((e) => !e.missing);
  if (S.sort === 'hour' && !S.showQuick) list = list.filter((e) => e.time >= QUICK_SECONDS);
  if (S.hideLoss) list = list.filter((e) => e.profit == null || e.profit > 0);
  if (q) list = list.filter((e) => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q));
  const key = { hour: 'perHour', item: 'profit', margin: 'margin', cost: 'cost', time: 'time' }[S.sort];
  const dir = S.sort === 'time' || S.sort === 'cost' ? 1 : -1;
  list.sort((a, b) => {
    if (a[key] == null) return 1;
    if (b[key] == null) return -1;
    return dir * (a[key] - b[key]);
  });
  return list;
}

function renderBest() {
  const tbody = $('#bestTable tbody');
  const list = rows();
  tbody.innerHTML = list.map((e) => {
    const cls = e.profit == null ? '' : e.profit >= 0 ? 'pos' : 'neg';
    const checked = S.compare.includes(e.id) ? 'checked' : '';
    const market = e.sale.market === 'bazaar' ? 'Bazaar' : e.sale.market === 'ah' ? 'AH' : '?';
    const demand = demandText(e);
    const quick = e.time < QUICK_SECONDS ? ' <span class="tag" title="Çok kısa forge süresi: saatlik kâr ancak bu kadar alıcı bulursan gerçekleşir.">kısa</span>' : '';
    const manual = e.sale.src === 'manual' || e.inputs.some((i) => i.src === 'manual') ? ' <span class="tag">elle</span>' : '';
    return `<tr data-id="${esc(e.id)}">
      <td><input type="checkbox" class="cmp" ${checked} aria-label="Karşılaştırmaya ekle"></td>
      <td>${esc(e.name)}${e.r.count > 1 ? ` <span class="muted">×${e.r.count}</span>` : ''}${manual}${quick}${e.sale.market === 'bazaar' ? thinTag(e.id) : ''}</td>
      <td><span class="tag">${market}</span></td>
      <td class="num">${coins(e.cost)}</td>
      <td class="num">${coins(e.sale.net)}</td>
      <td class="num ${cls}">${coins(e.profit)}</td>
      <td class="num">${duration(e.time)}</td>
      <td class="num ${cls}">${coins(e.perHour)}</td>
      <td class="num">${demand}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="muted">Filtrelere uyan item yok.</td></tr>';
}

// ---------- history helpers ----------
// Unit price series. Bazaar points are [ts, ask, bid]; AH points are [ts, lowestBin, listings].
// `pick` turns a Bazaar (ask, bid) pair into the price wanted.
function priceSeries(h, pick = (ask) => ask) {
  if (!h) return [];
  return h.points
    .map((p) => [p[0], h.market === 'bazaar' ? pick(p[1], p[2]) : p[1]])
    .filter((p) => p[1] != null);
}

// Profit-per-item over time, from snapshots that every ingredient shares.
async function profitSeries(r) {
  const ids = [r.id, ...r.inputs.filter((i) => i.id !== COIN).map((i) => i.id)];
  const hs = await Promise.all(ids.map(priceHistory));
  if (hs.some((h) => !h)) return [];
  const maps = hs.map((h) => new Map(priceSeries(h, bzBuyUnit)));
  const out = [];
  for (const [ts, outPrice] of priceSeries(hs[0], bzSellUnit)) {
    let cost = 0, ok = true;
    r.inputs.forEach((inp) => {
      if (inp.id === COIN) { cost += inp.count; return; }
      const p = S.overrides[inp.id] ?? maps[ids.indexOf(inp.id)].get(ts);
      if (p == null) ok = false; else cost += p * inp.count;
    });
    if (!ok) continue;
    const unit = S.overrides[r.id] ?? outPrice;
    const net = hs[0].market === 'bazaar'
      ? unit * r.count * (1 - S.bzTax / 100)
      : unit * r.count - ahFee(unit * r.count);
    out.push([ts, net - cost]);
  }
  return out;
}

const charts = {};
const GAP_MS = 45 * 60 * 1000;
function drawChart(key, canvas, datasets, rangeDays) {
  charts[key]?.destroy();
  const since = Date.now() / 1000 - rangeDays * 86400;
  const ds = datasets.map((d, i) => ({
    label: d.label,
    data: d.points.filter((p) => p[0] >= since).map((p) => ({ x: p[0] * 1000, y: p[1] })),
    borderColor: SERIES[i % SERIES.length],
    backgroundColor: SERIES[i % SERIES.length],
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.15,
    // Snapshots are 15 minutes apart; a longer stretch means missing data, drawn dashed.
    segment: { borderDash: (c) => (c.p1.parsed.x - c.p0.parsed.x > GAP_MS ? [4, 4] : undefined) },
  }));
  const xs = ds.flatMap((d) => d.data.map((p) => p.x));
  const fmtTime = (ms) => new Date(ms).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  charts[key] = new Chart(canvas, {
    type: 'line',
    data: { datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: ds.length > 1, labels: { color: '#c3c2b7', boxWidth: 12, boxHeight: 2 } },
        tooltip: { callbacks: { title: (it) => fmtTime(it[0].parsed.x), label: (it) => `${it.dataset.label}: ${coins(it.parsed.y)}` } },
      },
      scales: {
        // Axis spans the data only, so it never runs past the latest snapshot.
        x: { type: 'linear', min: xs.length ? Math.min(...xs) : undefined, max: xs.length ? Math.max(...xs) : undefined, ticks: { color: '#8f8e86', maxTicksLimit: 7, callback: (v) => fmtTime(v) }, grid: { color: '#2a2a27' } },
        y: { ticks: { color: '#8f8e86', callback: (v) => coins(v) }, grid: { color: '#2a2a27' } },
      },
    },
  });
  return ds.reduce((n, d) => n + d.data.length, 0);
}

function rangeButtons(el, onChange) {
  el.innerHTML = [[1, '1 gün'], [7, '7 gün'], [30, '30 gün']]
    .map(([d, t]) => `<button data-days="${d}" class="${S.range === d ? 'active' : ''}">${t}</button>`).join('');
  el.onclick = (ev) => {
    const d = Number(ev.target.dataset.days);
    if (!d) return;
    S.range = d; save();
    document.querySelectorAll('.range button').forEach((b) => b.classList.toggle('active', Number(b.dataset.days) === d));
    onChange();
  };
}

function stability(points) {
  const vals = points.map((p) => p[1]);
  if (vals.length < 4) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return { mean, min: Math.min(...vals), max: Math.max(...vals), cv: mean ? (sd / Math.abs(mean)) * 100 : null };
}

// ---------- detail dialog ----------
let detailId = null;
async function openDetail(id) {
  detailId = id;
  const r = recipes.find((x) => x.id === id);
  const e = evaluate(r);
  const { slots } = effective();
  $('#detailTitle').textContent = e.name + (r.count > 1 ? ` ×${r.count}` : '');
  const stat = (k, v, cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  const cls = e.profit == null ? '' : e.profit >= 0 ? 'pos' : 'neg';
  $('#detailSummary').innerHTML = [
    stat('Maliyet', coins(e.cost)),
    stat(`Satış (${saleLabel(e)}, net)`, coins(e.sale.net)),
    stat('Kâr / item', coins(e.profit), cls),
    stat('Forge süresi', duration(e.time)),
    stat('Kâr / saat (1 slot)', coins(e.perHour), cls),
    stat(`Günlük kâr (${slots} slot)`, coins(e.perHour == null ? null : e.perHour * 24 * slots), cls),
  ].join('');

  const overrideCell = (id2) => `<input class="override" type="number" min="0" placeholder="elle" data-ov="${esc(id2)}" value="${S.overrides[id2] ?? ''}">`;
  $('#detailInputs').innerHTML = `<thead><tr><th>Malzeme</th><th class="num">Adet</th><th class="num">Birim fiyat</th><th class="num">Toplam</th><th>Kaynak</th><th>Elle fiyat</th></tr></thead><tbody>
    ${e.inputs.map((i) => `<tr><td>${esc(nameOf(i.id))}</td><td class="num">${i.count.toLocaleString('tr-TR')}</td>
      <td class="num">${coins(i.unit)}</td><td class="num">${coins(i.total)}</td>
      <td><span class="tag">${{ coin: 'coin', bazaar: 'Bazaar anında alım', 'bazaar-order': 'Bazaar buy order', ah: 'AH lowest BIN', manual: 'elle', free: 'satılamaz, 0 sayıldı', missing: 'fiyat yok' }[i.src]}</span></td>
      <td>${i.id === COIN ? '' : overrideCell(i.id)}</td></tr>`).join('')}
    <tr><td><b>Çıktı:</b> ${esc(e.name)}</td><td class="num">${r.count}</td><td class="num">${coins(e.sale.unit)}</td><td class="num">${coins(e.sale.net)}</td>
      <td><span class="tag">${e.sale.src === 'manual' ? 'elle' : saleLabel(e)}</span></td><td>${overrideCell(r.id)}</td></tr>
  </tbody>`;

  const sel = $('#detailSeries');
  sel.innerHTML = `<option value="__profit">Kâr / item</option><option value="${esc(r.id)}">${esc(e.name)} (çıktı)</option>`
    + r.inputs.filter((i) => i.id !== COIN).map((i) => `<option value="${esc(i.id)}">${esc(nameOf(i.id))} (malzeme)</option>`).join('');
  sel.onchange = drawDetail;
  rangeButtons(document.querySelector('.range[data-target=detail]'), drawDetail);
  if (!$('#detail').open) $('#detail').showModal();
  V.detail = id; saveView();
  await drawDetail();
}

const saleLabel = (e) => (e.sale.market === 'ah' ? 'AH lowest BIN' : S.sellMode === 'instant' ? 'Bazaar anında satış' : 'Bazaar sell offer');

async function drawDetail() {
  const r = recipes.find((x) => x.id === detailId);
  const which = $('#detailSeries').value;
  let datasets;
  if (which === '__profit') datasets = [{ label: 'Kâr / item', points: await profitSeries(r) }];
  else {
    const h = await priceHistory(which);
    datasets = h?.market === 'bazaar'
      ? [
        { label: 'Anında alım fiyatı (en düşük satış emri)', points: priceSeries(h, (ask) => ask) },
        { label: 'Anında satış fiyatı (en yüksek alış emri)', points: priceSeries(h, (ask, bid) => bid) },
      ]
      : [{ label: `${nameOf(which)} lowest BIN`, points: priceSeries(h) }];
  }
  const { label, points } = datasets[0];
  const n = drawChart('detail', $('#detailChart'), datasets, S.range);
  const since = Date.now() / 1000 - S.range * 86400;
  const inRange = points.filter((p) => p[0] >= since);
  const st = stability(inRange);
  $('#detailNote').textContent = n === 0
    ? 'Bu aralıkta henüz kayıtlı fiyat yok. Fiyatlar 15 dakikada bir kaydediliyor, grafik zamanla dolacak.'
    : st ? `${label}: ortalama ${coins(st.mean)}, en düşük ${coins(st.min)}, en yüksek ${coins(st.max)}, dalgalanma %${st.cv?.toFixed(1)} (${inRange.length} kayıt).`
      : `${inRange.length} kayıt var, istatistik için daha fazla veri gerekiyor.`;
}

// ---------- compare ----------
async function renderCompare() {
  $('#compareCount').textContent = S.compare.length;
  const list = S.compare.map((id) => recipes.find((r) => r.id === id)).filter(Boolean).map(evaluate);
  $('#compareEmpty').hidden = list.length > 0;
  $('#compareBody').hidden = list.length === 0;
  if (!list.length) return;
  const { slots } = effective();
  const best = (f, max = true) => {
    const vals = list.map(f).filter((v) => v != null);
    return vals.length ? (max ? Math.max(...vals) : Math.min(...vals)) : null;
  };
  const row = (label, f, fmt = coins, max = true) => {
    const b = best(f, max);
    return `<tr><th>${label}</th>${list.map((e) => {
      const v = f(e);
      return `<td class="num">${v != null && v === b && list.length > 1 ? `<b>${fmt(v)}</b>` : fmt(v)}</td>`;
    }).join('')}</tr>`;
  };
  $('#compareTable').innerHTML = `<thead><tr><th></th>${list.map((e) => `<th class="num">${esc(e.name)} <button class="ghost small" data-rm="${esc(e.id)}" aria-label="Çıkar">✕</button></th>`).join('')}</tr></thead><tbody>
    <tr><th>Pazar</th>${list.map((e) => `<td class="num">${e.sale.market === 'ah' ? 'AH' : 'Bazaar'}</td>`).join('')}</tr>
    ${row('Maliyet', (e) => e.cost, coins, false)}
    ${row('Satış (net)', (e) => e.sale.net)}
    ${row('Kâr / item', (e) => e.profit)}
    ${row('Kâr oranı', (e) => e.margin, (v) => (v == null ? '—' : `%${v.toFixed(1)}`))}
    ${row('Forge süresi', (e) => e.time, duration, false)}
    ${row('Kâr / saat (1 slot)', (e) => e.perHour)}
    ${row(`Günlük kâr (${slots} slot)`, (e) => (e.perHour == null ? null : e.perHour * 24 * slots))}
    <tr><th>Talep</th>${list.map((e) => `<td class="num">${demandText(e)}${e.sale.market === 'bazaar' ? thinTag(e.id) : ''}</td>`).join('')}</tr>
  </tbody>`;
  $('#compareTable').onclick = (ev) => {
    const id = ev.target.dataset.rm;
    if (!id) return;
    S.compare = S.compare.filter((x) => x !== id); save();
    renderCompare(); renderBest();
  };
  rangeButtons(document.querySelector('.range[data-target=compare]'), drawCompare);
  await drawCompare();
}

async function drawCompare() {
  const list = S.compare.map((id) => recipes.find((r) => r.id === id)).filter(Boolean);
  const shown = list.slice(0, 8);
  const datasets = await Promise.all(shown.map(async (r) => ({ label: nameOf(r.id), points: await profitSeries(r) })));
  const n = drawChart('compare', $('#compareChart'), datasets, S.range);
  $('#compareNote').textContent = (n === 0 ? 'Bu aralıkta henüz kayıtlı fiyat yok, grafik zamanla dolacak. ' : '')
    + (list.length > 8 ? 'Grafikte ilk 8 item gösteriliyor. ' : '')
    + 'Kâr, her kayıt anındaki Bazaar/AH fiyatlarıyla yeniden hesaplanır.';
}

// ---------- market-wide data (NPC, craft and craft-or-sell tabs) ----------
// market.json: every Bazaar product [ask, bid, buyWeek, sellWeek, sellOffers, buyOrders] and every AH item [lowestBin, listings].
let market = null, npcData = null, craftData = null;
const craftsBy = new Map();
let extraPromise = null;
function loadExtra() {
  extraPromise ??= Promise.all([
    getJson(DATA_URL + 'market.json'),
    getJson(DATA_URL + 'npc.json').catch(() => null),
    getJson(DATA_URL + 'crafts.json').catch(() => null),
  ]).then(([m, n, c]) => {
    market = m; npcData = n; craftData = c;
    for (const cr of c?.crafts || []) {
      if (!craftsBy.has(cr.id)) craftsBy.set(cr.id, []);
      craftsBy.get(cr.id).push(cr);
    }
  });
  extraPromise.catch(() => { extraPromise = null; });
  return extraPromise;
}
const anyName = (id) => craftData?.names[id] || npcData?.names[id] || names[id] || id;

// Ensures market data is loaded; shows a message in the table while it is not.
async function needMarket(tbody, cols) {
  if (market) return true;
  tbody.innerHTML = `<tr><td colspan="${cols}" class="muted">Fiyatlar yükleniyor…</td></tr>`;
  try { await loadExtra(); return true; } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="${cols}" class="muted">Bu bölümün verisi henüz yok. Fiyat toplayıcı bir sonraki çalışmasında (15 dakikada bir) oluşturacak.</td></tr>`;
    return false;
  }
}

// ---------- live prices (forge, NPC, craft and metal tabs) ----------
// "Güncel fiyatları çek" reads Hypixel directly and only replaces `market` and `latest` in memory:
// nothing is written to the data branch, history or charts.
const roundP = (v) => (v == null ? null : Math.round(v * 10) / 10);
let liveAt = null, liveBusy = false;

function loadScript(src) {
  return new Promise((ok, fail) => {
    const el = document.createElement('script');
    el.src = src; el.onload = ok; el.onerror = () => fail(new Error(`${src} yüklenemedi`));
    document.head.appendChild(el);
  });
}

// Minimal NBT reader for AH item_bytes (same logic as scripts/nbt.mjs).
function readNbt(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  let pos = 0;
  const str = () => { const n = v.getUint16(pos); pos += 2; const t = dec.decode(bytes.subarray(pos, pos + n)); pos += n; return t; };
  const payload = (type) => {
    switch (type) {
      case 1: return v.getInt8(pos++);
      case 2: { const x = v.getInt16(pos); pos += 2; return x; }
      case 3: { const x = v.getInt32(pos); pos += 4; return x; }
      case 4: pos += 8; return null;
      case 5: pos += 4; return null;
      case 6: pos += 8; return null;
      case 7: { const n = v.getInt32(pos); pos += 4 + n; return null; }
      case 8: return str();
      case 9: { const t = v.getInt8(pos++); const n = v.getInt32(pos); pos += 4; const out = []; for (let i = 0; i < n; i++) out.push(payload(t)); return out; }
      case 10: { const o = {}; for (;;) { const t = v.getInt8(pos++); if (t === 0) return o; const k = str(); o[k] = payload(t); } }
      case 11: { const n = v.getInt32(pos); pos += 4 + 4 * n; return null; }
      case 12: { const n = v.getInt32(pos); pos += 4 + 8 * n; return null; }
      default: throw new Error(`NBT ${type}`);
    }
  };
  const type = v.getInt8(pos++);
  str();
  return payload(type);
}
const PET_TIERS = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC'];
function auctionItem(b64) {
  const bin = atob(b64);
  const raw = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
  const item = readNbt(window.pako.ungzip(raw))?.i?.[0];
  const ea = item?.tag?.ExtraAttributes;
  if (!ea?.id) return null;
  let id = ea.id;
  if (id === 'PET' && ea.petInfo) {
    try { const p = JSON.parse(ea.petInfo); id = `${p.type};${PET_TIERS.indexOf(p.tier)}`; } catch { return null; }
  }
  return { id, count: item.Count || 1 };
}

async function fetchLive(withAh, status) {
  await loadExtra();
  status('Bazaar fiyatları alınıyor…');
  const res = await getJson(`${HYPIXEL}/bazaar`);
  const bz = {};
  for (const [id, p] of Object.entries(res.products || {})) {
    const q = p.quick_status || {};
    const ask = roundP(p.buy_summary?.[0]?.pricePerUnit ?? null);
    const bid = roundP(p.sell_summary?.[0]?.pricePerUnit ?? null);
    if (ask == null && bid == null) continue;
    bz[id] = [ask, bid, q.buyMovingWeek ?? 0, q.sellMovingWeek ?? 0, q.buyOrders ?? 0, q.sellOrders ?? 0];
  }
  // Forge items and their inputs, in the latest.json shape (same as scripts/collect.mjs).
  const tracked = new Set();
  for (const r of recipes) {
    tracked.add(r.id);
    for (const i of r.inputs) if (i.id !== COIN) tracked.add(i.id);
  }
  const bazaar = {};
  for (const id of tracked) {
    const p = res.products?.[id];
    if (!p) continue;
    const q = p.quick_status || {};
    bazaar[id] = {
      ask: roundP(p.buy_summary?.[0]?.pricePerUnit ?? q.buyPrice),
      bid: roundP(p.sell_summary?.[0]?.pricePerUnit ?? q.sellPrice),
      buyWeek: q.buyMovingWeek ?? 0,
      sellWeek: q.sellMovingWeek ?? 0,
      buyOrders: q.buyOrders ?? 0,
      sellOrders: q.sellOrders ?? 0,
      asks: (p.buy_summary || []).slice(0, 15).map((o) => [roundP(o.pricePerUnit), o.amount]),
    };
  }
  let forgeAh = latest?.ah || {};
  let ah = market.ah;
  if (withAh) {
    if (!window.pako) await loadScript('https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js');
    ah = {}; forgeAh = {};
    const first = await getJson(`${HYPIXEL}/auctions?page=0`);
    const total = first.totalPages || 1;
    const pages = [first];
    let done = 1;
    status(`AH ilanları alınıyor… 1/${total}`);
    const rest = [...Array(total).keys()].slice(1);
    for (let i = 0; i < rest.length; i += 8) {
      pages.push(...await Promise.all(rest.slice(i, i + 8).map((n) => getJson(`${HYPIXEL}/auctions?page=${n}`)
        .catch(() => null).finally(() => status(`AH ilanları alınıyor… ${++done}/${total}`)))));
    }
    status('AH ilanları işleniyor…');
    await new Promise((r) => setTimeout(r)); // let the status paint
    for (const page of pages) {
      for (const a of page?.auctions || []) {
        if (!a.bin || a.claimed) continue;
        let info;
        try { info = auctionItem(a.item_bytes); } catch { continue; }
        if (!info || bz[info.id]) continue;
        const unit = a.starting_bid / info.count;
        const cur = ah[info.id] || (ah[info.id] = [unit, 0]);
        cur[0] = Math.min(cur[0], unit);
        cur[1]++;
        if (!tracked.has(info.id) || bazaar[info.id]) continue;
        const f = forgeAh[info.id] || (forgeAh[info.id] = { lbin: unit, n: 0 });
        f.lbin = Math.min(f.lbin, unit);
        f.n++;
      }
    }
    for (const v of Object.values(ah)) v[0] = roundP(v[0]);
    for (const v of Object.values(forgeAh)) v.lbin = roundP(v.lbin);
  }
  const ts = Math.floor((res.lastUpdated || Date.now()) / 1000);
  market = { ...market, ts, bz, ah, live: true, liveAh: withAh || market.liveAh };
  latest = { ...latest, ts, bazaar, ah: forgeAh };
  liveAt = new Date();
}

function renderLiveStatus(text) {
  const time = liveAt?.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  document.querySelectorAll('.live-status').forEach((el) => {
    el.classList.toggle('on', !text && !!liveAt);
    el.textContent = text || (liveAt
      ? `Anlık fiyatlar (${time}, Bazaar${market.liveAh ? ' + AH' : ''}). Kaydedilmez; sayfayı yenileyince 15 dakikalık kayda döner.`
      : '');
  });
}

async function liveClick(ev) {
  if (liveBusy) return;
  const withAh = S.liveAh && ev?.currentTarget?.dataset.ah !== 'off';
  liveBusy = true;
  document.querySelectorAll('.live-btn').forEach((b) => { b.disabled = true; });
  try {
    await fetchLive(withAh, renderLiveStatus);
    renderLiveStatus();
    refreshAll();
  } catch (err) {
    console.error(err);
    renderLiveStatus(err instanceof TypeError
      ? 'Hypixel\'e bağlanılamadı. İnternet bağlantını kontrol edip tekrar dene.'
      : `Fiyatlar alınamadı: ${err.message}`);
  } finally {
    liveBusy = false;
    document.querySelectorAll('.live-btn').forEach((b) => { b.disabled = false; });
  }
}

// ---------- NPC vs Bazaar ----------
async function renderNpc() {
  const farm = S.npcView === 'farm';
  $('#npcAll').hidden = farm;
  $('#npcFarm').hidden = !farm;
  if (farm) return renderFarm();
  const tbody = $('#npcTable tbody');
  if (!await needMarket(tbody, 8)) return;
  if (!npcData) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">NPC fiyatları henüz toplanmadı. Fiyat toplayıcı bir sonraki çalışmasında ekleyecek.</td></tr>';
    return;
  }
  const q = $('#npcSearch').value.trim().toLowerCase();
  let list = [];
  for (const [id, [ask, bid, buyWeek, sellWeek]] of Object.entries(market.bz)) {
    const npc = npcData.npc[id];
    if (!npc) continue;
    const sellUnit = bzSellUnit(ask, bid);
    const sell = sellUnit == null ? null : sellUnit * (1 - S.bzTax / 100);
    const buy = bzBuyUnit(ask, bid);
    const flip = buy == null ? null : npc - buy;
    list.push({
      id, name: anyName(id), npc, sell, buy, flip,
      diff: sell == null ? npc : npc - sell,
      flipPct: flip == null || !buy ? null : (flip / buy) * 100,
      volume: S.sellMode === 'instant' ? sellWeek : buyWeek,
    });
  }
  if (q) list = list.filter((e) => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q));
  if (S.npcOnlyNpc) list = list.filter((e) => e.diff > 0);
  if (S.npcOnlyFlip) list = list.filter((e) => e.flip > 0);
  const key = S.npcSort;
  list.sort((a, b) => (a[key] == null ? 1 : b[key] == null ? -1 : b[key] - a[key]));
  tbody.innerHTML = list.map((e) => {
    const toNpc = e.diff > 0;
    const fcls = e.flip == null ? '' : e.flip > 0 ? 'pos' : 'neg';
    return `<tr>
      <td>${esc(e.name)}${thinTag(e.id)}</td>
      <td class="num">${coins(e.npc)}</td>
      <td class="num">${coins(e.sell)}</td>
      <td><span class="tag">${toNpc ? 'NPC' : 'Bazaar'}</span></td>
      <td class="num ${toNpc ? 'pos' : 'neg'}">${coins(e.diff)}</td>
      <td class="num">${coins(e.buy)}</td>
      <td class="num ${fcls}">${coins(e.flip)}${e.flipPct != null && e.flip > 0 ? ` <span class="muted small">%${e.flipPct.toFixed(1)}</span>` : ''}</td>
      <td class="num">${coins(e.volume)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">Filtrelere uyan item yok.</td></tr>';
  $('#npcNote').textContent = `${list.length} item. NPC'ye satışta vergi yoktur; Bazaar satışından %${S.bzTax} vergi düşüldü (ayarlardan değişir). NPC fiyatları Hypixel'in item listesinden günde bir kez alınır.`;
}

// ---------- farming view (inside NPC vs Bazaar) ----------
// The farming items Mito wants compared, nothing else.
const FARM_ITEMS = [
  'ENCHANTED_HAY_BALE', 'ENCHANTED_GOLDEN_CARROT', 'ENCHANTED_BAKED_POTATO', 'ENCHANTED_HUGE_MUSHROOM_1',
  'ENCHANTED_HUGE_MUSHROOM_2', 'MUTANT_NETHER_STALK', 'ENCHANTED_SUGAR_CANE', 'ENCHANTED_CACTUS',
  'ENCHANTED_COOKIE', 'BOX_OF_SEEDS', 'ENCHANTED_MELON_BLOCK', 'POLISHED_PUMPKIN',
  'COMPACTED_MOONFLOWER', 'COMPACTED_SUNFLOWER', 'COMPACTED_WILD_ROSE', 'FERMENTO', 'CROPIE', 'HELIANTHUS',
];

async function renderFarm() {
  const tbody = $('#farmTable tbody');
  if (!await needMarket(tbody, 7)) return;
  if (!npcData) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">NPC fiyatları henüz toplanmadı.</td></tr>';
    return;
  }
  const list = FARM_ITEMS.map((id) => {
    const b = market.bz[id];
    const npc = npcData.npc[id] ?? null;
    const unit = b ? bzSellUnit(b[0], b[1]) : null;
    const bz = unit == null ? null : unit * (1 - S.bzTax / 100);
    const best = npc == null && bz == null ? null : (bz ?? -Infinity) >= (npc ?? -Infinity) ? 'bz' : 'npc';
    const lo = Math.min(npc ?? Infinity, bz ?? Infinity);
    const diff = npc != null && bz != null ? Math.abs(bz - npc) : null;
    return {
      id, name: anyName(id), npc, bz, best, diff,
      diffPct: diff != null && lo > 0 ? (diff / lo) * 100 : null,
      volume: b ? (S.sellMode === 'instant' ? b[3] : b[2]) : null,
    };
  });
  if (S.farmSort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  else list.sort((a, b) => (b.diffPct ?? -1) - (a.diffPct ?? -1));
  tbody.innerHTML = list.map((e) => `<tr>
      <td>${esc(e.name)}${thinTag(e.id)}</td>
      <td class="num${e.best === 'npc' ? ' best' : ''}">${coins(e.npc)}</td>
      <td class="num${e.best === 'bz' ? ' best' : ''}">${coins(e.bz)}</td>
      <td>${e.best ? `<span class="tag pos">${e.best === 'npc' ? 'NPC' : 'Bazaar'}</span>` : '—'}</td>
      <td class="num pos">${coins(e.diff)}</td>
      <td class="num">${e.diffPct == null ? '—' : `%${e.diffPct.toFixed(1)}`}</td>
      <td class="num">${coins(e.volume)}</td>
    </tr>`).join('');
  $('#farmNote').textContent = `Daha iyi olan fiyat yeşil çerçeveli. NPC'ye satışta vergi yoktur; Bazaar satışından %${S.bzTax} vergi düşüldü (ayarlardan değişir).`;
}

// ---------- craft vs buy ----------
// Unit price of buying a ready item: Bazaar (by buy mode), else AH lowest BIN.
function marketBuy(id) {
  if (S.overrides[id] != null) return { unit: S.overrides[id], src: 'manual' };
  const b = market.bz[id];
  if (b) {
    const unit = bzBuyUnit(b[0], b[1]);
    if (unit != null) return { unit, src: S.buyMode === 'order' && b[1] != null ? 'bazaar-order' : 'bazaar' };
  }
  const a = market.ah[id];
  if (a) return { unit: a[0], src: 'ah' };
  if (isFreeCrystal(id)) return { unit: 0, src: 'free' };
  return { unit: null, src: 'missing' };
}

// Net coins from selling one unit (Bazaar after tax, AH after fees).
function marketSell(id) {
  const manual = S.overrides[id];
  const b = market.bz[id];
  if (b) {
    const unit = manual ?? bzSellUnit(b[0], b[1]);
    return { market: 'bazaar', net: unit == null ? null : unit * (1 - S.bzTax / 100), demand: S.sellMode === 'instant' ? b[3] : b[2] };
  }
  const a = market.ah[id];
  if (a || manual != null) {
    const unit = manual ?? a[0];
    return { market: 'ah', net: unit - ahFee(unit), demand: a ? a[1] : null };
  }
  return { market: 'unknown', net: null, demand: null };
}

// Cheapest way to get one unit of `id`: buy it, or (with sub-recipes on) craft it.
// `stack` holds the items being crafted above this one, to stop recipe loops.
function acquire(id, ctx) {
  const buy = marketBuy(id);
  if (!S.craftDeep || ctx.stack.has(id) || !craftsBy.has(id)) return { unit: buy.unit, src: buy.src };
  if (ctx.memo.has(id)) return ctx.memo.get(id);
  const best = bestCraft(id, ctx);
  const res = best.unit != null && (buy.unit == null || best.unit < buy.unit)
    ? { unit: best.unit, src: 'craft', craft: best } : { unit: buy.unit, src: buy.src };
  ctx.memo.set(id, res);
  return res;
}
function craftCost(c, ctx) {
  const inputs = c.inputs.map((i) => {
    const a = acquire(i.id, ctx);
    return { ...i, ...a, total: a.unit == null ? null : a.unit * i.count };
  });
  const missing = inputs.some((i) => i.total == null);
  return { recipe: c, inputs, unit: missing ? null : inputs.reduce((s, i) => s + i.total, 0) / c.count };
}
function bestCraft(id, ctx) {
  ctx.stack.add(id);
  let best = null;
  for (const c of craftsBy.get(id)) {
    const cc = craftCost(c, ctx);
    if (!best || (cc.unit != null && (best.unit == null || cc.unit < best.unit))) best = cc;
  }
  ctx.stack.delete(id);
  return best;
}

function craftRows() {
  const ctx = { memo: new Map(), stack: new Set() };
  const out = [];
  for (const id of craftsBy.keys()) {
    const mk = market.bz[id] ? 'bazaar' : market.ah[id] ? 'ah' : 'unknown';
    if (mk === 'unknown' && S.overrides[id] == null) continue; // nothing to compare against
    const craft = bestCraft(id, ctx);
    const buy = marketBuy(id);
    const sale = marketSell(id);
    const save = buy.unit != null && craft.unit != null ? buy.unit - craft.unit : null;
    out.push({
      id, name: anyName(id), market: mk, craft, buy: buy.unit, sale, save,
      savePct: save != null && buy.unit > 0 ? (save / buy.unit) * 100 : null,
      profit: sale.net != null && craft.unit != null ? sale.net - craft.unit : null,
      missing: save == null,
    });
  }
  return out;
}

let craftOpen = V.craftOpen;
const SRC_LABEL = { bazaar: 'Bazaar anında alım', 'bazaar-order': 'Bazaar buy order', ah: 'AH lowest BIN', manual: 'elle', craft: 'craftlanır', free: 'satılamaz, 0 sayıldı', missing: 'fiyat yok', coin: 'coin' };

function craftDetail(e) {
  const c = e.craft;
  const line = (i, depth) => {
    const pad = depth ? `<span class="muted">${'— '.repeat(depth)}</span>` : '';
    let html = `<tr><td>${pad}${esc(anyName(i.id))}</td><td class="num">${i.count.toLocaleString('tr-TR')}</td>
      <td class="num">${coins(i.unit)}</td><td class="num">${coins(i.total)}</td><td><span class="tag">${SRC_LABEL[i.src]}</span></td></tr>`;
    if (i.src === 'craft' && depth < 4) {
      // Sub-recipe amounts scaled to how many units this ingredient needs.
      const k = i.count / i.craft.recipe.count;
      html += i.craft.inputs.map((s) => line({ ...s, count: s.count * k, total: s.total == null ? null : s.total * k }, depth + 1)).join('');
    }
    return html;
  };
  return `<tr class="sub"><td colspan="8">
    ${c.recipe.count > 1 ? `<p class="small muted">Bir craft ${c.recipe.count} adet verir; maliyet adet başına bölündü.</p>` : ''}
    ${craftsBy.get(e.id).length > 1 ? `<p class="small muted">Bu itemin ${craftsBy.get(e.id).length} tarifi var; en ucuzu gösteriliyor.</p>` : ''}
    <table><thead><tr><th>Malzeme (1 craft)</th><th class="num">Adet</th><th class="num">Birim</th><th class="num">Toplam</th><th>Nasıl</th></tr></thead>
    <tbody>${c.inputs.map((i) => line(i, 0)).join('')}</tbody></table>
  </td></tr>`;
}

async function renderCraft() {
  const tbody = $('#craftTable tbody');
  if (!await needMarket(tbody, 8)) return;
  if (!craftData) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted">Craft tarifleri henüz oluşturulmadı. Fiyat toplayıcı bir sonraki çalışmasında ekleyecek.</td></tr>';
    return;
  }
  const q = $('#craftSearch').value.trim().toLowerCase();
  let list = craftRows();
  if (S.craftMarket !== 'all') list = list.filter((e) => e.market === S.craftMarket);
  if (S.craftHideMissing) list = list.filter((e) => !e.missing);
  if (S.craftOnlyCheaper) list = list.filter((e) => e.save > 0);
  if (q) list = list.filter((e) => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q));
  const key = S.craftSort;
  list.sort((a, b) => (a[key] == null ? 1 : b[key] == null ? -1 : b[key] - a[key]));
  const shown = list.slice(0, 500);
  tbody.innerHTML = shown.map((e) => {
    const better = e.save == null ? '—' : e.save > 0 ? '<span class="tag pos">Craftla</span>' : '<span class="tag">Satın al</span>';
    const scls = e.save == null ? '' : e.save > 0 ? 'pos' : 'neg';
    const pcls = e.profit == null ? '' : e.profit > 0 ? 'pos' : 'neg';
    const demand = e.sale.demand == null ? '—' : e.market === 'ah' ? `${e.sale.demand} ilan` : `${coins(e.sale.demand)}/hf`;
    return `<tr data-id="${esc(e.id)}">
      <td>${esc(e.name)}${e.market === 'bazaar' ? thinTag(e.id) : ''}</td>
      <td><span class="tag">${e.market === 'ah' ? 'AH' : 'Bazaar'}</span></td>
      <td class="num">${coins(e.buy)}</td>
      <td class="num">${coins(e.craft.unit)}</td>
      <td>${better}</td>
      <td class="num ${scls}">${coins(e.save)}${e.savePct != null && e.save > 0 ? ` <span class="muted small">%${e.savePct.toFixed(1)}</span>` : ''}</td>
      <td class="num ${pcls}">${coins(e.profit)}</td>
      <td class="num">${demand}</td>
    </tr>${craftOpen === e.id ? craftDetail(e) : ''}`;
  }).join('') || '<tr><td colspan="8" class="muted">Filtrelere uyan item yok.</td></tr>';
  $('#craftNote').textContent = `${list.length} item${list.length > shown.length ? `, ilk ${shown.length} tanesi gösteriliyor (aramayla daralt)` : ''}. Malzemeleri görmek için satıra tıkla. `
    + (S.craftDeep ? 'Bir malzemeyi craftlamak daha ucuzsa o da craftlanmış sayılıyor. ' : 'Malzemeler hazır satın alınmış sayılıyor. ')
    + 'Fiyatı olmayan malzemeler (NPC\'den alınan vanilla itemler gibi) eksik sayılır.';
}

// ---------- craft and sell vs sell the materials ----------
// For materials you already have: sell them as they are, or craft them and sell the result.
// Both sides are net: Bazaar tax and AH fees come off, NPC sales are untaxed.
function bestSale(id) {
  const m = marketSell(id);
  const npc = S.scNpc && S.overrides[id] == null ? npcData?.npc[id] ?? null : null;
  if (npc != null && (m.net == null || npc > m.net)) return { net: npc, where: 'npc', market: m.market, demand: m.demand };
  return { net: m.net, where: m.market, market: m.market, demand: m.demand };
}

function sellCraftRow(c) {
  const out = bestSale(c.id);
  const inputs = c.inputs.map((i) => {
    const s = bestSale(i.id);
    return { ...i, unit: s.net, where: s.where, total: s.net == null ? null : s.net * i.count };
  });
  const missing = out.net == null || inputs.some((i) => i.total == null);
  const directNet = inputs.some((i) => i.total == null) ? null : inputs.reduce((t, i) => t + i.total, 0) / c.count;
  const diff = missing ? null : out.net - directNet;
  return {
    id: c.id, recipe: c, inputs, out, directNet, craftNet: out.net, diff, missing,
    diffPct: diff != null && directNet > 0 ? (diff / directNet) * 100 : null,
  };
}

function sellCraftRows() {
  const list = [];
  for (const [id, cs] of craftsBy) {
    const mk = market.bz[id] ? 'bazaar' : market.ah[id] ? 'ah' : 'unknown';
    if (mk === 'unknown' && S.overrides[id] == null && !(S.scNpc && npcData?.npc[id] != null)) continue;
    // With several recipes, show the one whose materials sell for the least: the best one to craft.
    let best = null;
    for (const c of cs) {
      const r = sellCraftRow(c);
      if (!best || (r.diff != null && (best.diff == null || r.diff > best.diff))) best = r;
    }
    list.push({ ...best, name: anyName(id), market: mk, alts: cs.length, demand: best.out.demand });
  }
  return list;
}

const WHERE_LABEL = { bazaar: 'Bazaar', ah: 'AH', npc: 'NPC', unknown: '—' };
let scOpen = V.scOpen;

function sellCraftDetail(e) {
  const c = e.recipe;
  const tax = (w) => (w === 'bazaar' ? `%${S.bzTax} vergi düşüldü` : w === 'ah' ? 'AH ücreti düşüldü' : w === 'npc' ? 'vergisiz' : '');
  return `<tr class="sub"><td colspan="7">
    ${c.count > 1 ? `<p class="small muted">Bir craft ${c.count} adet verir; malzeme değeri adet başına bölündü.</p>` : ''}
    ${e.alts > 1 ? `<p class="small muted">Bu itemin ${e.alts} tarifi var; craftlamanın en kârlı olduğu gösteriliyor.</p>` : ''}
    <table><thead><tr><th>Malzeme (1 craft)</th><th class="num">Adet</th><th class="num">Birim (net)</th><th class="num">Toplam (net)</th><th>Nereye</th></tr></thead>
    <tbody>${e.inputs.map((i) => `<tr><td>${esc(anyName(i.id))}${i.where === 'bazaar' ? thinTag(i.id) : ''}</td><td class="num">${i.count.toLocaleString('tr-TR')}</td>
      <td class="num">${coins(i.unit)}</td><td class="num">${coins(i.total)}</td>
      <td>${i.unit == null ? '<span class="tag">fiyat yok</span>' : `<span class="tag">${WHERE_LABEL[i.where]}</span> <span class="muted small">${tax(i.where)}</span>`}</td></tr>`).join('')}
      <tr><td><b>Çıktı:</b> ${esc(e.name)}</td><td class="num">${c.count}</td><td class="num">${coins(e.out.net)}</td><td class="num">${coins(e.out.net == null ? null : e.out.net * c.count)}</td>
      <td>${e.out.net == null ? '<span class="tag">fiyat yok</span>' : `<span class="tag">${WHERE_LABEL[e.out.where]}</span> <span class="muted small">${tax(e.out.where)}</span>`}</td></tr>
    </tbody></table>
  </td></tr>`;
}

// Calculator: one item and an amount, either of crafted items or of the main material you have.
function renderSellCraftCalc(rows) {
  const dl = $('#scCalcList');
  if (!dl.childElementCount) dl.innerHTML = rows.map((e) => `<option value="${esc(e.name)}"></option>`).join('');
  const body = $('#scCalcBody');
  const e = rows.find((x) => x.id === S.scCalcId);
  if (!e) { body.className = 'muted small'; body.innerHTML = S.scCalcId ? 'Bu item bulunamadı.' : 'Bir item seç ve adet yaz; malzemeleri satmakla craftlayıp satmak arasındaki toplam farkı burada görürsün.'; return; }
  if (document.activeElement !== $('#scCalcItem')) $('#scCalcItem').value = e.name;
  const c = e.recipe;
  const qty = Math.max(1, Math.floor(Number(S.scCalcQty) || 1));
  // Main material: the ingredient used most per craft.
  const main = c.inputs.reduce((a, b) => (b.count > a.count ? b : a));
  const crafts = S.scCalcUnit === 'in' ? Math.floor(qty / main.count) : Math.ceil(qty / c.count);
  const made = crafts * c.count;
  const leftover = S.scCalcUnit === 'in' ? qty - crafts * main.count : 0;
  const mats = e.inputs.map((i) => ({ ...i, n: i.count * crafts }));
  const direct = mats.some((i) => i.unit == null) ? null : mats.reduce((t, i) => t + i.unit * i.n, 0);
  const craft = e.out.net == null ? null : e.out.net * made;
  const diff = direct == null || craft == null ? null : craft - direct;
  const cls = diff == null ? '' : diff > 0 ? 'pos' : 'neg';
  const stat = (k, v, kls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${kls}">${v}</div></div>`;
  body.className = '';
  body.innerHTML = crafts === 0
    ? `<p class="muted small">1 craft için ${main.count.toLocaleString('tr-TR')} ${esc(anyName(main.id))} gerekiyor; yazdığın adet yetmiyor.</p>`
    : `<div class="stats">
      ${stat(`Malzemeleri sat (${crafts.toLocaleString('tr-TR')} craftlık)`, coins(direct))}
      ${stat(`${made.toLocaleString('tr-TR')} ${esc(e.name)} sat`, coins(craft))}
      ${stat(diff == null ? 'Fark' : diff > 0 ? 'Craftlarsan fazladan kazanırsın' : 'Craftlarsan kaybedersin', coins(diff == null ? null : Math.abs(diff)), cls)}
    </div>
    <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>Malzeme</th><th class="num">Toplam adet</th><th class="num">Birim (net)</th><th class="num">Toplam (net)</th><th>Nereye</th></tr></thead><tbody>
      ${mats.map((i) => `<tr><td>${esc(anyName(i.id))}</td><td class="num">${i.n.toLocaleString('tr-TR')}</td><td class="num">${coins(i.unit)}</td><td class="num">${coins(i.unit == null ? null : i.unit * i.n)}</td><td><span class="tag">${i.unit == null ? 'fiyat yok' : WHERE_LABEL[i.where]}</span></td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted small">${S.scCalcUnit === 'out' && made !== qty ? `Bir craft ${c.count} adet verdiği için ${made.toLocaleString('tr-TR')} adede yuvarlandı. ` : ''}${leftover > 0 ? `${leftover.toLocaleString('tr-TR')} ${esc(anyName(main.id))} artıyor; iki durumda da satılacağı için farkı değiştirmez. ` : ''}Bazaar fiyatı en iyi tekliften hesaplanır; çok büyük miktarda satışta fiyat düşebilir.</p>`;
}

// Gemstone tiers ranked by what one rough gem is worth when sold at that tier.
// Rough → Flawed → Fine → Flawless take 80 each (crafting table). Perfect (a forge) is left out.
const GEM_TIERS = [['ROUGH', 'Rough', 1], ['FLAWED', 'Flawed', 80], ['FINE', 'Fine', 6400], ['FLAWLESS', 'Flawless', 512000]];
// Selling what you hold of one gemstone. Gems only craft upward (80 of a tier make one of the
// next), never down. `target` is a tier key: everything below it is crafted up to it as far as full
// crafts allow, and tiers at or above it are sold as they are. 'best' picks Fine or Flawless,
// whichever earns more: Rough and Flawed trade too thinly for their prices to hold on a large sale.
const PLAN_TIERS = GEM_TIERS;
const PLAN_STEP = [80, 80, 80]; // from tier i to tier i + 1
const TO_TIER = { FLAWED: "Flawed'a", FINE: "Fine'a", FLAWLESS: "Flawless'a" };
function gemPlanTo(t, target) {
  const h = S.gemHold[t] || {};
  const held = PLAN_TIERS.map(([k]) => Math.max(0, Math.floor(Number(h[k]) || 0)));
  if (!held.some((x) => x > 0)) return null;
  const v = PLAN_TIERS.map(([k]) => bestSale(`${k}_${t}_GEM`).net);
  const last = PLAN_TIERS.length - 1;
  const T = target === 'asis' ? 0 : PLAN_TIERS.findIndex(([k]) => k === target);
  const sell = [], made = [];
  let pool = held[0];
  for (let i = 0; i <= last; i++) {
    if (i < T) {
      made[i + 1] = Math.floor(pool / PLAN_STEP[i]);
      sell[i] = pool - made[i + 1] * PLAN_STEP[i];
      pool = held[i + 1] + made[i + 1];
    } else {
      sell[i] = pool;
      if (i < last) pool = held[i + 1];
    }
  }
  // Rough and Flawed left over when going for Fine or higher are left out unless the box is ticked:
  // their prices don't hold on a large sale.
  const FINE_I = PLAN_TIERS.findIndex(([k]) => k === 'FINE');
  const skip = sell.map((n, i) => n > 0 && !S.gemCountLow && T >= FINE_I && i < FINE_I);
  const missing = sell.some((n, i) => n > 0 && !skip[i] && v[i] == null);
  const total = sell.reduce((a, n, i) => a + (skip[i] ? 0 : n * (v[i] ?? 0)), 0);
  return { held, sell, made, total, missing, target, skip };
}
function gemPlan(t, target) {
  if (target !== 'best') return gemPlanTo(t, target);
  const fine = gemPlanTo(t, 'FINE'), flawless = gemPlanTo(t, 'FLAWLESS');
  if (!fine) return null;
  return flawless.total > fine.total && !flawless.missing ? flawless : fine;
}
const fmtN = (n) => n.toLocaleString('tr-TR');
// Name of the tier the best plan goes to; without amounts, compare one Flawless with 80 Fine.
// Fine or Flawless by price alone: one Flawless against the 80 Fine it is made from.
function priceBestTier(t) {
  const fine = bestSale(`FINE_${t}_GEM`).net, flawless = bestSale(`FLAWLESS_${t}_GEM`).net;
  return flawless != null && (fine == null || flawless > fine * 80) ? 'FLAWLESS' : 'FINE';
}
// When Flawless pays more per gem but the amounts don't reach one Flawless, both plans sell the same.
function flawlessShort(t) {
  const fine = gemPlanTo(t, 'FINE');
  if (!fine || priceBestTier(t) !== 'FLAWLESS' || fine.sell[2] >= PLAN_STEP[2]) return 0;
  return PLAN_STEP[2] - fine.sell[2];
}
function bestTierLabel(t) {
  const p = gemPlan(t, 'best');
  if (p && flawlessShort(t)) return "Fine (Flawless'a yetmiyor)";
  return tierLabel(p ? p.target : priceBestTier(t));
}
const bestOptionText = (t) => `En kârlı: ${bestTierLabel(t)}`;
function gemPlanText(p) {
  const crafts = PLAN_TIERS.map(([, label], i) => (p.made[i] ? `${fmtN(p.made[i])} ${label}` : null)).filter(Boolean);
  const sells = PLAN_TIERS.map(([, label], i) => (p.sell[i] && !p.skip[i] ? `${fmtN(p.sell[i])} ${label}` : null)).filter(Boolean);
  const skipped = PLAN_TIERS.map(([, label], i) => (p.sell[i] && p.skip[i] ? `${fmtN(p.sell[i])} ${label}` : null)).filter(Boolean);
  return (crafts.length ? `Craftla: ${crafts.join(', ')}. ` : '') + `Sat: ${sells.join(', ') || '—'}`
    + (skipped.length ? `. <span class="muted">Hesaba katılmadı: ${skipped.join(', ')}</span>` : '');
}
// The less profitable of the two best-plan options (Fine or Flawless).
function gemOtherPlan(t, best) {
  return gemPlanTo(t, best.target === 'FLAWLESS' ? 'FINE' : 'FLAWLESS');
}
const tierLabel = (k) => PLAN_TIERS.find(([x]) => x === k)?.[1] || k;
function gemHoldHtml(t) {
  const target = S.gemHold[t]?.target || 'best';
  const p = gemPlan(t, target);
  if (!p) return '<span class="muted small">Adet yaz</span>';
  const best = gemPlan(t, 'best'), other = gemOtherPlan(t, best);
  let cmp = '';
  if (target === 'best' || target === best.target) {
    const gain = best.total - other.total;
    const short = flawlessShort(t);
    cmp = gain > 0 ? `<span class="pos">${tierLabel(other.target)} olarak satmaktan +${coins(gain)} daha kârlı</span>`
      : short ? `<span class="muted">Fiyata göre Flawless daha kârlı ama 1 Flawless için ${fmtN(short)} Fine daha gerekiyor, o yüzden Fine satılıyor.</span>`
      : `<span class="muted">${tierLabel(other.target)} ile aynı sonuç</span>`;
  } else if (p.total < best.total) {
    cmp = `<span class="neg">En kârlı seçeneğe (${tierLabel(best.target)}) göre ${coins(p.total - best.total)}</span>`;
  }
  return `<b>${coins(p.total)}</b>${p.missing ? ' <span class="warn">bazı tierların fiyatı yok, 0 sayıldı</span>' : ''}
    <div class="small">${gemPlanText(p)}</div>
    <div class="small">${cmp}</div>`;
}
function gemHoldTotal(types) {
  const ideal = types.map((t) => gemPlan(t, 'best')).filter(Boolean);
  if (!ideal.length) return '';
  const chosen = types.map((t) => gemPlan(t, S.gemHold[t]?.target || 'best')).filter(Boolean);
  const others = types.map((t) => { const b = gemPlan(t, 'best'); return b && gemOtherPlan(t, b); }).filter(Boolean);
  const sum = (l) => l.reduce((a, p) => a + p.total, 0);
  const st = (k, v, cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${coins(v)}</div></div>`;
  const diff = sum(chosen) - sum(ideal);
  const gain = sum(ideal) - sum(others);
  return `<div class="stats">
    ${st('Hepsini en kârlı şekilde satarsan', sum(ideal), 'pos')}
    ${st('Seçtiğin tierlarla', sum(chosen), diff < 0 ? 'neg' : '')}
    ${st('Daha az kârlı olan seçenekle satarsan', sum(others))}
  </div>
  ${gain > 0 ? `<p class="small pos">En kârlı seçenekler, daha az kârlı olanlardan toplam +${coins(gain)} fazla kazandırıyor.</p>` : ''}`;
}

function renderGemRank() {
  const box = $('#gemRank');
  const types = gemTypes();
  const gemName = (t) => anyName(`ROUGH_${t}_GEM`).replace(/^Rough /, '').replace(/ Gemstone$/, '');
  const rows = types.map((t) => {
    const tiers = GEM_TIERS.map(([k, label, eq]) => {
      const s = bestSale(`${k}_${t}_GEM`);
      return { label, id: `${k}_${t}_GEM`, per: s.net == null ? null : (s.net / eq) * 1000, where: s.where };
    }).filter((x) => x.per != null).sort((a, b) => b.per - a.per);
    return { t, name: gemName(t), tiers, pick: tierLabel(priceBestTier(t)) };
  });
  const n = Math.max(0, ...rows.map((r) => r.tiers.length));
  const holdRow = (t) => {
    const h = S.gemHold[t] || {};
    const target = h.target || 'best';
    return `<tr><td>${esc(gemName(t))}</td>
      ${GEM_TIERS.map(([k]) => `<td class="gem-hold"><input type="number" min="0" step="1" placeholder="0" data-gem="${t}" data-k="${k}" value="${h[k] || ''}"></td>`).join('')}
      <td class="gem-hold"><select data-gem="${t}" data-k="target">
        <option value="best"${target === 'best' ? ' selected' : ''}>${bestOptionText(t)}</option>
        <option value="asis"${target === 'asis' ? ' selected' : ''}>Olduğu gibi sat</option>
        ${PLAN_TIERS.slice(1).map(([k]) => `<option value="${k}"${target === k ? ' selected' : ''}>${TO_TIER[k]} kadar craftla</option>`).join('')}
      </select></td>
      <td id="gemRes-${t}">${gemHoldHtml(t)}</td></tr>`;
  };
  box.innerHTML = `<h3>Gemstone tier sıralaması</h3>
    <p class="muted small">Her gemstone için hangi tierda satmanın en kârlı olduğu. Değerler 1000 ham (Rough) gem başına net coin: Bazaar vergisi düşüldü${S.scNpc ? ', NPC daha iyiyse o sayıldı' : ''}. Yeşil çerçeve Fine ile Flawless'tan daha kârlı olanı gösterir; Rough ve Flawed fiyatları büyük satışta tutmadığı için soluk.</p>
    <div class="table-wrap"><table><thead><tr><th>Gemstone</th>${[...Array(n).keys()].map((i) => `<th>${i + 1}.</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.name)}</td>${r.tiers.map((x, i) => `<td class="${x.label === r.pick ? 'best' : x.label === 'Fine' || x.label === 'Flawless' ? '' : 'dim'}"><b>${x.label}</b>${x.where === 'npc' ? ' <span class="tag">NPC</span>' : thinTag(x.id)} <span class="muted small">${coins(x.per)}${i > 0 && r.tiers[0].per > 0 ? ` <span class="nowrap">(−%${((1 - x.per / r.tiers[0].per) * 100).toFixed(1)})</span>` : ''}</span></td>`).join('')}${'<td></td>'.repeat(n - r.tiers.length)}</tr>`).join('')}
    </tbody></table></div>
    <h3>Elimdeki gemstone'lar</h3>
    <label class="check" title="Fine'a craftlanamayacak kadar az kalan Rough ve Flawed gemler varsayılan olarak toplama katılmaz."><input type="checkbox" id="gemCountLow"${S.gemCountLow ? ' checked' : ''}> Fine'a craftlanamayan Rough/Flawed artıklarını da hesaba kat</label>
    <p class="muted small">Her tierdan kaç tane olduğunu yaz. Gemler sadece yukarı craftlanır (80 tane = 1 üst tier), üst tier aşağı çevrilemez, o yüzden elindeki üst tierlar en az o tierda satılır. Tam craft'a yetmeyen artanlar bulundukları tierda satılır. "En kârlı" seçeneği gemleri Fine'a kadar ya da Flawless'a kadar craftlayıp satmaktan hangisi daha çok kazandırıyorsa onu kullanır, çünkü Rough ve Flawed fiyatları büyük satışta tutmaz (sıralamada yine görünürler). "Ne yapmalı" sütunundan kendi seçtiğin tieri da hesaplatabilirsin.</p>
    <div class="table-wrap"><table><thead><tr><th>Gemstone</th>${GEM_TIERS.map(([, label]) => `<th>${label}</th>`).join('')}<th>Ne yapmalı</th><th>Sonuç (net)</th></tr></thead><tbody>
    ${types.map(holdRow).join('')}
    </tbody></table></div>
    <div id="gemHoldTotal">${gemHoldTotal(types)}</div>`;
  $('#gemCountLow').onchange = (ev) => { S.gemCountLow = ev.target.checked; save(); renderGemRank(); renderMineTotal(); };
  box.oninput = (ev) => {
    const { gem, k } = ev.target.dataset;
    if (!gem) return;
    S.gemHold[gem] = { ...S.gemHold[gem], [k]: k === 'target' ? ev.target.value : Number(ev.target.value) || 0 };
    save();
    $(`#gemRes-${gem}`).innerHTML = gemHoldHtml(gem);
    box.querySelector(`select[data-gem="${gem}"] option[value=best]`).textContent = bestOptionText(gem);
    $('#gemHoldTotal').innerHTML = gemHoldTotal(types);
    renderMineTotal();
  };
}

async function renderSellCraft() {
  const tbody = $('#scTable tbody');
  if (!await needMarket(tbody, 7)) return;
  if (!craftData) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">Craft tarifleri henüz oluşturulmadı. Fiyat toplayıcı bir sonraki çalışmasında ekleyecek.</td></tr>';
    return;
  }
  const q = $('#scSearch').value.trim().toLowerCase();
  let list = sellCraftRows();
  renderSellCraftCalc(list);
  if (S.scMarket !== 'all') list = list.filter((e) => e.market === S.scMarket);
  if (S.scHideMissing) list = list.filter((e) => !e.missing);
  if (S.scOnlyCraft) list = list.filter((e) => e.diff > 0);
  if (q) list = list.filter((e) => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q));
  const key = S.scSort;
  list.sort((a, b) => (a[key] == null ? 1 : b[key] == null ? -1 : b[key] - a[key]));
  const shown = list.slice(0, 500);
  tbody.innerHTML = shown.map((e) => {
    const better = e.diff == null ? '—' : e.diff > 0 ? '<span class="tag pos">Craftla, sat</span>' : '<span class="tag">Malzemeleri sat</span>';
    const cls = e.diff == null ? '' : e.diff > 0 ? 'pos' : 'neg';
    const where = e.out.where === 'npc' ? 'NPC' : e.market === 'ah' ? 'AH' : e.market === 'bazaar' ? 'Bazaar' : '?';
    const demand = e.demand == null ? '—' : e.market === 'ah' ? `${e.demand} ilan` : `${coins(e.demand)}/hf`;
    return `<tr data-id="${esc(e.id)}">
      <td>${esc(e.name)}${e.out.where === 'bazaar' ? thinTag(e.id) : ''}</td>
      <td><span class="tag">${where}</span></td>
      <td class="num">${coins(e.directNet)}</td>
      <td class="num">${coins(e.craftNet)}</td>
      <td>${better}</td>
      <td class="num ${cls}">${coins(e.diff)}${e.diffPct != null && e.diff > 0 ? ` <span class="muted small">%${e.diffPct.toFixed(1)}</span>` : ''}</td>
      <td class="num">${demand}</td>
    </tr>${scOpen === e.id ? sellCraftDetail(e) : ''}`;
  }).join('') || '<tr><td colspan="7" class="muted">Filtrelere uyan item yok.</td></tr>';
  $('#scNote').textContent = `${list.length} item${list.length > shown.length ? `, ilk ${shown.length} tanesi gösteriliyor (aramayla daralt)` : ''}. Malzemeleri görmek için satıra tıkla. `
    + `Bazaar satışından %${S.bzTax} vergi (ayarlardan değişir), AH satışından ilan ve claim ücreti düşüldü. `
    + (S.scNpc ? 'NPC\'ye satmak daha iyiyse o kullanıldı (NPC\'de vergi yok). ' : '')
    + 'Değerler 1 adet craftlanan item için.';
}

// ---------- Mining profits ----------
// Every mined material in one tab: amounts come from the sacks (or are typed), each material shows
// its routes (sell raw / Enchanted, forge into a key, Refined, Plate…), and the bottom adds up the
// route chosen for every material ticked for the total.
const MINE = [
  // noSell: selling raw or Enchanted isn't realistic in bulk, so only the forge/craft routes are
  // offered, and what is left over after the last full forge stays with you (counted as 0).
  { id: 'TUNGSTEN', noSell: true, name: 'Tungsten', raw: 'TUNGSTEN', ench: 'ENCHANTED_TUNGSTEN', refined: 'REFINED_TUNGSTEN', plate: 'TUNGSTEN_PLATE', key: 'TUNGSTEN_KEY' },
  { id: 'UMBER', noSell: true, name: 'Umber', raw: 'UMBER', ench: 'ENCHANTED_UMBER', refined: 'REFINED_UMBER', plate: 'UMBER_PLATE', key: 'UMBER_KEY' },
  { id: 'GLACITE', name: 'Glacite', raw: 'GLACITE', ench: 'ENCHANTED_GLACITE', refined: 'GLACITE_AMALGAMATION', refLabel: 'Glacite Amalgamation' },
  { id: 'MITHRIL', name: 'Mithril', raw: 'MITHRIL_ORE', ench: 'ENCHANTED_MITHRIL', refined: 'REFINED_MITHRIL' },
  { id: 'TITANIUM', name: 'Titanium', raw: 'TITANIUM_ORE', ench: 'ENCHANTED_TITANIUM', refined: 'REFINED_TITANIUM' },
  { id: 'HARD_STONE', noSell: true, name: 'Hard Stone', raw: 'HARD_STONE', ench: 'ENCHANTED_HARD_STONE', craftUp: 'CONCENTRATED_STONE' },
  // Drops that turn into nothing else: only sold as they are.
  { id: 'REFINED_MINERAL', name: 'Refined Mineral', raw: 'REFINED_MINERAL', simple: true, view: 'OTHER' },
  { id: 'GLOSSY_GEMSTONE', name: 'Glossy Gemstone', raw: 'GLOSSY_GEMSTONE', simple: true, view: 'OTHER' },
  { id: 'SUSPICIOUS_SCRAP', name: 'Suspicious Scrap', raw: 'SUSPICIOUS_SCRAP', simple: true, view: 'OTHER' },
];
const forgeRecipe = (id) => recipes.find((r) => r.id === id);
const fmtAmt = (n, d = 0) => n.toLocaleString('tr-TR', { maximumFractionDigits: d });
// Raw pieces per Enchanted, from the crafting table recipe (160 for most).
function enchRatio(m) {
  const c = craftsBy.get(m.ench)?.find((x) => x.inputs.length === 1 && x.inputs[0].id === m.raw);
  return c ? c.inputs[0].count / c.count : 160;
}

// Extra ingredients of a forge recipe (everything but `skip`), bought at the chosen buy mode.
function extras(r, skip) {
  return r.inputs.filter((i) => i.id !== skip).map((i) => {
    const b = marketBuy(i.id);
    return { id: i.id, count: i.count, unit: b.unit, total: b.unit == null ? null : b.unit * i.count };
  });
}

// One route: `n` forges of the product, `leftover` Enchanted sold as is.
// `stages` are [jobs, seconds per job] run back to back on the forge slots.
function metalRoute(m, label, product, n, extraCost, leftover, stages, missing) {
  const { slots, qfLevel } = effective();
  const k = 1 - qfPercent(qfLevel) / 100;
  const sale = marketSell(product);
  const enchSale = marketSell(m.ench);
  const leftoverNet = leftover > 0 && !m.noSell ? (enchSale.net == null ? null : enchSale.net * leftover) : 0;
  const ok = !missing && sale.net != null && extraCost != null && leftoverNet != null;
  const slotSec = stages.reduce((t, [jobs, sec]) => t + jobs * sec * k, 0);
  const wallSec = stages.reduce((t, [jobs, sec]) => t + Math.ceil(jobs / slots) * sec * k, 0);
  return {
    label, product, n, extraCost, leftover,
    gross: sale.net == null ? null : sale.net * n,
    total: ok ? sale.net * n - extraCost + leftoverNet : null,
    slotSec, wallSec, demand: sale.demand,
  };
}

// Routes for `enchAmount` whole Enchanted pieces (raw left over is added by the caller).
function metalRoutes(m, enchAmount) {
  const ratio = enchRatio(m);
  const rows = [];
  const raw = marketSell(m.raw);
  if (!m.noSell) {
    if (raw.net != null) rows.push(metalRoute(m, 'Ham olarak sat', m.raw, enchAmount * ratio, 0, 0, [], false));
    rows.push(metalRoute(m, 'Enchanted olarak sat', m.ench, enchAmount, 0, 0, [], false));
  }

  const keyR = m.key && forgeRecipe(m.key);
  if (keyR) {
    const per = keyR.inputs.find((i) => i.id === m.ench)?.count;
    const n = per ? Math.floor(enchAmount / per) : 0;
    const ex = extras(keyR, m.ench);
    const cost = ex.some((e) => e.total == null) ? null : ex.reduce((t, e) => t + e.total, 0) * n;
    rows.push({ ...metalRoute(m, 'Anahtar', m.key, n, cost, enchAmount - n * (per || 0), [[n, keyR.duration]], !per), extras: ex, per });
  }

  // A crafting table step (no forge time), e.g. Enchanted Hard Stone → Concentrated Stone.
  const upC = m.craftUp && craftsBy.get(m.craftUp)?.find((x) => x.inputs.length === 1 && x.inputs[0].id === m.ench);
  if (upC) {
    const per = upC.inputs[0].count / upC.count;
    const n = Math.floor(enchAmount / per);
    rows.push({ ...metalRoute(m, `${anyName(m.craftUp)} craftla`, m.craftUp, n, 0, enchAmount - n * per, [], false), per });
  }

  const refLabel = m.refLabel || 'Refined';
  const refR = m.refined && forgeRecipe(m.refined);
  const refPer = refR?.inputs.find((i) => i.id === m.ench)?.count;
  if (refR && refPer) {
    const n = Math.floor(enchAmount / refPer);
    const ex = extras(refR, m.ench);
    const cost = ex.some((e) => e.total == null) ? null : ex.reduce((t, e) => t + e.total, 0) * n;
    rows.push({ ...metalRoute(m, refLabel, m.refined, n, cost, enchAmount - n * refPer, [[n, refR.duration]], false), extras: ex, per: refPer });

    const plateR = m.plate && forgeRecipe(m.plate);
    const perPlate = plateR?.inputs.find((i) => i.id === m.refined)?.count;
    if (plateR && perPlate) {
      const p = Math.floor(enchAmount / (refPer * perPlate));
      const ex2 = extras(plateR, m.refined);
      const one = ex2.some((e) => e.total == null) || cost == null ? null : ex2.reduce((t, e) => t + e.total, 0);
      const refCost = ex.reduce((t, e) => t + (e.total ?? 0), 0) * perPlate;
      rows.push({
        ...metalRoute(m, `${refLabel} → Plate`, m.plate, p, one == null ? null : (one + refCost) * p,
          enchAmount - p * refPer * perPlate, [[p * perPlate, refR.duration], [p, plateR.duration]], false),
        extras: ex2, per: refPer * perPlate,
      });
    }
  }
  return rows;
}

// Amounts held of one material: { raw, ench } as typed or pulled from the sacks.
const mineHold = (m) => ({ raw: Math.max(0, Number(S.mine[m.id]?.raw) || 0), ench: Math.max(0, Number(S.mine[m.id]?.ench) || 0) });

// All routes of one material with what is held, the best one and the chosen one.
function mineCalc(m) {
  const { raw, ench } = mineHold(m);
  if (m.simple) {
    const r = metalRoute(m, 'Olduğu gibi sat', m.raw, raw, 0, 0, [], false);
    return { raw, ench: 0, whole: 0, rawLeft: 0, rows: [r], best: r, chosen: r, has: raw > 0 };
  }
  const ratio = enchRatio(m);
  const whole = ench + Math.floor(raw / ratio);
  const rawLeft = raw - Math.floor(raw / ratio) * ratio;
  const rawSale = marketSell(m.raw).net;
  // Raw that doesn't make a full Enchanted is sold raw on every route.
  const rawLeftNet = rawLeft > 0 && !m.noSell ? (rawSale == null ? null : rawSale * rawLeft) : 0;
  const rows = metalRoutes(m, whole).map((r) => {
    if (r.product === m.raw) return { ...r, n: r.n + rawLeft, total: r.total == null || rawSale == null ? r.total : r.total + rawSale * rawLeft };
    return { ...r, total: r.total == null || rawLeftNet == null ? null : r.total + rawLeftNet };
  });
  const best = rows.reduce((b, r) => (r.total != null && (r.n > 0 || r.product === m.ench) && (!b || r.total > b.total) ? r : b), null);
  const chosen = rows.find((r) => r.label === S.mineRoute[m.id]) || best;
  return { raw, ench, whole, rawLeft, rows, best, chosen, has: raw > 0 || ench > 0 };
}

const inTotal = (id) => S.mineInTotal[id] !== false;

// ---------- items in the forge ----------
// Only forges that belong to the routes on this tab: Refined / Plate / key of each metal,
// Glacite Amalgamation, Perfect Plate, Skeleton Key and Perfect gemstones.
function isMineForge(id) {
  if (isGem(id, 'PERFECT') || id === 'PERFECT_PLATE' || id === 'SKELETON_KEY') return true;
  return MINE.some((m) => [m.refined, m.plate, m.key].includes(id));
}
// Hypixel keeps the forge as forge.forge_processes.forge_1 = { "1": { id, startTime, slot }, … }.
function readForge(member, all = false) {
  const out = [];
  for (const group of Object.values(member?.forge?.forge_processes || {})) {
    for (const [slot, p] of Object.entries(group || {})) {
      if (p?.id && (all || isMineForge(p.id))) out.push({ id: p.id, slot: Number(p.slot ?? slot), start: Number(p.startTime) || 0 });
    }
  }
  return out.sort((a, b) => a.slot - b.slot);
}
// One forge job with its value and when it is done (recipe time with the Quick Forge discount).
function forgeJob(f) {
  const r = forgeRecipe(f.id);
  const count = r?.count || 1;
  const net = marketSell(f.id).net;
  const end = r && f.start ? f.start + r.duration * 1000 * (1 - qfPercent(effective().qfLevel) / 100) : null;
  return { ...f, count, value: net == null ? null : net * count, end };
}
const forgeJobs = () => (S.forging || []).map(forgeJob);
function forgeLeft(end) {
  if (end == null) return '—';
  const left = end - Date.now();
  return left <= 0 ? '<span class="tag pos">Hazır</span>' : `${duration(left / 1000)} kaldı`;
}
const forgeEndText = (end) => (end == null ? '' : new Date(end).toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
// "2× Refined Tungsten, 1× Perfect Plate" for the given jobs.
function forgeSummary(jobs) {
  const by = new Map();
  for (const j of jobs) by.set(j.id, (by.get(j.id) || 0) + j.count);
  return [...by].map(([id, n]) => `${fmtAmt(n)}× ${anyName(id)}`).join(', ');
}

// ---------- forge done notifications ----------
// A static page can't push on its own, so this works while the tab is open (it may be in the
// background). Jobs already done when they are first seen are not announced.
const forgeKey = (f) => `${f.slot}:${f.start}`;
const canNotify = () => 'Notification' in window;
function markDoneForges() {
  const now = Date.now();
  const keep = {};
  for (const j of (S.forgeAll || []).map(forgeJob)) {
    const k = forgeKey(j);
    if (S.forgeNotified[k] || (j.end != null && j.end <= now)) keep[k] = 1;
  }
  S.forgeNotified = keep;
}
function checkForgeDone() {
  if (!S.forgeNotify || !canNotify() || Notification.permission !== 'granted') return;
  const now = Date.now();
  const done = (S.forgeAll || []).map(forgeJob).filter((j) => j.end != null && j.end <= now && !S.forgeNotified[forgeKey(j)]);
  if (!done.length) return;
  for (const j of done) S.forgeNotified[forgeKey(j)] = 1;
  save();
  const body = done.map((j) => `Slot ${j.slot}: ${anyName(j.id)}${j.count > 1 ? ` ×${j.count}` : ''}`).join('\n');
  try {
    const n = new Notification(done.length > 1 ? `${done.length} forge bitti` : 'Forge bitti', { body, tag: 'forge-done' });
    n.onclick = () => { window.focus(); showTab('mine'); n.close(); };
  } catch { /* some mobile browsers only notify through a service worker */ }
  if ($('#tab-mine').classList.contains('active')) renderForging();
}
function nextForgeEnd() {
  const now = Date.now();
  const ends = (S.forgeAll || []).map(forgeJob).map((j) => j.end).filter((e) => e != null && e > now);
  return ends.length ? Math.min(...ends) : null;
}
function forgeNotifyHtml() {
  if (!canNotify()) return '<p class="muted small">Bu tarayıcı bildirimleri desteklemiyor.</p>';
  const perm = Notification.permission;
  const next = nextForgeEnd();
  const state = !S.forgeNotify ? ''
    : perm === 'denied' ? ' <span class="warn">Tarayıcı bildirimlere izin vermiyor; adres çubuğundaki site ayarlarından izin ver.</span>'
      : perm !== 'granted' ? ' <span class="warn">Bildirim izni bekleniyor.</span>'
        : next ? ` Sıradaki: ${forgeEndText(next)}.` : ' Bekleyen forge yok.';
  return `<p class="small"><label class="check"><input type="checkbox" id="forgeNotify"${S.forgeNotify ? ' checked' : ''}> Forge bitince bildirim gönder</label>${state}</p>
    <p class="muted small">Forgedaki her item için (yalnız bu tablodakiler değil) bitiş saatinde bildirim gelir. Bunun için bu sekme açık kalmalı, arka planda olabilir; tarayıcı kapalıyken bildirim gelmez. Yeni bir forge koyunca "Sack'lerden çek" ile listeyi yenile.</p>`;
}
async function setForgeNotify(on) {
  S.forgeNotify = on;
  if (on) {
    markDoneForges();
    if (canNotify() && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* old Safari */ }
    }
  }
  save();
  renderForging();
}

function renderForging() {
  const box = $('#mineForge');
  if (!S.forging) { box.hidden = true; return; }
  box.hidden = false;
  const jobs = forgeJobs();
  if (!jobs.length) {
    box.innerHTML = '<h3>Forgede olanlar</h3>' + forgeNotifyHtml() + '<p class="muted small">Son çekimde forgede bu sekmedeki yollarla ilgili item yoktu (Refined, Plate, anahtar, Glacite Amalgamation, Perfect Plate, Skeleton Key, Perfect gemstone).</p>';
    return;
  }
  const total = jobs.reduce((a, j) => a + (j.value ?? 0), 0);
  box.innerHTML = `<h3>Forgede olanlar</h3>
    <div class="table-wrap"><table><thead><tr>
      <th>Slot</th><th>Item</th>
      <th class="num" title="Seçili satış yöntemiyle, vergi düşülmüş satış. Malzemeler zaten harcandığı için tamamı kazanç sayılır.">Değer (net)</th>
      <th class="num">Bitiş</th><th class="num">Kalan</th>
    </tr></thead><tbody>
    ${jobs.map((j) => `<tr><td>${j.slot}</td><td>${esc(anyName(j.id))}${j.count > 1 ? ` <span class="muted">×${j.count}</span>` : ''}</td>
      <td class="num">${coins(j.value)}</td><td class="num small">${forgeEndText(j.end)}</td><td class="num">${forgeLeft(j.end)}</td></tr>`).join('')}
    </tbody></table></div>
    ${forgeNotifyHtml()}
    <p class="muted small">Toplam ${coins(total)} değerinde. "Sack'lerden çek" ile birlikte profilden alındı; bitiş zamanı tarif süresi ve Quick Forge seviyenle hesaplandı. Alttaki toplama "Forgedekiler" olarak eklenir.</p>`;
}

function mineSection(m) {
  const { slots } = effective();
  const c = mineCalc(m);
  // Compared with selling Enchanted, or with the best route when selling isn't an option.
  const base = m.noSell ? c.best?.total : c.rows.find((r) => r.product === m.ench)?.total;
  const tr = c.rows.map((r) => {
    const diff = r.total != null && base != null ? r.total - base : null;
    const perHour = m.noSell ? (r.total != null && r.slotSec > 0 ? r.total / (r.slotSec / 3600) : null)
      : diff != null && r.slotSec > 0 ? diff / (r.slotSec / 3600) : null;
    const hcls = m.noSell ? '' : null;
    const dcls = diff == null || Math.abs(diff) < 0.5 ? '' : diff > 0 ? 'pos' : 'neg';
    const ex = (r.extras || []).filter((e) => e.count > 0)
      .map((e) => `${e.count}× ${esc(anyName(e.id))} (${coins(e.unit)})`).join(', ');
    const what = `${fmtAmt(r.n)}× ${esc(anyName(r.product))}${thinTag(r.product)}`
      + (r.per ? ` <span class="muted small">(${r.per} Enchanted/adet)</span>` : '')
      + (r.leftover > 0.001 ? `<br><span class="muted small">+ ${fmtAmt(r.leftover, 1)} Enchanted artar, ${m.noSell ? 'sende kalır' : 'olduğu gibi satılır'}</span>` : '')
      + (c.rawLeft > 0 && r.product !== m.raw ? `<br><span class="muted small">+ ${fmtAmt(c.rawLeft)} ham artar, ${m.noSell ? 'sende kalır' : 'ham satılır'}</span>` : '');
    const ench = m.simple ? 0 : c.whole + c.rawLeft / enchRatio(m);
    // Sell rows of raw / Enchanted also show what the NPC pays (shown only, not a route).
    const npcUnit = !m.simple && (r.product === m.raw || r.product === m.ench) ? npcData?.npc[r.product] ?? null : null;
    const npcRow = r.product === m.raw ? r.n : r.n + (c.rawLeft > 0 ? c.rawLeft / enchRatio(m) : 0);
    const npcLine = npcUnit == null ? ''
      : `<br><span class="muted small">NPC: ${coins(npcUnit)}/adet → ${coins(npcUnit * npcRow)}`
        + `${r.total != null && npcUnit * npcRow > r.total ? ' <span class="tag pos">NPC daha iyi</span>' : ''}</span>`;
    return `<tr>
      <td class="nowrap"><label class="check"><input type="radio" name="route-${m.id}" data-route="${m.id}" value="${esc(r.label)}"${r === c.chosen ? ' checked' : ''}> ${esc(r.label)}</label>${r === c.best ? ' <span class="tag pos">En kârlı</span>' : ''}</td>
      <td>${what}${npcLine}${ex ? `<br><span class="muted small">Ek: ${ex}</span>` : ''}</td>
      <td class="num">${r.extraCost ? coins(r.extraCost) : '—'}</td>
      <td class="num">${coins(r.gross)}</td>
      <td class="num${r === c.best ? ' best' : ''}">${coins(r.total)}</td>
      <td class="num">${ench > 0 && r.total != null ? coins(r.total / ench) : '—'}</td>
      <td class="num ${dcls}">${r.product === m.ench || (m.noSell && r === c.best) ? '—' : coins(diff)}</td>
      <td class="num">${r.slotSec ? duration(r.wallSec) : '—'}</td>
      <td class="num ${hcls ?? dcls}">${coins(perHour)}</td>
      <td class="num">${r.demand == null ? '—' : `${coins(r.demand)}/hf`}</td>
    </tr>`;
  }).join('');
  return `<div class="card calc">
    <h3>${m.name}${(() => {
      const jobs = forgeJobs().filter((j) => [m.refined, m.plate, m.key].includes(j.id));
      return jobs.length ? ` <span class="tag" title="Son çekimde forgede.">Forgede: ${esc(forgeSummary(jobs))}</span>` : '';
    })()}</h3>
    <div class="controls">
      <label>${m.simple ? 'Adet' : `Ham ${esc(anyName(m.raw))}`} <input type="number" min="0" step="1" data-mine="${m.id}" data-k="raw" value="${c.raw || ''}" placeholder="0"></label>
      ${m.simple ? '' : `<label>${esc(anyName(m.ench))} <input type="number" min="0" step="1" data-mine="${m.id}" data-k="ench" value="${c.ench || ''}" placeholder="0"></label>`}
      <label class="check"><input type="checkbox" data-mine-total="${m.id}"${inTotal(m.id) ? ' checked' : ''}> Toplama kat</label>
      ${m.simple ? '<span class="muted small">Forge ya da craft tarifi yok, olduğu gibi satılır.</span>' : `<span class="muted small">Toplam ${fmtAmt(c.whole + c.rawLeft / enchRatio(m), 1)} Enchanted değerinde (${fmtAmt(enchRatio(m))} ham = 1 Enchanted)</span>`}
    </div>
    ${c.has ? `<div class="table-wrap"><table>
      <thead><tr>
        <th>Yol</th><th>Ne çıkar</th>
        <th class="num" title="Satın alınan ek malzemelerin toplamı.">Ek maliyet</th>
        <th class="num" title="Çıkan itemlerin seçili satış yöntemiyle, vergi düşülmüş toplamı.">Satış (net)</th>
        <th class="num" title="Satış − ek maliyet + artanların satışı. Hepsi aynı miktardan.">Toplam kazanç</th>
        <th class="num">Enchanted başına</th>
        ${m.noSell ? '<th class="num" title="Bu malzemenin en kârlı yoluna göre fark.">En kârlıya göre</th>'
          : '<th class="num" title="Enchanted olarak satmaya göre fazladan kazanç.">Enchanted satışına göre</th>'}
        <th class="num" title="Seçili slot sayınla ve Quick Forge indirimiyle tüm forgeların bitme süresi.">Forge süresi (${slots} slot)</th>
        ${m.noSell ? '<th class="num" title="Toplam kazanç ÷ harcanan forge slot-saati.">Kazanç / slot-saat</th>'
          : '<th class="num" title="Fazladan kazanç ÷ harcanan forge slot-saati.">Fark / slot-saat</th>'}
        <th class="num" title="Son 7 günde seçili satış yönteminin Bazaar hacmi.">Hacim (7g)</th>
      </tr></thead>
      <tbody>${tr}</tbody>
    </table></div>
    <p class="muted small">Soldaki yuvarlaktan hangi yolu seçersen alttaki toplamda o sayılır (varsayılan en kârlısı).${m.noSell ? ' Ham ya da Enchanted satış büyük miktarda gerçekçi olmadığı için seçenek değil; son forge\'a yetmeyen kısım sende kalır ve toplama katılmaz.' : ''}</p>`
    : '<p class="muted small">Adet yaz ya da yukarıdan "Sack\'lerden çek".</p>'}
    ${m.id === 'UMBER' || (m.id === 'TUNGSTEN' && S.mineView === 'TUNGSTEN') ? perfectSection() : ''}
  </div>`;
}

// Gemstone types on the Bazaar, and the totals of what is held.
const gemTypes = () => Object.keys(market.bz).map((id) => id.match(/^ROUGH_([A-Z]+)_GEM$/)?.[1]).filter(Boolean).sort();
function gemTotals() {
  const types = gemTypes();
  const chosen = types.map((t) => gemPlan(t, S.gemHold[t]?.target || 'best')).filter(Boolean);
  const best = types.map((t) => gemPlan(t, 'best')).filter(Boolean);
  return { chosen: chosen.reduce((a, p) => a + p.total, 0), best: best.reduce((a, p) => a + p.total, 0), has: chosen.length > 0 };
}

function renderMineTotal() {
  const box = $('#mineTotal');
  const lines = MINE.map((m) => {
    const c = mineCalc(m);
    if (!c.has) return null;
    return { id: m.id, name: m.name, what: c.chosen ? `${c.chosen.label}${c.chosen.n ? `: ${fmtAmt(c.chosen.n)}× ${anyName(c.chosen.product)}` : ''}` : '—',
      total: c.chosen?.total ?? null, best: c.best?.total ?? null, time: c.chosen?.wallSec || 0 };
  }).filter(Boolean);
  const g = gemTotals();
  if (g.has) lines.push({ id: 'GEM', name: 'Gemstone', what: 'Elimdeki gemstone\'lar tablosunda seçtiğin tierlar', total: g.chosen, best: g.best, time: 0 });
  const jobs = forgeJobs();
  if (jobs.length) {
    const v = jobs.some((j) => j.value == null) ? null : jobs.reduce((a, j) => a + j.value, 0);
    const left = Math.max(0, ...jobs.map((j) => (j.end == null ? 0 : (j.end - Date.now()) / 1000)));
    lines.push({ id: 'FORGE', name: 'Forgedekiler', what: forgeSummary(jobs), total: v, best: v, time: left });
  }
  if (!lines.length) { box.innerHTML = '<h3>Toplam</h3><p class="muted small">Henüz adet yok. "Sack\'lerden çek" ile ya da bölümlere adet yazarak doldur.</p>'; return; }
  const used = lines.filter((l) => inTotal(l.id));
  const sum = (k) => used.reduce((a, l) => a + (l[k] ?? 0), 0);
  const missing = used.some((l) => l.total == null);
  const st = (k, v, cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  box.innerHTML = `<h3>Seçtiklerimin toplamı</h3>
    <div class="table-wrap"><table><thead><tr><th>Toplama kat</th><th>Malzeme</th><th>Seçilen yol</th><th class="num">Kazanç (net)</th><th class="num" title="Bu malzemenin en kârlı yolundan farkı.">En kârlıya göre</th></tr></thead><tbody>
    ${lines.map((l) => {
      const d = l.total != null && l.best != null ? l.total - l.best : null;
      return `<tr${inTotal(l.id) ? '' : ' class="dim"'}><td><input type="checkbox" data-mine-total="${l.id}"${inTotal(l.id) ? ' checked' : ''} aria-label="${esc(l.name)} toplama kat"></td>
      <td>${esc(l.name)}</td><td class="small">${esc(l.what)}</td><td class="num">${coins(l.total)}</td>
      <td class="num ${d != null && d < -0.5 ? 'neg' : ''}">${d == null || Math.abs(d) < 0.5 ? '—' : coins(d)}</td></tr>`;
    }).join('')}
    </tbody></table></div>
    <div class="stats" style="margin-top:12px">
      ${st('Seçtiğin yollarla toplam', coins(sum('total')), 'pos')}
      ${st('Hepsi en kârlı yolla olsaydı', coins(sum('best')))}
      ${st('En uzun forge süresi', (Math.max(0, ...used.map((l) => l.time)) ? duration(Math.max(...used.map((l) => l.time))) : '—'))}
    </div>
    ${missing ? '<p class="small warn">Bazı yolların fiyatı eksik, toplamda 0 sayıldı.</p>' : ''}
    <p class="muted small">Forge süreleri her malzeme için ayrı hesaplandı; hepsini aynı anda forgelarsan slotlar paylaşılacağı için daha uzun sürer.</p>`;
}

function renderGemForge() {
  const tbody = $('#gemForgeTable tbody');
  if (!recipes.length) { tbody.innerHTML = '<tr><td colspan="7" class="muted">Forge tarifleri yükleniyor…</td></tr>'; return; }
  const list = recipes.filter((r) => isGem(r.id, 'PERFECT')).map(evaluate)
    .sort((a, b) => (a.perHour == null ? 1 : b.perHour == null ? -1 : b.perHour - a.perHour));
  tbody.innerHTML = list.map((e) => {
    const cls = e.profit == null ? '' : e.profit >= 0 ? 'pos' : 'neg';
    return `<tr data-id="${esc(e.id)}">
      <td>${esc(e.name)}${e.sale.market === 'bazaar' ? thinTag(e.id) : ''}</td>
      <td class="num">${coins(e.cost)}</td>
      <td class="num">${coins(e.sale.net)}</td>
      <td class="num ${cls}">${coins(e.profit)}</td>
      <td class="num">${duration(e.time)}</td>
      <td class="num ${cls}">${coins(e.perHour)}</td>
      <td class="num">${demandText(e)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">Perfect gemstone tarifi bulunamadı.</td></tr>';
}

async function renderMine() {
  const body = $('#mineBody');
  if (!recipes.length) { body.innerHTML = '<div class="empty">Forge tarifleri yükleniyor…</div>'; return; }
  if (!market) {
    body.innerHTML = '<div class="empty">Fiyatlar yükleniyor…</div>';
    try { await loadExtra(); } catch (err) {
      console.error(err);
      body.innerHTML = '<div class="empty">Bu bölümün verisi henüz yok. Fiyat toplayıcı bir sonraki çalışmasında (15 dakikada bir) oluşturacak.</div>';
      return;
    }
  }
  const view = S.mineView;
  body.innerHTML = MINE.filter((m) => view === 'all' || view === (m.view || m.id)).map(mineSection).join('');
  const gem = view === 'all' || view === 'GEM';
  $('#mineGem').hidden = !gem;
  if (gem) { renderGemForge(); renderGemRank(); }
  renderForging();
  renderMineTotal();
  $('#metalNote').textContent = 'Tarifler NotEnoughUpdates verisinden: anahtar, Refined ve Glacite Amalgamation doğrudan Enchanted malzemeden, Plate ise Refined + Glacite Amalgamation ile forgelanır. Ek malzemeler (Bejeweled Handle, Glacite Amalgamation, Fine gemler…) satın alınmış sayılır. '
    + `Bazaar satışından %${S.bzTax} vergi düşüldü (ayarlardan değişir). Bir sonraki ürüne yetmeyen miktar Enchanted (ya da ham) olarak satılmış sayılır. `
    + 'Plate süresine önce Refined forgeları, sonra Plate forgeları dahildir.';
}

// Perfect Plate (Mithril + Tungsten + Umber Plate) and Skeleton Key (Perfect Plate + Bejeweled Handle).
// The key is compared bought-Perfect-Plate vs forging the Perfect Plate from the three plates.
const OWN_PLATES = ['TUNGSTEN_PLATE', 'UMBER_PLATE'];
function plateInput(id, count) {
  // With "own plates" on, a Tungsten/Umber Plate costs what selling it would bring.
  const own = S.metalOwnPlates && OWN_PLATES.includes(id);
  const unit = own ? marketSell(id).net : marketBuy(id).unit;
  return { id, count, unit, total: unit == null ? null : unit * count, own };
}
function perfectRoute(label, product, inputs, stages) {
  const k = 1 - qfPercent(effective().qfLevel) / 100;
  const cost = inputs.some((i) => i.total == null) ? null : inputs.reduce((t, i) => t + i.total, 0);
  const sale = marketSell(product);
  return {
    label, product, inputs, cost, sale: sale.net, demand: sale.demand,
    profit: cost != null && sale.net != null ? sale.net - cost : null,
    wallSec: stages.reduce((t, sec) => t + sec * k, 0),
  };
}
function perfectSection() {
  const pp = forgeRecipe('PERFECT_PLATE'), sk = forgeRecipe('SKELETON_KEY');
  if (!pp || !sk) return '';
  const ppIn = pp.inputs.map((i) => plateInput(i.id, i.count));
  const skRest = sk.inputs.filter((i) => i.id !== 'PERFECT_PLATE').map((i) => plateInput(i.id, i.count));
  const ppCount = sk.inputs.find((i) => i.id === 'PERFECT_PLATE')?.count || 1;
  const rows = [
    perfectRoute('Perfect Plate forgela, sat', 'PERFECT_PLATE', ppIn, [pp.duration]),
    perfectRoute('Skeleton Key: hazır Perfect Plate ile', 'SKELETON_KEY', [plateInput('PERFECT_PLATE', ppCount), ...skRest], [sk.duration]),
    perfectRoute('Skeleton Key: 3 plate ile (önce Perfect Plate)', 'SKELETON_KEY',
      [...ppIn.map((i) => ({ ...i, count: i.count * ppCount, total: i.total == null ? null : i.total * ppCount })), ...skRest],
      [pp.duration, sk.duration]),
  ];
  const [, viaPerfect, viaPlates] = rows;
  const cheaper = viaPerfect.cost != null && viaPlates.cost != null
    ? (viaPerfect.cost <= viaPlates.cost ? viaPerfect : viaPlates) : null;
  const tr = rows.map((r) => {
    const cls = r.profit == null ? '' : r.profit >= 0 ? 'pos' : 'neg';
    const ins = r.inputs.map((i) => `${i.count}× ${esc(anyName(i.id))} (${coins(i.unit)}${i.own ? ', senin' : ''})`).join('<br>');
    return `<tr>
      <td>${esc(r.label)}${r === cheaper ? ' <span class="tag pos">Daha ucuz</span>' : ''}${thinTag(r.product)}</td>
      <td class="small">${ins}</td>
      <td class="num${r === cheaper ? ' best' : ''}">${coins(r.cost)}</td>
      <td class="num">${coins(r.sale)}</td>
      <td class="num ${cls}">${coins(r.profit)}</td>
      <td class="num">${duration(r.wallSec)}</td>
      <td class="num">${r.demand == null ? '—' : `${coins(r.demand)}/hf`}</td>
    </tr>`;
  }).join('');
  const diff = cheaper ? Math.abs(viaPerfect.cost - viaPlates.cost) : null;
  return `<h3>Perfect Plate ve Skeleton Key</h3>
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Yol</th><th>Malzemeler</th>
        <th class="num" title="Seçili alış yöntemiyle malzemelerin toplamı.">Maliyet</th>
        <th class="num" title="Seçili satış yöntemiyle, vergi düşülmüş satış.">Satış (net)</th>
        <th class="num">Kâr</th>
        <th class="num" title="Quick Forge indirimiyle forge süresi; 3 plate yolunda iki forge arka arkaya.">Forge süresi</th>
        <th class="num" title="Son 7 günde seçili satış yönteminin Bazaar hacmi.">Hacim (7g)</th>
      </tr></thead>
      <tbody>${tr}</tbody>
    </table></div>
    <p class="muted small">${cheaper ? `Skeleton Key için ${cheaper === viaPlates ? '3 plate ile Perfect Plate\'i kendin forgelamak' : 'hazır Perfect Plate almak'} ${coins(diff)} daha ucuz. ` : ''}`
    + `${S.metalOwnPlates ? 'Tungsten ve Umber Plate senin, maliyetleri satsan alacağın net fiyatla sayıldı. ' : ''}</p>`;
}

// ---------- profile ----------
async function uuidFor(name) {
  try {
    const d = await getJson(`https://playerdb.co/api/player/minecraft/${encodeURIComponent(name)}`);
    if (d?.data?.player?.raw_id) return d.data.player.raw_id;
  } catch { /* try next */ }
  const d = await getJson(`https://api.ashcon.app/mojang/v2/user/${encodeURIComponent(name)}`);
  return d.uuid.replace(/-/g, '');
}

function readMining(member) {
  // Hypixel moved HotM data from mining_core to skill_tree in 2025; read both.
  const st = member.skill_tree, mc = member.mining_core || {};
  const xp = st?.experience?.mining ?? mc.experience ?? 0;
  const nodes = st?.nodes?.mining || mc.nodes || {};
  let tier = 1;
  HOTM_XP.forEach((need, i) => { if (xp >= need) tier = i + 1; });
  const qfLevel = nodes.forge_time ?? nodes.quick_forge ?? 0;
  // Forge slots: 2 at HotM 1-2, +1 at tiers 3, 4 and 5.
  const slots = tier >= 5 ? 5 : tier >= 3 ? tier : 2;
  return { tier, qfLevel, slots };
}

let fetchedProfiles = null;
// Reads the player's Skyblock profiles with their API key (also used for sacks).
async function getProfiles() {
  const uuid = await uuidFor(S.username);
  const res = await fetch(`${HYPIXEL}/profiles?uuid=${uuid}`, { headers: { 'API-Key': S.apiKey } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 403) { S.apiKeyRejected = true; save(); renderKeyBanner(); throw new Error('API anahtarı geçersiz ya da süresi dolmuş. Development Key 3 günde bir yenilenmeli.'); }
  if (S.apiKeyRejected) { S.apiKeyRejected = false; save(); renderKeyBanner(); }
  if (res.status === 429) throw new Error('Hypixel istek sınırına ulaşıldı, biraz bekleyip tekrar dene.');
  if (!res.ok || !body.success) throw new Error(body.cause || `Hypixel hata verdi (${res.status}).`);
  if (!body.profiles?.length) throw new Error('Bu oyuncunun Skyblock profili yok.');
  fetchedProfiles = { uuid, profiles: body.profiles };
  return body;
}

// A fingerprint of the sack and forge contents, to tell whether the profile changed between two pulls.
function sackSig(sacks, forge = []) {
  const s = Object.keys(sacks).filter((k) => sacks[k] > 0).sort().map((k) => `${k}:${sacks[k]}`).join(',');
  return `${s}|${forge.map((f) => `${f.slot}:${f.id}:${f.start}`).join(',')}`;
}

function fmtWhen(t) {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const day = d.toDateString() === now.toDateString() ? '' : `${d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' })} `;
  const min = Math.max(0, Math.round((now - d) / 60000));
  const ago = min < 1 ? 'az önce' : min < 60 ? `${min} dk önce` : min < 1440 ? `${Math.floor(min / 60)} sa ${min % 60} dk önce` : `${Math.floor(min / 1440)} gün önce`;
  return `${day}${time}, ${ago}`;
}

// Shows what the last sack pull brought and how fresh it is.
function renderSackStatus() {
  const f = S.sackFetch, status = $('#mineSackStatus');
  if (!f || !status) return;
  // Hypixel does not say when it last saved the profile, so the best sign of freshness is
  // whether the contents moved since an earlier pull.
  const same = f.changedAt && f.changedAt < f.fetchedAt
    ? ` · Sack ve forge içeriği ${fmtWhen(f.changedAt)} yapılan çekimden beri değişmedi. Oyunda yeni bir şey koyduysan Hypixel henüz kaydetmemiş olabilir; lobi ya da ada değiştirip birkaç dakika sonra tekrar dene.`
    : '';
  status.dataset.live = '1';
  status.textContent = `${f.profile} profilinin sack'lerinden alındı: ${f.items.join(', ') || 'hiçbir şey bulunamadı'}. Çekildi: ${fmtWhen(f.fetchedAt)}${same}`;
}

// Fills the mined amounts and the gemstone holdings from the player's sacks.
async function fetchSacks() {
  const btn = $('#mineSackBtn'), status = $('#mineSackStatus');
  if (!S.username || !S.apiKey) { status.dataset.live = ''; status.textContent = 'Önce "Profil ve ayarlar" sekmesine kullanıcı adını ve API anahtarını gir.'; return; }
  btn.disabled = true; status.dataset.live = ''; status.textContent = 'Sack\'ler çekiliyor…';
  try {
    const { profiles } = await getProfiles();
    const p = profiles.find((x) => x.profile_id === S.profileId) || profiles.find((x) => x.selected) || profiles[0];
    const member = p.members[fetchedProfiles.uuid];
    // The forge comes with the same request and doesn't need the Inventory API.
    S.forging = readForge(member);
    S.forgeAll = readForge(member, true);
    markDoneForges();
    save();
    const sacks = member?.inventory?.sacks_counts ?? member?.sacks_counts;
    if (!sacks) { renderMine(); throw new Error('Sack bilgisi gelmedi. Oyunda SkyBlock Menu → Settings → API Settings\'ten Inventory API\'yi aç, birkaç dakika sonra tekrar dene.'); }
    const hold = {};
    let gems = 0;
    for (const [id, n] of Object.entries(sacks)) {
      const m = id.match(/^(ROUGH|FLAWED|FINE|FLAWLESS)_([A-Z]+)_GEM$/);
      if (!m || !(n > 0)) continue;
      (hold[m[2]] ||= {})[m[1]] = n;
      gems += n;
    }
    // Keep each gem's chosen target; replace the amounts.
    for (const t of new Set([...Object.keys(S.gemHold), ...Object.keys(hold)])) {
      S.gemHold[t] = { target: S.gemHold[t]?.target, ...hold[t] };
    }
    const got = [];
    for (const m of MINE) {
      const raw = sacks[m.raw] || 0, ench = m.ench ? sacks[m.ench] || 0 : 0;
      S.mine[m.id] = { raw, ench };
      if (raw || ench) got.push(m.name);
    }
    const sig = sackSig(sacks, S.forgeAll), prev = S.sackFetch, now = Date.now();
    S.sackFetch = {
      profile: p.cute_name,
      sig,
      // When the contents were first seen as they are now (an earlier pull of the same profile).
      changedAt: prev && prev.sig === sig && prev.profile === p.cute_name ? prev.changedAt || prev.fetchedAt : now,
      items: [...got, gems ? `${gems.toLocaleString('tr-TR')} gemstone` : null,
        S.forging.length ? `forgede ${S.forging.length} item` : null].filter(Boolean),
      fetchedAt: now,
    };
    save();
    renderSackStatus();
    renderMine();
  } catch (err) {
    status.textContent = err instanceof TypeError ? 'Hypixel\'e bağlanılamadı. İnternet bağlantını kontrol edip tekrar dene.' : err.message;
  } finally {
    btn.disabled = false;
  }
}

async function fetchProfile() {
  const btn = $('#fetchProfile'), status = $('#profileStatus');
  S.username = $('#username').value.trim(); setApiKey($('#apiKey').value.trim());
  if (!S.username || !S.apiKey) { status.textContent = 'Kullanıcı adı ve API anahtarı gerekli.'; return; }
  btn.disabled = true; status.textContent = 'Profil çekiliyor…';
  try {
    const body = await getProfiles();
    const sel = $('#profileSelect');
    sel.innerHTML = body.profiles.map((p) => `<option value="${p.profile_id}">${esc(p.cute_name)}${p.selected ? ' (aktif)' : ''}</option>`).join('');
    const chosen = body.profiles.find((p) => p.profile_id === S.profileId) || body.profiles.find((p) => p.selected) || body.profiles[0];
    sel.value = chosen.profile_id;
    $('#profileSelectWrap').hidden = body.profiles.length < 2;
    applyProfile(chosen.profile_id);
  } catch (err) {
    status.textContent = err instanceof TypeError
      ? 'Hypixel\'e bağlanılamadı. İnternet bağlantını kontrol et; sorun sürerse değerleri elle gir.'
      : err.message;
  } finally {
    btn.disabled = false;
  }
}

function applyProfile(profileId) {
  const p = fetchedProfiles.profiles.find((x) => x.profile_id === profileId);
  const member = p.members[fetchedProfiles.uuid];
  const m = readMining(member);
  S.profileId = profileId;
  S.auto = { slots: m.slots, qfLevel: m.qfLevel, hotmTier: m.tier, profileName: p.cute_name, fetchedAt: Date.now() };
  save();
  $('#profileStatus').textContent = `${p.cute_name}: HotM ${m.tier}, Quick Forge ${m.qfLevel}, ${m.slots} forge slotu.`;
  refreshAll();
}

// ---------- API key expiry ----------
// Hypixel Development Keys expire 3 days after they are made. The site remembers when the key was
// entered and warns near the end, or as soon as Hypixel rejects it.
const KEY_LIFE_MS = 3 * 86400 * 1000;
function setApiKey(key) {
  if (key !== S.apiKey) {
    S.apiKey = key;
    S.apiKeySetAt = key ? Date.now() : 0;
    S.apiKeyRejected = false;
  }
  save(); renderKeyBanner();
}
function keyState() {
  if (!S.apiKey) return null;
  const left = S.apiKeySetAt + KEY_LIFE_MS - Date.now();
  if (S.apiKeyRejected) return { level: 'expired', text: 'Hypixel API anahtarını reddetti: geçersiz ya da süresi dolmuş.' };
  if (left <= 0) return { level: 'expired', text: 'API anahtarının süresi dolmuş olmalı (Development Key 3 gün geçerli).' };
  const h = Math.ceil(left / 3600000);
  if (left <= 12 * 3600000) return { level: 'soon', text: `API anahtarının süresi yaklaşık ${h} saat sonra doluyor.` };
  return { level: 'ok', text: `API anahtarı yaklaşık ${h >= 24 ? `${Math.floor(h / 24)} gün ${h % 24} saat` : `${h} saat`} daha geçerli (${new Date(S.apiKeySetAt + KEY_LIFE_MS).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} civarı biter).` };
}
function renderKeyBanner() {
  const st = keyState();
  const el = $('#keyBanner');
  el.hidden = !st || st.level === 'ok';
  if (st && st.level !== 'ok') {
    el.className = `key-banner ${st.level}`;
    el.innerHTML = `<b>${st.text}</b> Yenilemek için <a href="https://developer.hypixel.net/dashboard" target="_blank" rel="noopener">developer.hypixel.net</a> → Dashboard → <b>Regenerate</b>, sonra yeni anahtarı <a href="#" data-go="settings">Profil ve ayarlar</a> sekmesine yapıştır.`;
  }
  const info = $('#apiKeyInfo');
  if (info) info.textContent = st ? st.text : '';
}

// ---------- settings UI ----------
function renderSettings() {
  $('#username').value = S.username;
  $('#apiKey').value = S.apiKey;
  $('#manualMode').checked = S.manualMode;
  const eff = effective();
  $('#slots').value = eff.slots;
  $('#qfLevel').value = eff.qfLevel;
  $('#bzTax').value = S.bzTax;
  $('#thinVolume').value = S.thinVolume;
  $('#thinOrders').value = S.thinOrders;
  const src = !S.manualMode && S.auto ? `profil (${esc(S.auto.profileName)})` : 'elle girilen değerler';
  $('#effectiveInfo').innerHTML = `Kullanılan: ${eff.slots} slot, Quick Forge ${eff.qfLevel} (süre −%${qfPercent(eff.qfLevel)}). Kaynak: ${src}.`
    + (S.auto ? '' : '<br>Profil henüz çekilmedi.');
  $('#playerChip').innerHTML = S.auto && !S.manualMode
    ? `${esc(S.username)} · ${esc(S.auto.profileName)}<br>HotM ${S.auto.hotmTier} · QF ${S.auto.qfLevel} · ${S.auto.slots} slot`
    : `${eff.slots} slot · QF ${eff.qfLevel} (elle)`;
  const ov = Object.entries(S.overrides);
  $('#overrideList').innerHTML = ov.length
    ? ov.map(([id, v]) => `<li><span>${esc(nameOf(id))}: <b>${coins(v)}</b></span><button class="ghost" data-clear="${esc(id)}">Sil</button></li>`).join('')
    : '<li class="muted small">Elle girilmiş fiyat yok.</li>';
}

function refreshAll() {
  renderSettings();
  renderBest();
  $('#compareCount').textContent = S.compare.length;
  if ($('#tab-compare').classList.contains('active')) renderCompare();
  if ($('#tab-npc').classList.contains('active')) renderNpc();
  if ($('#tab-craft').classList.contains('active')) renderCraft();
  if ($('#tab-sellcraft').classList.contains('active')) renderSellCraft();
  if ($('#tab-mine').classList.contains('active')) renderMine();
}

// Opens a tab and writes it into the URL hash.
function showTab(name, { render = true } = {}) {
  if (!TABS.includes(name)) name = 'best';
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (location.hash.slice(1) !== name) history.replaceState(null, '', name === 'best' ? location.pathname + location.search : `#${name}`);
  if (render) {
    if (name === 'compare') renderCompare();
    if (name === 'npc') renderNpc();
    if (name === 'craft') renderCraft();
    if (name === 'sellcraft') renderSellCraft();
    if (name === 'mine') renderMine();
  }
}

function wire() {
  // "az işlem" tags: a tap (phones have no hover) or Enter shows the reason in a small box.
  // Capture phase, so tapping the tag doesn't also open the row it sits in.
  const tipBox = $('#thinTip');
  const showTip = (el) => {
    tipBox.textContent = el.dataset.tip;
    tipBox.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tipBox.offsetWidth;
    tipBox.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left))}px`;
    const below = r.bottom + 6;
    tipBox.style.top = `${below + tipBox.offsetHeight > innerHeight - 8 ? Math.max(8, r.top - tipBox.offsetHeight - 6) : below}px`;
  };
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest?.('.thin');
    if (!el) { if (!ev.target.closest?.('#thinTip')) tipBox.hidden = true; return; }
    ev.stopPropagation(); ev.preventDefault();
    showTip(el);
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') tipBox.hidden = true;
    else if (ev.key === 'Enter' && ev.target.classList?.contains('thin')) showTip(ev.target);
  });
  window.addEventListener('scroll', () => { tipBox.hidden = true; }, { passive: true, capture: true });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  window.addEventListener('hashchange', () => showTab(tabFromHash(), { render: !!latest }));
  // Remember where the page is scrolled, per tab, to put it back after a refresh.
  let scrollTimer = 0;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { V.scroll[activeTab()] = Math.round(scrollY); saveView(); }, 150);
  }, { passive: true });
  window.addEventListener('pagehide', () => { V.scroll[activeTab()] = Math.round(scrollY); saveView(); });
  for (const id of SEARCHES) {
    const el = document.getElementById(id);
    if (V.search[id]) el.value = V.search[id];
    el.addEventListener('input', () => { V.search[id] = el.value; saveView(); });
  }
  // Controls bound to a setting; the same setting (e.g. buy mode) can appear on several tabs.
  const bound = document.querySelectorAll('[data-setting]');
  const syncBound = () => bound.forEach((el) => {
    const v = S[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = v;
    else if (el.type === 'radio') el.checked = el.value === v;
    else el.value = v;
  });
  syncBound();
  bound.forEach((el) => el.addEventListener('change', () => {
    S[el.dataset.setting] = el.type === 'checkbox' ? el.checked : el.value;
    save(); syncBound(); refreshAll();
  }));
  $('#search').addEventListener('input', renderBest);
  $('#npcSearch').addEventListener('input', renderNpc);
  document.querySelectorAll('.live-btn').forEach((b) => b.addEventListener('click', liveClick));
  $('#craftSearch').addEventListener('input', renderCraft);
  $('#craftTable tbody').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-id]');
    if (!tr) return;
    craftOpen = craftOpen === tr.dataset.id ? null : tr.dataset.id;
    V.craftOpen = craftOpen; saveView();
    renderCraft();
  });
  $('#scSearch').addEventListener('input', renderSellCraft);
  $('#scCalcQty').value = S.scCalcQty;
  $('#scCalcQty').addEventListener('input', (ev) => { S.scCalcQty = Number(ev.target.value) || 1; save(); renderSellCraft(); });
  $('#scCalcItem').addEventListener('change', async (ev) => {
    const v = ev.target.value.trim().toLowerCase();
    await loadExtra();
    const id = [...craftsBy.keys()].find((k) => anyName(k).toLowerCase() === v || k.toLowerCase() === v)
      || [...craftsBy.keys()].find((k) => anyName(k).toLowerCase().includes(v));
    S.scCalcId = v ? id || v : ''; save();
    if (id) ev.target.value = anyName(id);
    renderSellCraft();
  });
  $('#scTable tbody').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-id]');
    if (!tr) return;
    scOpen = scOpen === tr.dataset.id ? null : tr.dataset.id;
    V.scOpen = scOpen; saveView();
    S.scCalcId = tr.dataset.id; save();
    $('#scCalcItem').value = anyName(tr.dataset.id);
    renderSellCraft();
  });
  $('#bestTable tbody').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    if (ev.target.classList.contains('cmp')) {
      S.compare = ev.target.checked ? [...new Set([...S.compare, id])] : S.compare.filter((x) => x !== id);
      save(); $('#compareCount').textContent = S.compare.length;
      return;
    }
    openDetail(id);
  });
  $('#mineSackBtn').addEventListener('click', fetchSacks);
  $('#mineForge').addEventListener('change', (ev) => { if (ev.target.id === 'forgeNotify') setForgeNotify(ev.target.checked); });
  // Checked every 20 s; the "Kalan" column is refreshed with it.
  setInterval(() => {
    checkForgeDone();
    if (S.forging?.length && $('#tab-mine').classList.contains('active') && !$('#mineForge').contains(document.activeElement)) renderForging();
  }, 20 * 1000);
  renderSackStatus();
  setInterval(() => { if ($('#mineSackStatus').dataset.live) renderSackStatus(); }, 60 * 1000);
  $('#tab-mine').addEventListener('change', (ev) => {
    const el = ev.target, d = el.dataset;
    if (d.mine) S.mine[d.mine] = { ...S.mine[d.mine], [d.k]: Math.max(0, Math.floor(Number(el.value) || 0)) };
    else if (d.route) S.mineRoute[d.route] = el.value;
    else if (d.mineTotal) S.mineInTotal[d.mineTotal] = el.checked;
    else return;
    save(); renderMine();
  });
  $('#gemForgeTable tbody').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-id]');
    if (tr) openDetail(tr.dataset.id);
  });
  $('#closeDetail').addEventListener('click', () => $('#detail').close());
  $('#detail').addEventListener('close', () => { V.detail = null; saveView(); });
  $('#detail').addEventListener('click', (ev) => { if (ev.target === $('#detail')) $('#detail').close(); });
  $('#detail').addEventListener('change', (ev) => {
    const id = ev.target.dataset.ov;
    if (!id) return;
    const v = ev.target.value === '' ? null : Number(ev.target.value);
    if (v == null || !isFinite(v)) delete S.overrides[id]; else S.overrides[id] = v;
    save(); refreshAll(); openDetail(detailId);
  });
  $('#fetchProfile').addEventListener('click', fetchProfile);
  $('#apiKey').addEventListener('change', (ev) => setApiKey(ev.target.value.trim()));
  $('#keyBanner').addEventListener('click', (ev) => {
    if (ev.target.dataset.go !== 'settings') return;
    ev.preventDefault();
    document.querySelector('.tab[data-tab=settings]').click();
    $('#apiKey').focus();
  });
  setInterval(renderKeyBanner, 10 * 60 * 1000);
  $('#profileSelect').addEventListener('change', (ev) => applyProfile(ev.target.value));
  $('#manualMode').addEventListener('change', (ev) => { S.manualMode = ev.target.checked; save(); refreshAll(); });
  for (const [id, key, min, max] of [['#slots', 'slots', 1, 7], ['#qfLevel', 'qfLevel', 0, 20], ['#bzTax', 'bzTax', 0, 5],
    ['#thinVolume', 'thinVolume', 0, 1e9], ['#thinOrders', 'thinOrders', 0, 1e6]]) {
    $(id).addEventListener('change', (ev) => {
      const v = Math.min(max, Math.max(min, Number(ev.target.value) || 0));
      // Typing a slot or Quick Forge value means the user wants their own numbers.
      if ((key === 'slots' || key === 'qfLevel') && !S.manualMode) Object.assign(S, effective(), { manualMode: true });
      S[key] = v;
      save(); refreshAll();
    });
  }
  $('#overrideList').addEventListener('click', (ev) => {
    const id = ev.target.dataset.clear;
    if (!id) return;
    delete S.overrides[id]; save(); refreshAll();
  });
}

async function main() {
  // Keys saved before the date was tracked: start counting from now.
  if (S.apiKey && !S.apiKeySetAt) { S.apiKeySetAt = Date.now(); save(); }
  wire();
  showTab(tabFromHash(), { render: false });
  renderKeyBanner();
  renderSettings();
  try {
    await loadData();
  } catch (err) {
    $('#dataAge').textContent = 'Fiyat verisi henüz yok. GitHub Actions ilk fiyat kaydını yapınca burada görünecek.';
    console.error(err);
    return;
  }
  const age = Math.round((Date.now() / 1000 - latest.ts) / 60);
  $('#dataAge').textContent = `${recipes.length} forge tarifi · fiyatlar ${age < 1 ? 'az önce' : `${age} dk önce`} güncellendi (15 dakikada bir yenilenir)`;
  refreshAll();
  // Tables are filled now (some tabs load market data first): put the page back where it was.
  if (['npc', 'craft', 'sellcraft', 'mine'].includes(activeTab())) { try { await loadExtra(); } catch { /* tab shows it */ } }
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  scrollTo(0, V.scroll[activeTab()] || 0);
  if (V.detail && recipes.some((r) => r.id === V.detail)) openDetail(V.detail);
}
main();
