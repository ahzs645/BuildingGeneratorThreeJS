import assert from "node:assert/strict";
import test from "node:test";
import { meshCube } from "./primitives";

test("minimal Mesh Cube preserves Blender 5.1.2 vertex and face indices", () => {
  const mesh = meshCube([2, 4, 6]).mesh;
  assert.ok(mesh);
  assert.deepEqual(mesh.positions, [
    [-1, -2, -3],
    [1, -2, -3],
    [-1, 2, -3],
    [1, 2, -3],
    [-1, -2, 3],
    [1, -2, 3],
    [-1, 2, 3],
    [1, 2, 3],
  ]);
  assert.deepEqual(mesh.faces, [
    [0, 2, 3, 1],
    [0, 1, 5, 4],
    [4, 5, 7, 6],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ]);
  assert.deepEqual(mesh.edges, [
    [0, 1],
    [0, 2],
    [2, 3],
    [1, 3],
    [0, 4],
    [1, 5],
    [4, 5],
    [4, 6],
    [5, 7],
    [6, 7],
    [2, 6],
    [3, 7],
  ]);
});
