import assert from "node:assert/strict";
import test from "node:test";
import { Field, Vec3 } from "./core";
import { makeFieldCtx } from "./evaluator";
import { Geometry, Mesh } from "./geometry";
import "./nodes/topology";
import { REGISTRY } from "./registry";

test("Edge Vertices positions resolve endpoint indices on the point domain", () => {
  const geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [[10, 0, 0], [12, 1, 0], [15, 4, 0], [20, 9, 0]];
  geometry.mesh.faces = [[0, 2, 3], [0, 3, 1]];

  const handler = REGISTRY.get("GeometryNodeInputMeshEdgeVertices");
  assert.ok(handler);
  const outputs = handler({} as never);
  const context = makeFieldCtx(geometry, "EDGE");
  const positions1 = (outputs["Position 1"] as Field).array(context) as Vec3[];
  const positions2 = (outputs["Position 2"] as Field).array(context) as Vec3[];

  const endpoints = Array.from({ length: context.size }, (_, edge) => context.edgeVerts?.(edge) ?? [0, 0]);
  assert.deepEqual(positions1, endpoints.map(([vertex]) => geometry.mesh!.positions[vertex]));
  assert.deepEqual(positions2, endpoints.map(([, vertex]) => geometry.mesh!.positions[vertex]));
});
