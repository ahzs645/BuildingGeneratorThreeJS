// Capture one local BlendBridge dump using its actual browser runtime.
// Usage:
//   node tools/capture_blend_studio_dump.mjs \
//     BASE_URL DUMP.json TARGET_LABEL OUTPUT.png [TARGET_GROUP]
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const [, , baseUrl = "http://127.0.0.1:5173", dumpArg, targetLabel, outputArg, targetGroup] = process.argv;
if (!dumpArg || !targetLabel || !outputArg) {
  throw new Error("usage: BASE_URL DUMP.json TARGET_LABEL OUTPUT.png [TARGET_GROUP]");
}

const executablePath = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find(fs.existsSync);
if (!executablePath) throw new Error("Chrome or Chromium is required");

const dumpPath = path.resolve(dumpArg);
const outputPath = path.resolve(outputArg);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  protocolTimeout: 360_000,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 768, height: 768, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:"))
      errors.push(message.text());
  });
  const url = new URL("/blendbridge", baseUrl);
  url.searchParams.set("capture", "font-parity");
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 120_000 });
  const input = await page.waitForSelector('input[type="file"]', { timeout: 30_000 });
  await input.uploadFile(dumpPath);
  await page.waitForFunction(() => {
    const select = document.querySelector(".blend-field select");
    return select instanceof HTMLSelectElement
      && !select.disabled
      && [...select.options].some((option) => option.value);
  }, { timeout: 120_000 });

  const selected = await page.evaluate(({ label, group }) => {
    const select = document.querySelector(".blend-field select");
    if (!(select instanceof HTMLSelectElement)) throw new Error("execution target selector missing");
    const options = [...select.options];
    const option = options.find((candidate) => {
      if (!candidate.textContent?.includes(label)) return false;
      if (!group) return true;
      const value = candidate.value;
      return decodeURIComponent(value).includes(group);
    });
    if (!option) {
      throw new Error(`target not found: ${label}; available=${options.map((item) => item.textContent).join(" | ")}`);
    }
    select.value = option.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { value: option.value, text: option.textContent };
  }, { label: targetLabel, group: targetGroup });

  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === "Apply to preview");
    return button instanceof HTMLButtonElement && !button.disabled;
  }, { timeout: 30_000 });
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === "Apply to preview");
    if (!(button instanceof HTMLButtonElement)) throw new Error("Apply to preview button missing");
    button.click();
  });
  await page.waitForFunction(() => {
    const state = document.querySelector(".blend-runtime-status");
    return state?.classList.contains("ready") || state?.classList.contains("error");
  }, { timeout: 240_000 });
  const state = await page.evaluate(() => {
    const status = document.querySelector(".blend-runtime-status");
    const result = document.querySelector(".blend-result");
    return {
      state: status?.className ?? null,
      message: status?.textContent?.trim() ?? null,
      result: result?.textContent?.trim() ?? null,
    };
  });
  if (!state.state?.includes("ready")) {
    throw new Error(`browser evaluation failed: ${JSON.stringify(state)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const dataUrl = await page.$eval("#blend-studio-canvas", (canvas) => {
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error("BlendBridge canvas missing");
    return canvas.toDataURL("image/png");
  });
  fs.writeFileSync(outputPath, Buffer.from(dataUrl.split(",", 2)[1], "base64"));
  const metadata = {
    schemaVersion: 1,
    dump: dumpPath,
    target: selected,
    capture: {
      resolution: [768, 768],
      camera: "BlendBridge perspective 42deg; fitted bounding sphere; position coefficients [0.72,0.48,0.92]",
      cameraState: JSON.parse(
        await page.evaluate(() => document.documentElement.dataset.blendStudioCaptureCamera ?? "null"),
      ),
      background: "#ff00ff",
      grid: false,
    },
    state,
    errors,
  };
  fs.writeFileSync(outputPath.replace(/\.png$/i, ".json"), `${JSON.stringify(metadata, null, 2)}\n`);
  if (errors.length) throw new Error(`browser capture emitted errors: ${errors.join(" | ")}`);
  console.log(`BLEND_STUDIO_CAPTURE_OK ${JSON.stringify({ output: outputPath, target: selected, state })}`);
} finally {
  await browser.close();
}
