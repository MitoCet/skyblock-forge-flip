// Writes mod-values.json for the Mining-Profit-Calc Minecraft mod: what one unit of an item
// is worth, worked out the same way as the site's Mining tab with the site's default settings
// (sell offer, instant buy, 1.25% Bazaar tax, NPC price when it pays more for gemstones).
// KEEP IN SYNC with MINE / metalRoutes / gemPlan in js/app.js: when the site's mining rules
// change, change this file in the same PR so the mod values items the same way.
// Usage: node scripts/mod-values.mjs <dataDir>
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.argv[2] || 'data';
const read = (f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
const { recipes, names: recipeNames } = read('recipes.json');
const { crafts } = read('crafts.json');
const market = read('market.json');
const npcData = fs.existsSync(path.join(dataDir, 'npc.json')) ? read('npc.json') : { npc: {}, names: {} };

const BZ_TAX = 1.25;
const forgeRecipe = (id) => recipes.find((r) => r.id === id);
const craftsBy = new Map();
for (const c of crafts) {
  if (!craftsBy.has(c.id)) craftsBy.set(c.id, []);
  craftsBy.get(c.id).push(c);
}
const isFreeCrystal = (id) => /_CRYSTAL$/.test(id);

function ahFee(price) {
  const listing = price < 1e7 ? 0.01 : price < 1e8 ? 0.02 : 0.025;
  const claim = price > 1e6 ? 0.01 : 0;
  return price * (listing + claim);
}
// Sell offer: undercut the lowest sell order by 0.1 (site default).
function marketSell(id) {
  const b = market.bz[id];
  if (b) {
    const unit = b[0] != null ? b[0] - 0.1 : b[1];
    return unit == null ? null : unit * (1 - BZ_TAX / 100);
  }
  const a = market.ah[id];
  return a ? a[0] - ahFee(a[0]) : null;
}
// Instant buy (site default).
function marketBuy(id) {
  const b = market.bz[id];
  if (b && b[0] != null) return b[0];
  const a = market.ah[id];
  if (a) return a[0];
  return isFreeCrystal(id) ? 0 : null;
}
// Like the site's bestSale with "NPC" on: the NPC price when it pays more.
function bestSale(id) {
  const m = marketSell(id);
  const npc = npcData.npc[id] ?? null;
  return npc != null && (m == null || npc > m) ? npc : m;
}

// Same list as MINE in js/app.js.
const MINE = [
  { id: 'TUNGSTEN', noSell: true, raw: 'TUNGSTEN', ench: 'ENCHANTED_TUNGSTEN', refined: 'REFINED_TUNGSTEN', plate: 'TUNGSTEN_PLATE', key: 'TUNGSTEN_KEY' },
  { id: 'UMBER', noSell: true, raw: 'UMBER', ench: 'ENCHANTED_UMBER', refined: 'REFINED_UMBER', plate: 'UMBER_PLATE', key: 'UMBER_KEY' },
  { id: 'GLACITE', raw: 'GLACITE', ench: 'ENCHANTED_GLACITE', refined: 'GLACITE_AMALGAMATION' },
  { id: 'MITHRIL', raw: 'MITHRIL_ORE', ench: 'ENCHANTED_MITHRIL', refined: 'REFINED_MITHRIL' },
  { id: 'TITANIUM', raw: 'TITANIUM_ORE', ench: 'ENCHANTED_TITANIUM', refined: 'REFINED_TITANIUM' },
  { id: 'HARD_STONE', noSell: true, raw: 'HARD_STONE', ench: 'ENCHANTED_HARD_STONE', craftUp: 'CONCENTRATED_STONE' },
  { id: 'REFINED_MINERAL', raw: 'REFINED_MINERAL', simple: true },
  { id: 'GLOSSY_GEMSTONE', raw: 'GLOSSY_GEMSTONE', simple: true },
  { id: 'SUSPICIOUS_SCRAP', raw: 'SUSPICIOUS_SCRAP', simple: true },
];
function enchRatio(m) {
  const c = craftsBy.get(m.ench)?.find((x) => x.inputs.length === 1 && x.inputs[0].id === m.raw);
  return c ? c.inputs[0].count / c.count : 160;
}
// Cost of the other ingredients of one forge, or null if one has no price.
function extraCost(r, skip) {
  let t = 0;
  for (const i of r.inputs) {
    if (i.id === skip) continue;
    const u = marketBuy(i.id);
    if (u == null) return null;
    t += u * i.count;
  }
  return t;
}
// Net coins per Enchanted piece on every route of metalRoutes; returns the best.
function bestPerEnch(m) {
  const ratio = enchRatio(m);
  const routes = [];
  if (!m.noSell) {
    const raw = marketSell(m.raw);
    if (raw != null) routes.push(['raw', raw * ratio]);
    const ench = marketSell(m.ench);
    if (ench != null) routes.push(['ench', ench]);
  }
  const keyR = m.key && forgeRecipe(m.key);
  const keyPer = keyR?.inputs.find((i) => i.id === m.ench)?.count;
  if (keyPer) {
    const sale = marketSell(m.key), ex = extraCost(keyR, m.ench);
    if (sale != null && ex != null) routes.push(['key', (sale * keyR.count - ex) / keyPer]);
  }
  const upC = m.craftUp && craftsBy.get(m.craftUp)?.find((x) => x.inputs.length === 1 && x.inputs[0].id === m.ench);
  if (upC) {
    const sale = marketSell(m.craftUp);
    if (sale != null) routes.push(['craft', sale / (upC.inputs[0].count / upC.count)]);
  }
  const refR = m.refined && forgeRecipe(m.refined);
  const refPer = refR?.inputs.find((i) => i.id === m.ench)?.count;
  if (refPer) {
    const sale = marketSell(m.refined), ex = extraCost(refR, m.ench);
    if (sale != null && ex != null) routes.push(['refined', (sale * refR.count - ex) / refPer]);
    const plateR = m.plate && forgeRecipe(m.plate);
    const perPlate = plateR?.inputs.find((i) => i.id === m.refined)?.count;
    if (plateR && perPlate && ex != null) {
      const ps = marketSell(m.plate), ex2 = extraCost(plateR, m.refined);
      if (ps != null && ex2 != null) routes.push(['plate', (ps * plateR.count - ex2 - ex * perPlate) / (refPer * perPlate)]);
    }
  }
  return routes.reduce((b, r) => (!b || r[1] > b[1] ? r : b), null);
}

const items = {};
const put = (id, v, fam, route) => {
  if (v == null || !Number.isFinite(v)) return;
  items[id] = { v: Math.round(v * 100) / 100, ...(fam ? { fam } : {}), ...(route ? { route } : {}) };
};

for (const m of MINE) {
  if (m.simple) { put(m.raw, marketSell(m.raw), m.id, 'sell'); continue; }
  const best = bestPerEnch(m);
  if (!best) continue;
  put(m.ench, best[1], m.id, best[0]);
  put(m.raw, best[1] / enchRatio(m), m.id, best[0]);
}

// Gemstones: one Rough is worth its share of the best of Fine or Flawless (Rough and Flawed are
// crafted up, like the site's "en kârlı"); Flawless held is sold as it is.
const gemTypes = Object.keys(market.bz).map((id) => id.match(/^ROUGH_([A-Z]+)_GEM$/)?.[1]).filter(Boolean);
for (const t of gemTypes) {
  const fine = bestSale(`FINE_${t}_GEM`), flawless = bestSale(`FLAWLESS_${t}_GEM`);
  const perRough = Math.max(fine == null ? -Infinity : fine / 6400, flawless == null ? -Infinity : flawless / 512000);
  if (!Number.isFinite(perRough)) continue;
  const route = flawless != null && (fine == null || flawless > fine * 80) ? 'flawless' : 'fine';
  const fam = `GEM_${t}`;
  put(`ROUGH_${t}_GEM`, perRough, fam, route);
  put(`FLAWED_${t}_GEM`, perRough * 80, fam, route);
  put(`FINE_${t}_GEM`, perRough * 6400, fam, route);
  put(`FLAWLESS_${t}_GEM`, flawless, fam, 'sell');
}

// Everything else (corpse loot such as keys, enchanted books, dyes…): sold as it is.
for (const id of new Set([...Object.keys(market.bz), ...Object.keys(market.ah)])) {
  if (!items[id]) put(id, marketSell(id));
}

const names = { ...recipeNames, ...npcData.names };
for (const [id, it] of Object.entries(items)) if (names[id]) it.name = names[id];

fs.writeFileSync(path.join(dataDir, 'mod-values.json'), JSON.stringify({ ts: market.ts, items }));
console.log(`mod-values.json: ${Object.keys(items).length} items`);
