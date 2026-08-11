/**
 * Rendered-result cover for docs/INTERFACE_REVIEW.md.
 *
 * src/react/studio/studio-interface.test.ts asserts the source that encodes
 * these findings, and source text has a blind spot that this review has now
 * been bitten by twice: it cannot see the cascade, and it cannot see a number
 * that only exists after layout. C3 shipped a safe-area inset on `.st-nav`
 * that a later stylesheet's `padding` shorthand reset to a flat 10px, and the
 * test matched the declaration and passed. A3's toolbar fix reported "0px
 * clipped" and never measured height, which was 320px at 834×1112.
 *
 * So: a browser, six viewports, ten routes, and assertions about what the
 * layout actually produced. Run it with `npm run test:interface`; it is not in
 * `npm test` because sixty page loads through SwiftShader take minutes, and
 * because the CPU it burns makes the wall-clock assertion in
 * src/gnvm/volume.test.ts flaky when the two run together.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import process from "node:process";
import puppeteer from "puppeteer-core";
import { createServer } from "vite";

const VIEWPORTS = [
  { name: "1440×900", width: 1440, height: 900, touch: false },
  { name: "1280×800", width: 1280, height: 800, touch: false },
  { name: "1024×768", width: 1024, height: 768, touch: true },
  { name: "834×1112", width: 834, height: 1112, touch: true },
  { name: "844×390", width: 844, height: 390, touch: true },
  { name: "390×844", width: 390, height: 844, touch: true },
];

const ROUTES = [
  "/", "/building", "/gallery", "/bin", "/vase",
  "/crayon", "/typewriter", "/chrome-assets", "/paint", "/materialx",
];

/**
 * D3 is a claim about specific surfaces, so this is a check on those surfaces:
 * the three chrome strips every route shares, and the two Surface Studio files
 * the finding named. `surface-painter.css`'s lil-gui skin carries 8–10px
 * labels of its own that D3 never listed and this pass did not change — see
 * the Scope section of docs/INTERFACE_REVIEW.md. Widening this selector list
 * is how that would get fixed, and it should be widened.
 */
const TYPE_FLOOR_ROOTS = [".st-nav", ".st-toolbar", ".st-statusbar", ".surface-tool-selector"];

/**
 * Targets this file measures. The graph canvas is out: the kit exempts it by
 * name ("node bodies are diagram, not UI, and Blender's own editor sets that
 * scale"), and it is a third-party surface. `input[type=range]` is out because
 * the kit sizes the slider deliberately — a 20px hit area under an 18px bar on
 * desktop, --st-touch on a phone — and `input[type=file]` because it is
 * visually hidden behind its own label.
 */
const TARGET_EXCLUDES = [
  '.blender-flow-wrap *', '.react-flow *',
  'input[type="range"]', 'input[type="file"]',
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
  if (!executable) throw new Error("Chrome was not found. Set CHROME_BIN to run the interface measurements.");
  return executable;
}

/**
 * Everything this file asserts, read off one settled page. Collected in a
 * single evaluate() so a route is visited once per viewport rather than once
 * per finding.
 */
