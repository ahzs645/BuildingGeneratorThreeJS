import assert from "node:assert/strict";
import test from "node:test";
import { Field, Vec3 } from "./core";
import { Geometry, Mesh, realizeInstances } from "./geometry";
import { REGISTRY } from "./registry";
import "./index";

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
