import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4173";
const asset = process.argv[3];
const output = process.argv[4];
const lightScale = process.argv[5];
const previewMode = process.argv[6];
const overridesPayload = process.argv[7];
const backgroundHex = process.env.NODE_DOJO_CAPTURE_BACKGROUND_HEX ?? process.argv[8];
const sampleCount = process.env.NODE_DOJO_CAPTURE_SAMPLES;

if (!asset || !output) {
  throw new Error(
    "usage: node tools/capture_authored_asset.mjs BASE_URL ASSET_ID OUTPUT.png [LIGHT_SCALE] [PREVIEW_MODE] [OVERRIDES_JSON] [BACKGROUND_HEX]",
  );
}
if (lightScale !== undefined && (!Number.isFinite(Number(lightScale)) || Number(lightScale) <= 0)) {
  throw new Error(`invalid light scale: ${lightScale}`);
}
if (previewMode !== undefined && !["authored", "diagnostic", "workbench", "materialx-native"].includes(previewMode)) {
  throw new Error(`invalid preview mode: ${previewMode}`);
}
const overrides = overridesPayload === undefined ? null : JSON.parse(overridesPayload);
if (overrides !== null && (typeof overrides !== "object" || Array.isArray(overrides))) {
  throw new Error("OVERRIDES_JSON must be an object keyed by exposed control name");
}
if (backgroundHex !== undefined && !/^[0-9a-f]{6}$/i.test(backgroundHex)) {
  throw new Error("BACKGROUND_HEX must contain exactly six hexadecimal digits");
}
if (sampleCount !== undefined && (!Number.isInteger(Number(sampleCount)) || Number(sampleCount) < 1)) {
  throw new Error(`NODE_DOJO_CAPTURE_SAMPLES must be a positive integer: ${sampleCount}`);
}

const executablePath = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find(fs.existsSync);
if (!executablePath) throw new Error("Chrome or Chromium is required for authored-material capture");

const resolvedOutput = path.resolve(output);
fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
const route = new URL("/chrome-assets", baseUrl);
route.searchParams.set("asset", asset);
route.searchParams.set("capture", "authored");
if (lightScale !== undefined) route.searchParams.set("lightScale", lightScale);
if (previewMode !== undefined) route.searchParams.set("preview", previewMode);
if (sampleCount !== undefined) route.searchParams.set("samples", sampleCount);

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

  await page.goto(route.href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.documentElement.dataset.chromeAssetsReady !== undefined,
    { timeout: 240_000 },
  );
  if (backgroundHex !== undefined) {
    await page.evaluate((color) => {
      const value = `#${color}`;
      for (const element of document.querySelectorAll(".assets-shell, .assets-compare, .assets-pane")) {
        if (element instanceof HTMLElement) element.style.background = value;
      }
    }, backgroundHex);
  }
  if (overrides && Object.keys(overrides).length) {
    await page.evaluate((values) => {
      delete document.documentElement.dataset.chromeAssetsReady;
      for (const [name, value] of Object.entries(values)) {
        const inputs = [...document.querySelectorAll(`[data-control="${CSS.escape(name)}"]`)];
        if (!inputs.length) throw new Error(`capture override control missing: ${name}`);
        for (const input of inputs) {
          if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) continue;
          if (input instanceof HTMLInputElement && input.type === "checkbox") {
            input.checked = Boolean(value);
          } else if (Array.isArray(value) && input instanceof HTMLInputElement) {
            const axis = Number(input.dataset.axis);
            input.value = String(value[axis]);
          } else {
            input.value = String(value);
          }
          input.dataset.dirty = "true";
          input.dispatchEvent(new Event(input instanceof HTMLInputElement && input.type === "range" ? "input" : "change", {
            bubbles: true,
          }));
        }
      }
    }, overrides);
    await page.waitForFunction(
      () => document.documentElement.dataset.chromeAssetsReady !== undefined,
      { timeout: 240_000 },
    );
  }
  await page.evaluate(() => new Promise((resolve) => (
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  )));
  if (sampleCount !== undefined) {
    await page.waitForFunction(
      () => document.querySelector("#assets-canvas")?.dataset.captureReady === "true",
      { timeout: 240_000 },
    );
  }
  if (errors.length) throw new Error(`authored-material browser errors:\n${errors.join("\n")}`);

  const canvas = await page.$("#assets-canvas");
  if (!canvas) throw new Error("authored-material capture canvas missing");
  await canvas.screenshot({ path: resolvedOutput });
  const result = await page.evaluate(() => ({
    readiness: document.documentElement.dataset.chromeAssetsReady,
    count: document.querySelector("#assets-vm-count")?.textContent ?? null,
    status: document.querySelector("#assets-status")?.textContent ?? null,
  }));
  console.log(`AUTHORED_ASSET_WEB_REFERENCE ${JSON.stringify({
    asset,
    output: resolvedOutput,
    lightScale: lightScale === undefined ? null : Number(lightScale),
    previewMode: previewMode ?? "authored",
    backgroundHex: backgroundHex ?? "ff00ff",
    samples: sampleCount === undefined ? null : Number(sampleCount),
    overrides,
    ...result,
  })}`);
} finally {
  await browser.close();
}
process.exit(0);
