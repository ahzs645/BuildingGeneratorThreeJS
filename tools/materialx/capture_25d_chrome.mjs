import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4173";
const mode = process.argv[4] ?? "fis";
if (!["fis", "prefilter"].includes(mode)) throw new Error(`invalid 2.5D MaterialX mode: ${mode}`);
const output = path.resolve(process.argv[3] ?? (
  mode === "prefilter"
    ? "docs/materialx-evidence/current/25d-prefilter-web.png"
    : "docs/materialx-evidence/current/25d-native-web.png"
));
const readiness = mode === "prefilter" ? "materialx-prefilter" : "materialx-native";
const captureTimeout = Number(process.env.NODE_DOJO_CAPTURE_TIMEOUT_MS ?? 240_000);
if (!Number.isFinite(captureTimeout) || captureTimeout < 1_000) {
  throw new Error(`NODE_DOJO_CAPTURE_TIMEOUT_MS must be at least 1000: ${captureTimeout}`);
}
const executablePath = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find(fs.existsSync);
if (!executablePath) throw new Error("Chrome or Chromium is required for 2.5D MaterialX capture");
fs.mkdirSync(path.dirname(output), { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  protocolTimeout: Math.max(300_000, captureTimeout + 60_000),
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
    `${baseUrl}/chrome-assets?asset=25d-chrome-crayon&capture=${readiness}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForFunction(
    (expected) => document.documentElement.dataset.chromeAssetsReady === expected,
    { timeout: captureTimeout },
    readiness,
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (errors.length) throw new Error(`2.5D MaterialX browser errors:\n${errors.join("\n")}`);
  const canvas = await page.$("#assets-canvas");
  if (!canvas) throw new Error("2.5D MaterialX capture canvas missing");
  await canvas.screenshot({ path: output });
  console.log(`MATERIALX_25D_WEB_REFERENCE ${JSON.stringify({ output, mode, readiness })}`);
} finally {
  await browser.close();
}
