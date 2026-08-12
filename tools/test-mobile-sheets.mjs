/**
 * Rendered-result cover for the phone's own controls.
 *
 * tools/test-interface-measurements.mjs sweeps ten routes at six viewports and
 * has never measured a single control a phone user taps. Everything the mobile
 * layout owns lives inside `.st-sheet`, the sheet starts collapsed, and a
 * collapsed sheet sets [hidden] on its body — so `getClientRects()` is empty
 * for every button, select and checkbox in it and the sweep's own
 * `visible()` filter drops them all. It measured the handle and nothing behind
 * it. The 28px checkboxes and the 9px labels recorded as "known and unfixed"
 * in docs/INTERFACE_REVIEW.md were not judgement calls the harness made; they
 * were pixels it could not see.
 *
 * So this file drives the thing. It taps the handle through all three detents,
 * walks every tab with the sheet genuinely open, and asserts against what the
 * layout produced: that the cycle returns where it started, that exactly one
 * panel is ever visible, that the panel a detent opens is big enough to work,
 * that content taller than it can be scrolled to, and that the controls inside
 * hold the same 44px and 11px minimums the rest of the app is held to. It also
 * exercises the two mobile-only surfaces the static sweep never opens: the
 * node-graph FAB with its full-screen overlay, and the tool directory.
 *
 * Run it with `npm run test:mobile`. It is not in `npm test` for the same
 * reason the interface measurements are not: it drives a real browser through
 * SwiftShader and takes minutes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import process from "node:process";
import puppeteer from "puppeteer-core";
import { createServer } from "vite";

/** The two phone shapes the shell has separate layout rules for. */
const VIEWPORTS = [
  { name: "390×844", width: 390, height: 844 },
  { name: "844×390", width: 844, height: 390 },
];

/**
 * Every route, plus the two states that only a query parameter reaches: the
 * putty engine behind `/paint`, and the one Parity Catalog asset that renders
 * a node-graph entry point.
 */
const ROUTES = [
  "/", "/building", "/gallery", "/bin", "/vase",
  "/crayon", "/typewriter", "/chrome-assets?asset=type-pixel-brush",
  "/paint", "/paint?engine=putty", "/materialx",
];

/** The app's own mobile minimum (`--st-touch`), applied to what it opens. */
const TOUCH = 44;
/** The kit's stated type floor for anything read as text. */
const TYPE_FLOOR = 11;
/**
 * A detent that opens the panels has to open enough of them to work one
 * control. 44px is one touch-sized row; below that the sheet is showing the
 * top edge of a label and nothing else — which is what 34dvh did at 844×390,
 * where the handle and the tab strip took 88px of a 133px sheet and left 17.
 */
const MIN_PANEL = TOUCH;

/**
 * Excluded from the target sweep, matching the static harness: the slider is
 * deliberately sized by the kit, the file input is hidden behind its own
 * label, and the graph canvas is a third-party surface the kit exempts by name.
 */
const TARGET_EXCLUDES = [
  'input[type="range"]', 'input[type="file"]',
  '.react-flow *', '.blender-flow-wrap *',
];
/**
 * And more for type. lil-gui ships its own 8–11px skin, `surface-painter.css`
 * restyles it rather than replacing it, and docs/INTERFACE_REVIEW.md records
 * that skin as out of scope; its *controls* are still measured, since the same
 * file claims `--widget-height: var(--st-touch)` for them.
 *
 * The other three are the kit's own named exceptions, quoted from the comment
 * that declares the 11px floor in studio-kit.css: "the rail's 9px section
 * names, the 10px metric captions, and the 9px node-category badges". They are
 * listed here rather than silently passing, because a list is the difference
 * between an exception and a leak — `.st-metric span` is the one that carries
 * a phone-visible sentence today (see docs/INTERFACE_REVIEW.md).
 */
const TYPE_EXCLUDES = [
  ...TARGET_EXCLUDES, ".lil-gui *",
  ".st-rail a", ".st-metric span", ".st-node-badge",
];

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("Chrome was not found. Set CHROME_BIN to run the mobile sheet measurements.");
  return executable;
}

