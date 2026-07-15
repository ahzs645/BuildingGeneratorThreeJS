import assert from "node:assert/strict";
import test from "node:test";
import { Geometry, Mesh, realizeInstances, transformPointFloat32 } from "./geometry";
import { REGISTRY } from "./registry";
import "./index";

test("geometry transforms use Blender float32 matrix arithmetic", () => {
  const point: [number, number, number] = [70.57221984863281, 27.26752281188965, 0];
  const angle = Math.fround(Math.fround(120) * Math.fround(Math.PI / 180));

  assert.deepEqual(
    transformPointFloat32(point, [0, 0, 0], [0, 0, angle], [1, 1, 1]),
    [-58.900489807128906, 47.48356628417969, 0],
  );
  assert.deepEqual(
    transformPointFloat32([1.25, -2.5, 0.75], [0, 0, 0], [0.3, -0.7, 1.2], [1, 1, 1]),
    [2.784243106842041, -0.041279494762420654, 0.7882176041603088],
  );
});

test("Realize Instances rounds mesh and curve transforms like Blender", () => {
  const point: [number, number, number] = [70.57221984863281, 27.26752281188965, 0];
  const angle = Math.fround(Math.fround(120) * Math.fround(Math.PI / 180));
  const payload = new Geometry();
  payload.mesh = new Mesh();
  payload.mesh.positions = [point];
  payload.curves = [{
    cyclic: false,
    points: [point],
    controlPoints: [point],
    bezierLeft: [point],
    bezierRight: [point],
  }];
  const source = new Geometry();
  source.instances.push({
    geometry: payload,
    position: [0, 0, 0],
    rotation: [0, 0, angle],
    scale: [1, 1, 1],
  });

  const realized = realizeInstances(source);
  const expected: [number, number, number] = [-58.900489807128906, 47.48356628417969, 0];
  assert.deepEqual(realized.mesh?.positions, [expected]);
  assert.deepEqual(realized.curves[0].points, [expected]);
  assert.deepEqual(realized.curves[0].controlPoints, [expected]);
  assert.deepEqual(realized.curves[0].bezierLeft, [expected]);
  assert.deepEqual(realized.curves[0].bezierRight, [expected]);
});

test("Separate Components preserves authored Bezier controls", () => {
  const source = new Geometry();
  source.curves = [{
    cyclic: false,
    splineType: "BEZIER",
    resolution: 12,
    points: [[0, 0, 0], [1, 0, 0]],
    controlPoints: [[0, 0, 0], [1, 0, 0]],
    bezierLeft: [[-0.25, 0, 0], [0.75, 0, 0]],
    bezierRight: [[0.25, 0, 0], [1.25, 0, 0]],
  }];
  const handler = REGISTRY.get("GeometryNodeSeparateComponents");
  assert.ok(handler);
  const separated = handler({ geo: () => source } as never).Curve as Geometry;

  assert.equal(separated.curves[0].splineType, "BEZIER");
  assert.equal(separated.curves[0].resolution, 12);
  assert.deepEqual(separated.curves[0].controlPoints, source.curves[0].controlPoints);
  assert.deepEqual(separated.curves[0].bezierLeft, source.curves[0].bezierLeft);
  assert.deepEqual(separated.curves[0].bezierRight, source.curves[0].bezierRight);
});
