// Builds recipes.json (all forge recipes) and crafts.json (all crafting table
// recipes) from the NotEnoughUpdates item repo.
// Usage: node scripts/build-recipes.mjs <outDir> [neuRepoDir]
// Without neuRepoDir it downloads the repo; skips if both files are under 24h old.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const outDir = process.argv[2] || 'data';
let neuDir = process.argv[3];
const outFile = path.join(outDir, 'recipes.json');
const craftFile = path.join(outDir, 'crafts.json');

const fresh = (f) => fs.existsSync(f) && Date.now() - JSON.parse(fs.readFileSync(f, 'utf8')).builtAt < 24 * 3600 * 1000;
if (!neuDir && fresh(outFile) && fresh(craftFile)) {
  console.log('recipes.json and crafts.json are fresh, skipping');
  process.exit(0);
}

if (!neuDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neu-'));
  execSync(`curl -sSL https://codeload.github.com/NotEnoughUpdates/NotEnoughUpdates-REPO/tar.gz/master | tar xz -C ${tmp} --wildcards '*/items/*.json'`);
  neuDir = path.join(tmp, fs.readdirSync(tmp)[0]);
}

const itemsDir = path.join(neuDir, 'items');
const cleanName = (s) => (s || '').replace(/§./g, '').replace(/[-]/g, '').replace('[Lvl {LVL}] ', '').trim();
const readItem = (id) => {
  const f = path.join(itemsDir, `${id}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};

// NEU writes damage variants as LOG-1; the Bazaar calls them LOG:1.
const marketId = (id) => id.replace(/-(\d+)$/, ':$1');
const SLOTS = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3'];

// A crafting grid ({A1: "ID:count", ...}) summed into one entry per ingredient.
function craftInputs(grid) {
  const sum = {};
  for (const slot of SLOTS) {
    const s = grid[slot];
    if (!s) continue;
    const i = s.lastIndexOf(':');
    const id = marketId(i < 0 ? s : s.slice(0, i));
    const count = i < 0 ? 1 : Number(s.slice(i + 1));
    if (!id || !(count > 0)) continue;
    sum[id] = (sum[id] || 0) + count;
  }
  return Object.entries(sum).map(([id, count]) => ({ id, count }));
}

const recipes = [];
const crafts = [];
const names = {};
const craftNames = {};
const craftKeys = new Set();
for (const file of fs.readdirSync(itemsDir)) {
  if (!file.endsWith('.json')) continue;
  const item = JSON.parse(fs.readFileSync(path.join(itemsDir, file), 'utf8'));
  const grids = [];
  if (item.recipe) grids.push(item.recipe);
  for (const r of item.recipes || []) if (r.type === 'crafting' || (!r.type && r.A1 !== undefined)) grids.push(r);
  for (const g of grids) {
    const id = marketId(g.overrideOutputId || item.internalname);
    const inputs = craftInputs(g);
    if (!inputs.length) continue;
    const key = id + JSON.stringify(inputs);
    if (craftKeys.has(key)) continue;
    craftKeys.add(key);
    crafts.push({ id, count: Number(g.count) || 1, inputs });
  }
  for (const r of item.recipes || []) {
    if (r.type !== 'forge') continue;
    const id = r.overrideOutputId || item.internalname;
    const inputs = r.inputs.map((s) => {
      const i = s.lastIndexOf(':');
      return { id: s.slice(0, i), count: Number(s.slice(i + 1)) };
    });
    recipes.push({ id, count: Number(r.count) || 1, duration: Number(r.duration), inputs });
    names[id] = cleanName(item.displayname);
    for (const inp of inputs) {
      if (names[inp.id]) continue;
      names[inp.id] = inp.id === 'SKYBLOCK_COIN' ? 'Coins' : cleanName(readItem(inp.id)?.displayname) || inp.id;
    }
  }
}
for (const c of crafts) {
  for (const id of [c.id, ...c.inputs.map((i) => i.id)]) {
    if (craftNames[id]) continue;
    craftNames[id] = cleanName(readItem(id.replace(/:(\d+)$/, '-$1'))?.displayname) || id;
  }
}
recipes.sort((a, b) => a.id.localeCompare(b.id));
crafts.sort((a, b) => a.id.localeCompare(b.id));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ builtAt: Date.now(), recipes, names }));
fs.writeFileSync(craftFile, JSON.stringify({ builtAt: Date.now(), crafts, names: craftNames }));
console.log(`wrote ${recipes.length} forge recipes to ${outFile}, ${crafts.length} crafting recipes to ${craftFile}`);
