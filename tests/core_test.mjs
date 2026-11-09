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

// malformed recipes must be rejected, not crash
let rejected = 0;
for (const bad of ["", "AAAA", code.slice(0, -7), "!!!!"]) { try { decodeRecipe(bad); } catch { rejected++; } }
check(rejected === 4, "malformed recipes are rejected");
process.exit(failures ? 1 : 0);
