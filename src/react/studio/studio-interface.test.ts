import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Regression cover for the desktop + mobile interface review
 * (docs/INTERFACE_REVIEW.md), in source text. Two of these findings genuinely
 * cannot be observed in a browser here — a safe-area inset needs a notched
 * phone, and `dvh` only diverges from `vh` where a browser toolbar retracts —
 * and the rest are here because they are one careless edit away from
 * returning: the review found the same aspect-blind camera fit copied into
 * five files.
 *
 * What this file is *not* is proof that the interface renders correctly, and
 * an audit of the first pass showed exactly how that goes wrong. Several
 * assertions here could not fail: A1 pinned an exact single-line spelling the
 * file has never used; C3 matched the kit's declaration while a later
 * stylesheet's shorthand overrode it in the browser; D3 opened one of the two
 * files the finding named; B2 forbade a spelling the code never had.
 *
 * So two rules now hold in this file. **Match values, not spellings** — a
 * negative assertion written as `doesNotMatch(/min-height: 36px/)` passes on
 * 38px, so the checks below parse the number and compare it. And **anything
 * that only exists after layout belongs in a browser**: `npm run
 * test:interface` (tools/test-interface-measurements.mjs) drives six viewports
 * across ten routes and asserts the rendered result — chip presence, strip
 * heights, element-level overflow, computed insets, target sizes. It is a
 * separate script rather than part of `npm test` because sixty page loads
 * through SwiftShader take minutes.
 *
 * A third rule arrived with the fourth pass, and it is the one that let six
 * findings sit in a green suite: **a surface nothing opens is a surface nothing
 * measures.** The mobile sheet starts collapsed, a collapsed sheet hides its
 * body, and a hidden body has no client rects — so the phone sweep above,
 * which reads as app-wide, had never measured a control a phone user taps.
 * `npm run test:mobile` (tools/test-mobile-sheets.mjs) taps the handle first.
 * M1-M6 below are its findings; the numbers are in docs/INTERFACE_REVIEW.md.
 */

const repo = new URL("../../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, repo), "utf8");

/**
 * CSS with its comments stripped. These assertions match source text, and this
 * file's own comments explain rules by quoting them — so an assertion looking
 * for a declaration would happily match a sentence describing it, in either
 * direction. A comment reading "the phone path is min-width: max-content"
 * failed the check that no such rule exists outside the mobile block; a comment
 * mentioning flex-wrap would just as easily have satisfied a check that it
 * does. Rules are matched against rules.
 */
const rules = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const kitRaw = read("src/react/studio/studio-kit.css");
const kit = rules(kitRaw);
const navCss = rules(read("src/react/studio/studio-nav.css"));
const shellCss = rules(read("src/react/studio/studio-shell.css"));
const shell = read("src/react/studio/StudioShell.tsx");
const chrome = read("src/react/studio/StudioChrome.tsx");
const menu = read("src/react/studio/StudioMenu.tsx");
const nav = read("src/react/studio/StudioNav.tsx");
const pageRuntime = read("src/react/page-runtime.ts");
const cameraFit = read("src/camera-fit.ts");
const building = read("src/main.ts");
const buildingPage = read("src/react/pages/BuildingPage.tsx");
const paintToolbarCss = rules(read("src/react/pages/surface-studio/surface-workspace-toolbar.css"));
// D3 named two Surface Studio files and the first pass only opened one, so the
// 9px family labels and the 8px "Unavailable" caption survived a green test.
const paintSelectorCss = rules(read("src/react/pages/surface-studio/surface-tool-selector.css"));
const libraryCss = rules(read("src/react/blend-studio/asset-library.css"));
const gallery = read("src/dojo-gallery.ts");
const vase = read("src/vase-compare.ts");

/**
 * Every literal px font size a stylesheet sets, through either `font-size` or
 * the `font` shorthand. `doesNotMatch(/font: 700 8px/)` is a check on one
 * spelling of one weight; this is a check on the number, which is what the
 * kit's floor is actually about.
 */
function fontSizesPx(css: string): number[] {
  const sizes: number[] = [];
  for (const [, value] of css.matchAll(/font-size\s*:\s*([^;}]+)/g)) {
    const px = /(-?[\d.]+)px/.exec(value);
    if (px) sizes.push(Number(px[1]));
  }
  // `font: <style> <weight> <size>/<line-height> <family>` — the size is the
  // px value immediately before the slash, or the only one if there is none.
  for (const [, value] of css.matchAll(/(?:^|[;{])\s*font\s*:\s*([^;}]+)/g)) {
    const px = /(-?[\d.]+)px\s*(?:\/|$|\s)/.exec(value);
    if (px) sizes.push(Number(px[1]));
  }
  return sizes;
}

