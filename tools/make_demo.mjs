// Builds the "Play a round" demo: the Mona Lisa, made in the real app with the default packs.
// Writes web/samples/demo-recipe.txt (a full recipe, so it works without a short-link store)
// and saves the 512 px picture and the pieces sheet to OUTDIR (for the link-preview image).
// Needs: the site served at URL, Google Chrome, and playwright-core (npm i playwright-core).
// Usage: node tools/make_demo.mjs URL OUTDIR
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [URL, OUT] = process.argv.slice(2);
const recipePath = fileURLToPath(new globalThis.URL("../web/samples/demo-recipe.txt", import.meta.url));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 1500 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
await page.route("**/health", (r) => r.abort()); // no short-link store: we want the full recipe
await page.goto(URL);
await page.click("[data-sample=mona]");
await page.waitForSelector("#cropArea:not([hidden])");
await page.click("#buildBtn");
await page.waitForFunction(() => document.querySelector("#status").textContent.startsWith("Done"), null, { timeout: 240000 });
console.log(await page.textContent("#composition"));

await page.click("#shareBtn");
await page.waitForFunction(() => /copied/.test(document.querySelector("#shareNote").textContent), null, { timeout: 20000 });
const link = await page.evaluate(() => navigator.clipboard.readText());
const code = link.split("#r=")[1];
if (!code) throw new Error(`expected a full recipe link, got ${link.slice(0, 80)}`);
writeFileSync(recipePath, code + "\n");
console.log(`demo recipe: ${code.length} characters -> ${recipePath}`);

const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#downloadBtn")]);
await dl.saveAs(`${OUT}/demo_face.png`);
const sheet = await page.evaluate(() => document.querySelector("#sheet").toDataURL("image/png"));
writeFileSync(`${OUT}/demo_sheet.png`, Buffer.from(sheet.split(",")[1], "base64"));
writeFileSync(`${OUT}/demo_composition.txt`, (await page.textContent("#composition")).trim());
console.log(`saved ${OUT}/demo_face.png, demo_sheet.png`);
await browser.close();
