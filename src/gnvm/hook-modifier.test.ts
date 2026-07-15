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

test("pre-Geometry-Nodes Hooks and handle edits match the evaluated Blender curve", async () => {
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
  assert.ok(maximumError < 0.000005, `expected rebuilt bounds within 0.000005, got ${maximumError}`);

  const blenderProbes = new Map<number, number[]>([
    [0, [-1.1082268953323364, -0.0400000661611557, -1.0124541521072388]],
    [8, [-1.1063069105148315, -3.286666938606686e-8, -1.0524080991744995]],
    [24, [-1.1101468801498413, -3.517153501775283e-8, -0.972500205039978]],
    [2211, [7.100789546966553, -1.5948784351348877, 2.321850299835205]],
    [4726, [7.757305145263672, -1.5720593929290771, 3.686680316925049]],
  ]);
  const maximumAlignedProbeError = Math.max(...[...blenderProbes].flatMap(([index, expected]) =>
    expected.map((value, axis) => Math.abs(positions[index * 3 + axis] - value))));
  assert.ok(maximumAlignedProbeError < 0.000004,
    `expected aligned Blender probes within 0.000004, got ${maximumAlignedProbeError}`);
});

test("Set Curve Handle Positions rebuilds endpoint derivatives and invalidates normals", () => {
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
    prop: (_name: string, fallback: unknown) => fallback === "LEFT" ? "RIGHT" : fallback,
    node: { inputs: [{ identifier: "Position", linked: false }] },
  } as unknown as EvalAPI).Curve as Geometry;

  const tangents = result.curveAttributes.get("__curve_tangent")?.data as number[][];
  assert.equal(tangents.length, result.curves[0].points.length);
  assert.ok(Math.abs(tangents[0][0] - 0.24253562503633297) < 1e-12);
  assert.ok(Math.abs(tangents[0][1] - 0.9701425001453319) < 1e-12);
  assert.deepEqual(tangents.at(-1), [1, 0, 0]);
  assert.deepEqual(result.curveAttributes.get("__curve_imported_tangent")?.data, [1]);
  assert.equal(result.curveAttributes.has("__curve_normal"), false);
  assert.deepEqual(result.curves[0].bezierRight?.[0], [0.25, 1, 0]);
});
