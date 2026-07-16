import assert from "node:assert/strict";
import test from "node:test";
import { Geometry, Mesh, realizeInstances } from "./geometry";

test("Realize Instances composes nested affine matrices before transforming leaf points", () => {
  const leaf = new Geometry();
  leaf.mesh = new Mesh();
  leaf.mesh.positions = [[15.556474685668945, 0, 0]];

  const child = new Geometry();
  child.instances.push({
    geometry: leaf,
    position: [0, 0, 23.177337646484375],
    rotation: [0, 8.74227765734758e-8, Math.PI],
    scale: [1, 1, 1],
    transformMatrix: [
      [-1, 0, -8.742277657347586e-8, 0],
      [0, -1, 0, 0],
      [-8.742277657347586e-8, 0, 1, 23.177337646484375],
      [0, 0, 0, 1],
    ],
    attributes: new Map([["inner", 3]]),
  });

  const root = new Geometry();
  root.instances.push({
    geometry: child,
    position: [-12.954824447631836, 6.62493896484375, -7.7762451171875],
    rotation: [Math.PI / 2, 0, Math.PI / 2],
    scale: [1, 1, 1],
    transformMatrix: [
      [-4.371138473402425e-8, 4.371138828673793e-8, 1, -12.954824447631836],
      [0.9999999403953552, 1.910685465164705e-15, 4.371138828673793e-8, 6.62493896484375],
      [0, 0.9999999403953552, -4.371138473402425e-8, -7.7762451171875],
      [0, 0, 0, 1],
    ],
    attributes: new Map([["outer", 7]]),
  });

  const realized = realizeInstances(root);
  assert.deepEqual(realized.mesh?.positions, [
    [10.222512245178223, -8.931533813476562, -7.776246070861816],
  ]);
  assert.deepEqual(realized.mesh?.attributes.get("inner"), { domain: "POINT", data: [3] });
  assert.deepEqual(realized.mesh?.attributes.get("outer"), { domain: "POINT", data: [7] });
});

test("Realize Instances accumulates nested curve radius scaling", () => {
  const leaf = new Geometry();
  leaf.curves = [{ cyclic: false, points: [[1, 0, 0]] }];
  leaf.curveAttributes.set("radius", { domain: "POINT", data: [1] });

  const child = new Geometry();
  child.instances.push({
    geometry: leaf,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [3, 3, 3],
    transformMatrix: [
      [3, 0, 0, 0],
      [0, 3, 0, 0],
      [0, 0, 3, 0],
      [0, 0, 0, 1],
    ],
  });

  const root = new Geometry();
  root.instances.push({
    geometry: child,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [2, 2, 2],
    transformMatrix: [
      [2, 0, 0, 0],
      [0, 2, 0, 0],
      [0, 0, 2, 0],
      [0, 0, 0, 1],
    ],
  });

  const realized = realizeInstances(root);
  assert.deepEqual(realized.curves[0].points, [[6, 0, 0]]);
  assert.deepEqual(realized.curveAttributes.get("radius"), { domain: "POINT", data: [6] });
});
