// app.js - the page: pick a picture, pick image packs, build, scrub, share.
// Everything runs in the browser. The photo is never uploaded; share links
// carry only crop positions and brightnesses (see encodeRecipe in core.js).
import {
  N, makeSource, resampleCrop, PoolBuilder, Fitter, atomBytes, renderSum, stdOf, toRGBA,
  encodeRecipe, decodeRecipe, mulberry32,
} from "./core.js";
import { encodeGif } from "./gif.js";
import { openMap, gatherTiles, fetchTile, fetchDecoys, mapLimit } from "./maps.js";
import { findStore, storeRecipe, loadRecipe } from "./share.js";
import { startStats, track } from "./stats.js";

const CORESAMPLE = "https://davidackerman.github.io/coresample/";

const $ = (id) => document.getElementById(id);
const HI = 256;          // display resolution once a build is finished
const DL = 512;          // download resolution
const MAX_SIDE = 1024;   // photos and own images are scaled down to this
const LUMA = [0.2125, 0.7154, 0.0721];
const TILE_BUDGET = 320; // random map tiles fetched per build, shared by the selected maps
const MAX_PER_PACK = 4;  // bundled images used per pack per build (a random few: fresh mix, small download)
const SAMPLES = {
  mona: { url: "samples/mona.jpg", crop: { x: 117, y: 67, s: 367 } },
  astronaut: { url: "samples/astronaut.jpg", crop: { x: 155, y: 15, s: 200 } },
  cat: { url: "samples/cat.jpg", crop: { x: 100, y: 10, s: 270 } },
};
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  catalog: null,
  byId: new Map(),
  mapById: new Map(),
  familyByImg: new Map(), // bundled image id -> short name, as in "37% Mars"
  store: "",              // short-link store ("" = none)
  selected: new Set(),    // pack ids; everything is on by default (see init)
  tab: "all",
  own: [],
  ownCounter: 0,
  target: null,     // { src, w, h, canvas, crop: {x, y, s} }
  cache: new Map(), // catalog image id -> Promise<source>
  run: null,
  busy: false,
};

/* ------------------------------------------------------------ images */
function bitmapToRGB(bmp, maxSide) {
  const f = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * f)), h = Math.max(1, Math.round(bmp.height * f));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data, rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { rgb[j] = d[i]; rgb[j + 1] = d[i + 1]; rgb[j + 2] = d[i + 2]; }
  return { w, h, rgb, canvas };
}

async function fetchBitmap(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`couldn't load ${url}`);
  return createImageBitmap(await r.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
}

function catalogSource(id) {
  if (!state.cache.has(id)) {
    const im = state.byId.get(id);
    state.cache.set(id, fetchBitmap("packs/" + im.file).then((bmp) => {
      const { w, h, rgb } = bitmapToRGB(bmp, Infinity);
      return Object.assign(makeSource("img:" + id, w, h, rgb), { imgId: id, title: im.title });
    }));
  }
  return state.cache.get(id);
}

const selectedPacks = () => state.catalog.packs.filter((p) => state.selected.has(p.id));

// A map tile becomes a small source image; pieces are full-frame crops of it.
function tileSource(spec, t) {
  return Object.assign(makeSource(`map:${spec.id}:${t.z}/${t.x}/${t.y}`, t.w, t.h, t.rgb),
    { mapId: spec.id, z: t.z, tx: t.x, ty: t.y, title: `${spec.name}, zoom ${t.z}` });
}

// Every selected pack (and the user's own images) gets an equal share of the candidates;
// within a pack, bigger images get more.
async function gatherSources(run) {
  const groups = [], seenImg = new Set(), packs = selectedPacks(), rand = mulberry32((Math.random() * 2 ** 31) | 0);
  const local = packs.filter((q) => !q.map);
  for (const [pi, p] of local.entries()) {
    const ids = p.images.filter((i) => !seenImg.has(i));
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    const use = ids.slice(0, MAX_PER_PACK);
    use.forEach((i) => seenImg.add(i));
    setStatus(`Loading ${p.name}\u2026`);
    setProgress((pi / local.length) * 0.03);
    if (use.length) groups.push(await Promise.all(use.map(catalogSource)));
  }
  const maps = packs.filter((q) => q.map != null);
  const perMap = Math.max(40, Math.round(TILE_BUDGET / Math.max(1, maps.length)));
  for (const [mi, p] of maps.entries()) {
    const spec = state.mapById.get(p.map);
    setStatus(`Opening ${spec.name}…`);
    const map = await openMap(spec);
    const tiles = await gatherTiles(map, perMap, rand, {
      cancelled: () => run.cancelled,
      onProgress: (k) => {
        setStatus(`Fetching random pieces of ${spec.name} (${mi + 1} of ${maps.length} maps): ${k} of ${perMap}`);
        setProgress(((mi + k / perMap) / maps.length) * 0.08);
      },
    });
    if (run.cancelled) throw new Error("stopped");
    if (tiles.length) groups.push(tiles.map((t) => tileSource(spec, t)));
  }
  if (state.own.length) groups.push(state.own.map((o) => o.src));
  const sources = groups.flat();
  if (!sources.length) throw new Error("none of the images could be loaded");
  const weights = groups.flatMap((g) => {
    const a = g.map((s) => Math.min(Math.min(s.w, s.h), 512) ** 2), tot = a.reduce((x, y) => x + y, 0);
    return a.map((v) => v / tot / groups.length);
  });
  return { sources, weights };
}

/* ------------------------------------------------------------ drawing */
function drawFloat(canvas, vec, C, R, scale = 1) {
  if (canvas.width !== R) { canvas.width = R; canvas.height = R; }
  const ctx = canvas.getContext("2d"), img = ctx.createImageData(R, R);
  toRGBA(vec, C, R, img.data, scale);
  ctx.putImageData(img, 0, 0);
}

function drawBytes(canvas, u8, C, R) {
  const f = new Float32Array(u8.length);
  for (let i = 0; i < u8.length; i++) f[i] = u8[i] / 255;
  drawFloat(canvas, f, C, R);
}

const setStatus = (t) => { $("status").textContent = t; };
const setProgress = (f) => { $("progressBar").style.width = `${Math.round(f * 100)}%`; };

/* ------------------------------------------------------------ step 1: picture + crop */
async function setTarget(bmp, preset) {
  const { w, h, rgb, canvas } = bitmapToRGB(bmp, MAX_SIDE);
  const ms = Math.min(w, h);
  const crop = preset && preset.x + preset.s <= w && preset.y + preset.s <= h
    ? { ...preset }
    : { s: Math.round(ms * 0.6), x: Math.round((w - ms * 0.6) / 2), y: Math.round((h - ms * 0.6) / 2) };
  state.target = { src: makeSource("target", w, h, rgb), w, h, canvas, crop };
  $("cropSize").value = String(Math.round((crop.s / ms) * 100));
  $("cropArea").hidden = false;
  scheduleCrop();
  updateBuildButton();
}

function clampCrop() {
  const T = state.target, c = T.crop, ms = Math.min(T.w, T.h);
  c.s = Math.max(16, Math.min(ms, Math.round(c.s)));
  c.x = Math.max(0, Math.min(T.w - c.s, Math.round(c.x)));
  c.y = Math.max(0, Math.min(T.h - c.s, Math.round(c.y)));
}