/**
 * Installed once per page, so the sheet, the asset library and the tool
 * directory all measure a target the same way.
 *
 * A tap area does not have to be visible. The library's favourite star is a
 * 30px circle in a 180px card and reaches 44px through
 * `::after { position: absolute; inset: -7px }` — a deliberate pattern, and one
 * `getBoundingClientRect()` cannot see, so the first run of this file reported
 * 104 stars as sub-minimum targets. Negative insets on an absolutely-positioned
 * pseudo-element grow the box they sit in, and that growth is the target.
 */
function installTargetMeasure() {
  window.__stTarget = (element) => {
    const rect = element.getBoundingClientRect();
    let growX = 0;
    let growY = 0;
    for (const pseudo of ["::before", "::after"]) {
      const style = getComputedStyle(element, pseudo);
      if (!style.content || style.content === "none" || style.position !== "absolute") continue;
      const inset = ["top", "right", "bottom", "left"].map((side) => Number.parseFloat(style[side]));
      if (inset.some((one) => Number.isNaN(one))) continue;
      const [top, right, bottom, left] = inset;
      growX = Math.max(growX, Math.max(0, -left) + Math.max(0, -right));
      growY = Math.max(growY, Math.max(0, -top) + Math.max(0, -bottom));
    }
    return { w: +(rect.width + growX).toFixed(1), h: +(rect.height + growY).toFixed(1) };
  };
}

/**
 * One settled read of the sheet and the two surfaces that sit beside it.
 * Everything this file asserts comes from here, so a route is visited once per
 * viewport rather than once per assertion.
 */
function readSheet({ targetExcludes, typeExcludes, touch, typeFloor }) {
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      w: +rect.width.toFixed(1), h: +rect.height.toFixed(1),
      top: +rect.top.toFixed(1), bottom: +rect.bottom.toFixed(1),
      left: +rect.left.toFixed(1), right: +rect.right.toFixed(1),
    };
  };
  const visible = (element) => element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== "hidden";
  const name = (element) => (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)
    || element.getAttribute("aria-label") || element.getAttribute("title") || element.tagName;
  /**
   * "Past the panel's right edge" is not the same as "out of reach", and the
   * difference is the whole of this helper. The Surface Studio's brush rail is
   * a horizontal scroller inside the sheet: seven of its brushes render up to
   * 863px past the panel and every one is a swipe away. A control is out of
   * reach only when it is past the edge *and* nothing between it and the panel
   * scrolls sideways *and* the panel itself has not grown to hold it.
   */
  const reachableSideways = (element, root) => {
    for (let node = element.parentElement; node && node !== root; node = node.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(node).overflowX)) return true;
    }
    return root.scrollWidth > root.clientWidth;
  };

  const sheet = document.querySelector(".st-sheet");
  const statusbar = document.querySelector(".st-statusbar");
  const fab = document.querySelector(".graph-toggle");
  const overlay = document.querySelector("section.st-overlay");
  const read = {
    innerWidth: window.innerWidth, innerHeight: window.innerHeight,
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    present: Boolean(sheet),
    statusbar: statusbar ? box(statusbar) : null,
    fab: fab && visible(fab)
      ? { ...box(fab), label: name(fab), position: getComputedStyle(fab).position }
      : null,
    overlay: overlay
      ? { ...box(overlay), close: Boolean(overlay.querySelector(".st-overlay-close")) }
      : null,
  };
  if (!sheet) return read;

  const handle = sheet.querySelector(".st-sheet-handle");
  const body = sheet.querySelector(".st-sheet-body");
  const panel = sheet.querySelector(".st-sheet-panel:not([hidden])");
  read.detent = ["collapsed", "peek", "open"].find((one) => sheet.classList.contains(`is-${one}`)) ?? "none";
  read.sheet = box(sheet);
  read.handle = handle ? { ...box(handle), expanded: handle.getAttribute("aria-expanded") } : null;
  read.bodyHidden = body?.hasAttribute("hidden") ?? null;
  read.visiblePanels = sheet.querySelectorAll(".st-sheet-panel:not([hidden])").length;
  read.tabs = [...sheet.querySelectorAll(".st-segmented [role=tab]")].map((tab, index) => ({
    index, label: name(tab), selected: tab.getAttribute("aria-selected") === "true", ...box(tab),
  }));
  read.small = [];
  read.unreachable = [];
  read.belowTypeFloor = [];
  if (!panel) return read;

  read.panel = {
    ...box(panel),
    scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight,
    overflowY: getComputedStyle(panel).overflowY,
    text: (panel.textContent ?? "").trim().length,
  };
  if (read.bodyHidden) return read;

  const controls = "button, a[href], select, input, summary, textarea, [role=button]";
  for (const element of panel.querySelectorAll(controls)) {
    if (!visible(element) || targetExcludes.some((selector) => element.matches(selector))) continue;
    const measured = box(element);
    if (!measured.w || !measured.h) continue;
    const target = window.__stTarget(element);
    if (target.w < touch || target.h < touch) {
      read.small.push({ ...target, label: name(element) });
    }
    const edge = panel.getBoundingClientRect().left + panel.clientLeft + panel.clientWidth;
    if (measured.right - edge > 1 && !reachableSideways(element, panel)) {
      read.unreachable.push({ past: +(measured.right - edge).toFixed(1), label: name(element) });
    }
  }
  for (const element of panel.querySelectorAll("*")) {
    if (!visible(element) || typeExcludes.some((selector) => element.matches(selector))) continue;
    const size = Number.parseFloat(getComputedStyle(element).fontSize);
    if (!(size < typeFloor)) continue;
    const ownText = [...element.childNodes]
      .some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (!ownText) continue;
    read.belowTypeFloor.push({ size, label: name(element) });
  }
  return read;
}

