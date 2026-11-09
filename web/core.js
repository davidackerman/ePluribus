// core.js - the maths, shared by the page, the scoring workers and the Node tests.
// No DOM access in this file.
//
// A "piece" is a square crop of a source image, stretched to cover the whole
// N x N frame, optionally rotated/flipped. A picture is approximated as
//     sum_i  w_i * (piece_i - mean(piece_i))  +  target mean      (w_i >= 0)
// i.e. pieces are added as light (non-negative weights) and one black level
// per colour channel is set at the end.

export const N = 64;              // fitting resolution
export const NN = N * N;
export const MIN_CROP = 32;       // smallest crop side, in source pixels
const MIN_NORM = 0.5;             // reject nearly flat pieces (std ~ 0.008)
const LUMA = [0.2125, 0.7154, 0.0721];

/* ------------------------------------------------------------ random */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------ sources */
// rgb: Uint8Array of w*h*3. Builds a 2x box-filter pyramid so that any crop
// can be resampled from a level only 1-2x larger than the output.
export function makeSource(key, w, h, rgb) {
  const levels = [{ w, h, data: rgb }];
  let cur = levels[0];
  while (Math.min(cur.w, cur.h) >= 2 * N) {
    const nw = cur.w >> 1, nh = cur.h >> 1, src = cur.data, out = new Uint8Array(nw * nh * 3);
    const stride = cur.w * 3;
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const i = 2 * y * stride + 2 * x * 3, o = (y * nw + x) * 3;
        for (let c = 0; c < 3; c++) {
          out[o + c] = (src[i + c] + src[i + 3 + c] + src[i + stride + c] + src[i + stride + 3 + c] + 2) >> 2;
        }
      }
    }
    cur = { w: nw, h: nh, data: out };
    levels.push(cur);
  }
  return { key, w, h, levels };
}

/* ------------------------------------------------------------ resampling */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Taps for mapping [start, start+size) of a source axis onto R output samples:
// exact area averaging when shrinking, linear interpolation when enlarging.
function axisTaps(start, size, R, limit) {
  const scale = size / R, idx = [], wts = [], off = new Int32Array(R + 1);
  for (let i = 0; i < R; i++) {
    off[i] = idx.length;
    if (scale >= 1) {
      const a = start + i * scale, b = a + scale;
      for (let p = Math.floor(a); p < b; p++) {
        const ov = Math.min(b, p + 1) - Math.max(a, p);
        if (ov > 1e-9) { idx.push(clamp(p, 0, limit - 1)); wts.push(ov / scale); }
      }
    } else {
      const u = start + (i + 0.5) * scale - 0.5, p = Math.floor(u), f = u - p;
      idx.push(clamp(p, 0, limit - 1)); wts.push(1 - f);
      idx.push(clamp(p + 1, 0, limit - 1)); wts.push(f);
    }
  }
  off[R] = idx.length;
  return { idx: Int32Array.from(idx), wts: Float64Array.from(wts), off };
}

// Resample crop (x, y, s) [level-0 pixels] to R x R; out = Float32Array(3*R*R),
// channel-major, values in [0, 1].
export function resampleCrop(src, x, y, s, R, out) {
  let L = 0;
  while (L + 1 < src.levels.length && s / (1 << (L + 1)) >= R) L++;
  const lv = src.levels[L], f = 1 << L;
  const tx = axisTaps(x / f, s / f, R, lv.w), ty = axisTaps(y / f, s / f, R, lv.h);
  let r0 = Infinity, r1 = -Infinity;
  for (const r of ty.idx) { if (r < r0) r0 = r; if (r > r1) r1 = r; }
  const nrows = r1 - r0 + 1, tmp = new Float32Array(nrows * R * 3), data = lv.data, stride = lv.w * 3;
  for (let r = 0; r < nrows; r++) {
    const rowOff = (r0 + r) * stride;
    for (let j = 0; j < R; j++) {
      let s0 = 0, s1 = 0, s2 = 0;
      for (let t = tx.off[j]; t < tx.off[j + 1]; t++) {
        const q = rowOff + tx.idx[t] * 3, w = tx.wts[t];
        s0 += w * data[q]; s1 += w * data[q + 1]; s2 += w * data[q + 2];
      }
      const o = (r * R + j) * 3;
      tmp[o] = s0; tmp[o + 1] = s1; tmp[o + 2] = s2;
    }
  }
  const RR = R * R;
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < R; j++) {
      let s0 = 0, s1 = 0, s2 = 0;
      for (let t = ty.off[i]; t < ty.off[i + 1]; t++) {
        const o = ((ty.idx[t] - r0) * R + j) * 3, w = ty.wts[t];
        s0 += w * tmp[o]; s1 += w * tmp[o + 1]; s2 += w * tmp[o + 2];
      }
      const p = i * R + j;
      out[p] = s0 / 255; out[RR + p] = s1 / 255; out[2 * RR + p] = s2 / 255;
    }
  }
  return out;
}