function drawCrop() {
  const T = state.target, cv = $("cropCanvas");
  const cssW = cv.parentElement.clientWidth || 480, dpr = window.devicePixelRatio || 1;
  const k = (cssW / T.w) * dpr;
  cv.width = Math.round(T.w * k);
  cv.height = Math.round(T.h * k);
  const ctx = cv.getContext("2d");
  ctx.drawImage(T.canvas, 0, 0, cv.width, cv.height);
  const { x, y, s } = T.crop;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, cv.width, y * k);
  ctx.fillRect(0, (y + s) * k, cv.width, cv.height - (y + s) * k);
  ctx.fillRect(0, y * k, x * k, s * k);
  ctx.fillRect((x + s) * k, y * k, cv.width - (x + s) * k, s * k);
  ctx.strokeStyle = "#ffb86b";
  ctx.lineWidth = 2 * dpr;
  ctx.strokeRect(x * k, y * k, s * k, s * k);
}

function targetVec(C) {
  const T = state.target, { x, y, s } = T.crop;
  const rgb = resampleCrop(T.src, x, y, s, N, new Float32Array(3 * N * N));
  if (C === 3) return rgb;
  const RR = N * N, out = new Float32Array(RR);
  for (let p = 0; p < RR; p++) out[p] = LUMA[0] * rgb[p] + LUMA[1] * rgb[RR + p] + LUMA[2] * rgb[2 * RR + p];
  return out;
}

let cropPending = false;
function scheduleCrop() {
  if (cropPending || !state.target) return;
  cropPending = true;
  requestAnimationFrame(() => {
    cropPending = false;
    drawCrop();
    const C = $("colourInput").checked ? 3 : 1;
    drawFloat($("targetPreview"), targetVec(C), C, N);
  });
}

function wireCrop() {
  const cv = $("cropCanvas");
  let drag = null;
  const imgPt = (e) => {
    const r = cv.getBoundingClientRect(), T = state.target;
    return { x: ((e.clientX - r.left) / r.width) * T.w, y: ((e.clientY - r.top) / r.height) * T.h };
  };
  cv.addEventListener("pointerdown", (e) => {
    if (!state.target) return;
    const p = imgPt(e), c = state.target.crop;
    if (p.x < c.x || p.x > c.x + c.s || p.y < c.y || p.y > c.y + c.s) {
      c.x = p.x - c.s / 2;
      c.y = p.y - c.s / 2;
      clampCrop();
    }
    drag = { dx: p.x - c.x, dy: p.y - c.y };
    cv.setPointerCapture(e.pointerId);
    scheduleCrop();
  });
  cv.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = imgPt(e), c = state.target.crop;
    c.x = p.x - drag.dx;
    c.y = p.y - drag.dy;
    clampCrop();
    scheduleCrop();
  });
  const end = () => { drag = null; };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  $("cropSize").addEventListener("input", (e) => {
    const T = state.target;
    if (!T) return;
    const c = T.crop, cx = c.x + c.s / 2, cy = c.y + c.s / 2;
    c.s = (+e.target.value / 100) * Math.min(T.w, T.h);
    c.x = cx - c.s / 2;
    c.y = cy - c.s / 2;
    clampCrop();
    scheduleCrop();
  });
  window.addEventListener("resize", scheduleCrop);
}

