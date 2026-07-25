import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Field } from "./core";
import type { Dump } from "./dump-schema";
import { Geometry, Mesh, realizeInstances } from "./geometry";
import { runGenerator } from "./index";
import {
  meshCircle,
  meshCone,
  meshCube,
  meshGrid,
  meshIcoSphere,
} from "./primitives";
import { REGISTRY, type EvalAPI } from "./registry";
import "./nodes/curves";
import "./nodes/extra";

function assertAllFacesSharp(geometry: Geometry): void {
  const mesh = geometry.mesh;
  assert.ok(mesh);
  const sharpFace = mesh.attributes.get("sharp_face");
  assert.equal(sharpFace?.domain, "FACE");
  assert.equal(sharpFace?.data.length, mesh.faces.length);
  assert.ok(sharpFace?.data.every((value) => value === 1));
}

function hash(view: ArrayBufferView): string {
  return createHash("sha256")
    .update(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
    .digest("hex");
}

test("generated mesh primitives expose Blender's flat-face built-in", () => {
  const primitives = [
    meshCube([2, 2, 2]),
    meshGrid(2, 2, 2, 2),
    meshCircle(8, 1, "NGON"),
    meshIcoSphere(1, 1),
    meshCone(8, 1, 0.5, 2),
  ];
  for (const geometry of primitives) assertAllFacesSharp(geometry);
});

test("Mesh to Curve drops mesh-only sharpness while preserving generic face data", () => {
  const source = meshGrid(2, 2, 2, 2);
  assert.ok(source.mesh);
  source.mesh.attributes.set("panel", { domain: "FACE", data: [7] });

  const handler = REGISTRY.get("GeometryNodeMeshToCurve");
  assert.ok(handler);
  const output = handler({
    node: { inputs: [{ identifier: "Selection", linked: false }] },
    geo: () => source,
    field: () => Field.of(1),
  } as unknown as EvalAPI).Curve as Geometry;

  assert.equal(output.curveAttributes.has("sharp_face"), false);
  assert.equal(output.curveAttributes.has("sharp_edge"), false);
  assert.deepEqual(output.curveAttributes.get("panel"), {
    domain: "POINT",
    data: [7, 7, 7, 7],
  });
});

test("Fill Curve creates flat polygons", () => {
  const source = new Geometry();
  source.curves = [{
    cyclic: true,
    points: [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]],
  }];
  const handler = REGISTRY.get("GeometryNodeFillCurve");
  assert.ok(handler);
  const output = handler({
    geo: () => source,
    str: () => "NGONS",
    prop: (_name: string, fallback: unknown) => fallback,
  } as EvalAPI).Mesh as Geometry;
  assertAllFacesSharp(output);
});

test("Module 3 Control Box retains Blender's 169 sharp faces through Convex Hull", async () => {
  const geometryDump = JSON.parse(await readFile(fileURLToPath(new URL(
    "../../public/dojo/course-modules/module3-control-box/dump.json",
    import.meta.url,
  )), "utf8")) as Dump;
  const shaderMetadata = JSON.parse(await readFile(fileURLToPath(new URL(
    "../../public/dojo/course-modules/module3-shader-metadata.json",
    import.meta.url,
  )), "utf8"));
  const result = await runGenerator(Object.assign(geometryDump, shaderMetadata), {
    object: "Cube.001",
  });
  const mesh = realizeInstances(result.geometry).mesh;
  assert.ok(mesh);
  const sharpFace = mesh.attributes.get("sharp_face");

  assert.deepEqual(result.soup.stats, { verts: 1860, faces: 1609, tris: 3502 });
  assert.equal(sharpFace?.domain, "FACE");
  assert.equal(sharpFace?.data.length, 1609);
  assert.equal(sharpFace?.data.filter(Boolean).length, 169);
  assert.ok(result.soup.cornerNormals);
  assert.equal(hash(result.soup.positions), "b5e1c03429704d302fa2b2913508b446a7d981d63a5e4db6d4bccfe957c56a00");
  assert.equal(hash(result.soup.indices), "c7a24b29b64d927c0cfcfd75c22bf45adc504d5346a97c8524d4ef206d78d93b");
  assert.deepEqual(result.soup.groups, [{
    start: 0,
    count: 10506,
    material: null,
  }]);
});
