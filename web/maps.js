// maps.js - random tiles from huge public image pyramids, read straight from their hosts,
// which all send CORS headers. The tile layouts follow coresample's readers
// (github.com/davidackerman/coresample, web/src/sources.ts).
//
// A live source in packs.json is either one map (planetary maps, Earth layers, one giant
// Zoomify image) or a set: many images under one id, each item overriding the set's fields
// (Hubble's and Webb's big pictures, OpenOrganelle's electron-microscope volumes).
// Kinds:
//   xyz          web-map tiles, {z}/{x}/{y} in a URL template
//   zoomify      ESA/Hubble and ESA/Webb zoomable images
//   precomputed  Neuroglancer volumes in JPEG chunks (OpenOrganelle EM): a tile is one plane
//                through the middle of a chunk, across x-y, x-z or y-z
// A tile's address is { z, x, y, e }: zoom (or scale), tile (or chunk) column and row, and for
// volumes e = chunk depth * 4 + axis. A piece's item = e * 256 + which image of a set.
//
// Each tile that comes back becomes a small in-memory source image; pieces are full-frame
// crops of a tile.

const MIN_TILE = 64;    // skip edge tiles narrower than this
const MIN_STD = 0.012;  // skip flat tiles (no data, blank space)
const opened = new Map();

/** Which image of a set an item names, and the rest of a tile's address. */
export const splitItem = (item = 0) => ({ index: item % 256, e: Math.floor(item / 256) });

/** The spec of one image of a set (a plain map is its own only item). */
export function itemSpec(spec, item = 0) {
  if (!spec.items) return spec;
  const { index } = splitItem(item), it = spec.items[index];
  if (!it) throw new Error(`${spec.name} has no image ${index}`);
  return { ...spec, ...it, items: undefined, set: spec, index };
}

/** Opens a live source from packs.json (one image of it, for a set). */
export function openMap(spec, item = 0) {
  const key = `${spec.id}:${splitItem(item).index}`;
  if (!opened.has(key)) {
    const s = itemSpec(spec, item);
    const p = s.kind === "zoomify" ? openZoomify(s) : Promise.resolve(s.kind === "precomputed" ? openPrecomputed(s) : openXYZ(s));
    p.catch(() => opened.delete(key)); // let a failed open be retried
    opened.set(key, p);
  }
  return opened.get(key);
}

// Web-map tiles: zoom z shows the full-resolution image shrunk 2^(maxZoom - z) times.
function openXYZ(spec) {
  const { tileSize: ts, maxZoom, width: W, height: H } = spec, zooms = [];
  for (let z = 0; z <= maxZoom; z++) {
    const f = 2 ** (maxZoom - z);
    zooms.push({ z, nx: Math.ceil(Math.ceil(W / f) / ts), ny: Math.ceil(Math.ceil(H / f) / ts) });
  }
  return image2d(spec, zooms, (z, x, y) => spec.url.replace("{z}", z).replace("{x}", x).replace("{y}", y));
}

// Zoomify (ESA/Hubble, ESA/Webb): tier t counts ceil(W / (tile * 2^(maxTier - t))) tiles
// across; a tile's folder is its index over all tiers / 256. Sets carry each image's size,
// so only single images read ImageProperties.xml.
async function openZoomify(spec) {
  const base = spec.base.replace(/\/+$/, "");
  let { width: W, height: H, tileSize: ts } = spec;
  if (!W) {
    const r = await fetch(`${base}/ImageProperties.xml`);
    if (!r.ok) throw new Error(`couldn't open ${spec.name}`);
    const xml = await r.text();
    const attr = (k) => Number(new RegExp(`${k}\\s*=\\s*["'](\\d+)["']`, "i").exec(xml)[1]);
    [W, H, ts] = [attr("WIDTH"), attr("HEIGHT"), attr("TILESIZE")];
  }
  const tiers = [];
  for (let f = 1; ; f *= 2) {
    tiers.unshift([Math.ceil(W / (ts * f)), Math.ceil(H / (ts * f))]);
    if (W / f <= ts && H / f <= ts) break;
  }
  const cum = [0];
  for (const [nx, ny] of tiers) cum.push(cum[cum.length - 1] + nx * ny);
  const zooms = tiers.map(([nx, ny], z) => ({ z, nx, ny }));
  return image2d({ ...spec, tileSize: ts }, zooms, (z, x, y) => `${base}/TileGroup${Math.floor((cum[z] + y * tiers[z][0] + x) / 256)}/${z}-${x}-${y}.jpg`);
}

