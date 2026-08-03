import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { createServer } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Chrome was not found. Set CHROME_BIN to run the responsive Bin regression.");
  return executable;
}

async function waitForRuntime(page) {
  await page.waitForFunction(() => window.__BIN_COMPARE__?.ready === true, { timeout: 120_000 });
}

async function snapshot(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    };
    const input = document.querySelector('[data-bin-param="Size X"]');
    return {
      mobile: matchMedia("(max-width: 820px), ((pointer: coarse) and (max-height: 500px))").matches,
      viewport: box(".st-viewport"),
      canvas: box("#app"),
      dockCount: document.querySelectorAll(".st-dock-left").length,
      sheetCount: document.querySelectorAll(".st-sheet").length,
      inputCount: document.querySelectorAll('[data-bin-param="Size X"]').length,
      sizeX: input?.value,
      workspace: document.querySelector("#workspace-validate")?.getAttribute("aria-selected"),
      split: document.querySelector("#mode-split")?.getAttribute("aria-pressed"),
      overlay: document.querySelector("#mode-overlay")?.getAttribute("aria-pressed"),
      status: document.querySelector("#compare-status")?.textContent?.trim(),
      search: location.search,
    };
  });
}

async function setExactValue(page, name, value) {
  await page.evaluate((parameterName, nextValue) => {
    const field = document.querySelector(`[data-bin-output="${parameterName}"]`);
    field.value = String(nextValue);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }, name, value);
}

async function openSheet(page) {
  const isOpen = await page.$eval(".st-sheet", (element) => element.classList.contains("is-open"));
  if (!isOpen) await page.click(".st-sheet-handle");
  await page.waitForFunction(() => document.querySelector(".st-sheet")?.classList.contains("is-open"));
}

async function crossBreakpoint(page, viewport, mobile) {
  const token = `${viewport.width}-${viewport.height}-${Date.now()}`;
  await page.$eval("#app", (canvas, value) => { canvas.dataset.responsiveTestToken = value; }, token);
  await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
  await page.waitForFunction((expectedMobile, previousToken) => {
    const matches = matchMedia("(max-width: 820px), ((pointer: coarse) and (max-height: 500px))").matches;
    const canvas = document.querySelector("#app");
    return matches === expectedMobile && canvas?.dataset.responsiveTestToken !== previousToken;
  }, { timeout: 30_000 }, mobile, token);
  await waitForRuntime(page);
}

const server = await createServer({
  root: repo,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
});
let browser;

try {
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await puppeteer.launch({
    executablePath: chromeExecutable(),
    headless: "shell",
    args: ["--enable-unsafe-swiftshader", "--no-sandbox"],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // Tablet/compact desktop: the historical regression left only ~224px for
  // the canvas at this exact size.
  await page.setViewport({ width: 900, height: 800, deviceScaleFactor: 1 });
  await page.goto(`${origin}/bin`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await waitForRuntime(page);
  let state = await snapshot(page);
  assert.equal(state.mobile, false);
  assert.equal(state.dockCount, 1);
  assert.equal(state.sheetCount, 0);
  assert.equal(state.inputCount, 1);
  assert(state.viewport.width >= 400, `900px viewport collapsed to ${state.viewport.width}px`);
  assert(Math.abs(state.viewport.width - state.canvas.width) < 1);
  assert(Math.abs(state.viewport.height - state.canvas.height) < 1);

  // Build an unsaved draft and a non-default runtime view before crossing the
  // breakpoint. All three must survive the React dock replacement.
  await setExactValue(page, "Size X", 1.551);
  await page.click("#workspace-validate");
  await page.focus("#workspace-validate");
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.querySelector("#workspace-build")?.getAttribute("aria-selected") === "true");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "workspace-build");
  await page.keyboard.press("End");
  await page.waitForFunction(() => document.querySelector("#workspace-validate")?.getAttribute("aria-selected") === "true");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "workspace-validate");
  await page.click("#mode-split");
  state = await snapshot(page);
  assert.equal(state.sizeX, "1.551");
  assert.equal(state.workspace, "true");
  assert.equal(state.split, "true");
  assert.match(state.search, /workspace=validate/);
  assert.match(state.search, /layout=split/);

  // Tool shortcuts must not fire while a form control is being edited.
  await page.focus('[data-bin-output="Size X"]');
  await page.keyboard.press("o");
  await page.keyboard.press("1");
  state = await snapshot(page);
  assert.equal(state.split, "true");
  assert.equal(state.overlay, "false");

  // The canvas is keyboard reachable and provides a visible focus ring. From
  // there shortcuts are intentional and should remain operational.
  await page.focus("#app");
  const focus = await page.evaluate(() => {
    const canvas = document.querySelector("#app");
    const style = getComputedStyle(canvas);
    return { active: document.activeElement === canvas, outline: style.outlineStyle, width: style.outlineWidth };
  });
  assert.equal(focus.active, true);
  assert.notEqual(focus.outline, "none");
  assert.notEqual(focus.width, "0px");
  await page.keyboard.press("o");
  state = await snapshot(page);
  assert.equal(state.overlay, "true");

  await crossBreakpoint(page, { width: 390, height: 844 }, true);
  state = await snapshot(page);
  assert.equal(state.mobile, true);
  assert.equal(state.dockCount, 0);
  assert.equal(state.sheetCount, 1);
  assert.equal(state.inputCount, 1, "breakpoint rendered duplicate controls");
  assert.equal(state.sizeX, "1.551", "draft value was lost at the mobile breakpoint");
  assert.equal(state.workspace, "true", "workspace was lost at the mobile breakpoint");
  assert.equal(state.overlay, "true", "comparison view was lost at the mobile breakpoint");
  assert(state.viewport.height >= 500, `phone viewport collapsed to ${state.viewport.height}px`);
  assert.equal(await page.$eval("#compare-status", (element) => element.getAttribute("aria-live")), "polite");
  assert.equal(await page.$eval("#compare-status", (element) => element.getAttribute("aria-atomic")), "true");

  await openSheet(page);
  await page.click("#workspace-build");
  const mobileControls = await page.evaluate(() => {
    const slider = document.querySelector('[data-bin-param="Size X"]').getBoundingClientRect();
    const number = document.querySelector('[data-bin-output="Size X"]').getBoundingClientRect();
    return { sliderWidth: slider.width, numberWidth: number.width, sliderHeight: slider.height };
  });
  assert(mobileControls.sliderWidth >= 200, `mobile slider is only ${mobileControls.sliderWidth}px wide`);
  assert(mobileControls.numberWidth >= 68);
  assert(mobileControls.sliderHeight >= 32);
  await page.click("#workspace-validate");

  // Cross both sides of the exact boundary, then mutate the newly mounted
  // control. This catches runtimes that remain attached to discarded DOM.
  await crossBreakpoint(page, { width: 821, height: 800 }, false);
  state = await snapshot(page);
  assert.equal(state.mobile, false);
  assert(state.viewport.width >= 400, `821px viewport collapsed to ${state.viewport.width}px`);
  assert.equal(state.sizeX, "1.551");
  await crossBreakpoint(page, { width: 820, height: 800 }, true);
  await openSheet(page);
  await setExactValue(page, "Size X", 1.612);
  state = await snapshot(page);
  assert.equal(state.sizeX, "1.612");
  assert.match(state.search, /Size\+X=1.612/);
  assert.match(state.status, /Changes not compared with Blender/);

  assert.deepEqual(pageErrors, []);
  console.log("BIN_RESPONSIVE_OK 900x800 390x844 821x800 820x800");
} finally {
  await browser?.close();
  await server.close();
}
