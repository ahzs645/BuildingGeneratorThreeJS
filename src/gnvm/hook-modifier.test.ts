import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runGenerator, type Dump } from "./index";
import { Field } from "./core";
import { Geometry } from "./geometry";
import { REGISTRY, type EvalAPI } from "./registry";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/nodes-node/dump.json",
  import.meta.url,
)), "utf8")) as Dump;

test("pre-Geometry-Nodes Hooks rebuild the evaluated curve frame", async () => {
  const result = await runGenerator(dump, { object: "Point.001" });
  assert.deepEqual(result.soup.stats, { verts: 4736, faces: 4672, tris: 9344 });

  const source = dump.objects?.find((object) => object.name === "Point.001");
  assert.ok(source?.matrix_world);
  const translation = source.matrix_world.map((row) => row[3]).slice(0, 3);
  const positions = result.soup.positions;
  const worldMin = [Infinity, Infinity, Infinity];
  const worldMax = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[offset + axis] + translation[axis];
      worldMin[axis] = Math.min(worldMin[axis], value);
      worldMax[axis] = Math.max(worldMax[axis], value);
    }
  }

  const blenderMin = [-21.64906883239746, -1.6307388544082642, -2.5964837074279785];
  const blenderMax = [-12.781160354614258, 0.036633364856243134, 7.101312637329102];
  const maximumError = Math.max(
    ...worldMin.map((value, axis) => Math.abs(value - blenderMin[axis])),
    ...worldMax.map((value, axis) => Math.abs(value - blenderMax[axis])),
  );
  assert.ok(maximumError < 0.00051, `expected Hook-rebuilt bounds within 0.00051, got ${maximumError}`);
});

test("Set Curve Handle Positions invalidates the frame derived from old handles", () => {
  const geometry = new Geometry();
  geometry.curves = [{
    cyclic: false,
    resolution: 4,
    points: [[0, 0, 0], [1, 0, 0]],
    controlPoints: [[0, 0, 0], [1, 0, 0]],
    bezierLeft: [[-0.25, 0, 0], [0.75, 0, 0]],
    bezierRight: [[0.25, 0, 0], [1.25, 0, 0]],
  }];
  geometry.curveAttributes.set("__curve_tangent", { domain: "POINT", data: [[1, 0, 0], [1, 0, 0]] });
  geometry.curveAttributes.set("__curve_imported_tangent", { domain: "CURVE", data: [1] });
  geometry.curveAttributes.set("__curve_normal", { domain: "POINT", data: [[0, 0, 1], [0, 0, 1]] });

  const handler = REGISTRY.get("GeometryNodeSetCurveHandlePositions");
  assert.ok(handler);
  const result = handler({
    geo: () => geometry,
    field: (name: string) => Field.of(name === "Selection" ? 1 : [0, 1, 0]),
    prop: (_name: string, fallback: unknown) => fallback === "LEFT" ? "LEFT" : fallback,
    node: { inputs: [{ identifier: "Position", linked: false }] },
  } as unknown as EvalAPI).Curve as Geometry;

  assert.equal(result.curveAttributes.has("__curve_tangent"), false);
  assert.equal(result.curveAttributes.has("__curve_imported_tangent"), false);
  assert.equal(result.curveAttributes.has("__curve_normal"), false);
  assert.deepEqual(result.curves[0].bezierLeft?.[0], [-0.25, 1, 0]);
});
