import assert from "node:assert/strict";
import test from "node:test";
import { Field } from "./core";
import { makeFieldCtx } from "./evaluator";
import { Geometry, Mesh } from "./geometry";
import { REGISTRY } from "./registry";
import "./index";

test("material fields expose the face slot and select by material identity", () => {
  const geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  geometry.mesh.faces = [[0, 1, 2], [0, 2, 3]];
  geometry.mesh.materialSlots = ["Steel", "Rubber"];
  geometry.mesh.faceMaterial = [1, 0];
  const context = makeFieldCtx(geometry, "FACE");

  const indexHandler = REGISTRY.get("GeometryNodeInputMaterialIndex");
  assert.ok(indexHandler);
  const indices = (indexHandler({} as never)["Material Index"] as Field).array(context);
  assert.deepEqual(indices, [1, 0]);

  const selectionHandler = REGISTRY.get("GeometryNodeMaterialSelection");
  assert.ok(selectionHandler);
  const selection = selectionHandler({
    ref: () => ({ kind: "MATERIAL", name: "Steel" }),
  } as never).Selection as Field;
  assert.deepEqual(selection.array(context), [0, 1]);
});

test("curve handle position fields support absolute and relative coordinates", () => {
  const geometry = new Geometry();
  geometry.curves = [{
    points: [[0, 0, 0], [2, 0, 0]],
    controlPoints: [[0, 0, 0], [2, 0, 0]],
    bezierLeft: [[-1, 0, 0], [1, 0, 0]],
    bezierRight: [[1, 0, 0], [3, 0, 0]],
    cyclic: false,
  }];
  const handler = REGISTRY.get("GeometryNodeInputCurveHandlePositions");
  assert.ok(handler);
  const absolute = handler({ bool: () => false } as never);
  const relative = handler({ bool: () => true } as never);
  const context = makeFieldCtx(geometry, "POINT");

  assert.deepEqual((absolute.Left as Field).array(context), [[-1, 0, 0], [1, 0, 0]]);
  assert.deepEqual((absolute.Right as Field).array(context), [[1, 0, 0], [3, 0, 0]]);
  assert.deepEqual((relative.Left as Field).array(context), [[-1, 0, 0], [-1, 0, 0]]);
  assert.deepEqual((relative.Right as Field).array(context), [[1, 0, 0], [1, 0, 0]]);
});
