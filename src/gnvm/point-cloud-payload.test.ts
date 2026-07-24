import assert from "node:assert/strict";
import test from "node:test";
import { Geometry, Mesh, toTriSoup } from "./geometry";

test("toTriSoup exports loose point clouds without inflating mesh topology", () => {
  const geometry = new Geometry();
  const mesh = new Mesh();
  mesh.positions = [[1, 2, 3], [-4, 5, 6]];
  mesh.attributes.set("__gnvm_point_cloud", { domain: "POINT", data: [1, 1] });
  mesh.attributes.set("radius", { domain: "POINT", data: [.25, .5] });
  geometry.mesh = mesh;

  const soup = toTriSoup(geometry);
  assert.deepEqual(soup.stats, { verts: 0, faces: 0, tris: 0 });
  assert.deepEqual([...soup.points!.positions], [1, 2, 3, -4, 5, 6]);
  assert.deepEqual([...soup.points!.radii], [.25, .5]);
  assert.deepEqual(soup.points!.stats, { points: 2 });
});

test("toTriSoup does not duplicate point-cloud markers after topology is added", () => {
  const geometry = new Geometry();
  const mesh = new Mesh();
  mesh.positions = [[0, 0, 0], [1, 0, 0]];
  mesh.edges = [[0, 1]];
  mesh.attributes.set("__gnvm_point_cloud", { domain: "POINT", data: [1, 1] });
  geometry.mesh = mesh;

  const soup = toTriSoup(geometry);
  assert.equal(soup.points, undefined);
  assert.equal(soup.stats.verts, 2);
});
