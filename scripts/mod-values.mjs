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
  { id: 'GLACITE', raw: 'GLACITE', ench: 'ENCHANTED_GLACITE', refined: 'GLACITE_AMALGAMATION', preferRefined: true },
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
// Net coins per Enchanted piece on every route of metalRoutes; returns the best, or for
// preferRefined (Glacite, Mito 2026-11-12, like the site's Glacite card) always the forge route
// (Amalgamation) when it has a price, even if another route pays more.
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
  if (m.preferRefined) {
    const forge = routes.find((r) => r[0] === 'refined');
    if (forge) return forge;
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

// Classic ores (Mito, 2026-11-13): sold only as Enchanted Block (Enchanted Obsidian, which has no
// block), like the site's Ore cards (MINE in js/app.js, top). One raw unit is worth its share of
// that sale (sell offer); every form (raw, vanilla Block, Ore block, Enchanted, Enchanted Block) is
// worth its raw units times that, so crafting between forms never changes the value. Families
// start with ORE_ (the mod's "Ore" heading).
const ORES = [
  { id: 'COAL', raw: 'COAL', block: ['COAL_BLOCK', 9], ench: 'ENCHANTED_COAL', eblock: 'ENCHANTED_COAL_BLOCK' },
  { id: 'IRON', raw: 'IRON_INGOT', ore: 'IRON_ORE', block: ['IRON_BLOCK', 9], ench: 'ENCHANTED_IRON', eblock: 'ENCHANTED_IRON_BLOCK' },
  { id: 'GOLD', raw: 'GOLD_INGOT', ore: 'GOLD_ORE', block: ['GOLD_BLOCK', 9], ench: 'ENCHANTED_GOLD', eblock: 'ENCHANTED_GOLD_BLOCK' },
  { id: 'DIAMOND', raw: 'DIAMOND', block: ['DIAMOND_BLOCK', 9], ench: 'ENCHANTED_DIAMOND', eblock: 'ENCHANTED_DIAMOND_BLOCK' },
  { id: 'LAPIS', raw: 'INK_SACK:4', block: ['LAPIS_BLOCK', 9], ench: 'ENCHANTED_LAPIS_LAZULI', eblock: 'ENCHANTED_LAPIS_LAZULI_BLOCK' },
  { id: 'REDSTONE', raw: 'REDSTONE', block: ['REDSTONE_BLOCK', 9], ench: 'ENCHANTED_REDSTONE', eblock: 'ENCHANTED_REDSTONE_BLOCK' },
  { id: 'EMERALD', raw: 'EMERALD', block: ['EMERALD_BLOCK', 9], ench: 'ENCHANTED_EMERALD', eblock: 'ENCHANTED_EMERALD_BLOCK' },
  { id: 'QUARTZ', raw: 'QUARTZ', block: ['QUARTZ_BLOCK', 4], ench: 'ENCHANTED_QUARTZ', eblock: 'ENCHANTED_QUARTZ_BLOCK' },
  { id: 'OBSIDIAN', raw: 'OBSIDIAN', ench: 'ENCHANTED_OBSIDIAN' },
];
// Raw units in one piece made by a one-ingredient craft of `from` (160 when the data has no recipe).
function craftRatio(id, from) {
  const c = craftsBy.get(id)?.find((x) => x.inputs.length === 1 && x.inputs[0].id === from);
  return c ? c.inputs[0].count / c.count : 160;
}
for (const o of ORES) {
  const enchR = craftRatio(o.ench, o.raw);
  const forms = [[o.raw, 1], [o.ench, enchR]];
  if (o.ore) forms.push([o.ore, 1]);
  if (o.block) forms.push(o.block);
  const topUnits = o.eblock ? enchR * craftRatio(o.eblock, o.ench) : enchR;
  if (o.eblock) forms.push([o.eblock, topUnits]);
  const sale = marketSell(o.eblock || o.ench);
  if (sale == null) continue;
  const perRaw = sale / topUnits;
  for (const [id, units] of forms) put(id, perRaw * units, `ORE_${o.id}`, o.eblock ? 'eblock' : 'ench');
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
