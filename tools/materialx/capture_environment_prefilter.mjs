import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4173";
const output = path.resolve(
  process.argv[3] ?? "docs/materialx-evidence/current/environment-prefilter-runtime.json",
);
const executablePath = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find(fs.existsSync);
if (!executablePath) throw new Error("Chrome or Chromium is required for MaterialX prefilter capture");

const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  protocolTimeout: 300_000,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/materialx`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const result = await page.evaluate(async () => {
    const diagnostic = await import("/src/materialx/prefilter-diagnostic.ts");
    return diagnostic.runMaterialXPrefilterDiagnostic();
  });
  if (errors.length) {
    throw new Error(`MaterialX prefilter browser errors:\n${errors.join("\n")}`);
  }
  const report = {
    reportVersion: 1,
    generated: new Date().toISOString(),
    sourceEnvironment: "public/materialx/references/studio-environment.exr",
    writerManifest: "public/materialx/generated/environment-prefilter/manifest.json",
    materialManifest: "public/materialx/generated/native-prefilter/manifest.json",
    implementation: "official MaterialX 1.39.4 ESSL/PREFILTER with a documented pow(float,int) compatibility rewrite",
    ...result,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`MATERIALX_ENVIRONMENT_PREFILTER ${JSON.stringify({ output, ...result })}`);
} finally {
  await browser.close();
}
