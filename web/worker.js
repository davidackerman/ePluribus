// Scoring worker: holds one slice of the candidate pool and, for each
// residual it is sent, returns its best unused piece (and that piece's bytes).
import { scoreBest } from "./core.js";

let pool, norms, used, D;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    ({ pool, norms, D } = m);
    used = new Uint8Array(norms.length);
    self.postMessage({ type: "ready" });
  } else if (m.type === "score") {
    if (m.mark >= 0) used[m.mark] = 1;
    const { best, score } = scoreBest(pool, norms, used, D, m.res);
    const vec = best >= 0 ? pool.slice(best * D, (best + 1) * D) : null;
    self.postMessage({ type: "scored", best, score, vec }, vec ? [vec.buffer] : []);
  }
};
