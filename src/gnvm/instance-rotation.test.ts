import assert from "node:assert/strict";
import test from "node:test";
import { Field, Vec3 } from "./core";
import { Geometry, Mesh, realizeInstances } from "./geometry";
import { makeFieldCtx } from "./evaluator";
import { REGISTRY } from "./registry";
import "./index";

test("Instance Rotation reads the transform intrinsic on the instance domain", () => {
  const geometry = new Geometry();
  geometry.instances.push({
    geometry: new Geometry(),
    position: [-34.46500015258789, 95.08610534667969, 32.72673797607422],
    rotation: [Math.fround(Math.PI / 2), 0, Math.fround(Math.PI / 2)],
    scale: [1, 1, 1],
    transformMatrix: [
      [-4.4e-8, 4.4e-8, 1, -34.465000153],
      [1, 0, 4.4e-8, 95.086105347],
      [0, 1, -4.4e-8, 32.726737976],
      [0, 0, 0, 1],
    ],
  });

  const handler = REGISTRY.get("GeometryNodeInputInstanceRotation");
  assert.ok(handler);
  const rotation = handler({} as never).Rotation as Field;
  const values = rotation.array(makeFieldCtx(geometry, "INSTANCE"));
  assert.deepEqual(values, [
    [Math.fround(Math.PI / 2), 0, Math.fround(Math.PI / 2)],
  ]);
  assert.deepEqual(
    (values[0] as Vec3 & { [key: symbol]: [number, number, number, number] })[Symbol.for("gnvm.rotationQuaternion")],
    [0.5, 0.5, 0.5, 0.5],
  );
});

