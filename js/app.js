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
  auto: null, // { slots, qfLevel, hotmTier, profileName, fetchedAt }
  manualMode: false, slots: 2, qfLevel: 0, bzTax: 1.25,
  market: 'all', sort: 'hour', hideMissing: true, hideLoss: false, showQuick: false,
  buyMode: 'instant', sellMode: 'offer', // Bazaar: instant buy | buy order, sell offer | instant sell
  compare: [], overrides: {}, range: 7,
  npcSort: 'diff', npcOnlyNpc: false, npcOnlyFlip: false, npcView: 'all', farmAmount: 100000, farmSort: 'best',
  craftMarket: 'all', craftSort: 'save', craftDeep: false, craftOnlyCheaper: false, craftHideMissing: true,
};
let S = load();
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
function history(id) {
  if (!histCache.has(id)) {
    histCache.set(id, getJson(`${DATA_URL}history/${safeName(id)}.json`).catch(() => null));
  }
  return histCache.get(id);
}
const nameOf = (id) => names[id] || id;

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
      <td>${esc(e.name)}${e.r.count > 1 ? ` <span class="muted">×${e.r.count}</span>` : ''}${manual}${quick}</td>
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
  const hs = await Promise.all(ids.map(history));
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
function drawChart(key, canvas, datasets, rangeDays) {
  charts[key]?.destroy();
  const since = Date.now() / 1000 - rangeDays * 86400;
  const ds = datasets.map((d, i) => ({
    label: d.label,
    data: d.points.filter((p) => p[0] >= since).map((p) => ({ x: p[0] * 1000, y: p[1] })),
    borderColor: SERIES[i % SERIES.length],
    backgroundColor: SERIES[i % SERIES.length],
    borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.15,
  }));
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
        x: { type: 'linear', ticks: { color: '#8f8e86', maxTicksLimit: 7, callback: (v) => fmtTime(v) }, grid: { color: '#2a2a27' } },
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
      <td><span class="tag">${{ coin: 'coin', bazaar: 'Bazaar anında alım', 'bazaar-order': 'Bazaar buy order', ah: 'AH lowest BIN', manual: 'elle', missing: 'fiyat yok' }[i.src]}</span></td>
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
  await drawDetail();
}

const saleLabel = (e) => (e.sale.market === 'ah' ? 'AH lowest BIN' : S.sellMode === 'instant' ? 'Bazaar anında satış' : 'Bazaar sell offer');

