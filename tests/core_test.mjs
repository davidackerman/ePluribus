// Node test of web/core.js: fit quality, speed, and share-recipe round trip.
// Usage: node tests/core_test.mjs RAW_DIR [C=3] [POOL=10000] [K=300]
//   (RAW_DIR from: python tests/dump_raw.py RAW_DIR)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  N, makeSource, resampleCrop, PoolBuilder, scoreBest, Fitter, atomBytes,
  renderSum, encodeRecipe, decodeRecipe,
} from "../web/core.js";

const [dir, C_ = "3", POOL_ = "10000", K_ = "300"] = process.argv.slice(2);
const C = +C_, POOL = +POOL_, K = +K_;
const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
const load = (key) => makeSource(key, meta[key].w, meta[key].h, new Uint8Array(readFileSync(join(dir, `${key}.rgb`))));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failures++; };

// same five sources as the Python colour test
const ids = [0, 1, 2, 3, 5];
const sources = ids.map((id) => load(String(id)));

// target: astronaut face crop, as in experiments/
const astro = load("astronaut");
const rgb = resampleCrop(astro, 155, 15, 200, N, new Float32Array(3 * N * N));
const RR = N * N, t = new Float32Array(C * RR);
if (C === 3) t.set(rgb);
else for (let p = 0; p < RR; p++) t[p] = 0.2125 * rgb[p] + 0.7154 * rgb[RR + p] + 0.0721 * rgb[2 * RR + p];