function image2d(spec, zooms, url) {
  const skip = new Set(spec.skipZooms || []);
  // zooms to sample from: enough tiles to be worth it, and not broken on the server
  const sample = zooms.filter((q) => q.nx * q.ny >= 16 && !skip.has(q.z));
  const has = ({ z, x, y, e = 0 }) => e === 0 && Number.isInteger(z) && z >= 0 && z < zooms.length
    && x >= 0 && y >= 0 && x < zooms[z].nx && y < zooms[z].ny;
  const tileUrl = (t) => url(t.z, t.x, t.y);
  return {
    spec, zooms, sample, has, url: tileUrl,
    pick(rand) {
      const q = sample[Math.floor(rand() * sample.length)];
      return [{ z: q.z, x: Math.floor(rand() * q.nx), y: Math.floor(rand() * q.ny), e: 0 }];
    },
    fetch: (t) => fetchImage(tileUrl(t)),
  };
}

// Neuroglancer precomputed volumes: chunk files named x0-x1_y0-y1_z0-z1; a JPEG chunk is the
// chunk's voxels in x-fastest order, as one grey image's pixels.
function openPrecomputed(spec) {
  const zooms = spec.scales.map((sc, z) => ({
    z, nx: Math.ceil(sc.size[0] / sc.chunk[0]), ny: Math.ceil(sc.size[1] / sc.chunk[1]), nz: Math.ceil(sc.size[2] / sc.chunk[2]),
  }));
  const has = ({ z, x, y, e = 0 }) => {
    const q = zooms[z], cz = e >> 2, axis = e & 3;
    return !!q && Number.isInteger(z) && x >= 0 && y >= 0 && cz >= 0 && x < q.nx && y < q.ny && cz < q.nz && axis < 3;
  };
  const range = (sc, i, k) => {
    const a = sc.chunk[i] * k, b = Math.min(sc.size[i], a + sc.chunk[i]);
    return [a, b, `${a + sc.offset[i]}-${b + sc.offset[i]}`];
  };
  const chunkUrl = (t) => {
    const sc = spec.scales[t.z];
    return `${spec.base}/${sc.key}/${range(sc, 0, t.x)[2]}_${range(sc, 1, t.y)[2]}_${range(sc, 2, t.e >> 2)[2]}`;
  };
  const chunks = new Map(); // url -> Promise of grey voxels; a few chunks give three tiles each
  const chunk = (t) => {
    const u = chunkUrl(t);
    if (!chunks.has(u)) {
      if (chunks.size >= 32) chunks.delete(chunks.keys().next().value);
      chunks.set(u, fetchImage(u, { grey: true }).catch(() => null));
    }
    return chunks.get(u);
  };
  return {
    spec, zooms, sample: zooms, has, url: chunkUrl,
    pick(rand) { // one random chunk, cut three ways
      const q = zooms[Math.floor(rand() * zooms.length)];
      const x = Math.floor(rand() * q.nx), y = Math.floor(rand() * q.ny), cz = Math.floor(rand() * q.nz);
      return [0, 1, 2].map((axis) => ({ z: q.z, x, y, e: cz * 4 + axis }));
    },
    async fetch(t) {
      const v = await chunk(t);
      if (!v) return null;
      const sc = spec.scales[t.z], [x0, x1] = range(sc, 0, t.x), [y0, y1] = range(sc, 1, t.y), [z0, z1] = range(sc, 2, t.e >> 2);
      const X = x1 - x0, Y = y1 - y0, Z = z1 - z0;
      if (v.grey.length !== X * Y * Z) return null;
      const axis = t.e & 3, [w, h] = axis === 0 ? [X, Y] : axis === 1 ? [X, Z] : [Y, Z];
      const at = axis === 0 ? (i, j) => i + X * (j + Y * (Z >> 1))
        : axis === 1 ? (i, j) => i + X * ((Y >> 1) + Y * j)
        : (i, j) => (X >> 1) + X * (i + Y * j);
      const rgb = new Uint8Array(w * h * 3);
      for (let j = 0, q = 0; j < h; j++) for (let i = 0; i < w; i++, q += 3) rgb[q] = rgb[q + 1] = rgb[q + 2] = v.grey[at(i, j)];
      return { w, h, rgb };
    },
  };
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

async function decode(blob, grey = false) {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const w = bmp.width, h = bmp.height;
  const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const d = ctx.getImageData(0, 0, w, h).data;
  if (grey) {
    const g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = d[i];
    return { w, h, grey: g };
  }
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; }
  return { w, h, rgb };
}

