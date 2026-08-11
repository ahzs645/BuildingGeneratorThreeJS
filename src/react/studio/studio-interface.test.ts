import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Regression cover for the desktop + mobile interface review
 * (docs/INTERFACE_REVIEW.md). Several of those findings cannot be caught by a
 * headless browser at all — a safe-area inset needs a notched phone, and `dvh`
 * only diverges from `vh` where a browser toolbar retracts — so the contract
 * is asserted against the source that encodes it. The rest are here because
 * they are one careless edit away from returning: the review found the same
 * aspect-blind camera fit copied into five files.
 */

const repo = new URL("../../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, repo), "utf8");

const kit = read("src/react/studio/studio-kit.css");
const navCss = read("src/react/studio/studio-nav.css");
const shellCss = read("src/react/studio/studio-shell.css");
const shell = read("src/react/studio/StudioShell.tsx");
const chrome = read("src/react/studio/StudioChrome.tsx");
const menu = read("src/react/studio/StudioMenu.tsx");
const nav = read("src/react/studio/StudioNav.tsx");
const pageRuntime = read("src/react/page-runtime.ts");
const cameraFit = read("src/camera-fit.ts");
const building = read("src/main.ts");
const buildingPage = read("src/react/pages/BuildingPage.tsx");
const paintToolbarCss = read("src/react/pages/surface-studio/surface-workspace-toolbar.css");
const gallery = read("src/dojo-gallery.ts");
const vase = read("src/vase-compare.ts");

// A1 —— the 821-1180px band left the viewport a 158px slit on an 834px tablet.
test("the tablet band gives the viewport its width back", () => {
  const band = kit.match(/@media \(min-width: 821px\) and \(max-width: 1180px\) \{[\s\S]*?\n\}/);
  assert.ok(band, "studio-kit.css must carry a 821-1180px block");
  assert.match(band[0], /--st-rail-w: 0px/);
  assert.match(band[0], /--st-dock-w: clamp\(/);
  assert.match(band[0], /--st-inspector-w: clamp\(/);
  // The rail is what the section switcher replaces in this band, so the nav
  // must stop hiding the switcher below 1180px.
  assert.doesNotMatch(navCss, /@media \(max-width: 1180px\) \{ \.st-nav-sections \{ display: none/);
});

// A2 —— 390px of height had a 104px two-row nav in it.
test("the nav collapses to one row on a phone in landscape", () => {
  assert.match(kit, /@media \(\(pointer: coarse\) and \(max-height: 500px\)\) \{\s*:root \{ --st-nav-h: 52px;/);
  const landscape = navCss.match(/@media \(\(pointer: coarse\) and \(max-height: 500px\)\) \{[\s\S]*?\n\}/);
  assert.ok(landscape, "studio-nav.css must override the two-row mobile nav in landscape");
  assert.match(landscape[0], /grid-template-rows: minmax\(0, 1fr\)/);
  // Compaction must not cost the touch minimum.
  assert.match(landscape[0], /\.st-nav-sections a \{ height: var\(--st-touch\)/);
  // The landscape block has to come after the mobile block it overrides:
  // in studio-kit.css it lost on load order, which is what shipped first.
  assert.ok(
    navCss.indexOf("@media (max-width: 820px)") < navCss.indexOf("@media ((pointer: coarse) and (max-height: 500px))"),
    "the landscape block must follow the mobile block it overrides",
  );
});

// A3 —— 940px of toolbar in an 884px column, with Mode 218px off a phone.
test("the Surface workspace toolbar wraps on desktop and pins Mode on a phone", () => {
  assert.match(paintToolbarCss, /\.surface-workspace-toolbar \{[^}]*flex-wrap: wrap/s);
  assert.doesNotMatch(
    paintToolbarCss.split("@media")[0],
    /min-width: max-content/,
    "min-width:max-content outside the mobile block would defeat wrapping",
  );
  assert.match(paintToolbarCss, /\.surface-workspace-modes \{[^}]*position: sticky[^}]*order: -1/s);
});

// B1 —— Floors 6 -> 40 produced a pixel-identical render.
test("the building re-frames from its bounds instead of a fixed camera", () => {
  assert.match(building, /function frameBuilding/);
  assert.match(building, /fitDistanceForRadius\(camera, radius/);
  // Re-framed after a rebuild, on a step change in viewport shape, and on demand.
  assert.match(building, /frameBuilding\(\);/);
  assert.match(building, /if \(viewportAspectGate\(width \/ height\)\) frameBuilding\(true\)/);
  assert.match(building, /reframe: \(\) => frameBuilding\(true\)/);
  assert.match(buildingPage, /onClick=\{\(\) => tool\?\.reframe\(\)\}>Reframe</);
  // A 40x40x40 tower needs ~160 units; the authored dolly ceiling was 120.
  assert.match(building, /controls\.maxDistance = Math\.max\(120, distance \* 1\.4\)/);
});

// B2 —— the same vertical-FOV-only fit was written out in five files.
test("every camera fit solves on the narrower half-angle, from one helper", () => {
  assert.match(cameraFit, /Math\.min\(halfFovY, halfFovX\)/);
  assert.match(cameraFit, /Math\.atan\(Math\.tan\(halfFovY\) \* aspect\)/);
  for (const path of [
    "src/bin-compare.ts",
    "src/dojo-gallery.ts",
    "src/blend-studio/runtime.ts",
    "src/blend-import.ts",
    "src/main.ts",
  ]) {
    const source = read(path);
    assert.match(source, /fitDistanceForRadius\(/, `${path} must use the shared fit`);
    assert.doesNotMatch(
      source,
      /radius \/ Math\.sin\(THREE\.MathUtils\.degToRad\(camera\.fov/,
      `${path} must not reintroduce an aspect-blind fit`,
    );
  }
});

// B3 —— reframe-on-aspect-change existed in exactly one tool.
test("the aspect gate is shared, not copied", () => {
  assert.match(cameraFit, /export function createAspectGate/);
  assert.match(read("src/bin-compare.ts"), /createAspectGate\(\)/);
  assert.match(building, /createAspectGate\(\)/);
});

// C1 —— on a phone every entry point was inside a collapsed sheet.
test("the sheet can open itself when the dock holds the only entry point", () => {
  assert.match(shell, /sheetInitiallyOpen/);
  assert.match(shell, /useState<SheetDetent>\(sheetInitiallyOpen \? "peek" : "collapsed"\)/);
  assert.match(read("src/react/pages/BlendBridgePage.tsx"), /sheetInitiallyOpen=\{!workingDump\}/);
});

// C2 —— the FAB covered the status bar by 16px.
test("the node-graph FAB clears the status bar", () => {
  assert.match(
    shellCss,
    /bottom: calc\(var\(--st-sheet-collapsed\) \+ var\(--st-status-h\) \+ \d+px\)/,
    "a flat offset cannot track the sheet and status bar",
  );
});

// C3 —— unobservable headlessly: no emulator reports a notch inset.
test("the chrome strips honour horizontal safe-area insets", () => {
  const mobile = kit.slice(kit.indexOf("/* ------------------------------------------------------------------ mobile */"));
  for (const selector of [".st-nav", ".st-toolbar, .st-statusbar"]) {
    const rule = mobile.match(new RegExp(`\\${selector.split(",")[0]}[^{]*\\{[^}]*env\\(safe-area-inset-left`));
    assert.ok(rule, `${selector} must pad against the leading inset`);
  }
  assert.match(mobile, /padding-right: max\(\d+px, env\(safe-area-inset-right/);
});

// C4 —— unobservable headlessly: nothing retracts a browser toolbar.
test("full-height mobile surfaces are sized in dvh with a vh fallback", () => {
  assert.match(kit, /\.st-sheet\.is-open \{ height: calc\(62vh/);
  assert.match(kit, /\.st-sheet\.is-open \{ height: calc\(62dvh/);
  assert.ok(
    kit.indexOf("62vh") < kit.indexOf("62dvh"),
    "the vh declaration must come first or it would win over dvh",
  );
  assert.match(read("src/react/studio/studio-menu.css"), /max-height:86dvh/);
});

// C5 —— the open sheet left ~200px of a viewport it was editing.
test("the sheet has a peek detent between collapsed and open", () => {
  assert.match(shell, /const SHEET_DETENTS = \["collapsed", "peek", "open"\]/);
  assert.match(kit, /\.st-sheet\.is-peek \{ height: calc\(34dvh/);
  // Anything that hides for an open sheet has to hide for a peeking one.
  assert.match(shellCss, /:has\(\.st-sheet:is\(\.is-open, \.is-peek\)\) \.st-viewport \.graph-toggle/);
  assert.match(read("src/react/pages/surface-painter.css"), /\.st-sheet:is\(\.is-open, \.is-peek\)\)/);
});

// D1 —— two routes of ten filled the nav's chip track.
test("every tool publishes a runtime chip, and page chips do not evict it", () => {
  assert.match(chrome, /export type StudioChipGroup = "runtime" \| "page"/);
  assert.match(chrome, /export function useStudioRuntimeChip/);
  // Both runtime hooks, so a page gets the chip whether or not it keeps a handle.
  const chipCalls = pageRuntime.match(/useStudioRuntimeChip\(/g) ?? [];
  assert.equal(chipCalls.length, 2, "useToolController and useToolRuntime must both publish");
  assert.match(pageRuntime, /RUNTIME_CHIP\[phase\]/);
  assert.match(pageRuntime, /RUNTIME_CHIP\[state\.phase\]/);
});

// D2 —— the Parity Catalog's rows were the one control row the kit could not reach.
test("the Parity Catalog's authored inputs are kit rows", () => {
  assert.match(kit, /\.st-row\.st-row-stacked \{/);
  assert.match(read("src/chrome-assets.ts"), /st-row st-row-stacked assets-control/);
  assert.match(read("src/chrome-assets.ts"), /input\.className="st-input"/);
  // Inline sizing would beat the sheet's 28px touch checkbox.
  assert.doesNotMatch(read("src/chrome-assets.ts"), /input\.style\.width="18px"/);
});

// D3 / D4 —— 8px labels and 36px targets in the one strip a phone scrolls.
test("the Surface toolbar holds the kit's type floor and touch minimum", () => {
  assert.doesNotMatch(paintToolbarCss, /font: 700 8px/);
  assert.doesNotMatch(paintToolbarCss, /font: 600 9px/);
  assert.doesNotMatch(paintToolbarCss, /min-height: 36px/);
  assert.doesNotMatch(paintToolbarCss, /height: 36px/);
  assert.match(paintToolbarCss, /:is\(button, \.st-btn, \.st-select\) \{ min-height: var\(--st-touch\)/);
});

// D5 —— the cap named a key Windows and Linux keyboards do not have.
test("the shortcut is spelled for the platform and shown only with a keyboard", () => {
  assert.match(menu, /export const SHORTCUT_LABEL/);
  assert.match(menu, /\? "⌘K"\s*:\s*"Ctrl K"/);
  assert.match(nav, /<kbd>\{SHORTCUT_LABEL\}<\/kbd>/);
  assert.doesNotMatch(nav, /<kbd>⌘K<\/kbd>/);
  assert.match(navCss, /@media \(any-pointer: fine\)[^{]*\{\s*\.st-nav-tools kbd \{ display: inline/);
});

// D6 —— the shortcut opened a list with nothing to type into.
test("the tool menu is a palette", () => {
  assert.match(menu, /studio-menu-search/);
  assert.match(menu, /useModalDialog<HTMLElement>\(open, onClose, "\.studio-menu-search input"\)/);
  assert.match(menu, /event\.key === "ArrowDown"/);
  assert.match(menu, /event\.key === "Enter"/);
  assert.match(menu, /function matchesQuery/);
});

// D7 —— the selected model was styled as a header for the list beneath it.
test("the gallery names its list, not its selection", () => {
  const page = read("src/react/pages/DojoGalleryPage.tsx");
  assert.match(page, /meta=\{<span id="title">/);
  assert.doesNotMatch(page, /st-section-title"><span id="title"/);
});

// E1 / E2 —— 38MB and 14MB transfers, silent, and re-fetched.
test("large assets report progress and are allowed to cache", () => {
  assert.match(gallery, /describeLoadProgress\("loading Blender bake…"/);
  assert.doesNotMatch(gallery, /\?v=\$\{Date\.now\(\)\}/);
  assert.match(vase, /describeLoadProgress\("loading Blender truth…"/);
  assert.match(vase, /cache: import\.meta\.env\.DEV \? "no-store" : "default"/);
});

// Requested: the fill-bar slider lil-gui shows, in place of a rail and knob.
test("sliders are fill bars, and every one of them publishes its fill", () => {
  assert.match(kit, /--st-slider-fill: var\(--st-accent-fill\)/);
  assert.match(kit, /linear-gradient\(to right, var\(--st-slider-fill\) 0 var\(--st-fill, 0%\)/);
  // The input's box is the hit area, the track pseudo is the painted bar —
  // which is what lets a phone keep 44px under an 18px bar.
  assert.match(kit, /input\[type="range"\] \{[^}]*height: var\(--st-slider-h\)/s);
  assert.match(kit, /::-webkit-slider-runnable-track \{[^}]*height: var\(--st-slider-bar\)/s);
  assert.match(kit, /--st-slider-h: var\(--st-touch\)/, "the mobile hit area must be the touch minimum");
  // Firefox paints its own progress over the gradient unless told not to.
  assert.match(kit, /::-moz-range-progress \{ background: transparent; \}/);
  // Controlled inputs publish the fill in the same render as the value;
  // everything else is covered by the observer.
  const rangeFill = read("src/react/studio/range-fill.ts");
  assert.match(rangeFill, /export function rangeFillStyle/);
  assert.match(rangeFill, /export function installRangeFill/);
  assert.match(rangeFill, /attributeFilter: \["value", "min", "max", "step"\]/);
  assert.match(chrome, /installRangeFill\(document\.body\)/);
});

test("the fill percentage is clamped and never divides by zero", async () => {
  const { rangeFillPercent } = await import("./range-fill.js");
  assert.equal(rangeFillPercent(0, 1, 0.25), "25%");
  assert.equal(rangeFillPercent(3, 40, 3), "0%");
  assert.equal(rangeFillPercent(3, 40, 40), "100%");
  assert.equal(rangeFillPercent(-2.5, 2.5, 0), "50%");
  assert.equal(rangeFillPercent(0, 1, 5), "100%", "a value past max cannot overflow the track");
  assert.equal(rangeFillPercent(0, 1, -5), "0%");
  assert.equal(rangeFillPercent(1, 1, 1), "0%", "an empty range is not a division");
  assert.equal(rangeFillPercent(0, Number.NaN, 1), "0%");
});

// The phone crumb spent its width on a name the switcher already highlights.
test("the phone breadcrumb spends its width on the tool name", () => {
  const mobile = navCss.slice(navCss.indexOf("@media (max-width: 820px)"));
  assert.match(mobile, /\.st-crumb-section, \.st-crumb i \{ display: none; \}/);
});