// A picture from the upload button, a drop or a paste becomes the target.
async function useTargetFile(file) {
  try {
    await setTarget(await createImageBitmap(file));
    $("cropArea").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch {
    alert("Sorry, that file couldn't be read as an image.");
  }
}

// Drag a picture anywhere onto the page (or paste one) to use it; drop onto "Add your own
// images" to add source images instead. Not while playing a shared link.
function wireDrop() {
  const overlay = $("dropOverlay"), own = $("ownZone");
  let depth = 0;
  const active = (e) => !document.body.classList.contains("replaying") && [...(e.dataTransfer?.types || [])].includes("Files");
  const reset = () => { depth = 0; overlay.hidden = true; own.classList.remove("dropping"); };
  window.addEventListener("dragenter", (e) => {
    if (!active(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener("dragover", (e) => {
    if (!active(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const overOwn = !!e.target.closest?.("#ownZone");
    overlay.classList.toggle("own", overOwn);
    own.classList.toggle("dropping", overOwn);
  });
  window.addEventListener("dragleave", (e) => { if (active(e) && --depth <= 0) reset(); });
  window.addEventListener("drop", (e) => {
    if (!active(e)) return;
    e.preventDefault();
    const toOwn = !!e.target.closest?.("#ownZone");
    reset();
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) { alert("That doesn't look like a picture."); return; }
    if (toOwn) addOwnImages(files);
    else useTargetFile(files[0]);
  });
  window.addEventListener("paste", (e) => {
    if (document.body.classList.contains("replaying")) return;
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/"));
    if (!f) return;
    e.preventDefault();
    useTargetFile(f);
  });
}

/* ------------------------------------------------------------ step 2: sources */
function renderTabs() {
  const bar = $("packTabs");
  bar.replaceChildren();
  for (const t of [{ id: "all", name: "All" }, ...(state.catalog.tabs || [])]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab";
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(state.tab === t.id));
    const inTab = state.catalog.packs.filter((p) => t.id === "all" || p.tab === t.id);
    const on = inTab.filter((p) => state.selected.has(p.id)).length;
    const count = document.createElement("span");
    count.textContent = `${on}/${inTab.length}`;
    b.append(t.name, " ", count);
    b.addEventListener("click", () => { state.tab = t.id; renderPacks(); });
    bar.append(b);
  }
  const tabPacks = state.catalog.packs.filter((p) => state.tab === "all" || p.tab === state.tab);
  const allOn = tabPacks.every((p) => state.selected.has(p.id));
  const toggle = $("packAll");
  toggle.textContent = allOn ? "Switch these off" : "Switch these on";
  toggle.onclick = () => {
    for (const p of tabPacks) { if (allOn) state.selected.delete(p.id); else state.selected.add(p.id); }
    renderPacks();
    updateBuildButton();
  };
  const total = state.catalog.packs.length, on = state.selected.size;
  $("packSummary").textContent = on === total ? `All ${total} packs are on. Tap any to switch it off.` : `${on} of ${total} packs on.`;
}

function renderPacks() {
  renderTabs();
  const grid = $("packGrid");
  grid.replaceChildren();
  for (const p of state.catalog.packs.filter((q) => state.tab === "all" || q.tab === state.tab)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pack";
    b.setAttribute("aria-pressed", String(state.selected.has(p.id)));
    const thumbs = document.createElement("div");
    thumbs.className = "thumbs";
    const thumbFiles = p.map != null ? [state.mapById.get(p.map).thumb] : p.images.slice(0, 3).map((id) => state.byId.get(id).thumb);
    for (const f of thumbFiles) {
      const img = document.createElement("img");
      img.src = "packs/" + f;
      img.alt = "";
      thumbs.append(img);
    }
    const name = document.createElement("b"), blurb = document.createElement("span");
    name.textContent = p.name;
    blurb.textContent = p.map != null ? `${p.blurb} · live map`
      : `${p.blurb} · ${p.images.length} image${p.images.length > 1 ? "s" : ""}`;
    b.append(thumbs, name, blurb);
    b.addEventListener("click", () => {
      if (state.selected.has(p.id)) state.selected.delete(p.id); else state.selected.add(p.id);
      b.setAttribute("aria-pressed", String(state.selected.has(p.id)));
      renderTabs();
      updateBuildButton();
    });
    grid.append(b);
  }
}

async function addOwnImages(files) {
  for (const file of files) {
    try {
      const bmp = await createImageBitmap(file);
      const { w, h, rgb, canvas } = bitmapToRGB(bmp, MAX_SIDE);
      if (Math.min(w, h) < 32) continue;
      const key = "own:" + ++state.ownCounter;
      const src = Object.assign(makeSource(key, w, h, rgb), { title: `Your image (${file.name})`, own: true });
      const th = document.createElement("canvas");
      th.width = th.height = 104;
      const ms = Math.min(w, h);
      th.getContext("2d").drawImage(canvas, (w - ms) / 2, (h - ms) / 2, ms, ms, 0, 0, 104, 104);
      state.own.push({ key, src, thumb: th.toDataURL("image/jpeg", 0.8), name: file.name });
    } catch {
      // unreadable file: skip it
    }
  }
  renderOwn();
  updateBuildButton();
}

function renderOwn() {
  const box = $("ownThumbs");
  box.replaceChildren();
  for (const o of state.own) {
    const fig = document.createElement("figure"), img = document.createElement("img"), x = document.createElement("button");
    img.src = o.thumb;
    img.alt = o.name;
    img.title = o.name;
    x.type = "button";
    x.textContent = "×";
    x.setAttribute("aria-label", `Remove ${o.name}`);
    x.addEventListener("click", () => {
      state.own = state.own.filter((q) => q !== o);
      renderOwn();
      updateBuildButton();
    });
    fig.append(img, x);
    box.append(fig);
  }
}

function updateBuildButton() {
  const hasSrc = selectedPacks().length > 0 || state.own.length > 0;
  $("buildBtn").disabled = !state.target || !hasSrc || state.busy;
  $("buildHint").textContent = !state.target ? "Pick a picture first."
    : !hasSrc ? "Pick at least one pack."
    : state.busy ? "Building…" : "";
}

/* ------------------------------------------------------------ step 3: build */
function call(worker, msg, transfer = []) {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message || "worker failed"));
    worker.postMessage(msg, transfer);
  });
}
const workerCount = () => Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

function showStage({ replay }) {
  $("stage").hidden = false;
  $("targetBox").hidden = replay;
  for (const id of ["actions", "scrubRow", "orderRow", "playRow", "sheetBlock", "gifBox", "composition", "guessBtn", "guessNote"]) $(id).hidden = true;
  $("shareNote").textContent = "";
  $("addingLabel").textContent = "";
  $("addingCanvas").getContext("2d").clearRect(0, 0, 64, 64);
  setProgress(0);
  $("stage").scrollIntoView({ behavior: "smooth", block: "start" });
}

function showAdding(run, i, step = i + 1) {
  if (i < 0 || !run.atoms64[i]) return;
  const p = run.pieces[i], sheet = run.sheet;
  drawBytes($("addingCanvas"), run.atoms64[i].u8, run.C, N);
  // once the build is done: fade it by what it actually contributed, and say how much
  const fade = sheet && $("strengthInput").checked;
  $("addingCanvas").style.opacity = fade ? String(Math.max(0.06, sheet.contrib[i] / (sheet.contrib[sheet.byStrength[0]] || 1))) : "1";
  const box = $("addingLabel");
  box.replaceChildren();
  const a = document.createElement("div"), b = document.createElement("div");
  a.className = "ell";
  a.textContent = a.title = `#${step}: ${p.src.title}`;
  b.className = "ell";
  const share = sheet ? ` \u00b7 adds ${((100 * sheet.contrib[i]) / sheet.contrib.reduce((x, y) => x + y, 0)).toFixed(1)}%` : "";
  b.textContent = `${p.s} px crop${p.o ? (p.o & 4 ? ", flipped" : ", turned") : ""}${share}`;
  box.append(a, b);
}

async function build() {
  if (state.run) state.run.cancelled = true;
  state.busy = true;
  updateBuildButton();
  const C = $("colourInput").checked ? 3 : 1, K = +$("kInput").value, want = +$("poolInput").value;
  const minFrac = +$("pieceInput").value, rotate = $("rotateInput").checked; // advanced: make it harder
  const neutral = C === 3 && $("pureInput").checked; // colour only from the images: one shared black level
  const run = { C, K, replay: false, cancelled: false, pieces: [], order: [], wHist: [], atoms64: [] };
  state.run = run;
  showStage({ replay: false });
  setStatus("Loading images…");
  $("stopBtn").hidden = false;
  try {
    const t = targetVec(C);
    drawFloat($("targetThumb"), t, C, N);
    const { sources, weights } = await gatherSources(run);
    run.shareable = sources.every((s) => !s.own);

    run.neutral = neutral;
    const pb = new PoolBuilder({ sources, weights, count: want, C, neutral, minFrac, rotate, seed: (Math.random() * 2 ** 31) | 0 });
    while (!pb.step(250)) {
      setStatus(`Cutting ${pb.done.toLocaleString()} of ${want.toLocaleString()} crops…`);
      setProgress((pb.done / want) * 0.1);
      await nextFrame();
      if (run.cancelled) throw new Error("stopped");
    }

    // strict settings can leave fewer distinct crops than asked for
    const P = pb.done;
    if (!P) throw new Error("no usable pieces with these settings");
    const D = C * N * N, W = workerCount(), per = Math.ceil(P / W), workers = [];
    run.workers = workers;
    for (let i = 0; i < W; i++) {
      const a = i * per, b = Math.min(P, a + per);
      if (a >= b) break;
      const wk = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
      workers.push(wk);
      const pool = pb.pool.slice(a * D, b * D), norms = pb.norms.slice(a, b);
      await call(wk, { type: "init", pool, norms, D }, [pool.buffer, norms.buffer]);
    }
    run.params = pb.params;
    run.sources = sources;
    pb.pool = null; // the workers have their own copies now

    const fit = new Fitter(t, C, K, { neutral });
    run.fit = fit;
    const marks = new Int32Array(workers.length).fill(-1);
    $("stopBtn").hidden = false;
    let lastDraw = 0;
    for (let k = 0; k < K && !run.cancelled; k++) {
      const res = fit.residualF32();
      const replies = await Promise.all(workers.map((wk, i) => call(wk, { type: "score", res, mark: marks[i] })));
      let bi = -1;
      replies.forEach((r, i) => { if (r.best >= 0 && (bi < 0 || r.score > replies[bi].score)) bi = i; });
      if (bi < 0 || !(replies[bi].score > 1e-9)) { run.stalled = true; break; }
      marks.fill(-1);
      marks[bi] = replies[bi].best;
      const g = bi * per + replies[bi].best;
      fit.add(replies[bi].vec);
      const [si, x, y, s, o] = run.params.subarray(g * 5, g * 5 + 5);
      run.pieces.push({ src: sources[si], x, y, s, o });
      run.order.push(g);
      run.wHist.push(Float32Array.from(fit.w.subarray(0, fit.k)));
      run.atoms64.push({ u8: replies[bi].vec, mean: fit.means[fit.k - 1] });
      const now = performance.now();
      if (k < 12 || now - lastDraw > 40) {
        lastDraw = now;
        drawFloat($("resultCanvas"), fit.reconstruction(), C, N);
        showAdding(run, fit.k - 1);
        setStatus(`${fit.k} of ${K} images stacked`);
        setProgress(0.1 + (0.8 * fit.k) / K);
      }
      if (k < 6) await sleep(300); // let people see the first few arrive
    }
  } catch (err) {
    if (run.cancelled) setStatus("Stopped.");
    else { console.error(err); setStatus(`Something went wrong: ${err.message}`); }
  } finally {
    run.workers?.forEach((w) => w.terminate());
    $("stopBtn").hidden = true;
  }
  if (state.run === run && run.fit?.k) {
    await finishBuild(run);
    track("picture-made");
  }
  state.busy = false;
  updateBuildButton();
}

async function finishBuild(run) {
  const { C, fit } = run, n = fit.k;
  run.sources = null; // map tiles no piece uses can be freed; pieces keep their own
  run.n = n;
  run.tmean = Array.from(fit.tmean, Math.fround); // same precision as share links
  run.wFinal = run.wHist[n - 1];
  run.hi = [];
  for (let i = 0; i < n; i++) {
    const p = run.pieces[i];
    run.hi.push(atomBytes(p.src, p.x, p.y, p.s, p.o, HI, C, run.neutral));
    if (i % 10 === 0) {
      setStatus(`Rendering in high resolution: re-cutting all ${n} images at ${HI} px…`);
      setProgress(0.9 + (0.1 * i) / n);
      await nextFrame();
    }
  }
  setProgress(1);
  setStatus(`Done! ${n} real images, stacked as light.` + (run.stalled ? " (Stopped early: no image left would add light in the right places.)" : ""));
  run.finalStd = stdOf(renderSum(run.hi, run.wFinal, n, C, HI, run.tmean), C, run.tmean);
  setupScrub(run, n);
  renderAt(n);
  buildSheet(run);
  buildCredits(run);
  showComposition(run);
  $("actions").hidden = false;
  $("playRow").hidden = false;
  $("playBtn").textContent = "Watch it again";
  $("shareBtn").disabled = !run.shareable;
  $("shareNote").textContent = run.shareable ? ""
    : "Made with your own images, so it can't be shared as a link: your friends don't have those images. Download it instead.";
}

/* ------------------------------------------------------------ results */
function setupScrub(run, value) {
  const s = $("scrub");
  s.max = String(run.n);
  s.value = String(value);
  $("scrubRow").hidden = false;
  $("orderRow").hidden = false;
  $("sheetBlock").hidden = false;
}

function renderAt(k) {
  const run = state.run;
  if (!run?.hi) return;
  k = Math.max(1, Math.min(run.n, k));
  $("scrubLabel").textContent = `${k} of ${run.n}`;
  drawFloat($("resultCanvas"), frameVec(run, k), run.C, HI);
  showAdding(run, pieceAt(run, k), k);
  drawSheetMarks(run, k);
}

// The order pieces go in as the slider moves: the order the build picked them (default),
// or strongest first. One setting drives the picture, the grid, playback and saving.
const strongestFirst = (run) => !!run.sheet && $("sheetOrder").value === "strength";
const pieceAt = (run, k) => (strongestFirst(run) ? run.sheet.byStrength[k - 1] : k - 1);

// The picture after k images, as the arrays to sum: in build order the builder has the
// true k-image fit; otherwise (replays, strongest first) the final brightnesses are used
// and partial stacks get their contrast rescaled to the finished picture's.
function stackAt(run, k) {
  if (strongestFirst(run)) return { pieces: run.sheet.hiStrong, w: run.sheet.wStrong, rescale: k < run.n };
  return { pieces: run.hi, w: run.replay ? run.wFinal : run.wHist[k - 1], rescale: run.replay && k < run.n };
}

function frameVec(run, k) {
  const st = stackAt(run, k);
  return renderSum(st.pieces, st.w, k, run.C, HI, run.tmean, { matchStd: st.rescale ? run.finalStd : 0 });
}

let scrubPending = false;
function scheduleRender() {
  if (scrubPending) return;
  scrubPending = true;
  requestAnimationFrame(() => { scrubPending = false; renderAt(+$("scrub").value); });
}

async function play() {
  const run = state.run;
  if (!run?.hi) return;
  if (run.playing) { run.playing = false; return; }
  run.playing = true;
  $("playBtn").textContent = "Pause";
  let k = +$("scrub").value;
  if (k >= run.n) k = 0;
  while (run.playing && state.run === run && k < run.n) {
    k++;
    $("scrub").value = String(k);
    renderAt(k);
    await sleep(k <= 5 ? 700 : k <= 20 ? 250 : k <= 60 ? 90 : 35);
  }
  run.playing = false;
  $("playBtn").textContent = k >= run.n ? "Play again" : "Play";
  if (k >= run.n && run.replay) showComposition(run);
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function centeredNorm(u8, mean, C) {
  const RR = u8.length / C;
  let s = 0;
  for (let c = 0; c < C; c++) for (let p = 0; p < RR; p++) { const v = u8[c * RR + p] / 255 - mean[c]; s += v * v; }
  return Math.sqrt(s);
}

function buildSheet(run) {
  const cv = $("sheet"), n = run.n, cell = 66;
  const contrib = run.atoms64.map((a, i) => run.wFinal[i] * centeredNorm(a.u8, a.mean, run.C));
  const byStrength = [...Array(n).keys()].sort((a, b) => contrib[b] - contrib[a]);
  const strengthRank = new Int32Array(n);
  byStrength.forEach((i, r) => { strengthRank[i] = r; });
  // shown either in the order the pieces were added (what the slider follows) or strongest first
  const order = $("sheetOrder").value === "strength" ? byStrength : [...Array(n).keys()];
  const cols = Math.max(5, Math.min(20, Math.floor((cv.parentElement.clientWidth || 600) / 44)));
  const rows = Math.ceil(n / cols);
  cv.width = cols * cell;
  cv.height = rows * cell;
  // the tiles go on an offscreen copy; the visible sheet is that copy plus the slider marks
  const base = document.createElement("canvas");
  base.width = cv.width;
  base.height = cv.height;
  const ctx = base.getContext("2d"), tile = document.createElement("canvas");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, base.width, base.height);
  // optionally fade each piece by its share of what draws the picture (strongest = opaque)
  const fade = $("strengthInput").checked, cmax = contrib[byStrength[0]] || 1;
  order.forEach((i, r) => {
    drawBytes(tile, run.atoms64[i].u8, run.C, N);
    ctx.globalAlpha = fade ? Math.max(0.06, contrib[i] / cmax) : 1;
    ctx.drawImage(tile, (r % cols) * cell + 1, Math.floor(r / cols) * cell + 1, cell - 2, cell - 2);
  });
  ctx.globalAlpha = 1;
  const hiStrong = byStrength.map((i) => run.hi[i]), wStrong = Float32Array.from(byStrength, (i) => run.wFinal[i]);
  run.sheet = { order, byStrength, strengthRank, hiStrong, wStrong, cols, rows, contrib, base, cell };
  renderAt(+$("scrub").value || run.n); // picture, "now adding" and marks in the chosen order
}

// Show which pieces are in the picture at the slider's position: those added so far get
// an orange outline, the rest are dimmed, and the newest gets a white one.
function drawSheetMarks(run, k) {
  const sh = run.sheet;
  if (!sh) return;
  const ctx = $("sheet").getContext("2d"), c = sh.cell, all = k >= run.n;
  ctx.drawImage(sh.base, 0, 0);
  sh.order.forEach((i, r) => {
    const x = (r % sh.cols) * c, y = Math.floor(r / sh.cols) * c;
    const inPicture = strongestFirst(run) ? sh.strengthRank[i] < k : i < k;
    if (!inPicture) {
      ctx.fillStyle = "rgba(11, 13, 18, 0.8)";
      ctx.fillRect(x + 1, y + 1, c - 2, c - 2);
    } else if (!all) {
      ctx.strokeStyle = "#ffb86b";
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 2.5, y + 2.5, c - 5, c - 5);
    }
    if (i === pieceAt(run, k)) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 5;
      ctx.strokeRect(x + 3.5, y + 3.5, c - 7, c - 7);
    }
  });
}

