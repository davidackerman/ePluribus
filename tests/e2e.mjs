// End-to-end check of the ePluribus page in system Chrome (Playwright, no browser download).
// Needs: the site served (python3 -m http.server 8765 --directory web) and, for short links,
// the dev store (python tests/short_link_store.py). Uses the network for the live maps.
// Usage: node tests/e2e.mjs URL OUTDIR
import { chromium } from "playwright-core";

const [URL, OUT] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1500 }, permissions: ["clipboard-read", "clipboard-write"] });
const errors = [];
const SITE = new globalThis.URL(URL).host; // (URL is the address argument here)
const watch = (page, tag) => {
  // failed loads are judged by URL below (the console's message doesn't say which file)
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(`${tag} console: ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message}`));
  // the site's own files must all load; live tile servers may answer 4xx/5xx for some tiles
  // (those are retried or skipped), and the dev short-link store answers 404 for a missing id
  page.on("response", (r) => {
    const u = new globalThis.URL(r.url());
    if (r.status() >= 400 && u.host === SITE) errors.push(`${tag} ${r.status()} for ${u.pathname}`);
  });
};
const grab = (pg) => pg.evaluate(() => {
  const c = document.querySelector("#resultCanvas");
  return Array.from(c.getContext("2d").getImageData(0, 0, c.width, c.height).data);
});
const setScrub = (pg, v) => pg.evaluate((v) => {
  const s = document.querySelector("#scrub");
  s.value = v === "max" ? s.max : String(v);
  s.dispatchEvent(new Event("input"));
}, v);
const log = (...a) => console.log(...a);

// ---- build (astronaut, default packs incl. live maps, 300 images, colour)
const page = await ctx.newPage();
watch(page, "builder");
await page.goto(URL);
await page.click("[data-sample=astronaut]");
await page.waitForSelector("#cropArea:not([hidden])");
await page.screenshot({ path: `${OUT}/1_builder.png`, fullPage: true });
const t0 = Date.now();
await page.click("#buildBtn");
await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Done"), null, { timeout: 240000 });
log(`build: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${await page.textContent("#status")}`);
log(`composition: ${await page.textContent("#composition")}`);
log(`stop button hidden after build: ${!(await page.isVisible("#stopBtn"))}`);
await page.screenshot({ path: `${OUT}/2_result.png`, fullPage: true });
const senderPixels = await grab(page);

// ---- one piece, up close
await page.locator("#sheet").click({ position: { x: 20, y: 20 } });
await page.waitForSelector("#pieceDialog[open]");
log(`dialog: ${await page.textContent("#dlgTitle")} | ${await page.textContent("#dlgInfo")}`);
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(200);
log(`after ArrowRight: ${(await page.textContent("#dlgInfo")).split(" · ")[0]}`);
await page.check("#dlgWithout");
await page.waitForTimeout(150);
log(`without toggle caption: ${await page.textContent("#dlgPictureCap")}`);
// find a map piece and check its coresample link
let where = null;
for (let step = 0; step < 40 && !where; step++) {
  await page.waitForTimeout(120);
  if (await page.isVisible("#dlgWhere")) where = await page.getAttribute("#dlgWhere", "href");
  else await page.keyboard.press("ArrowRight");
}
log(`coresample link: ${where}`);
await page.locator("#pieceDialog").screenshot({ path: `${OUT}/3_dialog.png` });
await page.keyboard.press("Escape");

// ---- the all-pieces grid, faded by how much each piece adds
await page.locator("#sheet").screenshot({ path: `${OUT}/5_sheet.png` });
await page.check("#strengthInput");
await page.waitForTimeout(200);
await page.locator("#sheet").screenshot({ path: `${OUT}/5_sheet_strength.png` });
log(`strength checkbox: ${await page.isChecked("#strengthInput")}; now-adding label: "${(await page.textContent("#addingLabel")).replace(/\s+/g, " ")}", opacity ${await page.evaluate(() => document.querySelector("#addingCanvas").style.opacity)}`);
// the side column must not change height while scrubbing (long titles used to wrap)
const heights = new Set();
for (const k of [1, 5, 17, 60, 150, 299]) { await setScrub(page, k); await page.waitForTimeout(60); heights.add((await page.locator("#addingBox").boundingBox()).height); }
log(`"Now adding" box heights while scrubbing: ${[...heights].join(", ")}`);
await setScrub(page, "max");
await page.uncheck("#strengthInput");

