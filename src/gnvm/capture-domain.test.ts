import assert from "node:assert/strict";
import test from "node:test";
import { asNum, Field, fieldMap } from "./core";
import { Geometry, Mesh, buildTopology } from "./geometry";
import { EvalAPI, REGISTRY } from "./registry";
import "./index";

function captureFaceBoolean(source: Geometry, value: Field): number[] {
  const handler = REGISTRY.get("GeometryNodeCaptureAttribute");
  assert.ok(handler);
  const result = handler({
    geo: () => source,
    field: () => value,
    prop: (_name: string, fallback: unknown) => _name === "domain" ? "FACE" : fallback,
    node: {
      name: "Capture Attribute Test",
      inputs: [{ identifier: "Value", name: "Value", type: "NodeSocketBool" }],
    },
  } as never).Geometry as Geometry;
  const captured = [...result.mesh!.attributes]
    .find(([name]) => name.startsWith("__cap_") && name.endsWith("Capture Attribute Test"));
  assert.ok(captured);
  return captured[1].data.map(asNum);
}

function quadWithPointAttribute(name: string, data: number[]): Geometry {
  const geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  geometry.mesh.faces = [[0, 1, 2, 3]];
  geometry.mesh.attributes.set(name, { domain: "POINT", data });
  return geometry;
}

test("computed booleans interpolate numeric captures before comparison", () => {
  const geometry = quadWithPointAttribute("weight", [1, 1, 1, 0]);
  const weight = Field.perElem((index, context) => context.attr?.("weight", index) ?? 0)
    .tagged("POINT", "NUMERIC");
  const compared = fieldMap([weight, Field.of(0.5)], (value, threshold) =>
    asNum(value) > asNum(threshold) ? 1 : 0);

  assert.deepEqual(captureFaceBoolean(geometry, compared), [1]);
});

test("direct boolean captures retain point-to-face AND conversion", () => {
  const geometry = quadWithPointAttribute("mask", [1, 1, 1, 0]);
  const mask = Field.perElem((index, context) => context.attr?.("mask", index) ?? 0)
    .tagged("POINT", "BOOLEAN");

  assert.deepEqual(captureFaceBoolean(geometry, mask), [0]);
});

test("Capture Attribute reuses its anonymous ID across repeat evaluations", () => {
  const handler = REGISTRY.get("GeometryNodeCaptureAttribute");
  assert.ok(handler);
  const node = {
    name: "Capture Attribute",
    type: "GeometryNodeCaptureAttribute",
    label: null,
    inputs: [{ name: "Value", identifier: "Value", type: "NodeSocketFloat", linked: true, value: null }],
    outputs: [],
    props: { domain: "POINT" },
  };
  let geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [[0, 0, 0]];
  const evaluate = () => {
    const current = geometry;
    geometry = handler({
      node,
      scope: "Root/Repeat/Capture Attribute",
      geo: () => current,
      field: () => Field.of(1),
      prop: (name, fallback) => name === "domain" ? "POINT" : fallback,
    } as unknown as EvalAPI).Geometry as Geometry;
  };

  evaluate();
  evaluate();

  const captures = [...geometry.mesh!.attributes.keys()].filter((name) => name.startsWith("__cap_"));
  assert.deepEqual(captures, ["__cap_Root/Repeat/Capture Attribute_Capture Attribute"]);
});

test("Capture Attribute bounds rolling repeat captures to current and previous slots", () => {
  const handler = REGISTRY.get("GeometryNodeCaptureAttribute");
  assert.ok(handler);
  const node = {
    name: "Capture Attribute",
    type: "GeometryNodeCaptureAttribute",
    label: null,
    inputs: [{ name: "Value", identifier: "Value", type: "NodeSocketFloat", linked: true, value: null }],
    outputs: [],
    props: { domain: "POINT" },
  };
  let geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [[0, 0, 0]];
  for (let iteration = 1; iteration <= 40; iteration++) {
    const current = geometry;
    geometry = handler({
      node,
      scope: `Root/Repeat/Capture Attribute@${iteration & 1}`,
      geo: () => current,
      field: () => Field.of(iteration),
      prop: (name, fallback) => name === "domain" ? "POINT" : fallback,
    } as unknown as EvalAPI).Geometry as Geometry;
  }
  const captures = [...geometry.mesh!.attributes.keys()].filter((name) => name.startsWith("__cap_"));
  assert.equal(captures.length, 2);
  assert.deepEqual(
    captures.map((name) => geometry.mesh!.attributes.get(name)!.data.map(asNum)),
    [[39], [40]],
  );
});

test("Set Position adapts a final FACE boolean selection to POINT with AND", () => {
  const geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]];
  geometry.mesh.faces = [[0, 1, 2], [2, 1, 3]];
  const selection = Field.make((ctx) =>
    Array.from({ length: ctx.size }, (_, face) => face === 0 ? 1 : 0))
    .tagged("FACE", "BOOLEAN");
  const handler = REGISTRY.get("GeometryNodeSetPosition");
  assert.ok(handler);

  const output = handler({
    geo: () => geometry,
    field: (name) => name === "Selection" ? selection : Field.of([0, 0, 1]),
    node: { name: "Set Position", inputs: [{ identifier: "Position", linked: false }] },
  } as unknown as EvalAPI).Geometry as Geometry;

  assert.deepEqual(output.mesh!.positions, [
    [0, 0, 1], // belongs only to the true face
    [1, 0, 0], // true/false boundary: AND resolves false
    [0, 1, 0], // true/false boundary: AND resolves false
    [1, 1, 0], // belongs only to the false face
  ]);
});

test("Flip Faces preserves EDGE attributes by edge identity", () => {
  const geometry = quadWithPointAttribute("point value", [0, 0, 0, 0]);
  geometry.mesh!.faces = [[0, 1, 2], [0, 2, 3]];
  const before = buildTopology(geometry.mesh!).edges;
  geometry.mesh!.attributes.set("edge mask", {
    domain: "EDGE",
    data: before.map((_, index) => index + 10),
  });
  const expected = new Map(before.map((edge, index) => [
    [...edge.verts].sort((a, b) => a - b).join("_"),
    index + 10,
  ]));

  const handler = REGISTRY.get("GeometryNodeFlipFaces");
  assert.ok(handler);
  const result = handler({
    geo: () => geometry,
    field: () => Field.of(1),
    node: { name: "Flip Faces", inputs: [] },
  } as never).Mesh as Geometry;
  const after = buildTopology(result.mesh!).edges;
  const values = result.mesh!.attributes.get("edge mask")?.data.map(asNum);

  assert.deepEqual(values, after.map((edge) =>
    expected.get([...edge.verts].sort((a, b) => a - b).join("_"))),
  );
});