// rank (position in the sheet, strongest first) under a pointer event, or -1
function sheetRankAt(e) {
  const run = state.run, cv = $("sheet");
  if (!run?.sheet) return -1;
  const r = cv.getBoundingClientRect(), { order, cols, rows } = run.sheet;
  const c = Math.floor(((e.clientX - r.left) / r.width) * cols), rr = Math.floor(((e.clientY - r.top) / r.height) * rows);
  const idx = rr * cols + c;
  return c < 0 || c >= cols || idx < 0 || idx >= order.length ? -1 : idx;
}

function wireSheet() {
  const cv = $("sheet"), tip = $("sheetTip");
  cv.addEventListener("click", (e) => {
    const idx = sheetRankAt(e), sh = state.run?.sheet;
    if (idx >= 0) openPiece(sh.strengthRank[sh.order[idx]]);
  });
  const show = (e) => {
    const run = state.run, idx = sheetRankAt(e);
    if (idx < 0) { tip.hidden = true; return; }
    const i = run.sheet.order[idx], p = run.pieces[i];
    tip.textContent = `Added ${ordinal(i + 1)}, #${run.sheet.strengthRank[i] + 1} by strength: ${p.src.title}, ${p.s} px crop. Click for more.`;
    tip.hidden = false;
    const pr = cv.parentElement.getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX - pr.left + 12, pr.width - 250)}px`;
    tip.style.top = `${e.clientY - pr.top + 14}px`;
  };
  cv.addEventListener("pointermove", show);
  cv.addEventListener("pointerdown", show);
  cv.addEventListener("pointerleave", () => { tip.hidden = true; });
}

/* ------------------------------------------------------------ "37% Mars" */
function familyOf(src) {
  if (src.own) return "your images";
  if (src.mapId != null) return state.mapById.get(src.mapId).family;
  return state.familyByImg.get(src.imgId) || "other";
}

// Each family's share of the picture by contribution (brightness x contrast), as whole
// percentages adding up to 100 (largest remainders get the leftover points).
function composition(run) {
  const tot = new Map();
  let sum = 0;
  run.sheet.contrib.forEach((c, i) => {
    const f = familyOf(run.pieces[i].src);
    tot.set(f, (tot.get(f) || 0) + c);
    sum += c;
  });
  const parts = [...tot].map(([label, c]) => ({ label, exact: (100 * c) / (sum || 1) }));
  for (const p of parts) p.pct = Math.floor(p.exact);
  let left = 100 - parts.reduce((a, p) => a + p.pct, 0);
  for (const p of [...parts].sort((a, b) => (b.exact - b.pct) - (a.exact - a.pct))) if (left-- > 0) p.pct++;
  return parts.filter((p) => p.pct > 0).sort((a, b) => b.pct - a.pct);
}

function compositionText(run, max = 5) {
  const parts = composition(run), shown = parts.slice(0, max).map((p) => `${p.pct}% ${p.label}`);
  if (parts.length > max) shown.push(`${parts.slice(max).reduce((a, p) => a + p.pct, 0)}% other`);
  return shown.join(" · ");
}

const FAMILY_COLORS = {
  Moon: "#c9ccd6", Mars: "#ff7a59", Andromeda: "#8ab4ff", "Carina nebula": "#ff6bd6", "deep space": "#6b7cff",
  eyes: "#ff5c5c", tissue: "#e8a87c", "glowing cells": "#4ade80", "head scans": "#a3a3a3", "your images": "#ffd24a",
  nebulae: "#c084fc", planets: "#fbbf24", Earth: "#38bdf8", landscapes: "#a3e635", oceans: "#22d3ee",
  paintings: "#f472b6", "science art": "#34d399", patterns: "#fb923c",
};

function chip(text, color) {
  const c = document.createElement("span"), dot = document.createElement("i");
  c.className = "chip";
  dot.style.setProperty("--c", color || "#888");
  c.append(dot, text);
  return c;
}

function showComposition(run) {
  const el = $("composition"), parts = composition(run), lead = document.createElement("span");
  lead.className = "muted";
  lead.textContent = "Made of";
  el.replaceChildren(lead);
  for (const p of parts.slice(0, 8)) el.append(" ", chip(`${p.pct}% ${p.label}`, FAMILY_COLORS[p.label]));
  const rest = parts.slice(8).reduce((a, p) => a + p.pct, 0);
  if (rest) el.append(" ", chip(`${rest}% other`, "#777"));
  el.hidden = false;
}

/* ------------------------------------------------------------ one piece, up close */
let dlgRank = 0;

function openPiece(rank) {
  const run = state.run;
  if (!run?.sheet) return;
  dlgRank = Math.max(0, Math.min(run.n - 1, rank));
  const i = run.sheet.byStrength[dlgRank], p = run.pieces[i];
  const total = run.sheet.contrib.reduce((a, b) => a + b, 0) || 1;
  drawBytes($("dlgPiece"), run.hi[i].u8, run.C, HI);
  $("dlgWithout").checked = false;
  drawDialogPicture();
  $("dlgTitle").textContent = p.src.title;
  $("dlgInfo").textContent = `#${dlgRank + 1} of ${run.n} by strength · about ${((100 * run.sheet.contrib[i]) / total).toFixed(1)}% of the picture`
    + ` · brightness ×${run.wFinal[i].toFixed(2)} · ${p.s} px crop${p.o ? (p.o & 4 ? ", flipped" : ", turned") : ""}`;
  const where = $("dlgWhere"), rank0 = dlgRank;
  where.hidden = true;
  $("dlgSource").textContent = "";
  if (p.src.mapId != null) {
    coresampleLink(p).then((url) => { if (url && dlgRank === rank0) { where.href = url; where.hidden = false; } }).catch(() => {});
  } else if (!p.src.own) {
    const im = state.byId.get(p.src.imgId);
    $("dlgSource").textContent = im.credit.split(/(?<=\.)\s/)[0];
  }
  $("dlgPrev").disabled = dlgRank === 0;
  $("dlgNext").disabled = dlgRank === run.n - 1;
  if (!$("pieceDialog").open) $("pieceDialog").showModal();
}