// share of pixels that are pure black: a map's "no data" (gaps between survey strips,
// outside a mosaic's footprint, padding around a volume), which would otherwise be picked
// for its sharp edges
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

/** One image file as { w, h, rgb } (or { w, h, grey }), or null if there is none (or it came back broken). */
async function fetchImage(url, { grey = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404 || r.status === 400 || r.status === 403) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      if (!(await complete(blob))) return null;
      return await decode(blob, grey);
    } catch (e) {
      // a server error sent without CORS headers reaches us as a TypeError: give up after
      // two tries (as coresample does); other failures get three
      if (attempt === 2 || (e instanceof TypeError && attempt >= 1)) return null;
      await sleep(400 * 2 ** attempt);
    }
  }
  return null;
}

/** One tile ({ z, x, y, e }) of an opened map as { w, h, rgb }, or null. */
export const fetchTile = (map, t) => map.fetch(t);

/** Runs fn over items with at most `limit` running at once. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// k distinct random numbers below n
function distinct(n, k, rand) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < k; i++) { const j = i + Math.floor(rand() * (n - i)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, k);
}

const PER_ITEM = 5; // a set spreads its tiles over a few random images, about this many each

/** `count` random, usable tiles of a live source (random image of a set, random zoom,
 * random place): [{ item, z, x, y, w, h, rgb }]. */
export async function gatherTiles(spec, count, rand, { onProgress, cancelled, concurrency = 6 } = {}) {
  const items = spec.items ? distinct(spec.items.length, Math.min(spec.items.length, Math.ceil(count / PER_ITEM)), rand) : [0];
  const got = [];
  await Promise.all(items.map(async (index, k) => {
    const want = Math.floor(count / items.length) + (k < count % items.length ? 1 : 0);
    let map;
    try { map = await openMap(spec, index); } catch { return; }
    const noData = map.spec.noDataBlack, seen = new Set(), maxAttempts = want * 5, mine = [];
    let attempts = 0;
    const worker = async () => {
      while (mine.length < want && attempts < maxAttempts && !cancelled?.()) {
        attempts++;
        for (const t of map.pick(rand)) {
          const key = `${t.z}/${t.x}/${t.y}/${t.e}`;
          if (seen.has(key) || mine.length >= want) continue;
          seen.add(key);
          const tile = await map.fetch(t);
          const usable = tile && Math.min(tile.w, tile.h) >= MIN_TILE && !isFlat(tile) && !(noData && blackFraction(tile) > 0.01);
          if (usable && mine.length < want) {
            const item = spec.items ? t.e * 256 + index : 0;
            mine.push({ item, z: t.z, x: t.x, y: t.y, ...tile });
            got.push(mine[mine.length - 1]);
            onProgress?.(got.length);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.round(concurrency / items.length)) }, worker));
  }));
  return got;
}

/** Downloads (and discards) n random tiles of one image of a live source, so a host's logs
 * don't show only the tiles a shared picture uses. */
export async function fetchDecoys(spec, item, n, rand) {
  const map = await openMap(spec, item);
  const picks = [];
  while (picks.length < n) picks.push(...map.pick(rand).slice(0, 1));
  await mapLimit(picks, 6, (t) => fetch(map.url(t)).then((r) => r.blob()).catch(() => null));
}
