import assert from "node:assert/strict";
import test from "node:test";
import { Field } from "./core";
import { Geometry, Mesh } from "./geometry";
import { REGISTRY } from "./registry";
import "./index";

test("Points to Vertices filters point-cloud positions and preserves point attributes", () => {
  const points = new Geometry();
  points.mesh = new Mesh();
  points.mesh.positions = [[0, 0, 0], [1, 2, 3], [4, 5, 6]];
  points.mesh.attributes.set("__gnvm_point_cloud", {
    domain: "POINT",
    data: [1, 1, 1],
  });
  points.mesh.attributes.set("radius", {
    domain: "POINT",
    data: [.1, .2, .3],
  });

  const handler = REGISTRY.get("GeometryNodePointsToVertices");
  assert.ok(handler);
  const result = handler({
    geo: () => points,
    field: () => Field.perElem((index) => index === 1 ? 1 : 0),
  } as never).Mesh as Geometry;

  assert.deepEqual(result.mesh?.positions, [[1, 2, 3]]);
  assert.deepEqual(result.mesh?.attributes.get("radius"), {
    domain: "POINT",
    data: [.2],
  });
  assert.equal(result.mesh?.attributes.has("__gnvm_point_cloud"), false);
});

test("Points to Vertices defaults to selecting every point", () => {
  const points = new Geometry();
  points.mesh = new Mesh();
  points.mesh.positions = [[0, 0, 0], [1, 0, 0]];

  const handler = REGISTRY.get("GeometryNodePointsToVertices");
  assert.ok(handler);
  const result = handler({
    geo: () => points,
    field: () => Field.of(1),
  } as never).Mesh as Geometry;

  assert.deepEqual(result.mesh?.positions, points.mesh.positions);
  assert.notEqual(result.mesh, points.mesh);
});

test("Points to Vertices leaves a mesh-only component empty", () => {
  const meshOnly = new Geometry();
  meshOnly.mesh = new Mesh();
  meshOnly.mesh.positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  meshOnly.mesh.faces = [[0, 1, 2]];

  const handler = REGISTRY.get("GeometryNodePointsToVertices");
  assert.ok(handler);
  const result = handler({
    geo: () => meshOnly,
    field: () => Field.of(1),
  } as never).Mesh as Geometry;

  assert.deepEqual(result.mesh?.positions, []);
  assert.deepEqual(result.mesh?.faces, []);
});

test("Points to Vertices converts only the point-cloud component of mixed geometry", () => {
  const mixed = new Geometry();
  mixed.mesh = new Mesh();
  mixed.mesh.positions = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0],
    [10, 0, 0], [20, 0, 0],
  ];
  mixed.mesh.faces = [[0, 1, 2]];
  mixed.mesh.attributes.set("__gnvm_point_cloud", {
    domain: "POINT",
    data: [0, 0, 0, 1, 1],
  });
  mixed.mesh.attributes.set("radius", {
    domain: "POINT",
    data: [.01, .01, .01, .4, .8],
  });

  const handler = REGISTRY.get("GeometryNodePointsToVertices");
  assert.ok(handler);
  const result = handler({
    geo: () => mixed,
    // Index is point-cloud-local: index zero maps to mixed source point 3.
    field: () => Field.perElem((index) => index === 0 ? 1 : 0),
  } as never).Mesh as Geometry;

  assert.deepEqual(result.mesh?.positions, [[10, 0, 0]]);
  assert.deepEqual(result.mesh?.attributes.get("radius"), {
    domain: "POINT",
    data: [.4],
  });
});