function drawDialogPicture() {
  const run = state.run, i = run.sheet.byStrength[dlgRank], w = Float32Array.from(run.wFinal), without = $("dlgWithout").checked;
  if (without) w[i] = 0;
  drawFloat($("dlgPicture"), renderSum(run.hi, w, run.n, run.C, HI, run.tmean), run.C, HI);
  $("dlgPictureCap").textContent = without ? "The picture without it" : "The whole picture";
}

// The exact spot a map piece came from, in coresample's viewer (?d=dataset&v=x,y,z,scale,
// in full-resolution pixels; scale = full-resolution pixels per screen pixel).
async function coresampleLink(p) {
  const spec = state.mapById.get(p.src.mapId);
  if (!spec.coresample) return null;
  const map = await openMap(spec), f = 2 ** (map.zooms.length - 1 - p.src.z), ts = map.spec.tileSize;
  const cx = (p.src.tx * ts + p.x + p.s / 2) * f, cy = (p.src.ty * ts + p.y + p.s / 2) * f;
  const scale = Math.max(0.5, (p.s * f) / 350);
  return `${CORESAMPLE}?d=${spec.coresample}&v=${Math.round(cx)},${Math.round(cy)},0,${+scale.toFixed(2)}&globe=0`;
}

function wireDialog() {
  const dlg = $("pieceDialog");
  $("dlgClose").addEventListener("click", () => dlg.close());
  $("dlgPrev").addEventListener("click", () => openPiece(dlgRank - 1));
  $("dlgNext").addEventListener("click", () => openPiece(dlgRank + 1));
  $("dlgWithout").addEventListener("change", drawDialogPicture);
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") openPiece(dlgRank - 1);
    else if (e.key === "ArrowRight") openPiece(dlgRank + 1);
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // click outside
}

