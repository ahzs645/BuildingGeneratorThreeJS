import assert from "node:assert/strict";
import test from "node:test";
import { Field, type Vec3 } from "./core";
import { Geometry, Mesh } from "./geometry";
import "./nodes/meshops";
import { type EvalAPI, REGISTRY } from "./registry";

test("region Extrude Mesh preserves the magnitude of averaged face normals", () => {
  const geometry = new Geometry();
  const mesh = new Mesh();
  mesh.positions = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [-1, 0, 1],
    [0, -1, 0],
  ];
  mesh.faces = [
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 4],
    [0, 4, 1],
  ];
  geometry.mesh = mesh;

  const handler = REGISTRY.get("GeometryNodeExtrudeMesh");
  assert.ok(handler);
  const output = handler({
    geo: () => geometry,
    prop: () => "FACES",
    num: (name: string) => name === "Offset Scale" ? 2 : 0,
    bool: () => false,
    field: () => Field.of(1),
    node: { name: "Extrude Mesh", inputs: [{ identifier: "Offset", linked: false }] },
  } as unknown as EvalAPI).Mesh as Geometry;

  const sum = mesh.faces.reduce<Vec3>((normal, _, face) => {
    const next = mesh.faceNormal(face);
    return [normal[0] + next[0], normal[1] + next[1], normal[2] + next[2]];
  }, [0, 0, 0]);
  const expected = sum.map((component) => component / mesh.faces.length * 2) as Vec3;
  const actual = output.mesh!.positions[0];
  for (let axis = 0; axis < 3; axis++)
    assert.ok(Math.abs(actual[axis] - expected[axis]) < 1e-12);
  assert.ok(Math.hypot(...actual) < 2, "the non-planar average must not be normalized back to unit length");
});

test("repeated edge extrusion keeps open-profile endpoint strips consistently wound", () => {
  let geometry = new Geometry();
  const mesh = new Mesh();
  mesh.positions = [
    [0, 0, 0],
    [1, 0, 0],
    [2, 0, 0],
    [3, 0, 0],
  ];
  mesh.edges = [[0, 1], [1, 2], [2, 3]];
  geometry.mesh = mesh;

  const handler = REGISTRY.get("GeometryNodeExtrudeMesh");
  assert.ok(handler);
  let selection = Field.of(1);
  for (let step = 0; step < 3; step++) {
    const output = handler({
      geo: () => geometry,
      prop: () => "EDGES",
      num: (name: string) => name === "Offset Scale" ? 1 : 0,
      bool: () => false,
      field: (name: string) => name === "Selection" ? selection : Field.of([0, 1, 0]),
      node: { name: "Extrude Mesh", inputs: [{ identifier: "Offset", linked: true }] },
    } as unknown as EvalAPI);
    geometry = output.Mesh as Geometry;
    selection = output.Top as Field;
  }

  assert.equal(geometry.mesh!.faces.length, 9);
  for (let face = 0; face < geometry.mesh!.faces.length; face++)
    assert.deepEqual(geometry.mesh!.faceNormal(face), [0, 0, -1]);
});
