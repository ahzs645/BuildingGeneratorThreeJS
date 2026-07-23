import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4173";
const outputDir = path.resolve(process.argv[3] ?? "docs/materialx-evidence/current");
const expectedImplementation = process.argv[4];
const executablePath = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find(fs.existsSync);
if (!executablePath) throw new Error("Chrome or Chromium is required for MaterialX reference capture");
fs.mkdirSync(outputDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 768, height: 768, deviceScaleFactor: 1 });
  for (const [variant, filename] of [["source", "chrome-source-web.png"], ["bump", "noise-bump-web.png"]]) {
    await page.goto(`${baseUrl}/materialx?capture=1&variant=${variant}&forceWebGL=1`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.documentElement.dataset.materialBackend === "materialx", { timeout: 30_000 });
    if (expectedImplementation) {
      await page.waitForFunction(
        (implementation) => document.documentElement.dataset.materialxImplementation === implementation,
        { timeout: 30_000 },
        expectedImplementation,
      );
    }
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const canvas = await page.$("#materialx-canvas");
    if (!canvas) throw new Error("MaterialX capture canvas missing");
    await canvas.screenshot({ path: path.join(outputDir, filename) });
    console.log(`MATERIALX_WEB_REFERENCE ${filename}`);
  }
  for (const light of ["key", "fill", "rim"]) {
    await page.goto(`${baseUrl}/materialx?capture=1&diagnostic=light-${light}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (selected) => document.documentElement.dataset.materialxImplementation === "official-essl-fis"
        && document.querySelector("#materialx-status")?.textContent?.includes(`${selected} light direction`),
      { timeout: 30_000 },
      light,
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const lightCanvas = await page.$("#materialx-canvas");
    if (!lightCanvas) throw new Error(`MaterialX ${light} diagnostic canvas missing`);
    const filename = `light-${light}-web.png`;
    await lightCanvas.screenshot({ path: path.join(outputDir, filename) });
    console.log(`MATERIALX_WEB_REFERENCE ${filename}`);
  }
  await page.goto(`${baseUrl}/materialx?capture=1&diagnostic=coordinates`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.documentElement.dataset.materialxImplementation === "official-essl-fis",
    { timeout: 30_000 },
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const diagnosticCanvas = await page.$("#materialx-canvas");
  if (!diagnosticCanvas) throw new Error("MaterialX diagnostic canvas missing");
  await diagnosticCanvas.screenshot({ path: path.join(outputDir, "coordinate-cardinals-web.png") });
  console.log("MATERIALX_WEB_REFERENCE coordinate-cardinals-web.png");
  await page.goto(`${baseUrl}/materialx?capture=1&diagnostic=geomprop-col`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.documentElement.dataset.materialxImplementation === "official-essl-fis"
      && document.querySelector("#materialx-status")?.textContent?.includes("typed col geometry property"),
    { timeout: 30_000 },
  );
  console.log("MATERIALX_WEB_SMOKE typed-col-geomprop");
  await page.goto(`${baseUrl}/materialx?capture=1&diagnostic=ui-normal-band`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.documentElement.dataset.materialxImplementation === "official-essl-fis"
      && document.querySelector("#materialx-status")?.textContent?.includes("UI normal-band semantic diagnostic"),
    { timeout: 30_000 },
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const uiCanvas = await page.$("#materialx-canvas");
  if (!uiCanvas) throw new Error("MaterialX UI normal-band diagnostic canvas missing");
  await uiCanvas.screenshot({ path: path.join(outputDir, "ui-normal-band-web.png") });
  console.log("MATERIALX_WEB_REFERENCE ui-normal-band-web.png");
} finally {
  await browser.close();
}
