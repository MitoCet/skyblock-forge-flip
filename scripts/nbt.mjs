// Minimal reader for gzipped, base64-encoded Minecraft NBT (Hypixel item_bytes).
import { gunzipSync } from 'node:zlib';

export function decodeItemBytes(b64) {
  const buf = gunzipSync(Buffer.from(b64, 'base64'));
  const r = { buf, pos: 0 };
  const type = buf.readInt8(r.pos++);
  readString(r); // root name
  return readPayload(r, type);
}

function readString(r) {
  const len = r.buf.readUInt16BE(r.pos);
  r.pos += 2;
  const s = r.buf.toString('utf8', r.pos, r.pos + len);
  r.pos += len;
  return s;
}

function readPayload(r, type) {
  const b = r.buf;
  switch (type) {
    case 1: return b.readInt8(r.pos++);
    case 2: { const v = b.readInt16BE(r.pos); r.pos += 2; return v; }
    case 3: { const v = b.readInt32BE(r.pos); r.pos += 4; return v; }
    case 4: { const v = b.readBigInt64BE(r.pos); r.pos += 8; return Number(v); }
    case 5: { const v = b.readFloatBE(r.pos); r.pos += 4; return v; }
    case 6: { const v = b.readDoubleBE(r.pos); r.pos += 8; return v; }
    case 7: { const n = b.readInt32BE(r.pos); r.pos += 4 + n; return null; }
    case 8: return readString(r);
    case 9: {
      const t = b.readInt8(r.pos++);
      const n = b.readInt32BE(r.pos); r.pos += 4;
      const out = [];
      for (let i = 0; i < n; i++) out.push(readPayload(r, t));
      return out;
    }
    case 10: {
      const obj = {};
      for (;;) {
        const t = b.readInt8(r.pos++);
        if (t === 0) return obj;
        const name = readString(r);
        obj[name] = readPayload(r, t);
      }
    }
    case 11: { const n = b.readInt32BE(r.pos); r.pos += 4 + 4 * n; return null; }
    case 12: { const n = b.readInt32BE(r.pos); r.pos += 4 + 8 * n; return null; }
    default: throw new Error(`Unknown NBT tag ${type}`);
  }
}

const TIERS = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC'];

// Returns the NEU-style item id (pets become TYPE;tierIndex) and stack size.
export function itemIdFromBytes(b64) {
  const root = decodeItemBytes(b64);
  const item = root?.i?.[0];
  const ea = item?.tag?.ExtraAttributes;
  if (!ea?.id) return null;
  let id = ea.id;
  if (id === 'PET' && ea.petInfo) {
    try {
      const p = JSON.parse(ea.petInfo);
      id = `${p.type};${TIERS.indexOf(p.tier)}`;
    } catch { return null; }
  }
  return { id, count: item.Count || 1 };
}