let t0 = performance.now();
const pb = new PoolBuilder({ sources, count: POOL, C, seed: 1 });
pb.step(POOL);
console.log(`pool: ${POOL} pieces (C=${C}) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const D = C * RR, used = new Uint8Array(POOL), fit = new Fitter(t, C, K), order = [];
const corr = () => {
  const rec = fit.reconstruction();
  let num = 0, a2 = 0, b2 = 0;
  for (let c = 0; c < C; c++) {
    for (let p = 0; p < RR; p++) {
      const a = rec[c * RR + p] - fit.tmean[c], b = fit.tc[c * RR + p];
      num += a * b; a2 += a * a; b2 += b * b;
    }
  }
  return num / Math.sqrt(a2 * b2);
};
t0 = performance.now();
let tScore = 0, tFit = 0;
const snaps = {};
for (let k = 0; k < K; k++) {
  const s0 = performance.now();
  const { best, score } = scoreBest(pb.pool, pb.norms, used, D, fit.residualF32());
  const s1 = performance.now();
  if (!(score > 1e-9)) { console.log(`stalled at ${k}`); break; }
  used[best] = 1;
  order.push(best);
  fit.add(pb.pool.subarray(best * D, (best + 1) * D));
  tScore += s1 - s0;
  tFit += performance.now() - s1;
  if ([30, 100, 300].includes(k + 1)) snaps[k + 1] = corr();
}
console.log(`fit: ${fit.k} pieces in ${((performance.now() - t0) / 1000).toFixed(1)}s ` +
  `(scoring ${(tScore / 1000).toFixed(1)}s single-threaded, weights+residual ${(tFit / 1000).toFixed(1)}s, ` +
  `${(fit.sweeps / fit.k).toFixed(1)} sweeps/step)`);
for (const [k, r] of Object.entries(snaps)) console.log(`  corr at ${k}: ${r.toFixed(3)}`);
const pyRef = C === 3 ? 0.972 : 0.978;
check(snaps[300] > pyRef - 0.01, `corr at 300 (${snaps[300]?.toFixed(3)}) within 0.01 of Python (${pyRef})`);

// ---- recipe round trip: rebuild from crop parameters only, compare pictures
const pieces = order.map((j, i) => {
  const [si, x, y, s, o] = pb.params.subarray(j * 5, j * 5 + 5);
  return { img: ids[si], x, y, s, o, w: fit.w[i] };
});
const code = encodeRecipe({ C, tmean: Array.from(fit.tmean), pieces });
const dec = decodeRecipe(code);
console.log(`recipe: ${pieces.length} pieces -> ${code.length} characters`);
check(dec.pieces.length === pieces.length && dec.C === C, "recipe decodes to the same piece count and colour mode");
const byId = Object.fromEntries(ids.map((id, i) => [id, sources[i]]));
const rebuilt = dec.pieces.map((p) => atomBytes(byId[p.img], p.x, p.y, p.s, p.o, N, C));
const same = rebuilt.every((a, i) => {
  const j = order[i], orig = pb.pool.subarray(j * D, (j + 1) * D);
  for (let p = 0; p < D; p++) if (a.u8[p] !== orig[p]) return false;
  return true;
});
check(same, "every rebuilt piece is byte-identical to the pool piece");
const fromRecipe = renderSum(rebuilt, dec.pieces.map((p) => p.w), dec.pieces.length, C, N, dec.tmean);
const direct = fit.reconstruction();
let maxDiff = 0;
for (let p = 0; p < D; p++) maxDiff = Math.max(maxDiff, Math.abs(fromRecipe[p] - direct[p]));
check(maxDiff < 1e-4, `picture rebuilt from the recipe matches the fit (max diff ${maxDiff.toExponential(1)})`);

// ---- neutral mode: one black level for all channels (colour only from the images)
if (C === 3) {
  const pbN = new PoolBuilder({ sources, count: 3000, C, seed: 2, neutral: true });
  pbN.step(3000);
  const usedN = new Uint8Array(3000), fitN = new Fitter(t, C, 60, { neutral: true }), orderN = [];
  for (let k = 0; k < 60; k++) {
    const { best, score } = scoreBest(pbN.pool, pbN.norms, usedN, D, fitN.residualF32());
    if (!(score > 1e-9)) break;
    usedN[best] = 1;
    orderN.push(best);
    fitN.add(pbN.pool.subarray(best * D, (best + 1) * D));
  }
  check(fitN.tmean[0] === fitN.tmean[1] && fitN.tmean[1] === fitN.tmean[2], "neutral fit: the same black level in every channel (no tint)");
  const piecesN = orderN.map((j, i) => {
    const [si, x, y, s, o] = pbN.params.subarray(j * 5, j * 5 + 5);
    return { img: ids[si], x, y, s, o, w: fitN.w[i] };
  });
  const decN = decodeRecipe(encodeRecipe({ C, tmean: Array.from(fitN.tmean), pieces: piecesN, neutral: true }));
  check(decN.neutral === true && dec.neutral === false, "recipes carry the neutral flag (and old-style ones read as not neutral)");
  const rebuiltN = decN.pieces.map((p) => atomBytes(byId[p.img], p.x, p.y, p.s, p.o, N, C, true));
  const picN = renderSum(rebuiltN, decN.pieces.map((p) => p.w), decN.pieces.length, C, N, decN.tmean), directN = fitN.reconstruction();
  let maxN = 0;
  for (let p = 0; p < D; p++) maxN = Math.max(maxN, Math.abs(picN[p] - directN[p]));
  check(maxN < 1e-4, `neutral picture rebuilt from its recipe matches the fit (max diff ${maxN.toExponential(1)})`);
}

// ---- harder settings: big crops only, no turning
{
  const pbH = new PoolBuilder({ sources, count: 1500, C, seed: 3, minFrac: 0.5, rotate: false });
  pbH.step(1500);
  let ok = pbH.done > 0;
  for (let j = 0; j < pbH.done; j++) {
    const [si, , , s, o] = pbH.params.subarray(j * 5, j * 5 + 5), src = sources[si];
    if (o !== 0 || s < Math.min(Math.round(0.5 * Math.min(src.w, src.h)), Math.min(src.w, src.h))) ok = false;
  }
  check(ok, `minFrac 0.5 + no turning: all ${pbH.done} crops are at least half their image and upright`);
  const one = new PoolBuilder({ sources: [sources[1]], count: 50, C, seed: 4, minFrac: 1, rotate: false });
  one.step(50);
  check(one.exhausted && one.done === 1, `whole image only + no turning, one square image: exactly ${one.done} distinct piece (no duplicates)`);
}

// pieces of live sets carry an item (which image, and more); others don't pay for it
{
  const live = [
    { img: 3, z: 0, tx: 0, ty: 0, x: 10, y: 20, s: 64, o: 5, w: 0.25 },
    { img: 204, item: 37, z: 4, tx: 12, ty: 9, x: 1, y: 2, s: 200, o: 0, w: 1.5 },
    { img: 206, item: 69 * 256 + 3, z: 2, tx: 7, ty: 1, x: 0, y: 5, s: 90, o: 7, w: 0.75 },
    { img: 200, z: 8, tx: 300, ty: 100, x: 3, y: 4, s: 32, o: 2, w: 2 },
  ];
  const codeL = encodeRecipe({ C: 3, tmean: [0.1, 0.2, 0.3], pieces: live });
  const decL = decodeRecipe(codeL);
  const same = decL.pieces.every((p, i) => ["img", "z", "tx", "ty", "x", "y", "s", "o", "w"].every((k) => p[k] === live[i][k]) && p.item === (live[i].item || 0));
  check(same, "live-set items round-trip (and pieces without one read as item 0)");
  const bytes = Math.ceil(((4 + 12 + 4 * 17 + 2 * 4) * 4) / 3);
  check(codeL.length === bytes, `only the two set pieces carry the extra 4 bytes (${codeL.length} characters)`);
}

// malformed recipes must be rejected, not crash
let rejected = 0;
for (const bad of ["", "AAAA", code.slice(0, -7), code + "AAAA", "!!!!"]) { try { decodeRecipe(bad); } catch { rejected++; } }
check(rejected === 5, "malformed recipes are rejected");
process.exit(failures ? 1 : 0);
