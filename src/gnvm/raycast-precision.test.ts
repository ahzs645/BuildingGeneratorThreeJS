import test from "node:test";
import assert from "node:assert/strict";
import {
  blenderRaycastTriangleForTest,
  blenderRaycastTrianglesForTest,
  normalizeBlenderFloat3,
} from "./nodes/crayon";

test("Raycast normalizes directions through Blender float32 divisions", () => {
  assert.deepEqual(normalizeBlenderFloat3([
    5.5999997456868496, -1.5999999273391001, 0.8000000106436866,
  ]), [
    0.9525793790817261, -0.27216553688049316, 0.13608276844024658,
  ]);
});

test("Raycast uses Blender's float32 watertight triangle intersection", () => {
  const origin: [number, number, number] = [
    5.5999997456868496, -1.5999999273391001, 0.8000000106436866,
  ];
  const hit = blenderRaycastTriangleForTest(origin, origin, 100,
    [7.677200794219971, -2.128819227218628, 0.8000000715255737],
    [7.682273864746094, -2.111541748046875, 1.2000000476837158],
    [7.620327472686768, -2.322511672973633, 1.2029118537902832],
  );

  assert.ok(hit);
  assert.equal(hit.distance, 2.1622161865234375);
  assert.deepEqual(hit.position, [
    7.659682273864746, -2.1884806156158447, 1.094240427017212,
  ]);
});

test("Raycast follows Blender BVH traversal order for coincident hits", () => {
  const hit = blenderRaycastTrianglesForTest([0.25, 0.25, 0], [0, 0, 1], 100, [
    [[0, 0, 1], [1, 0, 1], [0, 1, 1]],
    [[0, 0, 1], [0, 1, 1], [1, 0, 1]],
  ]);

  assert.ok(hit);
  assert.equal(hit.distance, 1);
  assert.deepEqual(hit.normal, [0, 0, -1]);
});
