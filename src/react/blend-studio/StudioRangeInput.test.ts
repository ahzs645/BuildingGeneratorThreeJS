import assert from "node:assert/strict";
import test from "node:test";
import { steppedStudioRangeValue, studioRangeValueAtPointer } from "./StudioRangeInput";

test("steps from the exact authored value instead of snapping to the HTML grid", () => {
  assert.equal(
    steppedStudioRangeValue(23.715652465820312, 0, 71.14695739746094, 0.07114695739746094, 1),
    23.7867994232178,
  );
  assert.equal(
    steppedStudioRangeValue(23.715652465820312, 0, 71.14695739746094, 0.07114695739746094, -1),
    23.6445055084229,
  );
});

test("range stepping clamps at both bounds", () => {
  assert.equal(steppedStudioRangeValue(9.8, 0, 10, 1, 1), 10);
  assert.equal(steppedStudioRangeValue(0.2, 0, 10, 1, -1), 0);
  assert.equal(steppedStudioRangeValue(5, 0, 10, 1, 1, 10), 10);
});

test("pointer values preserve imported precision or snap to a discrete step", () => {
  assert.equal(studioRangeValueAtPointer(50, 0, 100, 0, 10, 1, true), 5);
  assert.equal(studioRangeValueAtPointer(56, 0, 100, 0, 10, 1, false), 6);
  assert.equal(studioRangeValueAtPointer(-10, 0, 100, 0, 10, 1, false), 0);
  assert.equal(studioRangeValueAtPointer(110, 0, 100, 0, 10, 1, false), 10);
});