test("Instance on Points composes a native rotation quaternion without an Euler round-trip", () => {
  const points = new Geometry();
  points.mesh = new Mesh();
  points.mesh.positions = [[10, 20, 0]];

  const payload = new Geometry();
  payload.mesh = new Mesh();
  payload.mesh.positions = [[1, 0, 0]];

  const choices = new Geometry();
  choices.instances.push({
    geometry: payload,
    position: [2, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });

  const rotation = [0, 0, Math.PI / 2] as Vec3 & { [key: symbol]: [number, number, number, number] };
  rotation[Symbol.for("gnvm.rotationQuaternion")] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  const handler = REGISTRY.get("GeometryNodeInstanceOnPoints");
  assert.ok(handler);
  const result = handler({
    geo: (name: string) => name === "Points" ? points : choices,
    field: (name: string) => Field.of(name === "Rotation" ? rotation : name === "Scale" ? [1, 1, 1] : 1),
    bool: (name: string) => name === "Pick Instance",
    vec: () => [1, 1, 1],
    prop: (_name: string, fallback: unknown) => fallback,
    node: {
      name: "Instance on Points",
      inputs: [
        { identifier: "Instance Index", linked: false },
        { identifier: "Scale", linked: true },
      ],
    },
  } as never).Instances as Geometry;

  assert.deepEqual(result.instances[0].position, [10, 22, 0]);
  assert.ok(result.instances[0].transformMatrix);
  assert.deepEqual(realizeInstances(result).mesh?.positions, [[10, 23, 0]]);

  const translate = REGISTRY.get("GeometryNodeTranslateInstances");
  assert.ok(translate);
  const translated = translate({
    geo: () => result,
    vec: () => [1, -2, 0],
  } as never).Instances as Geometry;
  assert.ok(translated.instances[0].transformMatrix);
  assert.deepEqual(translated.instances[0].position, [11, 20, 0]);
  assert.deepEqual(realizeInstances(translated).mesh?.positions, [[11, 21, 0]]);
});

test("Transform Geometry composes nested rotations as matrices", () => {
  const payload = new Geometry();
  payload.mesh = new Mesh();
  payload.mesh.positions = [[1, 0.25, -0.5]];
  const geometry = new Geometry();
  geometry.instances.push({
    geometry: payload,
    position: [0, 0, 0],
    rotation: [0, Math.fround(Math.PI / 4), 0],
    scale: [0.27, 0.27, 0.27],
  });
  const before = realizeInstances(geometry).mesh?.positions[0];

  const transform = REGISTRY.get("GeometryNodeTransform");
  assert.ok(transform);
  const result = transform({
    geo: () => geometry,
    vec: (name: string) => name === "Rotation"
      ? [-0.29304078221321106, 0, 0]
      : name === "Scale" ? [1, 1, 1] : [0, 0, 0],
  } as never).Geometry as Geometry;
  const after = realizeInstances(result).mesh?.positions[0];

  assert.ok(before && after);
  // A world-space X rotation cannot change X, even when the child already has
  // a Y rotation. Component-wise Euler addition violated this invariant.
  assert.equal(after[0], before[0]);
  assert.ok(result.instances[0].transformMatrix);
});

test("Rotate Instances uses Blender's incoming-matrix local axes without double rotation", () => {
  const payload = new Geometry();
  payload.curves = [{
    cyclic: false,
    points: [[0, 0, 23.177337646484375], [0, 0, -23.177337646484375]],
  }];
  const instances = new Geometry();
  instances.instances.push({
    geometry: payload,
    position: [-34.46500015258789, 95.08610534667969, 32.72673797607422],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });

  // Blender's Instance Rotation probe for Dowel .005. The Euler is the socket
  // compatibility value; the non-enumerable quaternion is the actual Rotation
  // socket payload consumed by Rotate Instances.
  const rotation = [Math.fround(Math.PI / 2), 0, Math.fround(Math.PI / 2)] as Vec3 & {
    [key: symbol]: [number, number, number, number];
  };
  rotation[Symbol.for("gnvm.rotationQuaternion")] = [0.5, 0.5, 0.5, 0.5];
  const rotate = REGISTRY.get("GeometryNodeRotateInstances");
  assert.ok(rotate);
  const result = rotate({
    geo: () => instances,
    field: (name: string) => Field.of(name === "Rotation" ? rotation : name === "Pivot Point" ? [0, 0, 0] : 1),
    bool: (name: string) => name === "Local Space",
  } as never).Instances as Geometry;

  assert.deepEqual(realizeInstances(result).curves[0].points, [
    [-11.287662506103516, 95.08610534667969, 32.72673797607422],
    [-57.642337799072266, 95.08610534667969, 32.72673797607422],
  ]);
});

test("Rotate Instances retains Blender quaternion-to-Euler quarter-turn precision", () => {
  const payload = new Geometry();
  payload.curves = [{ cyclic: false, points: [[15.556474685668945, 0, 23.177337646484375]] }];
  const instances = new Geometry();
  instances.instances.push({
    geometry: payload,
    position: [-5.639444351196289, -3.9697036743164062, 8.708961486816406],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });

  const rotation = [Math.fround(Math.PI / 2), 0, 0] as Vec3 & {
    [key: symbol]: [number, number, number, number];
  };
  rotation[Symbol.for("gnvm.rotationQuaternion")] = [Math.fround(Math.SQRT1_2), 0, 0, Math.fround(Math.SQRT1_2)];
  const rotate = REGISTRY.get("GeometryNodeRotateInstances");
  assert.ok(rotate);
  const result = rotate({
    geo: () => instances,
    field: (name: string) => Field.of(name === "Rotation" ? rotation : name === "Pivot Point" ? [0, 0, 0] : 1),
    bool: (name: string) => name === "Local Space",
  } as never).Instances as Geometry;

  assert.deepEqual(result.instances[0].transformMatrix, [
    [1, 0, 0, -5.639444351196289],
    [0, 7.549790126404332e-8, -1, -3.9697036743164062],
    [0, 1, 7.549790126404332e-8, 8.708961486816406],
    [0, 0, 0, 1],
  ]);
  assert.deepEqual(realizeInstances(result).curves[0].points, [
    [9.917030334472656, -27.14704132080078, 8.708963394165039],
  ]);
});

test("Curve to Mesh converts instance payloads without realizing their transforms", () => {
  const railPayload = new Geometry();
  railPayload.curves = [{ cyclic: false, points: [[0, 0, -1], [0, 0, 1]] }];
  const rail = new Geometry();
  rail.instances.push({
    geometry: railPayload,
    position: [4, 5, 6],
    rotation: [0, Math.PI / 2, 0],
    scale: [1, 1, 1],
  });
  const profile = new Geometry();
  profile.curves = [{
    cyclic: true,
    points: [[0.25, 0, 0], [0, 0.25, 0], [-0.25, 0, 0], [0, -0.25, 0]],
  }];

  const handler = REGISTRY.get("GeometryNodeCurveToMesh");
  assert.ok(handler);
  const result = handler({
    geo: (name: string) => name === "Curve" ? rail : profile,
    bool: () => false,
    num: (name: string) => name === "Scale" ? 1 : 0,
    field: () => Field.of(1),
    node: { name: "Curve to Mesh", inputs: [{ identifier: "Scale", linked: false }] },
  } as never).Mesh as Geometry;

  assert.equal(result.mesh, undefined);
  assert.equal(result.instances.length, 1);
  assert.equal(result.instances[0].geometry.mesh?.positions.length, 8);
  assert.equal(realizeInstances(result).mesh?.positions.length, 8);
});

test("Curve to Points and Instance on Points preserve nested transforms and shared references", () => {
  const curvePayload = new Geometry();
  curvePayload.curves = [{ cyclic: false, points: [[0, 0, 0], [0, 0, 2]] }];
  const source = new Geometry();
  for (const x of [10, 40]) source.instances.push({
    geometry: curvePayload,
    position: [x, 20, 30],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    transformMatrix: [
      [1, 0, 0, x],
      [0, 1, 0, 20],
      [0, 0, 1, 30],
      [0, 0, 0, 1],
    ],
  });

  const curveToPoints = REGISTRY.get("GeometryNodeCurveToPoints");
  assert.ok(curveToPoints);
  const pointOutputs = curveToPoints({
    geo: () => source,
    prop: (name: string, fallback: unknown) => name === "mode" ? "COUNT" : fallback,
    num: (name: string) => name === "Count" ? 2 : 0.1,
    node: { name: "Curve to Points" },
  } as never);
  const points = pointOutputs.Points as Geometry;
  assert.equal(points.instances.length, 2);
  assert.equal(points.instances[0].geometry, points.instances[1].geometry);
  assert.deepEqual(points.instances[0].geometry.mesh?.positions, [[0, 0, 0], [0, 0, 2]]);

  const marker = new Geometry();
  marker.mesh = new Mesh();
  marker.mesh.positions = [[1, 0, 0]];
  const instanceOnPoints = REGISTRY.get("GeometryNodeInstanceOnPoints");
  assert.ok(instanceOnPoints);
  const nested = instanceOnPoints({
    geo: (name: string) => name === "Points" ? points : marker,
    field: (name: string) => name === "Rotation"
      ? pointOutputs.Rotation as Field
      : Field.of(name === "Scale" ? [1, 1, 1] : name === "Selection" ? 1 : 0),
    bool: () => false,
    vec: () => [1, 1, 1],
    prop: (_name: string, fallback: unknown) => fallback,
    node: {
      name: "Instance on Points",
      inputs: [
        { identifier: "Instance Index", linked: false },
        { identifier: "Scale", linked: true },
      ],
    },
  } as never).Instances as Geometry;

  assert.equal(nested.instances.length, 2);
  assert.equal(nested.instances[0].geometry, nested.instances[1].geometry);
  assert.equal(nested.instances[0].geometry.instances.length, 2);
  assert.deepEqual(realizeInstances(nested).mesh?.positions, [
    [11, 20, 30],
    [11, 20, 32],
    [41, 20, 30],
    [41, 20, 32],
  ]);
});
