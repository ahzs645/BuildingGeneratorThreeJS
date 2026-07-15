import assert from "node:assert/strict";
import test from "node:test";
import type { Vec3 } from "./core";
import { surfaceNetsForTest } from "./nodes/volume";
import { OPENVDB_AMBIGUOUS_FACE, OPENVDB_EDGE_GROUPS, openVdbGroupCount } from "./openvdb-edge-groups";

test("bundles the complete OpenVDB ambiguous-cell topology tables", () => {
  assert.equal(OPENVDB_AMBIGUOUS_FACE.length, 256);
  assert.equal(OPENVDB_EDGE_GROUPS.length, 256 * 13);
  assert.equal(OPENVDB_AMBIGUOUS_FACE[52], 2);
  assert.equal(openVdbGroupCount(52), 1);
  assert.equal(openVdbGroupCount(255 - 52), 2);
});

test("surface nets closes a crossing on each axis' negative boundary", () => {
  const resolution: Vec3 = [4, 4, 4];
  const index = (x: number, y: number, z: number) => z * resolution[0] * resolution[1] + y * resolution[0] + x;

  for (let axis = 0; axis < 3; axis++) {
    const values = new Float32Array(4 * 4 * 4).fill(1);
    const coordinate: Vec3 = [1, 1, 1];
    coordinate[axis] = 0;
    values[index(...coordinate)] = -1;

    const mesh = surfaceNetsForTest(values, resolution, 0, [0, 0, 0], [1, 1, 1]);
    assert.equal(mesh.positions.length, 4, `axis ${axis} should create four incident cell vertices`);
    assert.equal(mesh.faces.length, 1, `axis ${axis} should emit the negative-boundary cap`);
    assert.equal(mesh.faces[0].length, 4);
  }
});