function buildCredits(run) {
  const list = $("creditList");
  list.replaceChildren();
  const seen = new Set();
  for (const p of run.pieces) {
    const key = p.src.mapId != null ? `map:${p.src.mapId}` : p.src.key;
    if (seen.has(key)) continue;
    seen.add(key);
    const li = document.createElement("li");
    if (p.src.own) li.textContent = `${p.src.title}: stays on your device.`;
    else if (p.src.mapId != null) {
      const spec = state.mapById.get(p.src.mapId);
      li.textContent = `${spec.name}: ${spec.credit}`;
    } else {
      const im = state.byId.get(p.src.imgId), first = im.credit.split(/(?<=\.)\s/)[0];
      li.textContent = `${im.title}: ${first} (scikit-image sample data)`;
    }
    list.append(li);
  }
}

/* ------------------------------------------------------------ download + share */
async function download() {
  const run = state.run;
  if (!run?.hi) return;
  const btn = $("downloadBtn"), before = $("status").textContent;
  btn.disabled = true;
  try {
    // exactly what's on screen: the same number of images and the same weights (and, for a
    // replay's partial stack, the same contrast rescaling), just rendered at 512 px
    const C = run.C, RR = DL * DL, acc = new Float32Array(C * RR), off = new Float64Array(C);
    const k = Math.max(1, Math.min(run.n, +$("scrub").value || run.n)), st = stackAt(run, k), w = st.w;
    let gain = 1;
    if (st.rescale) {
      const sd = stdOf(renderSum(st.pieces, w, k, C, HI, run.tmean), C, run.tmean);
      if (sd > 1e-9) gain = Math.min(run.finalStd / sd, 50);
    }
    for (let j = 0; j < k; j++) {
      if (!w[j]) continue;
      const p = run.pieces[strongestFirst(run) ? run.sheet.byStrength[j] : j];
      const a = atomBytes(p.src, p.x, p.y, p.s, p.o, DL, C, run.neutral), f = w[j] / 255;
      for (let q = 0; q < acc.length; q++) acc[q] += f * a.u8[q];
      for (let c = 0; c < C; c++) off[c] += w[j] * a.mean[c];
      if (j % 10 === 0) { setStatus(`Rendering a ${DL} px image… ${j} of ${k}`); await nextFrame(); }
    }
    for (let c = 0; c < C; c++) for (let p = 0; p < RR; p++) acc[c * RR + p] = (acc[c * RR + p] - off[c]) * gain + run.tmean[c];
    const cv = document.createElement("canvas");
    drawFloat(cv, acc, C, DL);
    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = k === run.n ? "epluribus.png" : `epluribus-${k}-images.png`;
    a.click();
    track("image-saved");
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } finally {
    setStatus(before);
    btn.disabled = false;
  }
}

