/**
 * Does every asset in the library still load?
 *
 * The catalog is 104 entries, each pointing at a dump and a Blender reference
 * render, and nothing checked that any of them still resolve. A renamed file
 * under `public/dojo/` breaks one card in a grid of a hundred and four; a dump
 * whose shape drifted breaks the studio only for the person who happens to tap
 * that card. Neither shows up in `npm test`, and neither shows up in the
 * interface harnesses, which open the library and measure it without ever
 * picking anything out of it.
 *
 * So: every path on disk, then the overlay itself, then all 104 assets loaded
 * one at a time through `/?asset=<id>` — the same `loadLibraryAsset` path the
 * card takes — asserting each one installs and opens on the object the catalog
 * says it should.
 *
 * `npm run test:library`. It is a separate script from `npm test` for the same
 * reason the other two are: a hundred and four page loads through SwiftShader
 * take about twenty minutes. `LIBRARY_SAMPLE=12` samples the catalog instead,
 * evenly across it, for a quicker signal; the static and overlay checks always
 * run over the whole thing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer-core";
import { createServer } from "vite";

const CATALOG = "public/dojo/chrome-assets/catalog.json";
/** Files the catalog points at; the first two are what a card needs to work. */
const ASSET_PATHS = ["dump", "reference", "authoredReference", "shaderMetadata"];
/** libraryAssetCategory() in asset-library-model.ts assigns every asset one. */
const CATEGORIES = ["Drawing", "Text", "Stickers", "Fabrication", "Studies", "Scenes"];

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Chrome was not found. Set CHROME_BIN to run the asset library check.");
  return executable;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const failures = [];
const note = (message) => { failures.push(message); };
const check = (fn) => { try { fn(); } catch (error) { note(error.message); } };

const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));

// ---------------------------------------------------------------- on disk
// A missing file here is a card that cannot load, and it is answerable
// without a browser, so it is answered first and for all 104 regardless of
// LIBRARY_SAMPLE.
check(() => assert.ok(catalog.length > 0, "the catalog is empty"));
const ids = new Set();
for (const asset of catalog) {
  check(() => assert.ok(!ids.has(asset.id), `duplicate catalog id "${asset.id}"`));
  ids.add(asset.id);
  check(() => assert.ok(asset.title && asset.object && asset.dump,
    `catalog entry "${asset.id}" is missing a title, object or dump`));
  for (const key of ASSET_PATHS) {
    const relative = asset[key];
    if (!relative) continue;
    check(() => assert.ok(
      fs.existsSync(path.join("public", relative)),
      `"${asset.id}" points at ${key} "${relative}", which is not in public/`,
    ));
  }
  // Every asset lands in a category, and the chips only offer these six — an
  // asset outside them would be unreachable through the category filter.
  check(() => assert.ok(
    CATEGORIES.length === 6,
    "the category list in this file has drifted from asset-library-model.ts",
  ));
}

const sample = Number(process.env.LIBRARY_SAMPLE ?? 0);
const assets = sample > 0
  ? catalog.filter((_, index) => index % Math.ceil(catalog.length / sample) === 0)
  : catalog;

