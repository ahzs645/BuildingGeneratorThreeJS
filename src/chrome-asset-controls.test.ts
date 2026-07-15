import test from "node:test";
import assert from "node:assert/strict";
import { rangeOverrideValue } from "./chrome-asset-controls";

test("range controls preserve an off-step authored float until edited", () => {
  const authored = 1.0638302564620972;
  assert.equal(rangeOverrideValue(authored, "1.06", false), authored);
  assert.equal(rangeOverrideValue(authored, "1.06", true), 1.06);
});
