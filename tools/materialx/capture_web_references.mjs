import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:4173";
const outputDir = path.resolve(process.argv[3] ?? "docs/materialx-evidence/current");
const expectedImplementation = process.argv[4];
const thinFilmSweep = process.argv.includes("--thin-film-sweep");
const roughnessFresnelOnly = process.argv.includes("--roughness-fresnel-only");
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
  const captureRoughnessFresnel = async () => {
    for (const [diagnostic, preset, filename] of [
      [
        "metal-roughness-fresnel-scalar",
        "roughness-fresnel-scalar-gold",
        "metal-roughness-fresnel-scalar-gold-web.png",
      ],
      [
        "metal-roughness-fresnel",
        "roughness-fresnel-gold",
        "metal-roughness-fresnel-gold-web.png",
      ],
    ]) {
      await page.goto(
        `${baseUrl}/materialx?capture=1&diagnostic=${diagnostic}`,
        { waitUntil: "domcontentloaded" },
      );
      await page.waitForFunction(
        (selectedPreset) => (
          document.documentElement.dataset.materialxImplementation === "official-essl-prefilter"
          && document.documentElement.dataset.materialxPreset === selectedPreset
        ),
        { timeout: 360_000 },
        preset,
      );
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const roughnessFresnelCanvas = await page.$("#materialx-canvas");
      if (!roughnessFresnelCanvas) throw new Error(`MaterialX ${preset} canvas missing`);
      await roughnessFresnelCanvas.screenshot({ path: path.join(outputDir, filename) });
      console.log(`MATERIALX_WEB_REFERENCE ${filename}`);
    }
  };
  if (roughnessFresnelOnly) {
    await captureRoughnessFresnel();
    await browser.close();
    process.exit(0);
  }
  if (thinFilmSweep) {
    const thicknesses = Array.from({ length: 61 }, (_, index) => index * 10);
    if (!thicknesses.includes(243)) thicknesses.push(243);
    thicknesses.sort((a, b) => a - b);
    for (const thickness of thicknesses) {
      await page.goto(
        `${baseUrl}/materialx?capture=1&diagnostic=metal-thin-film&thickness=${thickness}`,
        { waitUntil: "domcontentloaded" },
      );
      await page.waitForFunction(
        (selectedThickness) => (
          document.documentElement.dataset.materialxImplementation === "official-essl-prefilter"
          && document.documentElement.dataset.materialxPreset === "thin-film-gold"
          && document.documentElement.dataset.materialxThinFilm === String(selectedThickness)
        ),
        { timeout: 360_000 },
        thickness,
      );
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const sweepCanvas = await page.$("#materialx-canvas");
      if (!sweepCanvas) throw new Error(`MaterialX thin-film ${thickness} nm canvas missing`);
      const filename = `materialx-thinfilm-${thickness}.png`;
      await sweepCanvas.screenshot({ path: path.join(outputDir, filename) });
      console.log(`MATERIALX_WEB_SWEEP ${filename}`);
    }
    await browser.close();
    process.exit(0);
  }
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
  for (const environment of ["fis", "prefilter"]) {
    for (const roughness of [0, 2 / 15, 0.2610441]) {
      const slug = Number(roughness.toPrecision(7)).toString().replace(".", "p");
      await page.goto(
        `${baseUrl}/materialx?capture=1&diagnostic=roughness-sweep&environment=${environment}&roughness=${roughness}`,
        { waitUntil: "domcontentloaded" },
      );
      await page.waitForFunction(
        (selectedEnvironment, selectedRoughness) => (
          document.documentElement.dataset.materialxImplementation === `official-essl-${selectedEnvironment}`
          && document.documentElement.dataset.materialxRoughness === String(selectedRoughness)
        ),
        { timeout: 360_000 },
        environment,
        roughness,
      );
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const roughnessCanvas = await page.$("#materialx-canvas");
      if (!roughnessCanvas) throw new Error(`MaterialX ${environment} roughness ${roughness} canvas missing`);
      const filename = `roughness-${slug}-${environment}-web.png`;
      await roughnessCanvas.screenshot({ path: path.join(outputDir, filename) });
      console.log(`MATERIALX_WEB_REFERENCE ${filename}`);
    }
  }
  for (const preset of ["aluminum", "copper", "gold", "stainless-steel", "titanium"]) {
    await page.goto(
      `${baseUrl}/materialx?capture=1&diagnostic=metal-preset&preset=${preset}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForFunction(
      (selectedPreset) => (
        document.documentElement.dataset.materialxImplementation === "official-essl-prefilter"
        && document.documentElement.dataset.materialxPreset === selectedPreset
      ),
      { timeout: 360_000 },
      preset,
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const presetCanvas = await page.$("#materialx-canvas");
    if (!presetCanvas) throw new Error(`MaterialX metal preset ${preset} canvas missing`);
    const filename = `metal-preset-${preset}-web.png`;
    await presetCanvas.screenshot({ path: path.join(outputDir, filename) });
    console.log(`MATERIALX_WEB_REFERENCE ${filename}`);
  }
  await page.goto(
    `${baseUrl}/materialx?capture=1&diagnostic=metal-f82`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForFunction(
    () => (
      document.documentElement.dataset.materialxImplementation === "official-essl-prefilter"
      && document.documentElement.dataset.materialxPreset === "f82-gold"
    ),
    { timeout: 360_000 },
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const f82Canvas = await page.$("#materialx-canvas");
  if (!f82Canvas) throw new Error("MaterialX F82 Gold canvas missing");
  await f82Canvas.screenshot({ path: path.join(outputDir, "metal-f82-gold-web.png") });
  console.log("MATERIALX_WEB_REFERENCE metal-f82-gold-web.png");
  await page.goto(
    `${baseUrl}/materialx?capture=1&diagnostic=metal-layered-roughness`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForFunction(
    () => (
      document.documentElement.dataset.materialxImplementation === "official-essl-prefilter"
      && document.documentElement.dataset.materialxPreset === "layered-roughness-gold"
    ),
    { timeout: 360_000 },
  );
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const layeredRoughnessCanvas = await page.$("#materialx-canvas");
  if (!layeredRoughnessCanvas) throw new Error("MaterialX Gold layered-roughness canvas missing");
  await layeredRoughnessCanvas.screenshot({ path: path.join(outputDir, "metal-layered-roughness-gold-web.png") });
  console.log("MATERIALX_WEB_REFERENCE metal-layered-roughness-gold-web.png");
  await captureRoughnessFresnel();
  for (const [rotation, slug] of [[0, "r0"], [0.25, "r90"]]) {
    await page.goto(
      `${baseUrl}/materialx?capture=1&diagnostic=metal-anisotropy&rotation=${rotation}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForFunction(
      (selectedRotation) => (
        document.documentElement.dataset.materialxImplementation === "official-essl-prefilter"
        && document.documentElement.dataset.materialxPreset === "anisotropy-gold"
        && document.documentElement.dataset.materialxRotation === String(selectedRotation)
      ),
      { timeout: 360_000 },
      rotation,
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const anisotropyCanvas = await page.$("#materialx-canvas");
    if (!anisotropyCanvas) throw new Error(`MaterialX anisotropy ${slug} canvas missing`);
    const filename = `metal-anisotropy-gold-${slug}-web.png`;
    await anisotropyCanvas.screenshot({ path: path.join(outputDir, filename) });
    console.log(`MATERIALX_WEB_REFERENCE ${filename}`);
  }
  for (const thickness of [0, 243]) {
    await page.goto(
      `${baseUrl}/materialx?capture=1&diagnostic=metal-thin-film&thickness=${thickness}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForFunction(
      (selectedThickness) => (
        document.documentElement.dataset.materialxImplementation === "official-essl-prefilter"
        && document.documentElement.dataset.materialxPreset === "thin-film-gold"
        && document.documentElement.dataset.materialxThinFilm === String(selectedThickness)
      ),
      { timeout: 360_000 },
      thickness,
    );
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const thinFilmCanvas = await page.$("#materialx-canvas");
    if (!thinFilmCanvas) throw new Error(`MaterialX Gold thin-film ${thickness} nm canvas missing`);
    const filename = `metal-thin-film-gold-${thickness}nm-web.png`;
    await thinFilmCanvas.screenshot({ path: path.join(outputDir, filename) });
    console.log(`MATERIALX_WEB_REFERENCE ${filename}`);
  }
} finally {
  await browser.close();
}
