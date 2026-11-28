// Takes one price snapshot of every forge-related item from Hypixel's public
// Bazaar and Auction House APIs. Writes latest.json and appends to history/.
// Also writes market.json (current price of every Bazaar product and every
// AH item, no history), npc.json (NPC sell prices, refreshed daily) and
// norm.json (each item's normal price, by mayor/minister; terms.json keeps past terms).
// Usage: node scripts/collect.mjs <dataDir>
// Set FIXTURE_DIR to read bazaar.json / auctions_<page>.json from disk instead (tests).
import fs from 'node:fs';
import path from 'node:path';
import { itemIdFromBytes } from './nbt.mjs';

const dataDir = process.argv[2] || 'data';
const HISTORY_DAYS = 30;
const API = 'https://api.hypixel.net/v2/skyblock';

async function getJson(name, url) {
  if (process.env.FIXTURE_DIR) {
    return JSON.parse(fs.readFileSync(path.join(process.env.FIXTURE_DIR, `${name}.json`), 'utf8'));
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

const round = (v) => (v == null ? null : Math.round(v * 10) / 10);
export const safeName = (id) => id.replace(/[^A-Za-z0-9_-]/g, '-');

const { recipes } = JSON.parse(fs.readFileSync(path.join(dataDir, 'recipes.json'), 'utf8'));
const tracked = new Set();
for (const r of recipes) {
  tracked.add(r.id);
  for (const i of r.inputs) if (i.id !== 'SKYBLOCK_COIN') tracked.add(i.id);
}

// Bazaar. buy_summary holds sell orders (what instant-buy pays and what a new
// sell offer must undercut); sell_summary holds buy orders.
const bz = await getJson('bazaar', `${API}/bazaar`);
const ts = Math.floor((bz.lastUpdated || Date.now()) / 1000);
const bazaar = {};
for (const id of tracked) {
  const p = bz.products?.[id];
  if (!p) continue;
  const q = p.quick_status || {};
  bazaar[id] = {
    ask: round(p.buy_summary?.[0]?.pricePerUnit ?? q.buyPrice),
    bid: round(p.sell_summary?.[0]?.pricePerUnit ?? q.sellPrice),
    buyWeek: q.buyMovingWeek ?? 0,
    sellWeek: q.sellMovingWeek ?? 0,
    // Order counts: buyOrders are the sell offers (instant buys fill them), sellOrders the buy orders.
    buyOrders: q.buyOrders ?? 0,
    sellOrders: q.sellOrders ?? 0,
    asks: (p.buy_summary || []).slice(0, 15).map((o) => [round(o.pricePerUnit), o.amount]),
  };
}

// Every Bazaar product: [instant buy, instant sell, buyWeek, sellWeek, sell offers, buy orders].
const bzAll = {};
for (const [id, p] of Object.entries(bz.products || {})) {
  const q = p.quick_status || {};
  const ask = round(p.buy_summary?.[0]?.pricePerUnit ?? null);
  const bid = round(p.sell_summary?.[0]?.pricePerUnit ?? null);
  if (ask == null && bid == null) continue;
  bzAll[id] = [ask, bid, q.buyMovingWeek ?? 0, q.sellMovingWeek ?? 0, q.buyOrders ?? 0, q.sellOrders ?? 0];
}

// Auction House: lowest BIN per unit for items that are not on the Bazaar.
// `ah` covers tracked forge items (with history); `ahAll` covers everything.
const ah = {};
const ahAll = {};
const first = await getJson('auctions_0', `${API}/auctions?page=0`);
const pages = [first];
const pageNums = [...Array(first.totalPages || 1).keys()].slice(1);
for (let i = 0; i < pageNums.length; i += 10) {
  const batch = pageNums.slice(i, i + 10);
  pages.push(...await Promise.all(batch.map((n) => getJson(`auctions_${n}`, `${API}/auctions?page=${n}`).catch(() => null))));
}
for (const page of pages) {
  for (const a of page?.auctions || []) {
    if (!a.bin || a.claimed) continue;
    let info;
    try { info = itemIdFromBytes(a.item_bytes); } catch { continue; }
    if (!info || bz.products?.[info.id]) continue;
    const unit = a.starting_bid / info.count;
    const all = ahAll[info.id] || (ahAll[info.id] = [unit, 0]);
    all[0] = Math.min(all[0], unit);
    all[1]++;
    if (!tracked.has(info.id) || bazaar[info.id]) continue;
    const cur = ah[info.id] || (ah[info.id] = { lbin: unit, n: 0 });
    cur.lbin = Math.min(cur.lbin, unit);
    cur.n++;
  }
}
for (const v of Object.values(ah)) v.lbin = round(v.lbin);
for (const v of Object.values(ahAll)) v[0] = round(v[0]);

fs.writeFileSync(path.join(dataDir, 'latest.json'), JSON.stringify({ ts, bazaar, ah }));
fs.writeFileSync(path.join(dataDir, 'market.json'), JSON.stringify({ ts, bz: bzAll, ah: ahAll }));

// NPC sell prices change rarely; refresh them once a day. A failed refresh keeps the old file.
const npcFile = path.join(dataDir, 'npc.json');
const npcOld = fs.existsSync(npcFile) ? JSON.parse(fs.readFileSync(npcFile, 'utf8')) : null;
if (!npcOld || Date.now() - npcOld.fetchedAt > 24 * 3600 * 1000) {
  try {
    const res = await getJson('items', 'https://api.hypixel.net/v2/resources/skyblock/items');
    const npc = {}, names = {};
    for (const it of res.items || []) {
      if (!it.id) continue;
      if (it.name) names[it.id] = it.name.replace(/§./g, '').trim();
      if (it.npc_sell_price > 0) npc[it.id] = it.npc_sell_price;
    }
    fs.writeFileSync(npcFile, JSON.stringify({ fetchedAt: Date.now(), npc, names }));
    console.log(`npc.json: ${Object.keys(npc).length} NPC prices`);
  } catch (e) {
    console.error(`NPC prices not refreshed: ${e.message}`);
  }
}

// History: one small file per item, points are [unixSeconds, price...].
const histDir = path.join(dataDir, 'history');
fs.mkdirSync(histDir, { recursive: true });
const cutoff = ts - HISTORY_DAYS * 86400;
const append = (id, market, point) => {
  const f = path.join(histDir, `${safeName(id)}.json`);
  let h = { id, market, points: [] };
  if (fs.existsSync(f)) h = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (h.market !== market) h = { id, market, points: [] };
  if (h.points.length && h.points[h.points.length - 1][0] >= ts) return;
  h.points.push(point);
  h.points = h.points.filter((p) => p[0] >= cutoff);
  fs.writeFileSync(f, JSON.stringify(h));
};
for (const [id, v] of Object.entries(bazaar)) append(id, 'bazaar', [ts, v.ask, v.bid]);
for (const [id, v] of Object.entries(ah)) append(id, 'ah', [ts, v.lbin, v.n]);

// ---------- "normal" prices, by mayor ----------
// The site marks a price far from its normal as unusually low or high. Mayors and
// ministers move prices (Cole lowers mining prices), so the normal is taken from past
// terms without Cole as mayor or minister (else the last NORM_DAYS).
// A term starts when an election ends (Late Spring 27) and lasts one SkyBlock year (124 h).
// Price points: an item's history file if it has one, else norm-store.json, a compact
// snapshot of every Bazaar product every 4 hours.
const SB_EPOCH = 1560275700; // SkyBlock year 1, Early Spring 1 (as in SkyHanni's SkyBlockTime)
const SB_YEAR = 124 * 3600;
const TERM_OFFSET = (2 * 31 + 26) * 1200; // Late Spring 27, 20 min per SkyBlock day
const termYear = (t) => Math.floor((t - SB_EPOCH - TERM_OFFSET) / SB_YEAR) + 1;
const termStart = (y) => SB_EPOCH + (y - 1) * SB_YEAR + TERM_OFFSET;
// Past terms whose mayor/minister we learned elsewhere (the API only gives the current one).
// From Coflnet's mayor history (Mito, 2026-11-16). Coflnet numbers a term by its election
// year, one less than the year here (its 525 = our 526, started 2026-11-15 11:15 UTC).
// year: [mayor, minister]
const KNOWN_TERMS = {
  517: ['Cole', 'Diana'],
  518: ['Foxy', 'Marina'],
  519: ['Cole', 'Paul'],
  520: ['Finnegan', 'Diaz'],
  521: ['Jerry', null],
  522: ['Diaz', 'Cole'],
  523: ['Foxy', 'Aatrox'],
  524: ['Cole', 'Paul'],
  525: ['Finnegan', 'Foxy'],
};
const NORM_DAYS = 30;
const NORM_MIN_POINTS = 6;
const TERMS_KEEP = 70; // about a year of terms
const normCut = ts - NORM_DAYS * 86400;
const median = (xs, min = NORM_MIN_POINTS) => {
  const v = xs.filter((x) => x != null && x > 0).sort((a, b) => a - b);
  if (v.length < min) return null;
  const m = v.length >> 1;
  return round(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
};
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };

const storeFile = path.join(dataDir, 'norm-store.json');
let store = readJson(storeFile, []).filter((s) => s.ts >= normCut);
if (!store.length || ts - store[store.length - 1].ts >= 4 * 3600 - 10 * 60) {
  const p = {};
  for (const [id, v] of Object.entries(bzAll)) p[id] = [v[0], v[1]];
  store.push({ ts, p });
}
fs.writeFileSync(storeFile, JSON.stringify(store));

// Every item's recent points: bz -> [ts, ask, bid], ah -> [ts, lbin].
const series = { bz: {}, ah: {} };
for (const s of store) for (const [id, v] of Object.entries(s.p)) (series.bz[id] ||= []).push([s.ts, v[0], v[1]]);
for (const f of fs.readdirSync(histDir)) {
  const h = readJson(path.join(histDir, f), null);
  if (!h) continue;
  if (h.market === 'bazaar') series.bz[h.id] = h.points.map((x) => [x[0], x[1], x[2]]);
  else if (h.market === 'ah') series.ah[h.id] = h.points.map((x) => [x[0], x[1]]);
}
const medians = (from, to, min) => {
  const out = { bz: {}, ah: {} };
  for (const [id, pts] of Object.entries(series.bz)) {
    const w = pts.filter((x) => x[0] >= from && x[0] < to);
    const a = median(w.map((x) => x[1]), min), b = median(w.map((x) => x[2]), min);
    if (a != null || b != null) out.bz[id] = [a, b];
  }
  for (const [id, pts] of Object.entries(series.ah)) {
    const l = median(pts.filter((x) => x[0] >= from && x[0] < to).map((x) => x[1]), min);
    if (l != null) out.ah[id] = l;
  }
  return out;
};

// Current mayor and minister. A failed read keeps the last known ones for this term.
const termsFile = path.join(dataDir, 'terms.json');
const terms = readJson(termsFile, { cur: null, past: [] });
const nowYear = termYear(ts);
try {
  // Election is a resources endpoint (/v2/resources/skyblock/election), not /v2/skyblock/election (404).
  const el = await getJson('election', 'https://api.hypixel.net/v2/resources/skyblock/election');
  const mayor = el.mayor?.name || null, minister = el.mayor?.minister?.name || null;
  if (mayor) terms.cur = { year: nowYear, mayor, minister };
} catch (e) {
  console.error(`Election not read: ${e.message}`);
}
if (terms.cur && terms.cur.year !== nowYear) terms.cur = null; // a new term began and we couldn't read it yet
// Store each finished term (with a known mayor) once: its own median per item.
const who = {};
for (const [y, [mayor, minister]] of Object.entries(KNOWN_TERMS)) who[y] = { mayor, minister };
if (terms.last && terms.last.year < nowYear) who[terms.last.year] ||= terms.last;
for (let y = termYear(normCut); y < nowYear; y++) {
  if (!who[y] || terms.past.some((t) => t.year === y)) continue;
  const m = medians(termStart(y), termStart(y + 1), 3);
  if (!Object.keys(m.bz).length) continue;
  terms.past.push({ year: y, mayor: who[y].mayor, minister: who[y].minister, ...m });
}
terms.past = terms.past.sort((a, b) => a.year - b.year).slice(-TERMS_KEEP);
if (terms.cur) terms.last = terms.cur;
fs.writeFileSync(termsFile, JSON.stringify(terms));

// norm.json: per item [ask, bid] (bz) or lbin (ah), plus which basis it came from.
const recent = medians(normCut, ts + 1);
const norm = { ts, days: NORM_DAYS, mayor: terms.cur?.mayor || null, minister: terms.cur?.minister || null, basis: [], bz: {}, ah: {}, bzBasis: {}, ahBasis: {} };
// Mito (2026-11-16): the normal price is the price when Cole is neither mayor nor minister;
// Cole (Mining Fiesta, Prospection…) pulls mining prices down while he is in office.
const noCole = terms.past.filter((t) => t.mayor !== 'Cole' && t.minister !== 'Cole');
const groups = noCole.length ? [[noCole, "Cole'un olmadığı dönemler"]] : [];
const medianOfTerms = (list, f) => median(list.map(f), 1);
for (const [list, label] of groups) {
  for (const id of new Set(list.flatMap((t) => Object.keys(t.bz)))) {
    if (norm.bz[id]) continue;
    const have = list.filter((t) => t.bz[id]);
    const a = medianOfTerms(have, (t) => t.bz[id][0]), b = medianOfTerms(have, (t) => t.bz[id][1]);
    if (a == null && b == null) continue;
    norm.bz[id] = [a, b];
    norm.bzBasis[id] = norm.basis.length;
    norm.bzTerms ||= {}; norm.bzTerms[id] = have.length;
  }
  for (const id of new Set(list.flatMap((t) => Object.keys(t.ah || {})))) {
    if (norm.ah[id] != null) continue;
    const have = list.filter((t) => t.ah?.[id] != null);
    const l = medianOfTerms(have, (t) => t.ah[id]);
    if (l == null) continue;
    norm.ah[id] = l;
    norm.ahBasis[id] = norm.basis.length;
  }
  norm.basis.push(label);
}
const fallback = norm.basis.length;
norm.basis.push(`son ${NORM_DAYS} gün (Cole'suz dönem kaydı yok)`);
for (const [id, v] of Object.entries(recent.bz)) if (!norm.bz[id]) { norm.bz[id] = v; norm.bzBasis[id] = fallback; }
for (const [id, v] of Object.entries(recent.ah)) if (norm.ah[id] == null) { norm.ah[id] = v; norm.ahBasis[id] = fallback; }
fs.writeFileSync(path.join(dataDir, 'norm.json'), JSON.stringify(norm));

console.log(`snapshot ${new Date(ts * 1000).toISOString()}: ${Object.keys(bazaar).length} bazaar, ${Object.keys(ah).length} AH items, ${pages.length} AH pages`);
