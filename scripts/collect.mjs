// Takes one price snapshot of every forge-related item from Hypixel's public
// Bazaar and Auction House APIs. Writes latest.json and appends to history/.
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
    asks: (p.buy_summary || []).slice(0, 15).map((o) => [round(o.pricePerUnit), o.amount]),
  };
}

// Auction House: lowest BIN per unit for tracked items that are not on the Bazaar.
const ah = {};
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
    if (!info || !tracked.has(info.id) || bazaar[info.id]) continue;
    const unit = a.starting_bid / info.count;
    const cur = ah[info.id] || (ah[info.id] = { lbin: unit, n: 0 });
    cur.lbin = Math.min(cur.lbin, unit);
    cur.n++;
  }
}
for (const v of Object.values(ah)) v.lbin = round(v.lbin);

fs.writeFileSync(path.join(dataDir, 'latest.json'), JSON.stringify({ ts, bazaar, ah }));

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

console.log(`snapshot ${new Date(ts * 1000).toISOString()}: ${Object.keys(bazaar).length} bazaar, ${Object.keys(ah).length} AH items, ${pages.length} AH pages`);