/** Every literal px value a stylesheet gives one property. */
function pxValues(css: string, property: string): number[] {
  return [...css.matchAll(new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`, "g"))]
    .flatMap(([, value]) => [...value.matchAll(/(-?[\d.]+)px/g)].map(([, px]) => Number(px)));
}

/**
 * CSS specificity of one selector, as (ids, classes, elements). Enough to
 * answer "can a later stylesheet's rule beat this one", which is the question
 * C3 got wrong: the kit's `.st-nav { padding-left: … }` and studio-nav.css's
 * `.st-nav { padding: … }` tie at one class, and the later file wins.
 */
function specificity(selector: string): [number, number, number] {
  const cleaned = selector.replace(/::[\w-]+/g, " ").trim();
  const ids = (cleaned.match(/#[\w-]+/g) ?? []).length;
  const classes = (cleaned.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const elements = (cleaned.match(/(?:^|[\s>+~])[a-z][\w-]*/g) ?? []).length;
  return [ids, classes, elements];
}

const beats = (a: [number, number, number], b: [number, number, number]): boolean =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

/** Selector lists that declare `property`, paired with their declaration block. */
function rulesDeclaring(css: string, property: string): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , body]) => new RegExp(`(?:^|[;\\s])${property}\\s*:`).test(body))
    .map(([, selector, body]) => ({ selector: selector.trim(), body }));
}

// A1 —— the 821-1180px band left the viewport a 158px slit on an 834px tablet.
test("the tablet band gives the viewport its width back", () => {
  const band = kit.match(/@media \(min-width: 821px\) and \(max-width: 1180px\) \{[\s\S]*?\n\}/);
  assert.ok(band, "studio-kit.css must carry a 821-1180px block");
  assert.match(band[0], /--st-rail-w: 0px/);
  assert.match(band[0], /--st-dock-w: clamp\(/);
  assert.match(band[0], /--st-inspector-w: clamp\(/);
  // The rail is what the section switcher replaces in this band, so nothing
  // may hide the switcher here. The old form of this assertion pinned one
  // exact single-line spelling that studio-nav.css has never used, so it could
  // not fail; this asks the question the finding asks — is there any rule,
  // anywhere in the nav's stylesheet, that hides the switcher?
  const hidesSwitcher = rulesDeclaring(navCss, "display")
    .flatMap(({ selector, body }) => (/display\s*:\s*none/.test(body) ? selector.split(",") : []))
    .map((one) => one.trim())
    // ::-webkit-scrollbar hides the scrollbar, not the strip it belongs to.
    .filter((one) => one.includes(".st-nav-sections") && !one.includes("::"));
  assert.deepEqual(hidesSwitcher, [], "the section switcher is the band's only tool navigation besides ⌘K");
  // And the band's own block keeps it: the rail is gone here, so the nav is
  // where the wordmark yields rather than where the switcher does.
  const navBand = navCss.match(/@media \(min-width: 821px\) and \(max-width: 1180px\) \{[\s\S]*?\n\}/);
  assert.ok(navBand, "studio-nav.css must carry the matching 821-1180px block");
  assert.match(navBand[0], /\.st-nav-title, \.st-nav-sep \{ display: none/);
  // The width the viewport actually gets in this band is measured, not read:
  // see tools/test-interface-measurements.mjs.
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

// R1 —— the wrap that fixed A3 traded a clip for a very tall toolbar: 143px at
// 1440×900 and 1280×800, 221px at 1024×768 (28.8% of the screen) and 320px at
// 834×1112. Wrapping is not the problem; five groups in the strip was. Surface
// and Projection are set-up and moved to the inspector, and the Area group was
// a second copy of controls SurfaceProjectionPanel already owns.
test("the Surface toolbar carries only what a hand on the canvas reaches for", () => {
  const toolbar = read("src/react/pages/surface-studio/SurfaceWorkspaceToolbar.tsx");
  const page = read("src/react/pages/SurfacePaintPage.tsx");
  const strip = toolbar.slice(
    toolbar.indexOf("export function SurfaceWorkspaceToolbar"),
    toolbar.indexOf("export function SurfaceDocumentSetup"),
  );
  assert.ok(strip.length > 0, "both components must live in the toolbar module");
  for (const group of ["surface-workspace-modes", "surface-workspace-history"]) {
    assert.ok(strip.includes(group), `Mode and Document stay in the strip; ${group} is missing`);
  }
  for (const group of ["surface-workspace-source", "surface-workspace-target", "surface-workspace-area"]) {
    assert.ok(!strip.includes(group), `${group} must not be back in the strip`);
  }
  // Where they went, and that the page actually renders it.
  assert.match(toolbar, /export function SurfaceDocumentSetup/);
  assert.match(page, /<SurfaceDocumentSetup controller=\{controller\} snapshot=\{snapshot\} references=\{references\} \/>/);
  // Kit rows, so the sheet's 44px sizing and the tablet band's two-line rows
  // reach them — as flex children of a toolbar group they reached neither.
  assert.match(toolbar, /className="st-row st-row-stacked st-row-full"/);
  // Height at all six viewports is measured, not read:
  // tools/test-interface-measurements.mjs asserts it against the window.
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
    // A call, not an import. The old positive assertion was satisfied by the
    // `import { fitDistanceForRadius }` line alone, so a file could import the
    // helper, ignore it, and solve the distance itself.
    assert.match(
      source,
      /=\s*(?:Math\.max\()?fitDistanceForRadius\(\s*camera/,
      `${path} must solve its distance through the shared fit`,
    );
    // The bug's shape, not one of its spellings. The original read
    // `sphere.radius * padding / Math.sin(halfFov)`, which the old negative
    // assertion — `radius / Math.sin(THREE.MathUtils.degToRad(camera.fov` —
    // does not match: it forbade a spelling the code never had. A distance
    // divided by a sine IS the aspect-blind fit; camera-fit.ts is the one
    // place allowed to write it, because it takes the smaller half-angle.
    assert.doesNotMatch(
      source,
      /\/\s*Math\.sin\(/,
      `${path} must not solve a fit distance from a sine of its own`,
    );
  }
  assert.match(cameraFit, /\/ Math\.sin\(Math\.min\(halfFovY, halfFovX\)\)/);
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

// C3 —— the inset itself needs a notched phone, but the failure did not.
//
// The first pass wrote `.st-nav { padding-left: max(10px, env(…)) }` in the
// kit's mobile block and asserted that the declaration was present. It was.
// It also never applied: studio-nav.css declares `padding: 5px 10px 6px` on
// `.st-nav` in *its* mobile block, one class against one class, in a file that
// loads later — so the shorthand reset both inline sides to a flat 10px and
// the nav, the strip carrying the breadcrumb the finding is about, had no
// inset at all while the toolbar and status bar did. Matching the declaration
// is not the test. Winning the cascade is.
test("the chrome strips' safe-area inset out-specifies any padding shorthand", () => {
  const insetRules = rulesDeclaring(kit, "padding-left")
    .filter(({ body }) => body.includes("env(safe-area-inset-left"));
  assert.equal(insetRules.length, 1, "one rule should pad every chrome strip against the leading inset");
  const [inset] = insetRules;
  const strips = [".st-nav", ".st-toolbar", ".st-statusbar"];
  for (const strip of strips) {
    assert.ok(
      inset.selector.split(",").some((one) => one.trim().endsWith(strip)),
      `${strip} must be in the inset rule's selector list, got "${inset.selector}"`,
    );
  }
  // The doc says all three use max(12px, …); the nav used max(10px, …). The
  // floor is parsed rather than spelled, so 10px fails and 12px passes however
  // the declaration is written.
  for (const side of ["left", "right"] as const) {
    const declaration = new RegExp(`padding-${side}\\s*:\\s*([^;}]+)`).exec(inset.body);
    assert.ok(declaration, `the inset rule must set padding-${side}`);
    assert.match(declaration[1], new RegExp(`env\\(safe-area-inset-${side}`));
    assert.equal(
      Number(/max\(\s*([\d.]+)px/.exec(declaration[1])?.[1]),
      12,
      `the ${side} inset's floor must match the 12px the review documents`,
    );
  }

  // Now the part that failed: every stylesheet in the shell, checked against
  // the inset rule's specificity. A `padding` shorthand resets padding-left
  // and padding-right, so any such rule matching a chrome strip has to lose.
  const insetSpecificity = inset.selector.split(",")
    .map((one) => specificity(one.trim()))
    .reduce((weakest, current) => (beats(weakest, current) ? current : weakest));
  for (const path of [
    "src/react/studio/studio-kit.css",
    "src/react/studio/studio-nav.css",
    "src/react/studio/studio-shell.css",
    "src/react/shell.css",
  ]) {
    for (const rule of rulesDeclaring(rules(read(path)), "padding")) {
      for (const one of rule.selector.split(",").map((part) => part.trim())) {
        if (!strips.some((strip) => one.endsWith(strip))) continue;
        assert.ok(
          beats(insetSpecificity, specificity(one)),
          `${path}: "${one}" sets the padding shorthand at a specificity the safe-area inset `
          + `("${inset.selector.split(",")[0].trim()}") does not beat — this is exactly how C3 shipped broken`,
        );
      }
    }
  }
  // The rendered result — all three strips resolving the same inline padding,
  // and still resolving it after a bare-class shorthand is appended to the
  // document — is measured in tools/test-interface-measurements.mjs.
});

// C4 —— unobservable headlessly: nothing retracts a browser toolbar.
// The finding named three files: the sheet, the tool menu, and the asset
// library. The first pass fixed two and the test only opened two.
test("full-height mobile surfaces are sized in dvh with a vh fallback", () => {
  assert.match(kit, /\.st-sheet\.is-open \{ height: calc\(62vh/);
  assert.match(kit, /\.st-sheet\.is-open \{ height: calc\(62dvh/);
  assert.ok(
    kit.indexOf("62vh") < kit.indexOf("62dvh"),
    "the vh declaration must come first or it would win over dvh",
  );
  assert.match(rules(read("src/react/studio/studio-menu.css")), /max-height:\s*86dvh/);
  // asset-library.css:3/4 — `padding: 5vh` and `max-height: 90vh`, named by the
  // finding and left alone by the fix.
  assert.match(libraryCss, /\.asset-library\s*\{[^}]*max-height:\s*90dvh/s);
  assert.ok(
    libraryCss.indexOf("max-height:90vh") < libraryCss.indexOf("max-height:90dvh"),
    "the vh fallback must precede the dvh declaration",
  );
  assert.match(libraryCss, /\.asset-library-backdrop\s*\{[^}]*padding-block:\s*5dvh/s);
  // No `vh` may be left unpaired: every one of them needs a dvh beside it.
  for (const [, value] of libraryCss.matchAll(/([\d.]+)vh/g)) {
    assert.match(
      libraryCss,
      new RegExp(`${value}dvh`),
      `asset-library.css uses ${value}vh with no ${value}dvh to override it`,
    );
  }
});

// N5 —— the overlay's breakpoint was raised to the shell's 820px, but the
// layout rules that make the full-screen sheet work stayed at 720px, so
// 721-820px got the sheet with the desktop dialog's scrolling category strip.
test("the asset library's sheet layout uses the shell's breakpoint", () => {
  const sheet = libraryCss.match(
    /@media \(max-width: 820px\), \(\(pointer: coarse\) and \(max-height: 500px\)\) \{[\s\S]*?\n\}/,
  );
  assert.ok(sheet, "the overlay must follow MOBILE_STUDIO_QUERY, not a breakpoint of its own");
  for (const rule of [
    /\.asset-library-categories \{ flex-wrap: wrap; overflow-x: visible; \}/,
    /\.asset-library > header \{ flex-wrap: wrap; \}/,
    /\.asset-library-filters \{[^}]*flex-direction: column/,
  ]) assert.match(sheet[0], rule, "a full-screen sheet rule must live at the shell's breakpoint");
  // The card grid keeps a width breakpoint, because column count is a question
  // about pixels — but nothing about *being a sheet* may be left behind it.
  const narrow = libraryCss.match(/@media \(max-width: 720px\) \{[\s\S]*?\n\}/);
  if (narrow) {
    assert.doesNotMatch(narrow[0], /flex-wrap|flex-direction|order:/,
      "layout that follows the shell's mode must not be keyed on 720px");
  }
});

// C5 —— the open sheet left ~200px of a viewport it was editing.
test("the sheet has a peek detent between collapsed and open", () => {
  assert.match(shell, /const SHEET_DETENTS = \["collapsed", "peek", "open"\]/);
  assert.match(kit, /\.st-sheet\.is-peek \{ height: calc\(34dvh/);
  // Anything that hides for an open sheet has to hide for a peeking one.
  assert.match(shellCss, /:has\(\.st-sheet:is\(\.is-open, \.is-peek\)\) \.st-viewport \.graph-toggle/);
  assert.match(rules(read("src/react/pages/surface-painter.css")), /\.st-sheet:is\(\.is-open, \.is-peek\)\)/);
});

// D1 —— two routes of ten filled the nav's chip track.
test("every tool publishes a runtime chip, and page chips do not evict it", () => {
  assert.match(chrome, /export type StudioChipGroup = "runtime" \| "page"/);
  assert.match(chrome, /export function useStudioRuntimeChip/);
  // One publisher, reached by every path that mounts a runtime. Counting calls
  // inside page-runtime.ts — which is what this test used to do — is exactly
  // what let /materialx ship with an empty chip track: it mounts its runtime by
  // hand and called neither of the two hooks being counted. Assert the contract
  // at the routes instead, so a page that opts out of both is what fails.
  assert.match(pageRuntime, /export function useRuntimePhaseChip/);
  // The route table is read out of App.tsx rather than restated here, so a
  // page added tomorrow is covered the day it is added rather than the day
  // someone remembers to extend a list.
  const app = read("src/react/App.tsx");
  const lazyImports = new Map(
    [...app.matchAll(/const (\w+) = lazy\(\(\) => import\("\.\/pages\/([\w-]+)"\)\)/g)]
      .map(([, name, file]) => [name, `src/react/pages/${file}.tsx`]),
  );
  const routes = [...app.matchAll(/<Route path="(\/[\w-]*)" element=\{<(\w+) \/>\}/g)];
  assert.equal(routes.length, 10, `expected the ten studio routes in App.tsx, found ${routes.length}`);
  // Either publisher satisfies it: the point is that the nav's chip track says
  // something on every route, not which group filled it. BlendBridgePage
  // publishes its own bridge/VM chips and no runtime one, and that is fine —
  // an empty track is the defect, and it is what /materialx had.
  for (const [, path, component] of routes) {
    const file = lazyImports.get(component);
    assert.ok(file, `${path} renders <${component} /> with no lazy import to follow`);
    assert.match(
      read(file),
      /useToolController|useToolRuntime|useRuntimePhaseChip|useStudioStatusChips/,
      `${path} leaves the nav chip track empty`,
    );
  }
  // That a chip is actually *rendered* on each route — the part source text
  // cannot see, and the part that was wrong — is measured in
  // tools/test-interface-measurements.mjs.
});

// D2 —— the Parity Catalog's rows were the one control row the kit could not reach.
test("the Parity Catalog's authored inputs are kit rows", () => {
  assert.match(kit, /\.st-row\.st-row-stacked \{/);
  assert.match(read("src/chrome-assets.ts"), /st-row st-row-stacked assets-control/);
  assert.match(read("src/chrome-assets.ts"), /input\.className="st-input"/);
  // Inline sizing would beat the sheet's 28px touch checkbox.
  assert.doesNotMatch(read("src/chrome-assets.ts"), /input\.style\.width="18px"/);
});

// D3 / D4 —— 8px labels and 36px targets in the Surface Studio.
//
// Both halves of this test used to be unfalsifiable in the same way. The
// negative assertions were literal blacklists — `doesNotMatch(/font: 700 8px/)`
// passes on `font: 600 8px`, and `doesNotMatch(/min-height: 36px/)` passes on
// 38px — and the whole test opened one of the two files D3 named, so
// surface-tool-selector.css kept 9px family labels, 9px tool glyphs and an 8px
// "Unavailable" caption while this stayed green. Values, and both files.
test("the Surface Studio holds the kit's type floor and touch minimum", () => {
  for (const [name, css] of [
    ["surface-workspace-toolbar.css", paintToolbarCss],
    ["surface-tool-selector.css", paintSelectorCss],
  ] as const) {
    assert.deepEqual(
      fontSizesPx(css).filter((size) => size < 11), [],
      `${name} sets type below the kit's 11px floor`,
    );
  }
  // D4's minimum, checked on the blocks where it applies. A phone-sized target
  // is either --st-touch (no literal px at all) or a strip height; 0 is the
  // landscape block giving its min-height back.
  for (const [name, css] of [
    ["surface-workspace-toolbar.css", paintToolbarCss],
    ["surface-tool-selector.css", paintSelectorCss],
  ] as const) {
    const mobile = css.slice(css.indexOf("@media (max-width: 820px)"));
    assert.ok(mobile, `${name} must carry a mobile block`);
    for (const property of ["height", "min-height"]) {
      for (const value of pxValues(mobile, property)) {
        assert.ok(
          value === 0 || value >= 44,
          `${name} sets ${property}: ${value}px on a phone, under --st-touch`,
        );
      }
    }
  }
  assert.match(paintToolbarCss, /:is\(button, \.st-btn, \.st-select\) \{ min-height: var\(--st-touch\)/);
  assert.match(paintSelectorCss, /\.surface-tool-option \{[^}]*min-height: var\(--st-touch\)/s);
  // Rendered sizes across six viewports: tools/test-interface-measurements.mjs.
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

// Both overlays open on demand, so neither appeared in the viewport sweep that
// found the other sub-minimum targets. Their sizing is keyed on the pointer,
// not on width: an 834px tablet in portrait answers "is this a finger?" the
// same way a phone does.
test("the overlays size their controls for touch, by pointer not by width", () => {
  const library = rules(read("src/react/blend-studio/asset-library.css"));
  const menuCss = rules(read("src/react/studio/studio-menu.css"));
  for (const [name, css] of [["asset library", library], ["tool menu", menuCss]] as const) {
    const coarse = css.match(/@media \(pointer: coarse\)\s*\{[\s\S]*?\n\}/);
    assert.ok(coarse, `${name} must size its controls under (pointer: coarse)`);
    assert.match(coarse[0], /var\(--st-touch\)/);
  }
  // The star keeps its 30px circle and gets its 44px from a pad around it.
  assert.match(library, /\.asset-library-favorite::after \{ content: ""; position: absolute; inset: -7px/);
  // The category strip clipped "Studies" mid-word and pushed "Scenes" off the
  // end, with the scrollbar hidden and nothing else to say so.
  assert.match(library, /\.asset-library-categories \{ flex-wrap: wrap; overflow-x: visible; \}/);
  // And the overlay follows the shell's breakpoint, not one of its own.
  assert.match(library, /@media \(max-width: 820px\), \(\(pointer: coarse\) and \(max-height: 500px\)\)/);
});

// A lone button was taking the 1.4fr column of a two-up row.
test("a button row of one spans the row", () => {
  assert.match(kit, /\.st-btn-row:has\(> :only-child\) \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

// The phone crumb spent its width on a name the switcher already highlights.
test("the phone breadcrumb spends its width on the tool name", () => {
  const mobile = navCss.slice(navCss.indexOf("@media (max-width: 820px)"));
  assert.match(mobile, /\.st-crumb-section, \.st-crumb i \{ display: none; \}/);
});

/* -------------------------------------------------------------- dropdowns */
/* A second pass over the four routes that carry a `<select>`. */

// Two of the runtime's settings had no control anywhere: the React inspector
// replaced the lil-gui panel, the page renders that panel `hidden`, and tone
// mapping and the environment map were only ever in it.
test("the building's enumerated atmosphere settings have studio controls", () => {
  assert.match(buildingPage, /name: "toneMapping", label: "Tone mapping"/);
  assert.match(buildingPage, /name: "environmentMap", label: "Environment map"/);
  assert.match(buildingPage, /className="st-select"/);
  assert.match(building, /case "toneMapping": env\.settings\.toneMapping/);
  assert.match(building, /case "environmentMap": env\.setEnvironment/);
  // The legacy panel stays the holding pen it is documented to be.
  assert.match(buildingPage, /id="building-gui-dock" className="building-gui-dock" hidden/);
});

// Neither list is fixed: the LUT joins it when the profile validates and the
// EXR when it parses, both long after the inspector has rendered its rows.
test("the atmosphere option lists are published, not read once", () => {
  const environment = read("src/environment.ts");
  assert.match(building, /env\.setChoicesHandler/);
  assert.match(buildingPage, /tool\.subscribeAtmosphereOptions\(/);
  assert.match(environment, /setChoicesHandler\(handler: \(\) => void\)/);
  // The EXR probe used to live in addGui(), which would have made the
  // inspector's choice depend on a lil-gui panel existing.
  assert.match(environment, /private probeBlenderEnvironment\(\)/);
  assert.doesNotMatch(
    environment.slice(environment.indexOf("  addGui(")),
    /loadBlenderStudioEnvironment/,
    "the availability probe must not be tied to the legacy panel",
  );
});

// "Base object" was a .st-section-title sibling, not a label: the combobox
// announced 105 options under no name at all.
test("the typewriter's base object names its own control", () => {
  const page = read("src/react/pages/TypewriterPage.tsx");
  assert.doesNotMatch(page, /<select id="typewriter-base-select"/);
  assert.match(page, /<SearchableSelect id="typewriter-base-select" label="Base object"/);
  assert.match(read("src/react/studio/SearchableSelect.tsx"), /aria-label=\{label\}/);
});

// The same 104-entry catalogue was fronted three ways: a 105-option select on
// /typewriter, another on /paint, and the searchable field /chrome-assets had
// already got right.
test("the shape catalogue is fronted by one picker, not three", () => {
  const paintToolbar = read("src/react/pages/surface-studio/SurfaceWorkspaceToolbar.tsx");
  for (const path of [
    "src/react/pages/TypewriterPage.tsx",
    "src/react/pages/ChromeAssetsPage.tsx",
    "src/react/pages/surface-studio/SurfaceWorkspaceToolbar.tsx",
  ]) {
    assert.match(read(path), /<SearchableSelect/, `${path} must use the shared picker`);
  }
  assert.doesNotMatch(paintToolbar, /references\.map\(\(reference\) => <option/);
  // The two imperative runtimes own their catalogue, so they bind the same
  // helper the component binds rather than reimplementing the matching.
  assert.match(read("src/typewriter.ts"), /bindSearchableSelect\(baseSelect/);
  assert.match(read("src/chrome-assets.ts"), /bindSearchableSelect\(select/);
  assert.match(kit, /\.st-searchable \{/);
});

// The field shows a title but every tool stores an id — the typewriter's
// loader, /paint's reference lookup and the catalog's ?asset= all key on it.
test("the picker's value stays the id the runtimes read", async () => {
  const { matchSearchableOption, stepSearchableOption } = await import("./searchable-select.js");
  const options = [
    { value: "", label: "None · text only" },
    { value: "bin-generator", label: "Recursive Bin Generator · Add-on" },
    { value: "chrome-crayon", label: "Chrome Crayon · Study" },
  ];
  assert.equal(matchSearchableOption(options, "Chrome Crayon · Study")?.value, "chrome-crayon");
  assert.equal(matchSearchableOption(options, "  chrome-crayon ")?.value, "chrome-crayon");
  // A half-typed word must not commit the entry that happens to start with it.
  assert.equal(matchSearchableOption(options, "Chrome"), undefined);
  // Clearing the field is how a base object is removed, so "" is a real value.
  assert.equal(matchSearchableOption(options, "")?.value, "");
  assert.equal(stepSearchableOption(options, "", -1)?.value, "chrome-crayon", "the arrows wrap");
  assert.equal(stepSearchableOption(options, "chrome-crayon", 1)?.value, "");
  assert.equal(stepSearchableOption([], "", 1), undefined);
});

// A tablet keeps the docks, so every touch rule written against .st-sheet
// misses it: the picker's arrows measured 28px on an 834px iPad.
test("the picker is touch-sized by pointer, not by width", () => {
  const coarse = kit.match(/@media \(pointer: coarse\) \{[\s\S]*?\n\}/);
  assert.ok(coarse, "studio-kit.css must size dock controls under (pointer: coarse)");
  assert.match(coarse[0], /\.st-searchable \.st-btn \{ width: var\(--st-touch\); height: var\(--st-touch\); \}/);
  assert.match(coarse[0], /\.st-dock :is\(\.st-select, \.st-input\) \{ height: var\(--st-touch\); \}/);
  // A fixed height on the wrapper would clip those 44px controls back to 28.
  assert.doesNotMatch(paintToolbarCss, /\.surface-workspace-reference \{[^}]*height:/s);
  // And 44px arrows make the Surface group wider than an 834px tablet's
  // toolbar column, so the group wraps for the same reason the strip does.
  assert.match(paintToolbarCss, /\.surface-workspace-group \{[^}]*flex-wrap: wrap/s);
});

/* ------------------------------------------------ the audit's regressions */
/* Four defects an independent pass found in the fixes above, each one a thing
   the source tests of the day could not see. The measured versions live in
   tools/test-interface-measurements.mjs; these are the structural halves. */

// R2 —— .st-toolbar / .st-statusbar got overflow-x only inside the kit's mobile
// block, so the 821–1180px band A1 created had overflow:visible and children
// drew over the adjacent dock: "Hide node editor" 121.8px into /crayon's
// inspector at 834×1112, "Blender bridge · localhost" 413px past the strip on
// `/`. .st-shell is overflow:hidden, so the document never grew and the
// scrollWidth == clientWidth sweep saw nothing.
test("both chrome strips scroll at every width, not only on a phone", () => {
  for (const strip of [".st-toolbar", ".st-statusbar"]) {
    const base = new RegExp(`(?:^|\\n)\\${strip}[^{]*\\{[^}]*overflow-x:\\s*auto`, "s");
    assert.match(kit, base, `${strip} must declare overflow-x outside a media query`);
  }
  // The mobile block may only hide the scrollbar, never re-declare the axis:
  // that is the shape the bug had.
  const mobile = kit.slice(kit.indexOf("@media (max-width: 820px)"), kit.indexOf("@media (pointer: coarse)"));
  assert.doesNotMatch(mobile, /overflow-x:\s*visible/);
  assert.match(mobile, /\.st-toolbar, \.st-statusbar \{ scrollbar-width: none; \}/);
});

// R3 —— the sheet handle was 34px min-height and measured 39px at 844×390, on
// all ten routes: the only sub-44px target at that viewport, and the only
// control that opens the panels at all.
test("the sheet handle keeps the touch minimum in phone landscape", () => {
  const landscape = shellCss.match(/@media \(max-height: 500px\) \{[\s\S]*?\n  \}/);
  assert.ok(landscape, "studio-shell.css must carry the landscape sheet block");
  assert.deepEqual(
    pxValues(landscape[0], "min-height"), [],
    "a literal px min-height here is how the handle ended up at 39px",
  );
  assert.match(landscape[0], /\.st-sheet-handle \{ min-height: var\(--st-touch\)/);
  // --st-sheet-collapsed reserves the handle's height in the body grid, so the
  // two have to name the same number.
  assert.match(landscape[0], /--st-sheet-collapsed: calc\(var\(--st-touch\) \+ 1px/);
});

// N1 —— .st-tabs button had padding: 0 and no height inside a 36px strip, so
// its hit area was its type: "Nodes" 38.6 × 11, "Build Bin" 69.5 × 11 at
// 1440×900. Under WCAG 2.2's 24 × 24 at every viewport but the phone sheet.
test("tab buttons and ghost toolbar buttons have a hit area", () => {
  assert.match(kit, /\.st-tabs button \{[^}]*align-self: stretch/s);
  // The underline moved inside the button when the button gained height; an
  // outset spread would now draw it below the strip.
  assert.match(kit, /\.st-tabs button\[aria-selected="true"\][^}]*box-shadow: inset 0 -2px 0/);
  // A tablet keeps the docks, so the strip is sized for a finger by pointer.
  const coarse = kit.match(/@media \(pointer: coarse\) \{[\s\S]*?\n\}/);
  assert.match(coarse[0], /\.st-tabs \{ height: var\(--st-touch\)/);
  // bin-compare.css's Reframe measured 58.5 × 13 for the same reason.
  const binCss = rules(read("src/react/pages/bin-compare.css"));
  const button = /\.bin-toolbar-button \{([^}]*)\}/.exec(binCss);
  assert.ok(button, "bin-compare.css must still style its ghost toolbar button");
  assert.match(button[1], /display: inline-flex/);
  for (const value of pxValues(button[1], "min-height")) {
    assert.ok(value >= 24, `.bin-toolbar-button is ${value}px tall, under WCAG 2.2's minimum`);
  }
});

// N4 —— the mobile rule that stops the status line being squeezed to one letter
// took its shrink factor away and left it unbounded: a runtime error on
// /crayon at 390×844 took .st-statusbar's scrollWidth to 7,643px.
test("the phone status line keeps its width but does not run away with it", () => {
  const mobile = shellCss.slice(shellCss.indexOf("@media (max-width: 820px)"));
  const rule = /\.st-statusbar > \.st-state,?[^{]*\{([^}]*)\}/.exec(mobile);
  assert.ok(rule, "the mobile status rule must still exist");
  // The original intent survives — shrinking it against 390px rendered one
  // letter of the message — and is now bounded by one screenful.
  assert.match(rule[1], /flex: 0 0 auto/);
  assert.match(rule[1], /max-width: 100%/);
  // The kit is what turns that bound into an ellipsis rather than a clip.
  assert.match(kit, /\.st-state > \[data-status-text\] \{[^}]*text-overflow: ellipsis/s);
});

// ---------------------------------------------------------------------------
// Fourth pass —— the sheet, opened. Everything below was measured by
// tools/test-mobile-sheets.mjs, which taps the handle before it measures.
// `npm run test:interface` never could: a collapsed sheet sets [hidden] on its
// body, so every control behind it has an empty client rect and that sweep's
// own visibility filter dropped the lot.
// ---------------------------------------------------------------------------

// M1 —— 34dvh of a 390px-tall window is 133px, and the handle plus the tab
// strip take 116px of it. Peek measured 17px of panel on all five multi-tab
// routes at 844×390, in front of 1,405px of controls on /building.
test("the phone-landscape detents leave a panel worth opening", () => {
  const landscape = kit.match(/@media \(\(pointer: coarse\) and \(max-height: 500px\)\) \{[\s\S]*?\n\}/);
  assert.ok(landscape, "studio-kit.css must carry the phone-landscape block");
  // The sheet's own chrome in this block: a --st-touch handle and a --st-touch
  // tab strip, plus the body's 10px padding and 10px gap. A detent has to clear
  // that by a touch row before it is showing a control rather than a label's
  // top edge.
  const chromeHeight = 44 + 44 + 20;
  const shortest = 390;
  for (const [detent, floor] of [["peek", 44], ["open", 120]] as const) {
    const rule = new RegExp(`\\.st-sheet\\.is-${detent} \\{ height: calc\\(([^;]+)\\); \\}`, "g");
    const heights = [...landscape[0].matchAll(rule)].map(([, value]) => value);
    assert.ok(heights.length >= 2, `${detent} needs a vh rule and a dvh rule in the landscape block`);
    assert.ok(
      heights.some((value) => value.includes("dvh")),
      `${detent} must resolve against the dynamic viewport, not only vh`,
    );
    for (const height of heights) {
      // `56dvh` → 218px, `100dvh - var(--st-nav-h)` → 338px at --st-nav-h: 52px.
      const percent = /(\d+)d?vh/.exec(height);
      assert.ok(percent, `${detent}'s height must be viewport-relative, got "${height}"`);
      const nav = /var\(--st-nav-h\)/.test(height) ? 52 : 0;
      const panel = (shortest * Number(percent[1]) / 100) - nav - chromeHeight;
      assert.ok(
        panel >= floor,
        `${detent} leaves ${Math.round(panel)}px of panel at 844×390 — under the ${floor}px this detent is for`,
      );
    }
  }
  // The open detent stops at the bar rather than covering it: the switcher is
  // the phone's only tool navigation besides the directory.
  assert.match(landscape[0], /\.st-sheet\.is-open \{ height: calc\(100dvh - var\(--st-nav-h\)\); \}/);
});

// M2 —— five 28 × 28 checkboxes in /building's Details tab, against the app's
// own --st-touch minimum, on both phone viewports.
test("the sheet's checkboxes are touch targets, box and hit area apart", () => {
  const mobile = kit.slice(kit.indexOf("@media (max-width: 820px), ((pointer: coarse) and (max-height: 500px))"));
  const target = /\.st-sheet input\[type=checkbox\][^{]*\{([^}]*)\}/.exec(mobile);
  assert.ok(target, "the mobile block must still size the sheet's checkbox");
  for (const property of ["width", "height"]) {
    assert.deepEqual(
      pxValues(target[1], property), [],
      `a literal px ${property} here is how the target ended up at 28px`,
    );
    assert.match(target[1], new RegExp(`${property}: var\\(--st-touch\\)`));
  }
  // The painted box is not the target any more, so it needs its own box.
  assert.match(mobile, /\.st-sheet input\[type=checkbox\][^{]*::before \{[^}]*content: ""/s);
  // lil-gui's checkbox is a 44 × 28 toggle with a knob; it is not this widget.
  assert.match(target[0], /:not\(\.lil-gui \*\)/);
});

// M3 —— chrome-assets.css corner-anchors the same button for desktop, one
// class against one class, in a lazily-imported stylesheet that lands after
// studio-shell.css. On a phone that left the FAB `position: absolute` with both
// `left` and `right` set, which stretches an auto-width box: 362px across a
// 390px viewport, 816px across an 844px one.
test("the node-graph FAB out-specifies a page's own corner anchor", () => {
  const fab = rulesDeclaring(shellCss, "position")
    .find(({ selector }) => selector.includes(".graph-toggle") && !selector.includes(":has("));
  assert.ok(fab, "studio-shell.css must still place the mobile FAB");
  const anchor = rulesDeclaring(rules(read("src/react/pages/chrome-assets.css")), "position")
    .find(({ selector }) => selector.includes(".graph-toggle"));
  assert.ok(anchor, "chrome-assets.css must still corner-anchor its desktop button");
  assert.ok(
    beats(specificity(fab.selector), specificity(anchor.selector)),
    `"${fab.selector}" must out-specify "${anchor.selector}" — load order put the page stylesheet last`,
  );
  // Winning `position` is not enough: the page rule sets `left`, and a fixed
  // box with both insets stretches instead of hugging its content.
  assert.match(fab.body, /left: auto/);
});

// M4 —— 9px "Active settings" and "Procedural generator", and a 10px generator
// glyph, all in the Options tab of /paint on both phone viewports.
test("the Surface Studio's active-generator card holds the type floor", () => {
  const paintCss = rules(read("src/react/pages/surface-painter.css"));
  for (const selector of [
    "\\.paint-node-tabs > span",
    "\\.surface-active-generator-context > span",
    "\\.surface-active-generator-context small",
  ]) {
    const rule = new RegExp(`${selector} \\{([^}]*)\\}`).exec(paintCss);
    assert.ok(rule, `surface-painter.css must still style ${selector}`);
    for (const size of fontSizesPx(rule[1])) {
      assert.ok(size >= 11, `${selector} renders ${size}px text, under the kit's floor`);
    }
  }
});

// M5 —— N5 raised this overlay's breakpoint and gave its buttons a 44px
// min-height; the category chips are label-width, so the two shortest measured
// 33.6 × 44 ("All") and 42.3 × 44 ("Text") in the phone sheet. The nav's
// switcher had already been through this and got a min-width for it.
test("the asset library's filter chips are targets on both axes", () => {
  const coarse = libraryCss.match(/@media \(pointer: coarse\) \{[\s\S]*?\n\}/);
  assert.ok(coarse, "asset-library.css must still carry its coarse-pointer block");
  const chips = rulesDeclaring(coarse[0], "min-width")
    .find(({ selector }) => selector.includes(".asset-library-filters button"));
  assert.ok(chips, "the filter chips need a min-width, not only a min-height");
  assert.match(chips.body, /min-width: var\(--st-touch\)/);
  // And the height it already had, so neither axis is traded for the other.
  assert.ok(
    rulesDeclaring(coarse[0], "min-height")
      .some(({ selector }) => selector.includes(".asset-library-filters button")),
    "the filter chips must keep their min-height",
  );
});

// M6 —— a tab list that shrinks. `/` publishes Nodes only once a graph installs, so
// clearing the target takes three tabs back to two — left a stored index of 2
// matching no tab: a strip with nothing selected over a body with every panel
// hidden.
test("the sheet's tab index cannot outrun its tabs", () => {
  assert.match(shell, /Math\.min\(sheetTab, Math\.max\(tabs\.length - 1, 0\)\)/);
  // And the clamp is what renders, not just what is computed.
  assert.doesNotMatch(shell, /aria-selected=\{sheetTab === index\}/);
  assert.doesNotMatch(shell, /hidden=\{sheetTab !== index\}/);
  assert.match(shell, /aria-selected=\{activeTab === index\}/);
  assert.match(shell, /hidden=\{activeTab !== index\}/);
});
