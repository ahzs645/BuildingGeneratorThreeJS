import assert from "node:assert/strict";
import test from "node:test";
import { Field } from "./core";
import { Geometry, Mesh } from "./geometry";
import "./nodes/meshops";
import "./nodes/math";
import { type EvalAPI, REGISTRY } from "./registry";

test("FACE Separate Geometry filters Collection Info instance payloads", () => {
  const payload = new Geometry();
  payload.mesh = new Mesh();
  payload.mesh.positions = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
  ];
  payload.mesh.faces = [[0, 1, 2], [2, 1, 3]];
  payload.mesh.attributes.set("wrap", {
    domain: "FACE",
    data: [1, 0],
  });
  const source = new Geometry();
  source.instances.push({
    geometry: payload,
    position: [2, 3, 4],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });
  const handler = REGISTRY.get("GeometryNodeSeparateGeometry");
  assert.ok(handler);

  const output = handler({
    geo: () => source,
    prop: (name: string, fallback: unknown) =>
      name === "domain" ? "FACE" : fallback,
    field: () => Field.make((context) =>
      Array.from(
        { length: context.size },
        (_, index) => context.attr?.("wrap", index) ?? 0,
      )),
    node: { name: "Separate Geometry", inputs: [] },
  } as unknown as EvalAPI);
  const selected = output.Selection as Geometry;
  const inverted = output.Inverted as Geometry;

  assert.equal(selected.instances.length, 1);
  assert.equal(inverted.instances.length, 1);
  assert.equal(selected.instances[0].geometry.mesh?.faces.length, 1);
  assert.equal(inverted.instances[0].geometry.mesh?.faces.length, 1);
  assert.deepEqual(selected.instances[0].position, [2, 3, 4]);
});

test("Geometry Switch resolves a lazy single-value condition", () => {
  const populated = new Geometry();
  populated.mesh = new Mesh();
  populated.mesh.positions = [[0, 0, 0]];
  const empty = new Geometry();
  const handler = REGISTRY.get("GeometryNodeSwitch");
  assert.ok(handler);

  const output = handler({
    input: (name: string) => name === "False" ? populated : empty,
    field: () => Field.make((context) =>
      Array.from({ length: context.size }, () => 0)),
    prop: (name: string, fallback: unknown) =>
      name === "input_type" ? "GEOMETRY" : fallback,
    resolve: (field: Field, geometry: Geometry, domain: "POINT") =>
      field.array({
        size: geometry.mesh?.positions.length ?? 0,
        domain,
      }),
    node: { name: "Switch", inputs: [] },
  } as unknown as EvalAPI);

  assert.equal(output.Output, populated);
});

test("Delete Geometry Only Face keeps the resulting loose wire", () => {
  const geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ];
  geometry.mesh.faces = [[0, 1, 2, 3]];
  const handler = REGISTRY.get("GeometryNodeDeleteGeometry");
  assert.ok(handler);

  const output = handler({
    geo: () => geometry,
    field: () => Field.of(1),
    prop: (name: string, fallback: unknown) =>
      name === "mode" ? "ONLY_FACE"
        : name === "domain" ? "POINT"
          : fallback,
    node: { name: "Delete Geometry", inputs: [] },
  } as unknown as EvalAPI).Geometry as Geometry;

  assert.equal(output.mesh?.positions.length, 4);
  assert.equal(output.mesh?.faces.length, 0);
  assert.deepEqual(output.mesh?.edges, [[0, 1], [1, 2], [2, 3], [3, 0]]);
});