function readInterface({ typeFloorRoots, targetExcludes }) {
  const rect = (element) => {
    const box = element.getBoundingClientRect();
    return { w: +box.width.toFixed(1), h: +box.height.toFixed(1) };
  };
  const measure = (selector) => {
    const element = document.querySelector(selector);
    return element ? rect(element) : null;
  };
  const visible = (element) => element.getClientRects().length > 0
    && getComputedStyle(element).visibility !== "hidden";

  // Element-level overflow. A strip whose overflow-x is `visible` and whose
  // children run past its padding box is drawing over its neighbour, and the
  // document-level scrollWidth === clientWidth check cannot see it: .st-shell
  // is overflow:hidden, so the page never grows.
  const strips = [".st-toolbar", ".st-statusbar", ".st-nav"].flatMap((selector) => {
    const strip = document.querySelector(selector);
    if (!strip) return [];
    const style = getComputedStyle(strip);
    const box = strip.getBoundingClientRect();
    const right = box.left + strip.clientLeft + strip.clientWidth;
    let past = 0;
    let text = "";
    for (const child of strip.querySelectorAll("*")) {
      const childBox = child.getBoundingClientRect();
      if (!childBox.width && !childBox.height) continue;
      const over = childBox.right - right;
      if (over > past) {
        past = over;
        text = (child.textContent ?? "").trim().slice(0, 40);
      }
    }
    return [{
      selector,
      scrollable: style.overflowX === "auto" || style.overflowX === "scroll",
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      past: +past.toFixed(1),
      text,
      height: +box.height.toFixed(1),
    }];
  });

  const belowTypeFloor = [];
  for (const element of document.querySelectorAll(typeFloorRoots.map((root) => `${root} *`).join(", "))) {
    if (!visible(element)) continue;
    const size = Number.parseFloat(getComputedStyle(element).fontSize);
    if (!(size < 11)) continue;
    const ownText = [...element.childNodes]
      .some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (!ownText) continue;
    belowTypeFloor.push({
      size,
      selector: element.tagName.toLowerCase() + (element.className ? `.${String(element.className).split(" ").join(".")}` : ""),
      text: element.textContent.trim().slice(0, 28),
    });
  }

  const targets = [];
  for (const element of document.querySelectorAll("button, a[href], select, input, summary, [role=button]")) {
    if (!visible(element) || targetExcludes.some((selector) => element.matches(selector))) continue;
    const box = rect(element);
    if (!box.w || !box.h) continue;
    targets.push({
      ...box,
      text: (element.textContent ?? "").trim().slice(0, 24) || element.getAttribute("aria-label") || element.tagName,
    });
  }

  return {
    strips,
    belowTypeFloor,
    targets,
    chips: [...document.querySelectorAll(".st-nav-chip")].map((chip) => chip.textContent.trim()).filter(Boolean),
    toolbar: measure(".st-toolbar"),
    sheetHandle: measure(".st-sheet-handle"),
    innerHeight: window.innerHeight,
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}

/**
 * C3, as a rendered result. The inset itself needs a notched phone, but the
 * defect did not: the nav resolved 10px where the other two strips resolved
 * 12px, because a later `padding` shorthand at one class beat the kit's
 * `padding-left`. Both halves are checked — the three strips agree, and they
 * still agree after a bare-class shorthand is appended to the document, which
 * is the edit that broke it the first time.
 */
async function assertInsetSurvivesALaterShorthand(page, where) {
  const before = await page.evaluate(() => [".st-nav", ".st-toolbar", ".st-statusbar"]
    .map((selector) => getComputedStyle(document.querySelector(selector)).paddingLeft));
  assert.deepEqual(
    new Set(before), new Set(["12px"]),
    `${where}: all three chrome strips must resolve the same horizontal inset, got ${before.join(" / ")}`,
  );
  const after = await page.evaluate(() => {
    const style = document.createElement("style");
    style.id = "inset-cascade-probe";
    style.textContent = "@media (max-width:820px),((pointer:coarse) and (max-height:500px)){.st-nav{padding:5px 10px 6px}}";
    document.head.append(style);
    const padding = getComputedStyle(document.querySelector(".st-nav")).paddingLeft;
    style.remove();
    return padding;
  });
  assert.equal(
    after, "12px",
    `${where}: a later single-class padding shorthand took the nav's inset back to ${after} — the exact regression C3 shipped with`,
  );
}

/**
 * N4: a runtime error written into the status line took .st-statusbar to a
 * 7,643px scrollWidth against a 390px client, because the mobile rule that
 * stops the line being squeezed to one letter took its shrink factor away and
 * left it unbounded. The assertion is about the growth, not the total — the
 * strip is allowed to be wider than the screen, that is what scrolling it is
 * for; what it is not allowed to do is grow without limit from one message.
 */
async function assertStatusTextIsBounded(page, where) {
  const result = await page.evaluate(() => {
    const bar = document.querySelector(".st-statusbar");
    const line = bar?.querySelector("[data-status-text]")
      ?? [...(bar?.children ?? [])].find((child) => child.matches("span:not(.st-sep):not(.st-spacer):not(.st-dot)"));
    if (!bar || !line) return null;
    const before = bar.scrollWidth;
    line.textContent = "runtime failed: TypeError: Cannot read properties of undefined (reading 'evaluate') "
      + "at GNVM.evaluateGraph (gnvm/runtime.ts:412:19) at async rebuild (crayon-compare.ts:288:5) "
      + "— reload the page or pick another asset from the library";
    return { before, after: bar.scrollWidth, client: bar.clientWidth };
  });
  if (!result) return;
  assert.ok(
    result.after - result.before <= result.client,
    `${where}: one long status line grew .st-statusbar by ${result.after - result.before}px `
    + `(${result.before} → ${result.after}) against a ${result.client}px client`,
  );
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

try {
  for (const viewport of VIEWPORTS) {
    const phone = viewport.width <= 820 || (viewport.touch && viewport.height <= 500);
    for (const route of ROUTES) {
      const page = await browser.newPage();
      await page.setViewport({
        width: viewport.width,
        height: viewport.height,
        hasTouch: viewport.touch,
        isMobile: viewport.touch,
        deviceScaleFactor: 1,
      });
      const where = `${route} at ${viewport.name}`;
      try {
        await page.goto(`${base}${route}`, { waitUntil: "networkidle2", timeout: 90_000 });
        await new Promise((resolve) => { setTimeout(resolve, 1200); });
        const read = await page.evaluate(readInterface, {
          typeFloorRoots: TYPE_FLOOR_ROOTS,
          targetExcludes: TARGET_EXCLUDES,
        });

        // D1 — /materialx published nothing and .st-nav-chips measured 0×0,
        // while a source test counted hook calls in one file and passed.
        if (!phone) {
          check(() => assert.ok(read.chips.length > 0, `${where}: the nav publishes no status chip`));
        }

        // R2 — a strip that does not scroll must not paint past its own box.
        for (const strip of read.strips) {
          check(() => assert.ok(
            strip.scrollable || strip.past <= 1,
            `${where}: ${strip.selector} is overflow:${strip.scrollable ? "auto" : "visible"} and "${strip.text}" renders ${strip.past}px past it`,
          ));
        }

        // R1 — the wrap that fixed A3's clipping made the strip 320px tall.
        // Both halves, together: nothing hidden AND nothing eating the window.
        const toolbar = read.strips.find((strip) => strip.selector === ".st-toolbar");
        if (toolbar) {
          check(() => assert.ok(
            toolbar.height <= read.innerHeight * 0.2,
            `${where}: .st-toolbar is ${toolbar.height}px, ${(100 * toolbar.height / read.innerHeight).toFixed(1)}% of the window`,
          ));
        }

        // D3 — 8px and 9px labels outside the kit's three named exceptions.
        check(() => assert.deepEqual(
          read.belowTypeFloor, [],
          `${where}: ${read.belowTypeFloor.length} element(s) render text below the kit's 11px floor: ${
            read.belowTypeFloor.map((item) => `${item.selector} ${item.size}px "${item.text}"`).join("; ")}`,
        ));

        // D4 / N1 — 44px for a finger, WCAG 2.2's 24×24 for everything else.
        const minimum = phone ? 44 : 24;
        const small = read.targets.filter((target) => target.w < minimum || target.h < minimum);
        check(() => assert.deepEqual(
          small, [],
          `${where}: ${small.length} target(s) under ${minimum}px: ${
            small.map((target) => `"${target.text}" ${target.w}×${target.h}`).join("; ")}`,
        ));

        // R3 — 39px in phone landscape, on the one control that opens the
        // panels, and the only sub-44px target left at that viewport.
        if (read.sheetHandle) {
          check(() => assert.ok(
            read.sheetHandle.h >= 44,
            `${where}: the sheet handle is ${read.sheetHandle.h}px tall`,
          ));
        }

        check(() => assert.ok(
          read.documentOverflow <= 0,
          `${where}: the document overflows horizontally by ${read.documentOverflow}px`,
        ));

        if (phone) await assertStatusTextIsBounded(page, where).catch((error) => note(error.message));
        if (phone && route === "/building") await assertInsetSurvivesALaterShorthand(page, where).catch((error) => note(error.message));
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
  console.error(`\n${failures.length} interface measurement failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`\nok — ${VIEWPORTS.length} viewports × ${ROUTES.length} routes, no measured regression.`);
}