/* ------------------------------------------------------------ orientation */
// orient o in 0..7: rotate (o & 3) times by 90 deg counter-clockwise, then
// mirror left-right if (o & 4). Returns map: output index -> input index.
const orientCache = new Map();
export function orientMap(R, o) {
  const key = R * 8 + o;
  if (orientCache.has(key)) return orientCache.get(key);
  let a = new Int32Array(R * R);
  for (let k = 0; k < R * R; k++) a[k] = k;
  for (let r = 0; r < (o & 3); r++) {
    const b = new Int32Array(R * R);
    for (let i = 0; i < R; i++) for (let j = 0; j < R; j++) b[i * R + j] = a[j * R + (R - 1 - i)];
    a = b;
  }
  if (o & 4) {
    const b = new Int32Array(R * R);
    for (let i = 0; i < R; i++) for (let j = 0; j < R; j++) b[i * R + j] = a[i * R + (R - 1 - j)];
    a = b;
  }
  orientCache.set(key, a);
  return a;
}

// One piece as floats: C channels (1 = luminance, 3 = RGB), channel-major.
export function makeAtom(src, x, y, s, o, R, C, out, scratch) {
  const RR = R * R, rgb = resampleCrop(src, x, y, s, R, scratch || new Float32Array(3 * RR));
  const map = orientMap(R, o);
  if (C === 3) {
    for (let c = 0; c < 3; c++) for (let p = 0; p < RR; p++) out[c * RR + p] = rgb[c * RR + map[p]];
  } else {
    for (let p = 0; p < RR; p++) {
      const q = map[p];
      out[p] = LUMA[0] * rgb[q] + LUMA[1] * rgb[RR + q] + LUMA[2] * rgb[2 * RR + q];
    }
  }
  return out;
}

// Quantise a float piece into dst[off..] as bytes; returns {norm, mean}
// where norm is the length of the mean-removed (per channel) quantised piece.
export function quantizeInto(vals, C, dst, off) {
  const RR = vals.length / C, mean = new Float32Array(C);
  let n2 = 0;
  for (let c = 0; c < C; c++) {
    let s = 0, ss = 0;
    for (let p = 0; p < RR; p++) {
      const v = vals[c * RR + p], q = Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
      dst[off + c * RR + p] = q;
      const f = q / 255;
      s += f; ss += f * f;
    }
    mean[c] = s / RR;
    n2 += ss - RR * mean[c] * mean[c];
  }
  return { norm: Math.sqrt(Math.max(n2, 0)), mean };
}

// The exact bytes a piece has in the pool (used to rebuild shared recipes).
export function atomBytes(src, x, y, s, o, R, C) {
  const vals = makeAtom(src, x, y, s, o, R, C, new Float32Array(C * R * R));
  const u8 = new Uint8Array(C * R * R);
  const { mean, norm } = quantizeInto(vals, C, u8, 0);
  return { u8, mean, norm };
}

/* ------------------------------------------------------------ candidate pool */
export class PoolBuilder {
  // weights: how often each source is picked (default: by area, capped at 512 x 512)
  constructor({ sources, count, C, seed = 1, weights = null }) {
    Object.assign(this, { sources, count, C, D: C * NN, done: 0 });
    this.pool = new Uint8Array(count * this.D);
    this.norms = new Float32Array(count);
    this.params = new Int32Array(count * 5); // source index, x, y, s, orient
    this.rand = mulberry32(seed);
    const wts = weights || sources.map((s) => Math.min(Math.min(s.w, s.h), 512) ** 2);
    const tot = wts.reduce((a, b) => a + b, 0);
    let acc = 0;
    this.cum = wts.map((w) => (acc += w / tot));
    this.tmp = new Float32Array(this.D);
    this.scratch = new Float32Array(3 * NN);
  }

