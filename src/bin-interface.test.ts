import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const repo = new URL("../", import.meta.url);
const runtime = readFileSync(new URL("src/bin-compare.ts", repo), "utf8");
const page = readFileSync(new URL("src/react/pages/BinComparePage.tsx", repo), "utf8");
const css = readFileSync(new URL("src/react/pages/bin-compare.css", repo), "utf8");
const app = readFileSync(new URL("src/react/App.tsx", repo), "utf8");
const menu = readFileSync(new URL("src/react/studio/StudioMenu.tsx", repo), "utf8");

test("Recursive Bin has one canonical workspace and redirects retired live URLs", () => {
  assert.doesNotMatch(app, /BinLivePage/);
  assert.match(app, /"\/bin\/live": "\/bin"/);
  assert.doesNotMatch(menu, /title: "Bin Live"/);
  assert.equal(existsSync(new URL("src/bin-live.ts", repo)), false);
  assert.equal(existsSync(new URL("src/react/pages/BinLivePage.tsx", repo)), false);
  assert.equal(existsSync(new URL("src/react/pages/bin-live.css", repo)), false);
});

test("Recursive Bin separates build and validation workflows with complete actions", () => {
  for (const label of ["Build Bin", "Validate Engines", "Authored reset", "Revert preview", "Copy link", "Preview current bin", "Compare with Blender", "GLB", "STL", "Metadata"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /BIN_PRESETS\.map/);
  assert.match(page, /useToolRuntime\([^;]+isMobile\)/s);
  assert.match(page, /key=\{isMobile \? "mobile-bin-canvas" : "desktop-bin-canvas"\}/);
  assert.match(page, /Material mode reconstructs authored shaders in WebGL; it is not a Blender render comparison\./);
});

test("Recursive Bin clears stale truth claims and preserves a VM-only failure result", () => {
  assert.match(runtime, /function markDirty\(/);
  assert.match(runtime, /resultsEl\.classList\.add\("stale"\)/);
  assert.match(runtime, /Promise\.allSettled\(\[loadBlenderTruth/);
  assert.match(runtime, /GN-VM evaluated successfully, but no Blender payload exists/);
  assert.match(runtime, /No previous exact-match result is being shown/);
});

test("Recursive Bin exposes semantic states and protects number editing from shortcuts", () => {
  assert.match(page, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(page, /aria-pressed="true"/);
  assert.match(page, /aria-labelledby=\{labelId\}/);
  assert.match(page, /aria-keyshortcuts="O S W 1 2 3"/);
  assert.match(page, /tabIndex=\{0\}/);
  assert.match(page, /event\.key === "Home"/);
  assert.match(page, /event\.key === "End"/);
  assert.match(runtime, /target\?\.matches\("input, textarea, select, button"\)/);
  assert.match(runtime, /setAttribute\("aria-pressed"/);
  assert.match(css, /#app:focus-visible/);
});

test("Recursive Bin mobile controls use the full row and reframe after aspect changes", () => {
  assert.match(css, /@media \(max-width: 820px\)/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) 72px/);
  assert.match(css, /bin-param-row input\[type="range"\].*width: 100%/s);
  assert.match(runtime, /shouldReframe/);
});

test("Recursive Bin breakpoint remount persists the complete draft and runtime view", () => {
  assert.match(page, /useToolRuntime\("Recursive Bin · Build and Validate", loadBinCompare, isMobile\)/);
  assert.match(page, /key=\{isMobile \? "mobile-bin-canvas" : "desktop-bin-canvas"\}/);
  assert.match(runtime, /buildWorkspaceButton\.getAttribute\("aria-selected"\) === "true"/);
  assert.match(runtime, /binSearchFromValues\(values, \{ workspace, layout: mode, style, visible: resultView \}\)/);
  assert.match(runtime, /history\.replaceState/);
  // The deferred, connectivity-checked release moved into canvas-viewport's
  // releaseToolContext; this asserts the contract rather than the line's old
  // address. It went unnoticed because the test glob never reached this file.
  assert.match(runtime, /releaseToolContext\(renderer\)/);
  assert.match(
    readFileSync(new URL("src/canvas-viewport.ts", repo), "utf8"),
    /if \(!renderer\.domElement\.isConnected\) renderer\.forceContextLoss\(\)/,
  );
});

test("Recursive Bin uses registry and current live surface evidence without fixture overclaiming", () => {
  assert.match(runtime, /dojo\/bin-geometry-parity\.json/);
  assert.match(runtime, /findBinParityEvidence\(parityEvidence, overrides\)/);
  assert.match(runtime, /measureBinSurfaceParity\(truthSolid!, vmSolid!\)/);
  assert.match(runtime, /fixture-exact claims are disabled/);
  assert.match(runtime, /requested .* applied/);
});
