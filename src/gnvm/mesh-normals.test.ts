import assert from "node:assert/strict";
import test from "node:test";
import { Field } from "./core";
import { makeFieldCtx } from "./evaluator";
import { Geometry, Mesh, topologyOf } from "./geometry";
import { APPROXIMATIONS, REGISTRY } from "./registry";
import "./nodes/geometry";
import "./nodes/topology";

function foldedPair(): Geometry {
  const mesh = new Mesh();
  mesh.positions = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  mesh.faces = [
    [0, 1, 2],
    [1, 0, 3],
  ];
  const geometry = new Geometry();
  geometry.mesh = mesh;
  return geometry;
}

test("Is Edge Smooth reads the inverse sharp_edge attribute", () => {
  const geometry = foldedPair();
  const edgeCount = topologyOf(geometry.mesh!).edges.length;
  geometry.mesh!.attributes.set("sharp_edge", {
    domain: "EDGE",
    data: Array.from({ length: edgeCount }, (_, edge) => edge % 2),
  });

  const handler = REGISTRY.get("GeometryNodeInputEdgeSmooth");
  assert.ok(handler);
  const smooth = handler({} as never).Smooth as Field;

  assert.equal(smooth.srcDomain, "EDGE");
  assert.equal(smooth.srcDomainValueType, "BOOLEAN");
  assert.deepEqual(
    smooth.array(makeFieldCtx(geometry, "EDGE")),
    Array.from({ length: edgeCount }, (_, edge) => edge % 2 ? 0 : 1),
  );
});

test("Is Edge Smooth defaults to smooth only for mesh edges", () => {
  const handler = REGISTRY.get("GeometryNodeInputEdgeSmooth");
  assert.ok(handler);
  const smooth = handler({} as never).Smooth as Field;
  const geometry = foldedPair();
  assert.deepEqual(
    smooth.array(makeFieldCtx(geometry, "EDGE")),
    Array(topologyOf(geometry.mesh!).edges.length).fill(1),
  );

  const curve = new Geometry();
  curve.curves.push({ points: [[0, 0, 0], [1, 0, 0]], cyclic: false });
  assert.deepEqual(smooth.array(makeFieldCtx(curve, "POINT")), [0, 0]);
});

test("Set Mesh Normal SHARPNESS writes edge and face sharpness fields", () => {
  const source = foldedPair();
  const edgeCount = topologyOf(source.mesh!).edges.length;
  source.mesh!.attributes.set("sharp_edge", {
    domain: "EDGE",
    data: Array(edgeCount).fill(0),
  });
  source.mesh!.attributes.set("sharp_face", {
    domain: "FACE",
    data: Array(source.mesh!.faces.length).fill(0),
  });

  const handler = REGISTRY.get("GeometryNodeSetMeshNormal");
  assert.ok(handler);
  const result = handler({
    node: { type: "GeometryNodeSetMeshNormal" },
    geo: (name: string) => {
      assert.equal(name, "Mesh");
      return source;
    },
    prop: (name: string) => name === "mode" ? "SHARPNESS" : undefined,
    field: (name: string) => name === "Edge Sharpness"
      ? Field.perElem((edge) => edge % 2)
      : Field.perElem((face) => face === 1 ? 1 : 0),
  } as never).Mesh as Geometry;

  assert.notEqual(result, source);
  assert.deepEqual(result.mesh!.attributes.get("sharp_edge"), {
    domain: "EDGE",
    data: Array.from({ length: edgeCount }, (_, edge) => edge % 2),
  });
  assert.deepEqual(result.mesh!.attributes.get("sharp_face"), {
    domain: "FACE",
    data: [0, 1],
  });
  assert.deepEqual(source.mesh!.attributes.get("sharp_edge")?.data, Array(edgeCount).fill(0));
  assert.deepEqual(source.mesh!.attributes.get("sharp_face")?.data, [0, 0]);
});

test("Set Mesh Normal reports custom-normal modes as approximations", () => {
  const handler = REGISTRY.get("GeometryNodeSetMeshNormal");
  assert.ok(handler);
  APPROXIMATIONS.clear();
  const source = foldedPair();
  const result = handler({
    node: { type: "GeometryNodeSetMeshNormal" },
    geo: () => source,
    prop: () => "FREE",
  } as never).Mesh as Geometry;

  assert.notEqual(result, source);
  assert.equal(APPROXIMATIONS.get("GeometryNodeSetMeshNormal"), 1);
});
