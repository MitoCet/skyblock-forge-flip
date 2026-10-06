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
  market: 'all', sort: 'hour', hideMissing: true, hideLoss: false,
  compare: [], overrides: {}, range: 7,
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

// Price to buy `qty` of an input right now, walking the Bazaar sell orders.
function buyCost(id, qty) {
  if (id === COIN) return { total: qty, unit: 1, src: 'coin' };
  if (S.overrides[id] != null) return { total: S.overrides[id] * qty, unit: S.overrides[id], src: 'manual' };
  const b = latest.bazaar[id];
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

// Net coins from selling one forge result: Bazaar sell offer (undercut by 0.1) or AH lowest BIN.
function saleValue(id, count) {
  const b = latest.bazaar[id];
  const manual = S.overrides[id];
  if (b && (b.ask || b.bid || manual != null)) {
    const unit = manual ?? (b.ask ? b.ask - 0.1 : b.bid);
    return { market: 'bazaar', unit, net: unit * count * (1 - S.bzTax / 100), demand: b.buyWeek, src: manual != null ? 'manual' : 'bazaar' };
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
    const quick = e.time < 600 ? ' <span class="tag" title="Çok kısa forge süresi: saatlik kâr ancak bu kadar alıcı bulursan gerçekleşir.">kısa</span>' : '';
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
// Unit price series for an item: Bazaar uses the lowest sell order (ask), AH the lowest BIN.
function priceSeries(h) {
  if (!h) return [];
  return h.points.map((p) => [p[0], p[1] ?? p[2]]).filter((p) => p[1] != null);
}

// Profit-per-item over time, from snapshots that every ingredient shares.
async function profitSeries(r) {
  const ids = [r.id, ...r.inputs.filter((i) => i.id !== COIN).map((i) => i.id)];
  const hs = await Promise.all(ids.map(history));
  if (hs.some((h) => !h)) return [];
  const maps = hs.map((h) => new Map(priceSeries(h)));
  const out = [];
  for (const [ts, outPrice] of priceSeries(hs[0])) {
    let cost = 0, ok = true;
    r.inputs.forEach((inp) => {
      if (inp.id === COIN) { cost += inp.count; return; }
      const p = S.overrides[inp.id] ?? maps[ids.indexOf(inp.id)].get(ts);
      if (p == null) ok = false; else cost += p * inp.count;
    });
    if (!ok) continue;
    const unit = S.overrides[r.id] ?? outPrice;
    const net = hs[0].market === 'bazaar'
      ? (unit - 0.1) * r.count * (1 - S.bzTax / 100)
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
    stat(e.sale.market === 'ah' ? 'Satış (lowest BIN, net)' : 'Satış (sell offer, net)', coins(e.sale.net)),
    stat('Kâr / item', coins(e.profit), cls),
    stat('Forge süresi', duration(e.time)),
    stat('Kâr / saat (1 slot)', coins(e.perHour), cls),
    stat(`Günlük kâr (${slots} slot)`, coins(e.perHour == null ? null : e.perHour * 24 * slots), cls),
  ].join('');

  const overrideCell = (id2) => `<input class="override" type="number" min="0" placeholder="elle" data-ov="${esc(id2)}" value="${S.overrides[id2] ?? ''}">`;
  $('#detailInputs').innerHTML = `<thead><tr><th>Malzeme</th><th class="num">Adet</th><th class="num">Birim fiyat</th><th class="num">Toplam</th><th>Kaynak</th><th>Elle fiyat</th></tr></thead><tbody>
    ${e.inputs.map((i) => `<tr><td>${esc(nameOf(i.id))}</td><td class="num">${i.count.toLocaleString('tr-TR')}</td>
      <td class="num">${coins(i.unit)}</td><td class="num">${coins(i.total)}</td>
      <td><span class="tag">${{ coin: 'coin', bazaar: 'Bazaar anında alım', ah: 'AH lowest BIN', manual: 'elle', missing: 'fiyat yok' }[i.src]}</span></td>
      <td>${i.id === COIN ? '' : overrideCell(i.id)}</td></tr>`).join('')}
    <tr><td><b>Çıktı:</b> ${esc(e.name)}</td><td class="num">${r.count}</td><td class="num">${coins(e.sale.unit)}</td><td class="num">${coins(e.sale.net)}</td>
      <td><span class="tag">${e.sale.src === 'manual' ? 'elle' : e.sale.market === 'ah' ? 'AH lowest BIN' : 'Bazaar sell offer'}</span></td><td>${overrideCell(r.id)}</td></tr>
  </tbody>`;

  const sel = $('#detailSeries');
  sel.innerHTML = `<option value="__profit">Kâr / item</option><option value="${esc(r.id)}">${esc(e.name)} (çıktı)</option>`
    + r.inputs.filter((i) => i.id !== COIN).map((i) => `<option value="${esc(i.id)}">${esc(nameOf(i.id))} (malzeme)</option>`).join('');
  sel.onchange = drawDetail;
  rangeButtons(document.querySelector('.range[data-target=detail]'), drawDetail);
  if (!$('#detail').open) $('#detail').showModal();
  await drawDetail();
}

async function drawDetail() {
  const r = recipes.find((x) => x.id === detailId);
  const which = $('#detailSeries').value;
  let points, label;
  if (which === '__profit') { points = await profitSeries(r); label = 'Kâr / item'; }
  else {
    const h = await history(which);
    points = priceSeries(h); label = `${nameOf(which)} birim fiyat${h?.market === 'ah' ? ' (lowest BIN)' : ' (Bazaar)'}`;
  }
  const n = drawChart('detail', $('#detailChart'), [{ label, points }], S.range);
  const since = Date.now() / 1000 - S.range * 86400;
  const st = stability(points.filter((p) => p[0] >= since));
  $('#detailNote').textContent = n === 0
    ? 'Bu aralıkta henüz kayıtlı fiyat yok. Fiyatlar 15 dakikada bir kaydediliyor, grafik zamanla dolacak.'
    : st ? `${label}: ortalama ${coins(st.mean)}, en düşük ${coins(st.min)}, en yüksek ${coins(st.max)}, dalgalanma %${st.cv?.toFixed(1)} (${n} kayıt).`
      : `${n} kayıt var, istatistik için daha fazla veri gerekiyor.`;
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
}

function wire() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${t.dataset.tab}`));
    if (t.dataset.tab === 'compare') renderCompare();
  }));
  for (const [id, key, kind] of [['#market', 'market'], ['#sort', 'sort'], ['#hideMissing', 'hideMissing', 'check'], ['#hideLoss', 'hideLoss', 'check']]) {
    const el = $(id);
    if (kind === 'check') el.checked = S[key]; else el.value = S[key];
    el.addEventListener('change', () => { S[key] = kind === 'check' ? el.checked : el.value; save(); renderBest(); });
  }
  $('#search').addEventListener('input', renderBest);
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
