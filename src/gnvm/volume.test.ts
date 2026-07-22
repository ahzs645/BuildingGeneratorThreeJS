import assert from "node:assert/strict";
import test from "node:test";
import type { Vec3 } from "./core";
import { resampleVolumeGridForTest, surfaceNetsForTest } from "./nodes/volume";
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

test("surface nets preserves Blender's directional quad winding and diagonals", () => {
  const resolution: Vec3 = [4, 4, 4];
  const index = (x: number, y: number, z: number) => z * resolution[0] * resolution[1] + y * resolution[0] + x;
  const expectedForward = [
    [1, 0, 2, 3],
    [2, 0, 1, 3],
    [0, 2, 3, 1],
  ];
  const expectedReverse = [
    [3, 2, 0, 1],
    [3, 1, 0, 2],
    [2, 0, 1, 3],
  ];

  for (const inside of [true, false]) for (let axis = 0; axis < 3; axis++) {
    const values = new Float32Array(4 * 4 * 4).fill(inside ? 1 : -1);
    const coordinate: Vec3 = [1, 1, 1];
    coordinate[axis] = 0;
    values[index(...coordinate)] = inside ? -1 : 1;

    const mesh = surfaceNetsForTest(values, resolution, 0, [0, 0, 0], [1, 1, 1]);
    assert.equal(mesh.faces.length, 1, `axis ${axis}, inside=${inside}`);
    assert.deepEqual(mesh.faces[0], (inside ? expectedForward : expectedReverse)[axis]);
  }
});

test("volume resampling uses OpenVDB's sparse lower guard and ceil-rounded extent", () => {
  const volume = {
    kind: "GNVM_VOLUME_GRID" as const,
    background: 0,
    min: [0, 0, 0] as Vec3,
    max: [2, 2, 2] as Vec3,
    resolution: [3, 3, 3] as Vec3,
    origin: [0, 0, 0] as Vec3,
    voxelSize: [1, 1, 1] as Vec3,
    values: new Float32Array(27).fill(1),
  };
  const resampled = resampleVolumeGridForTest(volume, 0.6);
  assert.deepEqual(resampled.resolution, [10, 10, 10]);
  assert.deepEqual(resampled.origin.map((value) => Number(value.toFixed(6))), [-1.2, -1.2, -1.2]);
  const index = (x: number, y: number, z: number) =>
    z * resampled.resolution[0] * resampled.resolution[1] + y * resampled.resolution[0] + x;
  assert.equal(resampled.values[index(0, 2, 2)], 0, "outer lower plane must be hard background");
  assert.ok(resampled.values[index(1, 2, 2)] > 0, "one lower BoxSampler support layer must remain interpolated");
  assert.equal(resampled.values[index(9, 2, 2)], 0, "ceil-rounded upper guard must reach background");

  const mesh = surfaceNetsForTest(resampled.values, resampled.resolution, 0.5, resampled.origin, resampled.spacing);
  assert.equal(mesh.positions.length, 146);
  assert.equal(mesh.faces.length, 144);
  const edgeUses = new Map<string, number>();
  for (const face of mesh.faces) for (let corner = 0; corner < face.length; corner++) {
    const a = face[corner], b = face[(corner + 1) % face.length];
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
  }
  assert.ok([...edgeUses.values()].every((uses) => uses === 2), "boundary-touching surface must close manifoldly");
});

test("volume resampling preserves the numeric background of inactive OpenVDB regions", () => {
  const volume = {
    kind: "GNVM_VOLUME_GRID" as const,
    background: 1,
    min: [0, 0, 0] as Vec3,
    max: [7, 7, 7] as Vec3,
    resolution: [8, 8, 8] as Vec3,
    origin: [0, 0, 0] as Vec3,
    voxelSize: [1, 1, 1] as Vec3,
    values: new Float32Array(8 * 8 * 8).fill(1),
  };
  const resampled = resampleVolumeGridForTest(volume, 0.75);
  assert.ok(
    resampled.values.every((value) => value === 1),
    "GridTransformer keeps the source tree's numeric background even when every voxel is inactive",
  );
});
