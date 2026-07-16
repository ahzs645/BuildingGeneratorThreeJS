import assert from "node:assert/strict";
import test from "node:test";
import { Geometry, Mesh, triangulateFaceIndices } from "./geometry";
import { makeFieldCtx } from "./evaluator";
import { closestTrianglePointFloat32, nearestEdgePointFloat32, nearestPointBvhLeafFloat32 } from "./nodes/geometry";
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

test("point proximity returns Blender's FLT_EPSILON-inflated BVH leaf", () => {
  const result = nearestPointBvhLeafFloat32(
    [-42.24137496948242, 0.9817886352539062, -5.71881628036499],
    [-47.22046661376953, -1.1766977310180664, -10.936535835266113],
  );

  assert.deepEqual(result, {
    dSquared: 56.67501449584961,
    q: [-47.22046661376953, -1.1766976118087769, -10.936535835266113],
  });
  assert.equal(Math.fround(Math.sqrt(result.dSquared)), 7.528281211853027);
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

test("Edge Angle uses Blender's quad-specialized face normal", () => {
  const geometry = new Geometry();
  const mesh = geometry.mesh = new Mesh();
  mesh.positions = [
    [16.507436752319336, -17.976547241210938, 14.626008987426758],
    [16.62053680419922, -17.890953063964844, 14.597086906433105],
    [16.6934757232666, -17.824338912963867, 14.586451530456543],
    [16.553251266479492, -17.928491592407227, 14.621424674987793],
    [16.66985511779785, -17.849557876586914, 14.58786678314209],
    [16.820987701416016, -17.72283172607422, 14.563400268554688],
    [16.83702278137207, -17.71034812927246, 14.556960105895996],
  ];
  mesh.faces = [[0, 1, 2, 3], [4, 5, 6, 2, 1]];

  const context = makeFieldCtx(geometry, "EDGE");
  const sharedEdge = Array.from({ length: context.size }, (_, index) => index)
    .find((index) => {
      const vertices = context.edgeVerts?.(index);
      return vertices?.includes(1) && vertices.includes(2);
    });
  assert.notEqual(sharedEdge, undefined);
  assert.equal(context.edgeAngle?.(sharedEdge!), 0.523707389831543);
  assert.ok(context.edgeAngle!(sharedEdge!) > Math.fround(Math.PI / 6));
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
