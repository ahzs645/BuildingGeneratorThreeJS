import test from "node:test";
import assert from "node:assert/strict";
import {
  captureOverrideValue,
  guideLinePreviewValue,
  rangeOverrideValue,
} from "./chrome-asset-controls";

test("range controls preserve an off-step authored float until edited", () => {
  const authored = 1.0638302564620972;
  assert.equal(rangeOverrideValue(authored, "1.06", false), authored);
  assert.equal(rangeOverrideValue(authored, "1.06", true), 1.06);
});

test("capture URL overrides retain each Geometry Nodes socket type", () => {
  assert.equal(captureOverrideValue(64, "100"), 100);
  assert.equal(captureOverrideValue(false, "true"), true);
  assert.equal(captureOverrideValue(false, "0"), false);
  assert.equal(captureOverrideValue("Y", "Z"), "Z");
  assert.deepEqual(captureOverrideValue([0, 0, 0], "1.5,-2,3"), [1.5, -2, 3]);
  assert.equal(captureOverrideValue(64, null), undefined);
  assert.equal(captureOverrideValue(64, "not-a-number"), undefined);
});

test("authored captures hide declared guide curves without removing the viewport diagnostic", () => {
  assert.equal(guideLinePreviewValue(true, true, null), "hide");
  assert.equal(guideLinePreviewValue(false, true, null), "show");
  assert.equal(guideLinePreviewValue(true, false, null), "show");
  assert.equal(guideLinePreviewValue(true, true, "show"), "show");
  assert.equal(guideLinePreviewValue(false, true, "hide"), "hide");
  assert.equal(guideLinePreviewValue(true, true, "invalid"), "hide");
});