/** The tool directory, which on a phone is the only way to another tool. */
function readToolMenu(touch) {
  const menu = document.querySelector(".studio-menu");
  if (!menu) return { open: false };
  const rect = menu.getBoundingClientRect();
  const backdrop = document.querySelector(".studio-menu-backdrop");
  const targets = [...menu.querySelectorAll("a[href], button, input")]
    .map((element) => ({
      ...window.__stTarget(element),
      label: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 32)
        || element.getAttribute("aria-label") || element.tagName,
    }))
    .filter((target) => target.w && target.h);
  return {
    open: true,
    bottom: +rect.bottom.toFixed(1),
    innerHeight: window.innerHeight,
    scrolls: /auto|scroll/.test(getComputedStyle(backdrop).overflowY),
    small: targets.filter((target) => target.h < touch || target.w < touch),
  };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const currentDetent = (page) => page.evaluate(() => {
  const sheet = document.querySelector(".st-sheet");
  return sheet
    ? (["collapsed", "peek", "open"].find((one) => sheet.classList.contains(`is-${one}`)) ?? "none")
    : null;
});

/** Tap the handle until the sheet reports `want`. The cycle is three long. */
async function driveTo(page, want) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const at = await currentDetent(page);
    if (at === null || at === want) return at;
    await page.click(".st-sheet-handle");
    await sleep(400);
  }
  return currentDetent(page);
}