async function drawDetail() {
  const r = recipes.find((x) => x.id === detailId);
  const which = $('#detailSeries').value;
  let datasets;
  if (which === '__profit') datasets = [{ label: 'Kâr / item', points: await profitSeries(r) }];
  else {
    const h = await history(which);
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
    <tr><th>Talep</th>${list.map((e) => `<td class="num">${demandText(e)}</td>`).join('')}</tr>
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

// ---------- market-wide data (NPC and craft tabs) ----------
// market.json: every Bazaar product [ask, bid, buyWeek, sellWeek] and every AH item [lowestBin, listings].
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
      <td>${esc(e.name)}</td>
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
// Each group starts with the raw drop; the other forms are its compressed versions.
// How many raw items one form holds is worked out from the crafting recipes.
const FARM_GROUPS = [
  ['WHEAT', 'ENCHANTED_WHEAT', 'ENCHANTED_HAY_BALE'],
  ['SEEDS', 'ENCHANTED_SEEDS', 'BOX_OF_SEEDS'],
  ['CARROT_ITEM', 'ENCHANTED_CARROT', 'ENCHANTED_GOLDEN_CARROT'],
  ['POTATO_ITEM', 'ENCHANTED_POTATO', 'ENCHANTED_BAKED_POTATO'],
  ['POISONOUS_POTATO', 'ENCHANTED_POISONOUS_POTATO'],
  ['PUMPKIN', 'ENCHANTED_PUMPKIN', 'POLISHED_PUMPKIN'],
  ['MELON', 'MELON_BLOCK', 'ENCHANTED_MELON', 'ENCHANTED_MELON_BLOCK'],
  ['SUGAR_CANE', 'ENCHANTED_SUGAR', 'ENCHANTED_SUGAR_CANE'],
  ['CACTUS', 'ENCHANTED_CACTUS_GREEN', 'ENCHANTED_CACTUS'],
  ['INK_SACK:3', 'ENCHANTED_COCOA'],
  ['NETHER_STALK', 'ENCHANTED_NETHER_STALK', 'MUTANT_NETHER_STALK'],
  ['RED_MUSHROOM', 'HUGE_MUSHROOM_2', 'ENCHANTED_RED_MUSHROOM', 'ENCHANTED_HUGE_MUSHROOM_2'],
  ['BROWN_MUSHROOM', 'HUGE_MUSHROOM_1', 'ENCHANTED_BROWN_MUSHROOM', 'ENCHANTED_HUGE_MUSHROOM_1'],
  ['LEATHER', 'ENCHANTED_LEATHER'],
  ['RAW_BEEF', 'ENCHANTED_RAW_BEEF'],
  ['PORK', 'ENCHANTED_PORK', 'ENCHANTED_GRILLED_PORK'],
  ['RAW_CHICKEN', 'ENCHANTED_RAW_CHICKEN'],
  ['EGG', 'ENCHANTED_EGG', 'SUPER_EGG'],
  ['FEATHER', 'ENCHANTED_FEATHER'],
  ['MUTTON', 'ENCHANTED_MUTTON', 'ENCHANTED_COOKED_MUTTON'],
  ['RABBIT', 'ENCHANTED_RABBIT', 'ENCHANTED_COOKED_RABBIT'],
  ['RABBIT_FOOT', 'ENCHANTED_RABBIT_FOOT'],
  ['RABBIT_HIDE', 'ENCHANTED_RABBIT_HIDE'],
];

// Raw items in one unit of `id`, following single-ingredient recipes down to `raw`.
function rawPer(id, raw, depth = 0) {
  if (id === raw) return 1;
  if (depth > 5) return null;
  for (const c of craftsBy.get(id) || []) {
    if (c.inputs.length !== 1) continue;
    const r = rawPer(c.inputs[0].id, raw, depth + 1);
    if (r != null) return (c.inputs[0].count * r) / c.count;
  }
  return null;
}

async function renderFarm() {
  const tbody = $('#farmTable tbody');
  if (!await needMarket(tbody, 7)) return;
  if (!npcData || !craftData) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">NPC fiyatları ya da tarifler henüz toplanmadı.</td></tr>';
    return;
  }
  const amount = Number(S.farmAmount) || 0;
  const groups = FARM_GROUPS.map((ids) => {
    const raw = ids[0];
    const forms = ids.map((id) => {
      const per = rawPer(id, raw);
      const b = market.bz[id];
      const npc = npcData.npc[id] ?? null;
      const unit = b ? bzSellUnit(b[0], b[1]) : null;
      const bz = unit == null ? null : unit * (1 - S.bzTax / 100);
      return {
        id, per, npc, bz,
        npcRaw: npc != null && per ? npc / per : null,
        bzRaw: bz != null && per ? bz / per : null,
        volume: b ? (S.sellMode === 'instant' ? b[3] : b[2]) : null,
      };
    }).filter((f) => f.per != null && (f.npc != null || f.bz != null));
    let best = null;
    for (const f of forms) {
      for (const [where, v] of [['npc', f.npcRaw], ['bz', f.bzRaw]]) {
        if (v != null && (!best || v > best.v)) best = { f, where, v };
      }
    }
    return { raw, name: anyName(raw), forms, best };
  }).filter((g) => g.forms.length);
  if (S.farmSort === 'best') groups.sort((a, b) => (b.best?.v ?? -1) - (a.best?.v ?? -1));
  else groups.sort((a, b) => a.name.localeCompare(b.name, 'tr'));

  tbody.innerHTML = groups.map((g) => {
    const bestText = g.best
      ? `En iyisi: ${esc(anyName(g.best.f.id))} → ${g.best.where === 'npc' ? 'NPC' : 'Bazaar'} (ham başına ${coins(g.best.v)})`
        + (amount ? ` · ${amount.toLocaleString('tr-TR')} ham = <span class="pos">${coins(g.best.v * amount)}</span>` : '')
      : 'Fiyat yok';
    const head = `<tr class="group"><td colspan="7">${esc(g.name)} <span class="muted small">${bestText}</span></td></tr>`;
    return head + g.forms.map((f) => {
      const isBest = (w) => (g.best && g.best.f === f && g.best.where === w ? ' best' : '');
      return `<tr>
        <td>${esc(anyName(f.id))}</td>
        <td class="num">${f.per.toLocaleString('tr-TR')}</td>
        <td class="num">${coins(f.npc)}</td>
        <td class="num">${coins(f.bz)}</td>
        <td class="num${isBest('npc')}">${coins(f.npcRaw)}</td>
        <td class="num${isBest('bz')}">${coins(f.bzRaw)}</td>
        <td class="num">${coins(f.volume)}</td>
      </tr>`;
    }).join('');
  }).join('') || '<tr><td colspan="7" class="muted">Farming itemi bulunamadı.</td></tr>';
  $('#farmNote').textContent = 'Her ürün için ham itemi sattığın haliyle ya da sıkıştırıp (enchanted) sattığın haliyle ham item başına kaç coin ettiği. '
    + `En iyi seçenek yeşil çerçeveli. NPC'ye satışta vergi yoktur; Bazaar satışından %${S.bzTax} vergi düşüldü. `
    + 'Sıkıştırma tam katlarla yapılır; artan ham itemleri ayrıca satman gerekir.';
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

let craftOpen = null;
const SRC_LABEL = { bazaar: 'Bazaar anında alım', 'bazaar-order': 'Bazaar buy order', ah: 'AH lowest BIN', manual: 'elle', craft: 'craftlanır', missing: 'fiyat yok', coin: 'coin' };

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
      <td>${esc(e.name)}</td>
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
async function fetchProfile() {
  const btn = $('#fetchProfile'), status = $('#profileStatus');
  S.username = $('#username').value.trim(); S.apiKey = $('#apiKey').value.trim(); save();
  if (!S.username || !S.apiKey) { status.textContent = 'Kullanıcı adı ve API anahtarı gerekli.'; return; }
  btn.disabled = true; status.textContent = 'Profil çekiliyor…';
  try {
    const uuid = await uuidFor(S.username);
    const res = await fetch(`${HYPIXEL}/profiles?uuid=${uuid}`, { headers: { 'API-Key': S.apiKey } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error('API anahtarı geçersiz ya da süresi dolmuş. Development Key 3 günde bir yenilenmeli.');
    if (res.status === 429) throw new Error('Hypixel istek sınırına ulaşıldı, biraz bekleyip tekrar dene.');
    if (!res.ok || !body.success) throw new Error(body.cause || `Hypixel hata verdi (${res.status}).`);
    if (!body.profiles?.length) throw new Error('Bu oyuncunun Skyblock profili yok.');
    fetchedProfiles = { uuid, profiles: body.profiles };
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

// ---------- settings UI ----------
function renderSettings() {
  $('#username').value = S.username;
  $('#apiKey').value = S.apiKey;
  $('#manualMode').checked = S.manualMode;
  const eff = effective();
  $('#slots').value = eff.slots;
  $('#qfLevel').value = eff.qfLevel;
  $('#bzTax').value = S.bzTax;
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
}

function wire() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${t.dataset.tab}`));
    if (t.dataset.tab === 'compare') renderCompare();
    if (t.dataset.tab === 'npc') renderNpc();
    if (t.dataset.tab === 'craft') renderCraft();
  }));
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
    S[el.dataset.setting] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Math.max(0, Number(el.value) || 0) : el.value;
    save(); syncBound(); refreshAll();
  }));
  $('#search').addEventListener('input', renderBest);
  $('#npcSearch').addEventListener('input', renderNpc);
  $('#craftSearch').addEventListener('input', renderCraft);
  $('#craftTable tbody').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-id]');
    if (!tr) return;
    craftOpen = craftOpen === tr.dataset.id ? null : tr.dataset.id;
    renderCraft();
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
  $('#closeDetail').addEventListener('click', () => $('#detail').close());
  $('#detail').addEventListener('click', (ev) => { if (ev.target === $('#detail')) $('#detail').close(); });
  $('#detail').addEventListener('change', (ev) => {
    const id = ev.target.dataset.ov;
    if (!id) return;
    const v = ev.target.value === '' ? null : Number(ev.target.value);
    if (v == null || !isFinite(v)) delete S.overrides[id]; else S.overrides[id] = v;
    save(); refreshAll(); openDetail(detailId);
  });
  $('#fetchProfile').addEventListener('click', fetchProfile);
  $('#profileSelect').addEventListener('change', (ev) => applyProfile(ev.target.value));
  $('#manualMode').addEventListener('change', (ev) => { S.manualMode = ev.target.checked; save(); refreshAll(); });
  for (const [id, key, min, max] of [['#slots', 'slots', 1, 7], ['#qfLevel', 'qfLevel', 0, 20], ['#bzTax', 'bzTax', 0, 5]]) {
    $(id).addEventListener('change', (ev) => {
      const v = Math.min(max, Math.max(min, Number(ev.target.value) || 0));
      // Typing a slot or Quick Forge value means the user wants their own numbers.
      if (key !== 'bzTax' && !S.manualMode) Object.assign(S, effective(), { manualMode: true });
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
  wire();
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
}
main();