const server = await createServer({ server: { port: 0 }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await puppeteer.launch({
  executablePath: chromeExecutable(),
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--disable-dev-shm-usage"],
  headless: true,
});

/** Open the studio at a phone size with the sheet up, then the library. */
async function openLibrary(page) {
  await page.goto(`${base}/`, { waitUntil: "networkidle2", timeout: 120_000 });
  await page.waitForSelector(".st-nav-chip", { timeout: 20_000 }).catch(() => {});
  await sleep(2000);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const open = await page.evaluate(() => document.querySelector(".st-sheet")?.className.includes("is-open"));
    if (open) break;
    await page.click(".st-sheet-handle");
    await sleep(350);
  }
  const index = await page.$$eval(".st-sheet button",
    (buttons) => buttons.findIndex((one) => one.textContent?.includes("Browse asset library")));
  if (index < 0) return false;
  await page.evaluate((one) => { document.querySelectorAll(".st-sheet button")[one].click(); }, index);
  await sleep(2000);
  return true;
}

const grid = () => ({
  cards: document.querySelectorAll(".asset-library-card").length,
  message: document.querySelector(".asset-library-message")?.textContent?.trim() ?? null,
});

try {
  // ------------------------------------------------------------- the overlay
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    try {
      const opened = await openLibrary(page);
      check(() => assert.ok(opened, "the sheet has no way into the asset library"));

      // Thumbnails are loading="lazy" in a scroll container, so an unscrolled
      // grid reports most of them as not-loaded. Scroll first, then judge —
      // the first version of this check called 88 unrequested images broken.
      await page.evaluate(async () => {
        const list = document.querySelector(".asset-library-grid");
        for (let y = 0; y <= list.scrollHeight; y += list.clientHeight) {
          list.scrollTop = y;
          await new Promise((resolve) => { setTimeout(resolve, 120); });
        }
        list.scrollTop = 0;
      });
      await sleep(4000);
      const rendered = await page.evaluate(() => ({
        cards: document.querySelectorAll(".asset-library-card").length,
        broken: [...document.querySelectorAll(".asset-library-grid img")]
          .filter((img) => !(img.complete && img.naturalWidth > 0))
          .map((img) => img.getAttribute("src")),
      }));
      check(() => assert.equal(
        rendered.cards, catalog.length,
        `the grid shows ${rendered.cards} cards for a catalog of ${catalog.length}`,
      ));
      check(() => assert.deepEqual(
        rendered.broken, [],
        `${rendered.broken.length} reference render(s) did not load: ${rendered.broken.slice(0, 5).join(", ")}`,
      ));

      // Every category chip has to lead somewhere. A category that filters to
      // nothing is a chip that looks broken.
      for (const category of CATEGORIES) {
        const index = await page.$$eval(".asset-library-categories button",
          (buttons, want) => buttons.findIndex((one) => one.textContent.trim() === want), category);
        if (index < 0) { note(`the library has no "${category}" chip`); continue; }
        await page.evaluate((one) => { document.querySelectorAll(".asset-library-categories button")[one].click(); }, index);
        await sleep(400);
        const state = await page.evaluate(grid);
        check(() => assert.ok(state.cards > 0, `the "${category}" chip filters to an empty grid`));
      }
      const all = await page.$$eval(".asset-library-categories button",
        (buttons) => buttons.findIndex((one) => one.textContent.trim() === "All"));
      await page.evaluate((one) => { document.querySelectorAll(".asset-library-categories button")[one].click(); }, all);
      await sleep(400);

      // An empty Recent or Favorites is not a failed search, and used to say
      // it was: `No assets match “”.`, quoting a query nobody typed.
      for (const [label, expected] of [["Recent", /opened|Recent/i], ["★ Favorites", /favorite/i]]) {
        const index = await page.$$eval(".asset-library-views button",
          (buttons, want) => buttons.findIndex((one) => one.textContent.trim() === want), label);
        await page.evaluate((one) => { document.querySelectorAll(".asset-library-views button")[one].click(); }, index);
        await sleep(400);
        const state = await page.evaluate(grid);
        if (state.cards === 0) {
          check(() => assert.ok(
            state.message && !/match “”/.test(state.message) && expected.test(state.message),
            `an empty ${label} says "${state.message}"`,
          ));
        }
        await page.evaluate((one) => { document.querySelectorAll(".asset-library-views button")[one].click(); }, index);
        await sleep(300);
      }
    } catch (error) {
      note(`the asset library overlay: ${error.message}`);
    } finally {
      await page.close();
    }
  }

  // Search, from a page of its own so no view or category can leak into it.
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    try {
      await openLibrary(page);
      await page.type(".asset-library > header input", "crayon");
      await sleep(700);
      const hit = await page.evaluate(grid);
      check(() => assert.ok(hit.cards > 0, `searching "crayon" found nothing in a catalog that ports several`));
      check(() => assert.ok(hit.cards < catalog.length, "searching narrowed nothing"));
      await page.evaluate(() => {
        const input = document.querySelector(".asset-library > header input");
        // React tracks the value setter, so assigning .value directly is not
        // seen; go through the prototype setter and then fire input.
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
          .set.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await sleep(600);
      const cleared = await page.evaluate(grid);
      check(() => assert.equal(
        cleared.cards, catalog.length,
        `clearing the search left ${cleared.cards} of ${catalog.length} cards`,
      ));
    } catch (error) {
      note(`the asset library search: ${error.message}`);
    } finally {
      await page.close();
    }
  }

  // -------------------------------------------------------------- every asset
  // `/?asset=<id>` is the deep link the parity lab uses and it runs the same
  // loadLibraryAsset the card runs, so this is the library sweep without
  // driving the modal a hundred and four times.
  process.stdout.write(`  loading ${assets.length} asset${assets.length === 1 ? "" : "s"}\n`);
  for (const [index, asset] of assets.entries()) {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error).slice(0, 160)));
    page.on("response", (response) => {
      // The Blender bridge on :7801 is a local-only probe and answers nothing
      // in CI by design; every other 4xx/5xx is this asset failing to load.
      if (response.status() >= 400 && !response.url().includes(":7801")) {
        errors.push(`${response.status()} ${response.url().replace(base, "")}`);
      }
    });
    try {
      await page.goto(`${base}/?asset=${encodeURIComponent(asset.id)}`, { waitUntil: "networkidle2", timeout: 120_000 });
      await page.waitForSelector(".st-nav-chip", { timeout: 20_000 }).catch(() => {});
      // Wait for the install rather than for a fixed delay: the source card
      // names the asset only once installDump() has run.
      await page.waitForFunction(
        (title) => document.querySelector(".st-card b")?.textContent?.includes(title.slice(0, 18)),
        { timeout: 40_000 },
        asset.title,
      ).catch(() => {});
      const read = await page.evaluate(() => {
        const select = document.querySelector(".st-sheet select, .st-dock select");
        return {
          card: document.querySelector(".st-card b")?.textContent?.trim() ?? null,
          target: select?.selectedOptions?.[0]?.textContent?.trim() ?? null,
          targets: select ? select.options.length : 0,
          panel: document.querySelector(".st-sheet-body, .st-dock")?.textContent ?? "",
        };
      });
      check(() => assert.ok(
        read.card && asset.title.startsWith(read.card.slice(0, 15)),
        `"${asset.id}" installed as "${read.card}"`,
      ));
      check(() => assert.ok(read.targets > 0, `"${asset.id}" installed with no runnable target`));
      // The card shows one object; the studio must open on that object, not on
      // whichever target happened to be discovered first.
      check(() => assert.ok(
        read.target?.includes(asset.object),
        `"${asset.id}" is "${asset.object}" in the catalog and opened on "${read.target}"`,
      ));
      check(() => assert.ok(
        !/Asset failed/.test(read.panel),
        `"${asset.id}": ${/Asset failed[^.]*/.exec(read.panel)?.[0] ?? "the studio reported a failure"}`,
      ));
      for (const error of errors) note(`"${asset.id}": ${error}`);
    } catch (error) {
      note(`"${asset.id}": ${error.message}`);
    } finally {
      await page.close();
    }
    if ((index + 1) % 20 === 0) process.stdout.write(`  ${index + 1}/${assets.length}\n`);
  }
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} asset library failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`\nok — ${catalog.length} catalog entries on disk, the overlay filters and searches, `
    + `and ${assets.length} asset${assets.length === 1 ? "" : "s"} loaded into the studio.`);
}
