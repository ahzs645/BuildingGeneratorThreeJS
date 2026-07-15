import assert from "node:assert/strict";
import test from "node:test";
import { nearestEdgePointFloat32 } from "./nodes/geometry";
import { blenderMergeTargets } from "./nodes/meshops";
import { meshGrid } from "./primitives";

test("Mesh Grid preserves Blender float32 step and X-major vertex order", () => {
  const positions = meshGrid(313.1252193450928, 287.75, 4, 3).mesh?.positions;

  assert.deepEqual(positions, [
    [-156.56260681152344, -143.875, 0],
    [-156.56260681152344, 0, 0],
    [-156.56260681152344, 143.875, 0],
    [-52.18753433227539, -143.875, 0],
    [-52.18753433227539, 0, 0],
    [-52.18753433227539, 143.875, 0],
    [52.18753433227539, -143.875, 0],
    [52.18753433227539, 0, 0],
    [52.18753433227539, 143.875, 0],
    [156.56260681152344, -143.875, 0],
    [156.56260681152344, 0, 0],
    [156.56260681152344, 143.875, 0],
  ]);
});

test("Geometry Proximity uses Blender float32 closest-edge arithmetic", () => {
  const result = nearestEdgePointFloat32(
    [70.57221984863281, 27.26752281188965, 1.370941162109375],
    [
      [[0.1, 0.2, 0.3], [100.5, 30.3, 2.7]],
      [[10, -4, 1], [11, -4, 1]],
    ],
  );

  assert.deepEqual(result, {
    d: 5.726995944976807,
    q: [72.19184112548828, 21.81319236755371, 2.023311138153076],
  });
});

test("Merge by Distance keeps Blender's index-ordered representative targets", () => {
  const targets = blenderMergeTargets(
    [[0, 0, 0], [0.0005, 0, 0], [0.0014, 0, 0], [2, 0, 0]],
    [true, true, true, false],
    0.001,
  );

  assert.deepEqual(targets, [0, 0, -1, -2]);
});