const server = await createServer({ server: { port: 0 }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await puppeteer.launch({
  executablePath: chromeExecutable(),
  args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--disable-dev-shm-usage"],
  headless: true,
});

const failures = [];
const note = (message) => { failures.push(message); };
const check = (fn) => { try { fn(); } catch (error) { note(error.message); } };

/** The measurements every detent and every tab are held to. */
function assertOpenPanel(read, where) {
  check(() => assert.equal(
    read.visiblePanels, 1,
    `${where}: ${read.visiblePanels} sheet panels are visible at once`,
  ));
  const panel = read.panel;
  if (!panel) { note(`${where}: the sheet body is open and renders no panel`); return; }
  check(() => assert.ok(
    panel.clientHeight >= MIN_PANEL,
    `${where}: the open panel is ${panel.clientHeight}px tall and holds ${panel.scrollHeight}px of controls`,
  ));
  check(() => assert.ok(
    panel.scrollHeight <= panel.clientHeight + 1 || /auto|scroll/.test(panel.overflowY),
    `${where}: ${panel.scrollHeight}px of controls in a ${panel.clientHeight}px panel with overflow-y:${panel.overflowY}`,
  ));
  check(() => assert.deepEqual(
    read.small, [],
    `${where}: ${read.small.length} target(s) in the sheet under ${TOUCH}px: ${
      read.small.map((one) => `"${one.label}" ${one.w}×${one.h}`).join("; ")}`,
  ));
  check(() => assert.deepEqual(
    read.unreachable, [],
    `${where}: ${read.unreachable.length} control(s) render past the panel with nothing to scroll them into view: ${
      read.unreachable.map((one) => `"${one.label}" by ${one.past}px`).join("; ")}`,
  ));
  check(() => assert.deepEqual(
    read.belowTypeFloor, [],
    `${where}: ${read.belowTypeFloor.length} element(s) in the sheet render below the ${TYPE_FLOOR}px floor: ${
      read.belowTypeFloor.map((one) => `${one.size}px "${one.label}"`).join("; ")}`,
  ));
}

try {
  for (const viewport of VIEWPORTS) {
    for (const route of ROUTES) {
      const page = await browser.newPage();
      await page.setViewport({
        width: viewport.width, height: viewport.height,
        hasTouch: true, isMobile: true, deviceScaleFactor: 1,
      });
      const where = `${route} at ${viewport.name}`;
      const errors = [];
      page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
      try {
        await page.goto(`${base}${route}`, { waitUntil: "networkidle2", timeout: 120_000 });
        await page.waitForSelector(".st-nav-chip", { timeout: 20_000 }).catch(() => {});
        await sleep(2000);
        await page.evaluate(installTargetMeasure);

        const initial = await page.evaluate(readSheet, { targetExcludes: TARGET_EXCLUDES, typeExcludes: TYPE_EXCLUDES, touch: TOUCH, typeFloor: TYPE_FLOOR });
        check(() => assert.ok(
          initial.documentOverflow <= 0,
          `${where}: the document overflows horizontally by ${initial.documentOverflow}px`,
        ));

        if (initial.present) {
          // The handle is the only control that opens the panels, and its
          // cycle is collapsed → peek → open. Three taps from anywhere must
          // visit all three and come back — a route that starts at peek
          // (sheetInitiallyOpen) is not allowed to cycle differently.
          const seen = [];
          for (let tap = 0; tap < 3; tap += 1) {
            await page.click(".st-sheet-handle");
            await sleep(400);
            seen.push(await currentDetent(page));
          }
          check(() => assert.deepEqual(
            [...new Set([initial.detent, ...seen])].sort(), ["collapsed", "open", "peek"],
            `${where}: the handle cycles ${initial.detent} → ${seen.join(" → ")}`,
          ));
          check(() => assert.equal(
            seen[2], initial.detent,
            `${where}: three taps started at ${initial.detent} and landed on ${seen[2]}`,
          ));

          // A collapsed sheet is a bar over the shell. It must not land on the
          // status bar, which the kit calls the tool's only state readout.
          await driveTo(page, "collapsed");
          const collapsed = await page.evaluate(readSheet, { targetExcludes: TARGET_EXCLUDES, typeExcludes: TYPE_EXCLUDES, touch: TOUCH, typeFloor: TYPE_FLOOR });
          check(() => assert.equal(
            collapsed.bodyHidden, true,
            `${where}: the collapsed sheet still renders its body`,
          ));
          if (collapsed.statusbar) {
            check(() => assert.ok(
              collapsed.statusbar.bottom <= collapsed.sheet.top + 1,
              `${where}: the collapsed sheet covers the status bar (bar ends at ${collapsed.statusbar.bottom}, sheet starts at ${collapsed.sheet.top})`,
            ));
          }

          for (const detent of ["peek", "open"]) {
            const at = await driveTo(page, detent);
            if (at !== detent) { note(`${where}: the handle never reached ${detent} (stuck at ${at})`); continue; }
            await sleep(300);
            const read = await page.evaluate(readSheet, { targetExcludes: TARGET_EXCLUDES, typeExcludes: TYPE_EXCLUDES, touch: TOUCH, typeFloor: TYPE_FLOOR });
            check(() => assert.ok(
              read.sheet.h <= read.innerHeight + 1,
              `${where}: the ${detent} sheet is ${read.sheet.h}px in a ${read.innerHeight}px window`,
            ));
            check(() => assert.ok(
              read.handle.h >= TOUCH,
              `${where}: the ${detent} sheet's handle is ${read.handle.h}px tall`,
            ));
            assertOpenPanel(read, `${where} · ${detent}`);
          }

          // Every tab, with the sheet genuinely open. A tab that renders an
          // empty panel is a tab that lost its content to a stale index.
          await driveTo(page, "open");
          const tabCount = await page.evaluate(
            () => document.querySelectorAll(".st-sheet .st-segmented [role=tab]").length,
          );
          for (let index = 0; index < tabCount; index += 1) {
            await page.evaluate((one) => {
              document.querySelectorAll(".st-sheet .st-segmented [role=tab]")[one].click();
            }, index);
            await sleep(400);
            const read = await page.evaluate(readSheet, { targetExcludes: TARGET_EXCLUDES, typeExcludes: TYPE_EXCLUDES, touch: TOUCH, typeFloor: TYPE_FLOOR });
            const label = read.tabs[index]?.label ?? `#${index}`;
            check(() => assert.ok(
              read.tabs[index]?.selected,
              `${where}: tapping "${label}" did not select it`,
            ));
            check(() => assert.ok(
              (read.panel?.text ?? 0) > 0,
              `${where}: the "${label}" tab renders an empty panel`,
            ));
            assertOpenPanel(read, `${where} · tab "${label}"`);
          }
          await driveTo(page, "collapsed");
        }

        // The node-graph entry point: a thumb target that clears the two
        // strips under it, and a full-screen overlay that closes again.
        if (await page.$(".graph-toggle")) {
          const read = await page.evaluate(readSheet, { targetExcludes: TARGET_EXCLUDES, typeExcludes: TYPE_EXCLUDES, touch: TOUCH, typeFloor: TYPE_FLOOR });
          const fab = read.fab;
          if (fab) {
            check(() => assert.equal(
              fab.position, "fixed",
              `${where}: the "${fab.label}" entry point is position:${fab.position} — it cannot track the sheet and status bar from inside the viewport`,
            ));
            check(() => assert.ok(
              fab.h >= TOUCH && fab.w <= read.innerWidth * 0.75,
              `${where}: the "${fab.label}" entry point measures ${fab.w}×${fab.h} — a thumb target, not a bar across the viewport`,
            ));
            if (read.statusbar) {
              check(() => assert.ok(
                fab.bottom <= read.statusbar.top + 1,
                `${where}: the "${fab.label}" entry point covers the status bar`,
              ));
            }
            if (read.sheet) {
              check(() => assert.ok(
                fab.bottom <= read.sheet.top + 1,
                `${where}: the "${fab.label}" entry point covers the collapsed sheet`,
              ));
            }
          }
          await page.click(".graph-toggle");
          await sleep(2000);
          const opened = await page.evaluate(readSheet, { targetExcludes: TARGET_EXCLUDES, typeExcludes: TYPE_EXCLUDES, touch: TOUCH, typeFloor: TYPE_FLOOR });
          check(() => assert.ok(opened.overlay, `${where}: the node-graph entry point opened no overlay`));
          if (opened.overlay) {
            check(() => assert.ok(
              opened.overlay.close,
              `${where}: the node overlay renders no close button`,
            ));
            check(() => assert.ok(
              opened.overlay.h >= opened.innerHeight * 0.9,
              `${where}: the node overlay is ${opened.overlay.h}px of a ${opened.innerHeight}px window`,
            ));
            await page.click(".st-overlay-close");
            await sleep(500);
            const stillOpen = await page.evaluate(() => Boolean(document.querySelector("section.st-overlay")));
            check(() => assert.ok(!stillOpen, `${where}: the node overlay stayed open after Close`));
          }
        }

        // The asset library, the third full-screen surface a phone reaches.
        // It opens from inside the sheet on `/` and nowhere else, so it is
        // driven here rather than given a route of its own: its mobile rules
        // were already left behind at an old breakpoint once (N5).
        if (route === "/") {
          await driveTo(page, "open");
          const browse = await page.$$eval(
            ".st-sheet button",
            (buttons) => buttons.findIndex((one) => one.textContent?.includes("Browse asset library")),
          );
          if (browse >= 0) {
            await page.evaluate((index) => {
              document.querySelectorAll(".st-sheet button")[index].click();
            }, browse);
            await sleep(1500);
            const library = await page.evaluate((touch) => {
              const dialog = document.querySelector(".asset-library");
              if (!dialog) return { open: false };
              const rect = dialog.getBoundingClientRect();
              const grid = dialog.querySelector(".asset-library-grid");
              const targets = [...dialog.querySelectorAll("button, a[href], input")]
                .map((element) => ({
                  ...window.__stTarget(element),
                  label: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 28)
                    || element.getAttribute("aria-label") || element.tagName,
                }))
                .filter((target) => target.w && target.h);
              return {
                open: true,
                h: +rect.height.toFixed(1), bottom: +rect.bottom.toFixed(1),
                innerHeight: window.innerHeight,
                gridScrolls: grid ? /auto|scroll/.test(getComputedStyle(grid).overflowY) : null,
                small: targets.filter((target) => target.h < touch || target.w < touch),
              };
            }, TOUCH);
            check(() => assert.ok(library.open, `${where}: "Browse asset library" opened nothing`));
            if (library.open) {
              check(() => assert.ok(
                library.bottom <= library.innerHeight + 1,
                `${where}: the asset library ends ${(library.bottom - library.innerHeight).toFixed(0)}px below the window`,
              ));
              check(() => assert.ok(
                library.gridScrolls !== false,
                `${where}: the asset library's card grid does not scroll`,
              ));
              check(() => assert.deepEqual(
                library.small, [],
                `${where}: ${library.small.length} asset-library target(s) under ${TOUCH}px: ${
                  library.small.map((one) => `"${one.label}" ${one.w}×${one.h}`).join("; ")}`,
              ));
              await page.keyboard.press("Escape");
              await sleep(400);
            }
          }
          await driveTo(page, "collapsed");
        }

        // The tool directory. On a phone the rail is gone, so this and the
        // switcher are the whole of the app's navigation.
        if (await page.$(".st-nav-tools")) {
          await page.click(".st-nav-tools");
          await sleep(600);
          const menu = await page.evaluate(readToolMenu, TOUCH);
          check(() => assert.ok(menu.open, `${where}: the Tools button opened no directory`));
          if (menu.open) {
            check(() => assert.ok(
              menu.bottom <= menu.innerHeight + 1 || menu.scrolls,
              `${where}: the tool directory ends ${(menu.bottom - menu.innerHeight).toFixed(0)}px below the window and its backdrop does not scroll`,
            ));
            check(() => assert.deepEqual(
              menu.small, [],
              `${where}: ${menu.small.length} tool-directory target(s) under ${TOUCH}px: ${
                menu.small.map((one) => `"${one.label}" ${one.w}×${one.h}`).join("; ")}`,
            ));
            await page.keyboard.press("Escape");
            await sleep(400);
            const menuOpen = await page.evaluate(() => Boolean(document.querySelector(".studio-menu")));
            check(() => assert.ok(!menuOpen, `${where}: Escape did not close the tool directory`));
          }
        }

        for (const error of errors) note(`${where}: uncaught ${error}`);
      } catch (error) {
        note(`${where}: ${error.message}`);
      } finally {
        await page.close();
      }
    }
    process.stdout.write(`  ${viewport.name} · ${ROUTES.length} routes\n`);
  }
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} mobile sheet failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`\nok — ${VIEWPORTS.length} phone viewports × ${ROUTES.length} routes, every sheet opened and walked.`);
}
