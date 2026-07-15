import assert from "node:assert/strict";
import test from "node:test";
import { Mesh, triangulateFaceIndices } from "./geometry";
import { closestTrianglePointFloat32, nearestEdgePointFloat32 } from "./nodes/geometry";
import { blenderMergeTargets } from "./nodes/meshops";
import { meshGrid, meshIcoSphere } from "./primitives";

test("Mesh Grid preserves Blender float32 step and X-major vertex order", () => {
  const positions = meshGrid(313.1252193450928, 287.75, 4, 3).mesh?.positions;

  assert.deepEqual(positions, [
    [-156.56260681152344, -143.875, 0],
    [-156.56260681152344, 0, 0],
    [-156.56260681152344, 143.875, 0],
    [-52.18753433227539, -143.875, 0],
    [-52.18753433227539, 0, 0],
    [-52.18753433227539, 143.875, 0],
    [52.18753433227539, -143.875, 0],
    [52.18753433227539, 0, 0],
    [52.18753433227539, 143.875, 0],
    [156.56260681152344, -143.875, 0],
    [156.56260681152344, 0, 0],
    [156.56260681152344, 143.875, 0],
  ]);
});

test("Geometry Proximity uses Blender float32 closest-edge arithmetic", () => {
  const result = nearestEdgePointFloat32(
    [70.57221984863281, 27.26752281188965, 1.370941162109375],
    [
      [[0.1, 0.2, 0.3], [100.5, 30.3, 2.7]],
      [[10, -4, 1], [11, -4, 1]],
    ],
  );

  assert.deepEqual(result, {
    d: 5.726995944976807,
    q: [72.19184112548828, 21.81319236755371, 2.023311138153076],
  });
});

test("face proximity follows Blender float32 triangle projection", () => {
  const position = closestTrianglePointFloat32(
    [0.37, -0.21, 0.84],
    { a: [-0.4, 0.2, 0.1], b: [1.3, -0.6, 0.3], c: [0.1, 1.1, -0.8] },
  );

  assert.deepEqual(position, [0.44999995827674866, -0.20000000298023224, 0.20000001788139343]);
});

test("quad tessellation uses Blender's stable 0-2 diagonal", () => {
  const mesh = new Mesh();
  mesh.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0.1], [0, 1, 0]];

  assert.deepEqual(triangulateFaceIndices(mesh, [0, 1, 2, 3]), [[0, 1, 2], [0, 2, 3]]);
});

test("n-gon tessellation follows Blender's balanced polyfill sweep", () => {
  const mesh = new Mesh();
  mesh.positions = [
    [0, 0, 0], [2, 0, 0], [3, 1, 0], [2.5, 2.5, 0], [1, 3, 0], [-0.5, 1.5, 0],
  ];

  assert.deepEqual(triangulateFaceIndices(mesh, [0, 1, 2, 3, 4, 5]), [
    [5, 0, 1], [1, 2, 3], [3, 4, 5], [1, 3, 5],
  ]);
});

test("n-gon tessellation preserves Blender's non-planar concave ears", () => {
  const mesh = new Mesh();
  mesh.positions = [
    [5.6985979080200195, 4.206120014190674, 2.2141342163085938],
    [5.601629257202148, 4.322347640991211, 2.216545343399048],
    [5.768020153045654, 4.122910022735596, 2.2124080657958984],
    [5.962743759155273, 3.8895132541656494, 2.207566022872925],
    [5.879220008850098, 3.9896252155303955, 2.2096428871154785],
  ];

  assert.deepEqual(triangulateFaceIndices(mesh, [0, 1, 2, 3, 4]), [
    [4, 0, 1], [2, 3, 4], [1, 2, 4],
  ]);
});

test("Ico Sphere uses Blender's BMesh seed and projected grid", () => {
  const mesh = meshIcoSphere(1, 4).mesh!;

  assert.equal(mesh.positions.length, 642);
  assert.equal(mesh.faces.length, 1280);
  assert.deepEqual(mesh.positions[0], [0, 0, -1]);
  assert.ok(mesh.positions.some((position) => position.every((value, axis) =>
    // This interior grid point is copied from Blender 5.1's evaluated mesh.
    // Projecting one barycentric interpolation misses it by 2.35e-6; BMesh's
    // boundary-projection then row-projection path reproduces it exactly.
    Math.abs(value - [-0.7824448347091675, 0.4693736433982849, -0.40922895073890686][axis]) < 1e-7)));
});

test("Merge by Distance keeps Blender's index-ordered representative targets", () => {
  const targets = blenderMergeTargets(
    [[0, 0, 0], [0.0005, 0, 0], [0.0014, 0, 0], [2, 0, 0]],
    [true, true, true, false],
    0.001,
  );

  assert.deepEqual(targets, [0, 0, -1, -2]);
});