  step(n) { // build up to n more pieces; true when finished
    const end = Math.min(this.count, this.done + n);
    while (this.done < end) this._one(this.done++);
    return this.done >= this.count;
  }

  _one(slot) {
    const rand = this.rand;
    for (let attempt = 0; attempt < 20; attempt++) {
      const r = rand();
      let si = 0;
      while (si < this.cum.length - 1 && r > this.cum[si]) si++;
      const src = this.sources[si], ms = Math.min(src.w, src.h);
      const s = ms <= MIN_CROP ? ms : MIN_CROP + Math.floor(rand() * (ms - MIN_CROP + 1));
      const x = Math.floor(rand() * (src.w - s + 1)), y = Math.floor(rand() * (src.h - s + 1));
      const o = Math.floor(rand() * 8);
      makeAtom(src, x, y, s, o, N, this.C, this.tmp, this.scratch);
      const { norm } = quantizeInto(this.tmp, this.C, this.pool, slot * this.D);
      if (norm >= MIN_NORM || attempt === 19) {
        this.norms[slot] = Math.max(norm, 1e-6);
        this.params.set([si, x, y, s, o], slot * 5);
        return;
      }
    }
  }
}

/* ------------------------------------------------------------ scoring (worker) */
// Best unused piece for residual res (mean-zero per channel):
// score_j = <piece_j, res> / ||piece_j - mean||.  Since res has zero mean per
// channel, the raw dot product equals the mean-removed one.
export function scoreBest(pool, norms, used, D, res) {
  let best = -1, bestScore = -Infinity;
  for (let j = 0, n = norms.length; j < n; j++) {
    if (used[j]) continue;
    const o = j * D;
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
    for (let i = 0; i < D; i += 4) {
      s0 += pool[o + i] * res[i];
      s1 += pool[o + i + 1] * res[i + 1];
      s2 += pool[o + i + 2] * res[i + 2];
      s3 += pool[o + i + 3] * res[i + 3];
    }
    const sc = (s0 + s1 + s2 + s3) / (255 * norms[j]);
    if (sc > bestScore) { bestScore = sc; best = j; }
  }
  return { best, score: bestScore };
}

/* ------------------------------------------------------------ fitting */
// Greedy non-negative pursuit state: add pieces one at a time; after each add
// all weights are re-solved together (non-negative least squares by
// coordinate descent on the Gram matrix, warm-started).
export class Fitter {
  constructor(target, C, Kmax) {
    const D = target.length, RR = D / C;
    Object.assign(this, { D, C, RR, Kmax, k: 0 });
    this.tmean = new Float64Array(C);
    this.tc = new Float64Array(D);
    for (let c = 0; c < C; c++) {
      let s = 0;
      for (let p = 0; p < RR; p++) s += target[c * RR + p];
      this.tmean[c] = s / RR;
      for (let p = 0; p < RR; p++) this.tc[c * RR + p] = target[c * RR + p] - this.tmean[c];
    }
    this.tnorm = Math.sqrt(this.tc.reduce((a, v) => a + v * v, 0));
    this.atoms = [];          // mean-removed pieces (Float32Array D)
    this.means = [];          // per-channel means of each piece
    this.G = new Float64Array(Kmax * Kmax);
    this.b = new Float64Array(Kmax);
    this.w = new Float64Array(Kmax);
    this.res = Float64Array.from(this.tc);
    this.sweeps = 0;
  }

  add(u8) {
    const { D, C, RR, Kmax, G, b, w } = this, k = this.k;
    if (k >= Kmax) throw new Error("Fitter full");
    const a = new Float32Array(D), mean = new Float32Array(C);
    for (let c = 0; c < C; c++) {
      let s = 0;
      for (let p = 0; p < RR; p++) s += u8[c * RR + p];
      mean[c] = s / RR / 255;
      for (let p = 0; p < RR; p++) a[c * RR + p] = u8[c * RR + p] / 255 - mean[c];
    }
    for (let i = 0; i < k; i++) {
      const g = dot(a, this.atoms[i]);
      G[k * Kmax + i] = g;
      G[i * Kmax + k] = g;
    }
    G[k * Kmax + k] = dot(a, a);
    b[k] = dot(a, this.tc);
    this.atoms.push(a);
    this.means.push(mean);
    this.k = k + 1;
    let g = b[k];
    for (let i = 0; i < k; i++) g -= G[k * Kmax + i] * w[i];
    w[k] = Math.max(0, g / G[k * Kmax + k]);
    this.solve();
    this.updateResidual();
  }