// ---- GIF
{
  const t1 = Date.now();
  await page.click("#gifBtn");
  await page.waitForSelector("#gifBox:not([hidden])", { timeout: 120000 });
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.click("#gifSaveBtn")]);
  await dl.saveAs(`${OUT}/builder.gif`);
  log(`GIF in ${((Date.now() - t1) / 1000).toFixed(1)}s: ${await page.textContent("#gifNote")}`);
}

// ---- share link (short if the dev store is running)
await page.click("#shareBtn");
await page.waitForFunction(() => /copied|Couldn't/.test(document.querySelector("#shareNote").textContent), null, { timeout: 20000 });
const link = await page.evaluate(() => navigator.clipboard.readText());
log(`share link: ${link.length} chars: ${link.slice(0, 90)}${link.length > 90 ? "…" : ""}`);

// ---- open it as a friend
const friend = await ctx.newPage();
watch(friend, "friend");
await friend.goto(link);
await friend.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Hit play"), null, { timeout: 120000 });
log(`friend sees: "${(await friend.textContent("#replayIntro h2")).trim()}", guess button visible: ${await friend.isVisible("#guessBtn")}`);
await setScrub(friend, "max");
await friend.waitForTimeout(300);
const friendPixels = await grab(friend);
log(`friend's final picture identical to sender's: ${friendPixels.length === senderPixels.length && friendPixels.every((v, i) => v === senderPixels[i])}`);
await setScrub(friend, 40);
await friend.click("#guessBtn");
log(`guess: ${await friend.textContent("#guessText")} | composition shown: ${await friend.isVisible("#composition")}`);
await friend.click("#challengeBtn");
await friend.waitForTimeout(200);
log(`challenge clipboard: ${(await friend.evaluate(() => navigator.clipboard.readText())).slice(0, 110)}…`);
await friend.screenshot({ path: `${OUT}/4_friend.png`, fullPage: false });

// ---- the landing page's demo round
{
  const demo = await ctx.newPage();
  watch(demo, "demo");
  await demo.goto(URL);
  await demo.screenshot({ path: `${OUT}/0_landing.png` });
  await demo.click("#demoBtn");
  await demo.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Hit play"), null, { timeout: 120000 });
  log(`demo: ${(await demo.textContent("#replayIntro p")).trim().slice(0, 60)}… hero buttons hidden: ${!(await demo.isVisible("#heroCtas"))}`);
  await setScrub(demo, 12);
  await demo.click("#guessBtn");
  log(`demo guess: ${await demo.textContent("#guessText")}`);
  await demo.screenshot({ path: `${OUT}/0_demo.png` });
  await demo.close();
}

// ---- broken links fail gracefully
for (const bad of ["#r=AQEsAAAA", "#s=nope.AAAAAAAAAAAAAAAAAAAAAA"]) {
  const p = await ctx.newPage();
  watch(p, "broken");
  await p.goto(URL + bad);
  await p.waitForTimeout(1200);
  log(`broken link ${bad.slice(0, 4)}: ${(await p.textContent("#replayIntro p")).trim()}`);
  await p.close();
}

// ---- phone layout
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
watch(phone, "phone");
await phone.goto(URL);
await phone.click("[data-sample=astronaut]");
await phone.waitForTimeout(400);
log(`phone horizontal overflow px: ${await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)}`);

// live tile servers send some error pages without CORS headers (those tiles are skipped)
const LIVE = /astro\.arcgis\.com|trek\.nasa\.gov|cdn\.esa(hubble|webb)\.org|gibs\.earthdata\.nasa\.gov|janelia-cosem-datasets/;
const real = errors.filter((e) => !(/blocked by CORS policy/.test(e) && LIVE.test(e)) && !/console: .*net::ERR_FAILED/.test(e));
log(real.length ? "ERRORS:\n" + real.join("\n") : "no unexpected console errors");
await browser.close();
