import assert from "node:assert/strict";
import test from "node:test";
import { Field } from "./core";
import {
  decomposeMatrix,
  identityMatrix,
  invertMatrix,
  matrixFromTRS,
  MatrixValue,
  multiplyMatrices,
} from "./matrix";
import "./nodes/matrix";
import "./nodes/geometry";
import { DUMP_CONTEXT, REGISTRY, type EvalAPI } from "./registry";

function apiFor(type: string, value: MatrixValue): EvalAPI {
  return {
    node: { name: type, type, label: null, inputs: [], outputs: [] },
    input: () => value,
    inputs: () => [],
    geoInputs: () => [],
    geo: () => { throw new Error("unused"); },
    field: () => Field.of(0),
    num: () => 0,
    vec: () => [0, 0, 0],
    bool: () => false,
    str: () => "",
    ref: () => null,
    prop: (_name, fallback) => fallback as never,
    resolve: () => [],
  };
}

function close(actual: number[], expected: number[], tolerance = 1e-9): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) =>
    assert.ok(Math.abs(value - expected[index]) <= tolerance, `${value} != ${expected[index]}`));
}

test("matrix values round-trip Blender-style translation, XYZ rotation, and scale", () => {
  const value = matrixFromTRS([3, -2, 7], [.2, -.4, .7], [2, 3, 4]);
  const parts = decomposeMatrix(value);
  close(parts.translation, [3, -2, 7]);
  close(parts.rotation, [.2, -.4, .7]);
  close(parts.scale, [2, 3, 4]);
});

test("Invert Matrix composes back to identity and reports singular matrices", () => {
  const handler = REGISTRY.get("FunctionNodeInvertMatrix");
  assert.ok(handler);
  const value = matrixFromTRS([4, 5, 6], [.1, .2, .3], [2, 3, 4]);
  const outputs = handler(apiFor("FunctionNodeInvertMatrix", value));
  const inverse = outputs.Matrix;
  assert.ok(inverse instanceof MatrixValue);
  const product = multiplyMatrices(value, inverse);
  close(product.rows.flat(), identityMatrix().rows.flat(), 1e-8);
  assert.equal((outputs.Invertible as Field).value, 1);

  const singular = new MatrixValue([
    [0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1],
  ]);
  const failed = handler(apiFor("FunctionNodeInvertMatrix", singular));
  assert.deepEqual((failed.Matrix as MatrixValue).rows, identityMatrix().rows);
  assert.equal((failed.Invertible as Field).value, 0);
});

test("Separate Transform exposes the inverse object's translation", () => {
  const invert = REGISTRY.get("FunctionNodeInvertMatrix");
  const separate = REGISTRY.get("FunctionNodeSeparateTransform");
  assert.ok(invert && separate);
  const source = matrixFromTRS([8, -3, 2], [0, 0, 0], [1, 1, 1]);
  const inverse = invert(apiFor("FunctionNodeInvertMatrix", source)).Matrix as MatrixValue;
  const outputs = separate(apiFor("FunctionNodeSeparateTransform", inverse));
  assert.deepEqual((outputs.Translation as Field).value, [-8, 3, -2]);
});

test("Object Info keeps an unassigned Relative object at the identity transform", () => {
  const handler = REGISTRY.get("GeometryNodeObjectInfo");
  assert.ok(handler);
  DUMP_CONTEXT.objects = [];
  DUMP_CONTEXT.activeObject = {
    name: "Active",
    location: [8, -3, 2],
    rotation: [.1, .2, .3],
    scale: [2, 2, 2],
  };
  const outputs = handler({
    node: { name: "Object Info", type: "GeometryNodeObjectInfo", inputs: [], outputs: [] },
    ref: () => null,
    bool: () => false,
    prop: (name: string, fallback: unknown) => name === "transform_space" ? "RELATIVE" : fallback,
  } as never);

  assert.deepEqual((outputs.Transform as MatrixValue).rows, identityMatrix().rows);
  assert.deepEqual((outputs.Location as Field).value, [0, 0, 0]);
  assert.deepEqual((outputs.Rotation as Field).value, [0, 0, 0]);
  assert.deepEqual((outputs.Scale as Field).value, [1, 1, 1]);
  DUMP_CONTEXT.activeObject = undefined;
});
