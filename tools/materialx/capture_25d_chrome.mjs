import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4173";
const output = path.resolve(process.argv[3] ?? "docs/materialx-evidence/current/25d-native-web.png");
const executablePath = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find(fs.existsSync);
if (!executablePath) throw new Error("Chrome or Chromium is required for 2.5D MaterialX capture");
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
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400 && !new URL(response.url()).pathname.endsWith("/favicon.ico")) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.goto(
    `${baseUrl}/chrome-assets?asset=25d-chrome-crayon&capture=materialx-native`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForFunction(
    () => document.documentElement.dataset.chromeAssetsReady === "materialx-native",
    { timeout: 240_000 },
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (errors.length) throw new Error(`2.5D MaterialX browser errors:\n${errors.join("\n")}`);
  const canvas = await page.$("#assets-canvas");
  if (!canvas) throw new Error("2.5D MaterialX capture canvas missing");
  await canvas.screenshot({ path: output });
  console.log(`MATERIALX_25D_WEB_REFERENCE ${output}`);
} finally {
  await browser.close();
}