async function share() {
  const run = state.run;
  if (!run?.hi || !run.shareable) return;
  const pieces = [];
  run.pieces.forEach((p, i) => {
    if (!(run.wFinal[i] > 0)) return;
    const where = p.src.mapId != null
      ? { img: p.src.mapId, z: p.src.z, tx: p.src.tx, ty: p.src.ty }
      : { img: p.src.imgId, z: 0, tx: 0, ty: 0 };
    pieces.push({ ...where, x: p.x, y: p.y, s: p.s, o: p.o, w: run.wFinal[i] });
  });
  const note = $("shareNote"), base = location.href.split("#")[0];
  track("link-shared");
  if (!run.shareUrl) {
    const recipe = encodeRecipe({ C: run.C, tmean: run.tmean, pieces, neutral: run.neutral });
    run.shareUrl = `${base}#r=${recipe}`;
    run.shortLink = false;
    if (state.store) {
      note.textContent = "Making a short link…";
      try {
        run.shareUrl = `${base}#s=${await storeRecipe(state.store, recipe)}`;
        run.shortLink = true;
      } catch (e) {
        console.warn("short link failed, using the full link:", e);
      }
    }
  }
  const url = run.shareUrl;
  const what = run.shortLink
    ? "The recipe is stored encrypted: only someone with this exact link can open it, not even the server."
    : `It lists only which pieces to stack and how bright (${pieces.length} images), not your photo.`;
  if (matchMedia("(pointer: coarse)").matches && navigator.share) {
    try {
      await navigator.share({ title: "What's hiding in here?", text: `What's hiding in these ${run.n} images? (${compositionText(run, 4)})`, url });
      note.textContent = `Shared. ${what}`;
      return;
    } catch { /* fall back to copying */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    note.textContent = `Link copied${run.shortLink ? "" : ` (${url.length.toLocaleString()} characters)`}! Your friend watches it build and guesses what it is. ${what}`;
  } catch {
    note.textContent = "Couldn't copy automatically. Here's the link:";
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.rows = 3;
    ta.style.width = "100%";
    note.append(ta);
    ta.select();
  }
}

/* ------------------------------------------------------------ GIF */
// A small shareable animation: every image in a grid (strongest first, weak ones faint),
// then the images added one by one, strongest first - each flashes over the picture as it
// goes in, with the latest few in a strip below - ending on the picture and what it is
// made of ("37% Mars · 29% Moon ...").
const GIF_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
function gifText(ctx, text, x, y, { size = 16, weight = 600, color = "#e6e8ee", align = "center" } = {}) {
  ctx.font = `${weight} ${size}px ${GIF_FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText(text, x, y);
}

// split "a · b · c" into lines no wider than maxWidth, never breaking inside an item
function wrapItems(ctx, items, maxWidth) {
  const lines = [];
  let line = "";
  for (const it of items) {
    const t = line ? `${line} · ${it}` : it;
    if (line && ctx.measureText(t).width > maxWidth) { lines.push(line); line = it; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

async function makeGif() {
  const run = state.run;
  if (!run?.hi || !run.sheet) return;
  const btn = $("gifBtn"), before = $("status").textContent;
  btn.disabled = true;
  try {
    const W = 360, H = 440, PIC = 236, PX = (W - PIC) / 2, PY = 46, C = run.C, n = run.n;
    const ACCENT = "#ffb86b", MUTED = "#9aa3b2";
    const cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingQuality = "high";
    const frames = [];
    const push = (delay) => frames.push({ rgba: ctx.getImageData(0, 0, W, H).data, delay });
    const bg = () => { ctx.globalAlpha = 1; ctx.fillStyle = "#0b0d12"; ctx.fillRect(0, 0, W, H); };
    // the footer carries the site's address, so anyone who sees the GIF can find the game
    const site = `${location.host}${location.pathname}`.replace(/\/(index\.html)?$/, "");
    const footer = () => gifText(ctx, `what are you made of? \u00b7 ${site}`, W / 2, H - 12, { size: 11, weight: 400, color: MUTED });
    const toCanvas = (draw) => { const c = document.createElement("canvas"); draw(c); return c; };

    // strongest first: partial stacks use the final brightnesses, contrast-matched
    const order = run.sheet.byStrength, contrib = run.sheet.contrib, cmax = contrib[order[0]] || 1;
    const hiC = order.map((i) => run.hi[i]), wC = order.map((i) => run.wFinal[i]);
    const picture = (k) => toCanvas((c) => drawFloat(c, renderSum(hiC, wC, k, C, HI, run.tmean, { matchStd: k < n ? run.finalStd : 0 }), C, HI));
    const small = order.map((i) => toCanvas((c) => drawBytes(c, run.atoms64[i].u8, C, N)));

    setStatus("Making the GIF…");
    await nextFrame();
    // 1. all the images
    bg();
    gifText(ctx, `${n} real images…`, W / 2, 30);
    const cols = Math.min(20, Math.ceil(Math.sqrt(n * 1.3))), cell = Math.floor((W - 24) / cols), rows = Math.ceil(n / cols);
    const gx = (W - cols * cell) / 2, gy = PY + Math.max(0, (PIC + 60 - rows * cell) / 2);
    order.forEach((i, r) => {
      ctx.globalAlpha = 0.3 + 0.7 * Math.sqrt(contrib[i] / cmax);
      ctx.drawImage(small[r], gx + (r % cols) * cell, gy + Math.floor(r / cols) * cell, cell - 1, cell - 1);
    });
    ctx.globalAlpha = 1;
    gifText(ctx, "strongest first, faint ones add the least", W / 2, gy + rows * cell + 20, { size: 12, weight: 400, color: MUTED });
    footer();
    push(2800);

    // 2. added one by one
    const SW = 46, SG = 8, sx0 = (W - (5 * SW + 4 * SG)) / 2, SY = PY + PIC + 14;
    const ks = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 18, 22, 27, 33, 40, 50, 60, 75, 90, 110, 130, 160, 190, 230, 270, 320, 380, 450]
      .filter((k) => k < n);
    ks.push(n);
    for (const k of ks) {
      setStatus(`Making the GIF… ${k} of ${n}`);
      await nextFrame();
      const pic = picture(k), flashImg = toCanvas((c) => drawBytes(c, hiC[k - 1].u8, C, HI));
      const frame = (flash) => {
        bg();
        gifText(ctx, "…added together as light", W / 2, 30);
        ctx.drawImage(pic, PX, PY, PIC, PIC);
        if (flash > 0) { ctx.globalAlpha = flash; ctx.drawImage(flashImg, PX, PY, PIC, PIC); ctx.globalAlpha = 1; }
        for (let j = 0; j < 5; j++) {
          const r = k - 5 + j;
          if (r < 0) continue;
          const x = sx0 + j * (SW + SG);
          ctx.drawImage(small[r], x, SY, SW, SW);
          if (r === k - 1) { ctx.strokeStyle = ACCENT; ctx.lineWidth = 2; ctx.strokeRect(x - 1, SY - 1, SW + 2, SW + 2); }
        }
        gifText(ctx, `${k} image${k > 1 ? "s" : ""}`, W / 2, SY + SW + 26, { size: 15, weight: 400, color: ACCENT });
        footer();
      };
      if (k <= 8) { frame(0.85); push(450); frame(0); push(380); } else { frame(0.35); push(k === n ? 700 : 120); }
    }

    // 3. the picture, and what it's made of
    bg();
    gifText(ctx, `${n} real images, added as light`, W / 2, 30, { size: 15 });
    ctx.drawImage(picture(n), PX, PY, PIC, PIC);
    ctx.font = `600 15px ${GIF_FONT}`;
    const parts = composition(run).slice(0, 5).map((p) => `${p.pct}% ${p.label}`);
    wrapItems(ctx, parts, W - 32).forEach((line, j) => gifText(ctx, line, W / 2, PY + PIC + 34 + j * 22, { size: 15, color: ACCENT }));
    footer();
    push(4500);

    setStatus("Encoding the GIF…");
    await nextFrame();
    const blob = new Blob([encodeGif(frames, W, H)], { type: "image/gif" });
    if (run.gifUrl) URL.revokeObjectURL(run.gifUrl);
    run.gifUrl = URL.createObjectURL(blob);
    run.gifFile = new File([blob], "epluribus.gif", { type: "image/gif" });
    $("gifPreview").src = run.gifUrl;
    $("gifBox").hidden = false;
    track("gif-made");
    // sharing a file needs a fresh tap, so it gets its own button (where the device can)
    $("gifShareBtn").hidden = !navigator.canShare?.({ files: [run.gifFile] });
    $("gifNote").textContent = `${(blob.size / 1e6).toFixed(1)} MB. Post it with your share link so people can play.`;
    $("gifBox").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } finally {
    setStatus(before);
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------ shared links */
async function startReplay(code) {
  document.body.classList.add("replaying");
  $("builder").hidden = true;
  $("heroCtas").hidden = true;
  $("replayIntro").hidden = false;
  const fail = (msg = "This link is damaged or from a newer version, so it can't be rebuilt.") => {
    $("replayIntro").querySelector("p").textContent = msg;
    $("stage").hidden = true;
  };
  let rec;
  try {
    rec = decodeRecipe(code);
    for (const p of rec.pieces) {
      if (p.s < 1) throw new Error("bad piece");
      if (state.mapById.has(p.img)) continue; // map tiles are checked once fetched
      const im = state.byId.get(p.img);
      if (!im || p.x + p.s > im.width || p.y + p.s > im.height) throw new Error("bad piece");
    }
    if (!rec.pieces.length) throw new Error("empty");
  } catch {
    fail();
    return;
  }
  $("replayCount").textContent = String(rec.pieces.length);
  const C = rec.C, n = rec.pieces.length;
  const run = { replay: true, C, n, neutral: rec.neutral, tmean: rec.tmean, wFinal: Float32Array.from(rec.pieces.map((p) => p.w)), shareable: true };
  state.run = run;
  showStage({ replay: true });
  setStatus("Loading the images…");
  const srcs = new Map(); // key -> source
  try {
    const imgIds = [...new Set(rec.pieces.filter((p) => !state.mapById.has(p.img)).map((p) => p.img))];
    for (const id of imgIds) srcs.set(`img:${id}`, await catalogSource(id));
    // map tiles: fetch exactly the tiles used, plus as many random decoys from each map
    const tiles = new Map();
    for (const p of rec.pieces) if (state.mapById.has(p.img)) tiles.set(`${p.img}:${p.z}/${p.tx}/${p.ty}`, p);
    const perMap = new Map();
    for (const p of tiles.values()) perMap.set(p.img, (perMap.get(p.img) || 0) + 1);
    const rand = mulberry32((Math.random() * 2 ** 31) | 0);
    let got = 0;
    const decoys = [...perMap].map(async ([id, k]) => {
      try { await fetchDecoys(await openMap(state.mapById.get(id)), k, rand); } catch { /* decoys are best effort */ }
    });
    await mapLimit([...tiles], 8, async ([key, p]) => {
      const spec = state.mapById.get(p.img), map = await openMap(spec);
      if (!map.has(p.z, p.tx, p.ty)) throw new Error("bad tile");
      const t = await fetchTile(map, p.z, p.tx, p.ty);
      if (!t) throw new Error(`couldn't fetch a tile of the ${spec.name}`);
      srcs.set(key, tileSource(spec, { ...t, z: p.z, x: p.tx, y: p.ty }));
      setStatus(`Fetching the map pieces… ${++got} of ${tiles.size}`);
    });
    await Promise.all(decoys);
  } catch (err) {
    console.error(err);
    fail("Some of the images this picture needs couldn't be loaded. Try again in a moment.");
    return;
  }
  run.pieces = rec.pieces.map((p) => ({
    src: srcs.get(state.mapById.has(p.img) ? `${p.img}:${p.z}/${p.tx}/${p.ty}` : `img:${p.img}`),
    x: p.x, y: p.y, s: p.s, o: p.o,
  }));
  if (run.pieces.some((p) => p.x + p.s > p.src.w || p.y + p.s > p.src.h)) { fail(); return; }
  run.hi = [];
  run.atoms64 = [];
  for (let i = 0; i < n; i++) {
    const p = run.pieces[i];
    run.hi.push(atomBytes(p.src, p.x, p.y, p.s, p.o, HI, C, run.neutral));
    run.atoms64.push(atomBytes(p.src, p.x, p.y, p.s, p.o, N, C, run.neutral));
    if (i % 10 === 0) { setStatus(`Cutting the ${n} images… ${i} of ${n}`); setProgress(i / n); await nextFrame(); }
  }
  setProgress(1);
  run.finalStd = stdOf(renderSum(run.hi, run.wFinal, n, C, HI, run.tmean), C, run.tmean);
  setupScrub(run, 1);
  renderAt(1);
  buildSheet(run);
  buildCredits(run);
  $("actions").hidden = false;
  $("playRow").hidden = false;
  $("guessBtn").hidden = false;
  $("playBtn").textContent = "Play";
  setStatus("Hit play, then tap “I got it!” the moment you recognise it.");
}