  solve(maxSweeps = 400) {
    const { k, Kmax, G, b, w } = this, grad = new Float64Array(k);
    for (let i = 0; i < k; i++) {
      let g = b[i];
      const row = i * Kmax;
      for (let j = 0; j < k; j++) g -= G[row + j] * w[j];
      grad[i] = g;
    }
    const tol = 1e-6 * this.tnorm;
    for (let sweep = 0; sweep < maxSweeps; sweep++) {
      let maxCh = 0;
      for (let i = 0; i < k; i++) {
        const gii = G[i * Kmax + i], nw = Math.max(0, w[i] + grad[i] / gii), d = nw - w[i];
        if (d !== 0) {
          w[i] = nw;
          const row = i * Kmax;
          for (let j = 0; j < k; j++) grad[j] -= G[row + j] * d;
          const ch = Math.abs(d) * Math.sqrt(gii);
          if (ch > maxCh) maxCh = ch;
        }
      }
      this.sweeps++;
      if (maxCh < tol) break;
    }
  }

  updateResidual() {
    const { D, k, w, res, tc } = this;
    res.set(tc);
    for (let i = 0; i < k; i++) {
      const wi = w[i];
      if (wi === 0) continue;
      const a = this.atoms[i];
      for (let p = 0; p < D; p++) res[p] -= wi * a[p];
    }
  }

  residualF32() { return Float32Array.from(this.res); }

  // current picture: target - residual = sum w (piece - mean) + target mean
  reconstruction() {
    const { D, C, RR } = this, out = new Float32Array(D);
    for (let c = 0; c < C; c++) {
      for (let p = 0; p < RR; p++) out[c * RR + p] = this.tc[c * RR + p] - this.res[c * RR + p] + this.tmean[c];
    }
    return out;
  }
}

export function dot(a, b) {
  let s0 = 0, s1 = 0;
  const n = a.length;
  let i = 0;
  for (; i + 1 < n; i += 2) { s0 += a[i] * b[i]; s1 += a[i + 1] * b[i + 1]; }
  if (i < n) s0 += a[i] * b[i];
  return s0 + s1;
}

/* ------------------------------------------------------------ rendering */
// pieces: [{u8: Uint8Array(C*R*R), mean: Float32Array(C)}]
// Returns sum_i<k weights[i] * (piece_i - mean_i) + tmean, optionally
// rescaled so its contrast (std) equals `matchStd` (used for replays, where
// partial sums use the final weights). With raw=true returns the plain sum
// of light, sum_i weights[i] * piece_i.
export function renderSum(pieces, weights, k, C, R, tmean, { matchStd = 0, raw = false } = {}) {
  const RR = R * R, D = C * RR, acc = new Float32Array(D), off = new Float64Array(C);
  for (let i = 0; i < k; i++) {
    const wi = weights[i];
    if (!wi) continue;
    const f = wi / 255, u = pieces[i].u8;
    for (let p = 0; p < D; p++) acc[p] += f * u[p];
    for (let c = 0; c < C; c++) off[c] += wi * pieces[i].mean[c];
  }
  if (raw) return acc;
  for (let c = 0; c < C; c++) for (let p = 0; p < RR; p++) acc[c * RR + p] -= off[c];
  if (matchStd > 0) {
    let ss = 0;
    for (let p = 0; p < D; p++) ss += acc[p] * acc[p];
    const sd = Math.sqrt(ss / D);
    if (sd > 1e-9) {
      const f = Math.min(matchStd / sd, 50);
      for (let p = 0; p < D; p++) acc[p] *= f;
    }
  }
  for (let c = 0; c < C; c++) for (let p = 0; p < RR; p++) acc[c * RR + p] += tmean[c];
  return acc;
}

export function stdOf(vec, C, tmean) {
  const RR = vec.length / C;
  let ss = 0;
  for (let c = 0; c < C; c++) for (let p = 0; p < RR; p++) { const v = vec[c * RR + p] - tmean[c]; ss += v * v; }
  return Math.sqrt(ss / vec.length);
}

