import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4174";
const output = path.resolve(process.argv[3] ?? "docs/materialx-evidence/baked/noise-bump-baked-web.png");
const query = process.argv[4] ?? "";
const executablePath = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find(fs.existsSync);
if (!executablePath) throw new Error("Chrome or Chromium is required");
fs.mkdirSync(path.dirname(output), { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 768, height: 768, deviceScaleFactor: 1 });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/tools/materialx/bake/index.html${query ? `?${query}` : ""}`, { waitUntil: "networkidle0" });
  try {
    await page.waitForFunction(
      () => document.documentElement.dataset.bakedReady === "true" || Boolean(document.documentElement.dataset.bakedError),
      { timeout: 30_000 },
    );
  } catch (error) {
    const dataset = await page.evaluate(() => ({ ...document.documentElement.dataset }));
    throw new Error(`Baked lab timed out; dataset=${JSON.stringify(dataset)}; console=${errors.join(" | ")}`, { cause: error });
  }
  const bakedError = await page.evaluate(() => document.documentElement.dataset.bakedError);
  if (bakedError) throw new Error(`Baked lab failed: ${bakedError}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const canvas = await page.$("#baked-canvas");
  if (!canvas) throw new Error("Baked validation canvas missing");
  await canvas.screenshot({ path: output });
  if (errors.length) throw new Error(`Browser errors:\n${errors.join("\n")}`);
  console.log(`MATERIALX_BAKED_WEB_REFERENCE ${output}`);
} finally {
  await browser.close();
}
