// maps.js - random tiles from huge public image pyramids (planetary maps, Zoomify images),
// read straight from their hosts, which all send CORS headers. The tile layouts follow
// coresample's readers (github.com/davidackerman/coresample, web/src/sources.ts).
//
// Each tile that comes back becomes a small in-memory source image; pieces are full-frame
// crops of a tile, at whatever zoom the tile came from.

const MIN_TILE = 64;    // skip edge tiles narrower than this
const MIN_STD = 0.012;  // skip flat tiles (no data, blank space)
const opened = new Map();

/** Opens a map spec from packs.json: { id, kind: "xyz" | "zoomify", ... }. */
export function openMap(spec) {
  if (!opened.has(spec.id)) {
    const p = spec.kind === "zoomify" ? openZoomify(spec) : Promise.resolve(openXYZ(spec));
    p.catch(() => opened.delete(spec.id)); // let a failed open be retried
    opened.set(spec.id, p);
  }
  return opened.get(spec.id);
}

// Web-map tiles: zoom z shows the full-resolution image shrunk 2^(maxZoom - z) times.
function openXYZ(spec) {
  const { tileSize: ts, maxZoom, width: W, height: H } = spec, zooms = [];
  for (let z = 0; z <= maxZoom; z++) {
    const f = 2 ** (maxZoom - z);
    zooms.push({ z, nx: Math.ceil(Math.ceil(W / f) / ts), ny: Math.ceil(Math.ceil(H / f) / ts) });
  }
  return finish(spec, zooms, (z, x, y) => spec.url.replace("{z}", z).replace("{x}", x).replace("{y}", y));
}

// Zoomify (ESA/Hubble, ESA/Webb): tier t counts ceil(W / (tile * 2^(maxTier - t))) tiles
// across; a tile's folder is its index over all tiers / 256.
async function openZoomify(spec) {
  const base = spec.base.replace(/\/+$/, "");
  const r = await fetch(`${base}/ImageProperties.xml`);
  if (!r.ok) throw new Error(`couldn't open ${spec.name}`);
  const xml = await r.text();
  const attr = (k) => Number(new RegExp(`${k}\\s*=\\s*["'](\\d+)["']`, "i").exec(xml)[1]);
  const W = attr("WIDTH"), H = attr("HEIGHT"), ts = attr("TILESIZE"), tiers = [];
  for (let f = 1; ; f *= 2) {
    tiers.unshift([Math.ceil(W / (ts * f)), Math.ceil(H / (ts * f))]);
    if (W / f <= ts && H / f <= ts) break;
  }
  const cum = [0];
  for (const [nx, ny] of tiers) cum.push(cum[cum.length - 1] + nx * ny);
  const zooms = tiers.map(([nx, ny], z) => ({ z, nx, ny }));
  return finish(spec, zooms, (z, x, y) => `${base}/TileGroup${Math.floor((cum[z] + y * tiers[z][0] + x) / 256)}/${z}-${x}-${y}.jpg`);
}

function finish(spec, zooms, url) {
  const skip = new Set(spec.skipZooms || []);
  // zooms to sample from: enough tiles to be worth it, and not broken on the server
  const sample = zooms.filter((q) => q.nx * q.ny >= 16 && !skip.has(q.z));
  const has = (z, x, y) => Number.isInteger(z) && z >= 0 && z < zooms.length && x >= 0 && y >= 0 && x < zooms[z].nx && y < zooms[z].ny;
  return { spec, zooms, sample, url, has };
}

/** Whether an image file arrived whole (ArcGIS caches serve cut-off PNGs and error pages). */
async function complete(blob) {
  if (blob.size < 16) return false;
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  const tail = new Uint8Array(await blob.slice(blob.size - 12).arrayBuffer());
  if (head[0] === 0x89 && head[1] === 0x50) return tail[4] === 0x49 && tail[5] === 0x45 && tail[6] === 0x4e && tail[7] === 0x44;
  if (head[0] === 0xff && head[1] === 0xd8) { for (let i = 0; i < 11; i++) if (tail[i] === 0xff && tail[i + 1] === 0xd9) return true; return false; }
  return false;
}

async function decode(blob) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const w = bmp.width, h = bmp.height;
  const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const d = ctx.getImageData(0, 0, w, h).data, rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; }
  return { w, h, rgb };
}

// share of pixels that are pure black: a map's "no data" (gaps between survey strips,
// outside a mosaic's footprint), which would otherwise be picked for its sharp edges
function blackFraction(t) {
  let k = 0, n = 0;
  for (let p = 0; p < t.w * t.h; p += 5, n++) { const q = p * 3; if (t.rgb[q] + t.rgb[q + 1] + t.rgb[q + 2] === 0) k++; }
  return k / n;
}

function isFlat(t) {
  let s = 0, ss = 0, n = 0;
  for (let p = 0; p < t.w * t.h; p += 7) {
    const q = p * 3, v = (0.299 * t.rgb[q] + 0.587 * t.rgb[q + 1] + 0.114 * t.rgb[q + 2]) / 255;
    s += v; ss += v * v; n++;
  }
  const m = s / n;
  return Math.sqrt(Math.max(0, ss / n - m * m)) < MIN_STD;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One tile as { w, h, rgb }, or null if there is none (or it came back broken). */
export async function fetchTile(map, z, x, y) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(map.url(z, x, y));
      if (r.status === 404 || r.status === 400) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      if (!(await complete(blob))) return null;
      return await decode(blob);
    } catch (e) {
      // a server error sent without CORS headers reaches us as a TypeError: give up after
      // two tries (as coresample does); other failures get three
      if (attempt === 2 || (e instanceof TypeError && attempt >= 1)) return null;
      await sleep(400 * 2 ** attempt);
    }
  }
  return null;
}

/** Runs fn over items with at most `limit` running at once. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** `count` random, usable tiles (random zoom, random place): [{ z, x, y, w, h, rgb }]. */
export async function gatherTiles(map, count, rand, { onProgress, cancelled, concurrency = 12 } = {}) {
  const got = [], seen = new Set(), maxAttempts = count * 5;
  let attempts = 0;
  const worker = async () => {
    while (got.length < count && attempts < maxAttempts && !cancelled?.()) {
      attempts++;
      const q = map.sample[Math.floor(rand() * map.sample.length)];
      const x = Math.floor(rand() * q.nx), y = Math.floor(rand() * q.ny), key = `${q.z}/${x}/${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = await fetchTile(map, q.z, x, y);
      const usable = t && Math.min(t.w, t.h) >= MIN_TILE && !isFlat(t) && !(map.spec.noDataBlack && blackFraction(t) > 0.01);
      if (usable && got.length < count) {
        got.push({ z: q.z, x, y, ...t });
        onProgress?.(got.length);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return got;
}

/** Downloads (and discards) n random tiles, so a host's logs don't show only the tiles a
 * shared picture uses. */
export async function fetchDecoys(map, n, rand) {
  const picks = Array.from({ length: n }, () => {
    const q = map.sample[Math.floor(rand() * map.sample.length)];
    return [q.z, Math.floor(rand() * q.nx), Math.floor(rand() * q.ny)];
  });
  await mapLimit(picks, 6, ([z, x, y]) => fetch(map.url(z, x, y)).then((r) => r.blob()).catch(() => null));
}