// Float picture (C channels, channel-major, 0..1) -> RGBA bytes.
// scale lets the raw light sum be shown divided by its maximum.
export function toRGBA(vec, C, R, out = new Uint8ClampedArray(R * R * 4), scale = 1) {
  const RR = R * R;
  for (let p = 0; p < RR; p++) {
    const r = vec[p] * scale, g = (C === 3 ? vec[RR + p] : vec[p]) * scale, b = (C === 3 ? vec[2 * RR + p] : vec[p]) * scale;
    out[4 * p] = r * 255; out[4 * p + 1] = g * 255; out[4 * p + 2] = b * 255; out[4 * p + 3] = 255;
  }
  return out;
}

/* ------------------------------------------------------------ share recipes */
// Binary, little-endian:
//   u8 version | u8 flags (bit 0: colour) | u16 count | f32 tmean[C] | count x piece
//   version 2 piece: u8 image or map id, u8 zoom, u16 tile x, u16 tile y,
//                    u16 x, u16 y, u16 size, u8 orient, f32 weight
//     (for a plain image, zoom and tile are 0 and x, y, size are in the image;
//      for a map, x, y, size are inside tile (zoom, tile x, tile y))
//   version 1 piece: u8 image id, u16 x, u16 y, u16 size, u8 orient, f32 weight
// Holds only which crops of the public images were used and how bright -
// never the photo itself.
export const RECIPE_VERSION = 2;
const PIECE_BYTES = { 1: 12, 2: 17 };

export function encodeRecipe({ C, tmean, pieces }) {
  const buf = new ArrayBuffer(4 + 4 * C + PIECE_BYTES[2] * pieces.length), dv = new DataView(buf);
  dv.setUint8(0, RECIPE_VERSION);
  dv.setUint8(1, C === 3 ? 1 : 0);
  dv.setUint16(2, pieces.length, true);
  for (let c = 0; c < C; c++) dv.setFloat32(4 + 4 * c, tmean[c], true);
  let o = 4 + 4 * C;
  for (const p of pieces) {
    dv.setUint8(o, p.img); dv.setUint8(o + 1, p.z || 0); dv.setUint16(o + 2, p.tx || 0, true); dv.setUint16(o + 4, p.ty || 0, true);
    dv.setUint16(o + 6, p.x, true); dv.setUint16(o + 8, p.y, true); dv.setUint16(o + 10, p.s, true);
    dv.setUint8(o + 12, p.o); dv.setFloat32(o + 13, p.w, true);
    o += PIECE_BYTES[2];
  }
  return b64urlEncode(new Uint8Array(buf));
}

export function decodeRecipe(str) {
  const bytes = b64urlDecode(str), dv = new DataView(bytes.buffer);
  const version = bytes.length >= 4 ? dv.getUint8(0) : 0;
  if (!PIECE_BYTES[version]) throw new Error("Unknown recipe version");
  const C = dv.getUint8(1) & 1 ? 3 : 1, count = dv.getUint16(2, true), pb = PIECE_BYTES[version];
  if (bytes.length !== 4 + 4 * C + pb * count || count > 2000) throw new Error("Malformed recipe");
  const tmean = Array.from({ length: C }, (_, c) => dv.getFloat32(4 + 4 * c, true));
  const pieces = [];
  let o = 4 + 4 * C;
  for (let i = 0; i < count; i++, o += pb) {
    pieces.push(version === 1
      ? { img: dv.getUint8(o), z: 0, tx: 0, ty: 0, x: dv.getUint16(o + 1, true), y: dv.getUint16(o + 3, true),
          s: dv.getUint16(o + 5, true), o: dv.getUint8(o + 7) & 7, w: dv.getFloat32(o + 8, true) }
      : { img: dv.getUint8(o), z: dv.getUint8(o + 1), tx: dv.getUint16(o + 2, true), ty: dv.getUint16(o + 4, true),
          x: dv.getUint16(o + 6, true), y: dv.getUint16(o + 8, true), s: dv.getUint16(o + 10, true),
          o: dv.getUint8(o + 12) & 7, w: dv.getFloat32(o + 13, true) });
  }
  if (!tmean.every(Number.isFinite) || !pieces.every((p) => Number.isFinite(p.w) && p.w >= 0)) {
    throw new Error("Malformed recipe");
  }
  return { C, tmean, pieces };
}

function b64urlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
