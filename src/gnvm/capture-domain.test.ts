import assert from "node:assert/strict";
import test from "node:test";
import { asNum, Field, fieldMap } from "./core";
import { Geometry, Mesh, buildTopology } from "./geometry";
import { REGISTRY } from "./registry";
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
