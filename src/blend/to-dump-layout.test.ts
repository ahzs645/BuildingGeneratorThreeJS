import assert from "node:assert/strict";
import test from "node:test";
import { resolveStoredNodeLayouts } from "./to-dump";

test("Blender 4.x locx/locy locations upgrade through nested frame offsets", () => {
  const layouts = resolveStoredNodeLayouts([
    { name: "Frame", locx: -500, locy: 20, offsetx: -9.8278, offsety: 4.8633 },
    {
      name: "Value",
      parent: "Frame",
      locx: 70,
      locy: -58,
      offsetx: 3.7605,
      offsety: 1.8932,
    },
    {
      name: "Nested Frame",
      parent: "Frame",
      locx: 240,
      locy: -180,
      offsetx: 12,
      offsety: -6,
    },
    {
      name: "Nested Value",
      parent: "Nested Frame",
      locx: 10,
      locy: -30,
      offsetx: 14,
      offsety: -2,
    },
  ]);

  const rounded = (values?: [number, number]): number[] | undefined => values?.map((value) => Number(value.toFixed(4)));
  assert.deepEqual(rounded(layouts.get("Frame")?.location), [-509.8278, 24.8633]);
  assert.deepEqual(rounded(layouts.get("Value")?.location), [83.5883, -60.9701]);
  assert.deepEqual(rounded(layouts.get("Value")?.location_absolute), [-426.2395, -36.1068]);
  assert.deepEqual(rounded(layouts.get("Nested Frame")?.location), [261.8278, -190.8633]);
  assert.deepEqual(layouts.get("Nested Value")?.location, [12, -26]);
  assert.deepEqual(layouts.get("Nested Value")?.location_absolute, [-236, -192]);
});

test("modern location is preferred and location cycles fail closed", () => {
  const layouts = resolveStoredNodeLayouts([
    { name: "Modern", location: [12, -8], locx: 900, locy: 900 },
    { name: "A", parent: "B", location: [1, 2] },
    { name: "B", parent: "A", location: [3, 4] },
  ]);
  assert.deepEqual(layouts.get("Modern"), {
    location: [12, -8],
    location_absolute: [12, -8],
  });
  assert.ok(layouts.has("A") && layouts.has("B"));
});
