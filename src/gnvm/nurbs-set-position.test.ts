import assert from "node:assert/strict";
import test from "node:test";
import { Field, type Vec3 } from "./core";
import { Geometry } from "./geometry";
import "./nodes/geometry";
import { nurbsSpline } from "./nodes/extra";
import { type EvalAPI, REGISTRY } from "./registry";

test("Set Position edits NURBS controls and rebuilds evaluated samples", () => {
  const controls: Vec3[] = [
    [0, 0, 0],
    [1, 2, 0],
    [3, 2, 0],
    [4, 0, 0],
    [5, -1, 0],
  ];
  const geometry = new Geometry();
  geometry.curves = [nurbsSpline({
    points: controls,
    cyclic: false,
    resolution: 8,
  })];
  const before = geometry.curves[0].points.map((point) => [...point]);
  const handler = REGISTRY.get("GeometryNodeSetPosition");
  assert.ok(handler);

  const result = handler({
    geo: () => geometry,
    field: (name: string) =>
      name === "Selection" ? Field.of(1) : Field.of([0.5, -1, 2]),
    node: {
      name: "Set Position",
      inputs: [
        { identifier: "Position", linked: false },
        { identifier: "Offset", linked: true },
      ],
    },
  } as unknown as EvalAPI).Geometry as Geometry;

  assert.equal(result.curves[0].controlPoints?.length, controls.length);
  assert.equal(result.curves[0].points.length, before.length);
  assert.deepEqual(
    result.curves[0].controlPoints,
    controls.map(([x, y, z]) => [x + 0.5, y - 1, z + 2]),
  );
  assert.deepEqual(
    result.curves[0].points,
    before.map(([x, y, z]) => [x + 0.5, y - 1, z + 2]),
  );
});
