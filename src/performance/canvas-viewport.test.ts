import assert from "node:assert/strict";
import test from "node:test";
import {
  MOBILE_CANVAS_BREAKPOINT, canvasPixelRatioFor, isLowPowerViewport,
} from "../canvas-viewport";

test("mobile and coarse-pointer canvases cap their initial pixel ratio at 1.5", () => {
  assert.equal(canvasPixelRatioFor(3, 390, true), 1.5);
  assert.equal(canvasPixelRatioFor(3, 812, false), 1.5);
  assert.equal(canvasPixelRatioFor(3, 1440, true), 1.5);
});

test("desktop canvases retain the 2x ceiling and lower-density displays", () => {
  assert.equal(canvasPixelRatioFor(3, 1440, false), 2);
  assert.equal(canvasPixelRatioFor(1.25, 1440, false), 1.25);
});

test("pixel-ratio selection respects stricter limits and sanitizes invalid input", () => {
  assert.equal(canvasPixelRatioFor(3, 390, true, 1), 1);
  assert.equal(canvasPixelRatioFor(Number.NaN, 1440, false), 1);
});

test("the low-power predicate matches the viewports that get the reduced pixel ratio", () => {
  // narrow screen, coarse pointer, or both — the cases capped at 1.5 above
  assert.equal(isLowPowerViewport(390, true), true);
  assert.equal(isLowPowerViewport(812, false), true);
  assert.equal(isLowPowerViewport(1440, true), true);
  assert.equal(isLowPowerViewport(1440, false), false);
  // the breakpoint itself is low-power; one pixel past it is not
  assert.equal(isLowPowerViewport(MOBILE_CANVAS_BREAKPOINT, false), true);
  assert.equal(isLowPowerViewport(MOBILE_CANVAS_BREAKPOINT + 1, false), false);
});

test("an unmeasured viewport is not mistaken for a small screen", () => {
  // A tab that boots hidden or prerendering reports innerWidth 0 before layout.
  // Callers latch this once at startup, so treating 0 as "mobile" would leave a
  // desktop stuck at the reduced pixel ratio with ambient occlusion off.
  assert.equal(isLowPowerViewport(0, false), false);
  assert.equal(canvasPixelRatioFor(2, 0, false), 2);
  // a coarse pointer is still decisive on its own, width or no width
  assert.equal(isLowPowerViewport(0, true), true);
});
