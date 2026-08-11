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
  // Sliced from the raw text — the section boundary IS a comment — then
  // stripped, so the assertions below still match rules rather than prose.
  const mobile = rules(kitRaw.slice(kitRaw.indexOf("------------------ mobile */")));
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
  assert.match(rules(read("src/react/studio/studio-menu.css")), /max-height:86dvh/);
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