// "Guess who": the replay's game. Record how many images it took, reveal, and offer a
// challenge to pass on.
function guessNow() {
  const run = state.run;
  if (!run?.replay) return;
  run.guessedAt = Math.max(1, +$("scrub").value);
  track("guessed");
  run.playing = false;
  $("guessBtn").hidden = true;
  const k = run.guessedAt, n = run.n;
  $("guessText").textContent = k >= n ? `All ${n} images. Tough one!`
    : k <= 15 ? `Just ${k} of ${n} images. Eagle eye!`
    : k <= 40 ? `${k} of ${n} images. Sharp!`
    : k <= 100 ? `${k} of ${n} images. Nice!`
    : `${k} of ${n} images. Got there!`;
  $("guessNote").hidden = false;
  $("scrub").value = String(run.n);
  renderAt(run.n);
  showComposition(run);
}

async function challenge() {
  const run = state.run, url = location.href;
  const text = `I spotted what's hiding in these ${run.n} images after just ${run.guessedAt}. Can you beat that?`;
  if (matchMedia("(pointer: coarse)").matches && navigator.share) {
    try { await navigator.share({ text, url }); return; } catch { /* fall back to copying */ }
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    $("guessText").textContent = `Copied! (Your score: ${run.guessedAt}.) Paste it to a friend.`;
  } catch {
    $("guessText").textContent = `${text} ${url}`;
  }
}

// "Play a round": a ready-made picture (the Mona Lisa) to guess, before making your own.
async function playDemo() {
  try {
    const r = await fetch("samples/demo-recipe.txt");
    if (!r.ok) throw new Error("no demo");
    const code = (await r.text()).trim();
    history.replaceState(null, "", `#r=${code}`);
    track("demo-played");
    await startReplay(code);
  } catch {
    $("demoBtn").textContent = "Demo unavailable";
    $("demoBtn").disabled = true;
  }
}

function linkError(msg) {
  document.body.classList.add("replaying");
  $("builder").hidden = true;
  $("heroCtas").hidden = true;
  $("replayIntro").hidden = false;
  $("replayIntro").querySelector("p").textContent = msg;
}

/* ------------------------------------------------------------ start */
async function init() {
  const r = await fetch("packs/packs.json");
  state.catalog = await r.json();
  for (const im of state.catalog.images) state.byId.set(im.id, im);
  for (const m of state.catalog.maps || []) state.mapById.set(m.id, m);
  if (startStats()) $("statsNote").hidden = false;
  for (const p of state.catalog.packs) for (const id of p.images || []) if (!state.familyByImg.has(id)) state.familyByImg.set(id, p.family);
  wireDialog();
  for (const p of state.catalog.packs) state.selected.add(p.id);
  renderPacks();
  wireCrop();
  wireSheet();
  $("fileInput").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) await useTargetFile(f);
    e.target.value = "";
  });
  wireDrop();
  for (const b of document.querySelectorAll("[data-sample]")) {
    b.addEventListener("click", async () => {
      const s = SAMPLES[b.dataset.sample];
      await setTarget(await fetchBitmap(s.url), s.crop);
    });
  }
  $("ownInput").addEventListener("change", (e) => { addOwnImages([...e.target.files]); e.target.value = ""; });
  $("kInput").addEventListener("input", (e) => { $("kLabel").textContent = e.target.value; });
  $("colourInput").addEventListener("change", () => { $("pureInput").disabled = !$("colourInput").checked; scheduleCrop(); });
  $("buildBtn").addEventListener("click", build);
  $("stopBtn").addEventListener("click", () => { if (state.run) state.run.cancelled = true; });
  const stopPlaying = () => { if (state.run?.playing) state.run.playing = false; };
  $("scrub").addEventListener("pointerdown", stopPlaying);
  $("scrub").addEventListener("keydown", stopPlaying);
  $("scrub").addEventListener("input", () => { stopPlaying(); scheduleRender(); });
  $("sheetOrder").addEventListener("change", () => { if (state.run?.sheet) buildSheet(state.run); });
  $("strengthInput").addEventListener("change", () => { if (state.run?.sheet) buildSheet(state.run); });
  $("playBtn").addEventListener("click", play);
  $("downloadBtn").addEventListener("click", download);
  $("gifBtn").addEventListener("click", makeGif);
  $("gifSaveBtn").addEventListener("click", () => {
    if (!state.run?.gifUrl) return;
    const a = document.createElement("a");
    a.href = state.run.gifUrl;
    a.download = "epluribus.gif";
    a.click();
  });
  $("gifShareBtn").addEventListener("click", async () => {
    const run = state.run;
    if (!run?.gifFile) return;
    try {
      await navigator.share({ files: [run.gifFile], text: `What are you made of? This one's ${compositionText(run, 4)}.` });
    } catch { /* cancelled */ }
  });
  $("shareBtn").addEventListener("click", share);
  $("makeOwnBtn").addEventListener("click", () => { location.href = location.pathname; });
  $("guessBtn").addEventListener("click", guessNow);
  $("demoBtn").addEventListener("click", playDemo);
  $("heroArt").addEventListener("click", playDemo);
  $("heroArt").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); playDemo(); } });
  $("challengeBtn").addEventListener("click", challenge);
  state.store = await findStore();
  const long = location.hash.match(/^#r=([A-Za-z0-9_-]+)$/), short = location.hash.match(/^#s=([A-Za-z0-9_.-]+)$/);
  if (long || short) track("link-opened");
  if (long) await startReplay(long[1]);
  else if (short) {
    let recipe = null;
    try {
      if (!state.store) throw new Error("this copy of the site has no link store set up");
      recipe = await loadRecipe(state.store, short[1]);
    } catch (e) {
      linkError(`This short link can't be opened: ${e.message}.`);
    }
    if (recipe) await startReplay(recipe);
  }
}

init().catch((err) => {
  console.error(err);
  document.querySelector("main").insertAdjacentHTML("afterbegin",
    '<section class="card"><b>The page couldn\'t start.</b> It has to be opened through a web server (see README), not as a file.</section>');
});
