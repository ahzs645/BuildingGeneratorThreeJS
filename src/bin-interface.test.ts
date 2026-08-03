import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repo = new URL("../", import.meta.url);
const runtime = readFileSync(new URL("src/bin-compare.ts", repo), "utf8");
const page = readFileSync(new URL("src/react/pages/BinComparePage.tsx", repo), "utf8");
const css = readFileSync(new URL("src/react/pages/bin-compare.css", repo), "utf8");

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
  assert.match(runtime, /if \(!canvas\.isConnected\) renderer\.forceContextLoss\(\)/);
});

test("Recursive Bin uses registry and current live surface evidence without fixture overclaiming", () => {
  assert.match(runtime, /dojo\/bin-geometry-parity\.json/);
  assert.match(runtime, /findBinParityEvidence\(parityEvidence, overrides\)/);
  assert.match(runtime, /measureBinSurfaceParity\(truthSolid!, vmSolid!\)/);
  assert.match(runtime, /fixture-exact claims are disabled/);
  assert.match(runtime, /requested .* applied/);
});
