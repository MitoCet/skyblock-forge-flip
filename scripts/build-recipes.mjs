// Builds recipes.json (all forge recipes) from the NotEnoughUpdates item repo.
// Usage: node scripts/build-recipes.mjs <outDir> [neuRepoDir]
// Without neuRepoDir it downloads the repo; skips if recipes.json is under 24h old.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const outDir = process.argv[2] || 'data';
let neuDir = process.argv[3];
const outFile = path.join(outDir, 'recipes.json');

if (!neuDir && fs.existsSync(outFile)) {
  const old = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  if (Date.now() - old.builtAt < 24 * 3600 * 1000) {
    console.log('recipes.json is fresh, skipping');
    process.exit(0);
  }
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

const recipes = [];
const names = {};
for (const file of fs.readdirSync(itemsDir)) {
  if (!file.endsWith('.json')) continue;
  const item = JSON.parse(fs.readFileSync(path.join(itemsDir, file), 'utf8'));
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
recipes.sort((a, b) => a.id.localeCompare(b.id));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ builtAt: Date.now(), recipes, names }));
console.log(`wrote ${recipes.length} forge recipes to ${outFile}`);
