import assert from "node:assert/strict";
import test from "node:test";
import { Field, type FieldCtx, type Vec3 } from "./core";
import { Geometry } from "./geometry";
import { REGISTRY, type EvalAPI } from "./registry";
import "./index";

const ROTATION_QUATERNION = Symbol.for("gnvm.rotationQuaternion");
type Quaternion = [number, number, number, number];
type TaggedRotation = Vec3 & { [ROTATION_QUATERNION]?: Quaternion };

function fieldApi(
  type: string,
  fields: Record<string, Field>,
  props: Record<string, unknown> = {},
): EvalAPI {
  return {
    node: { name: type, type, label: null, inputs: [], outputs: [] },
    input: (name) => fields[name],
    inputs: () => [],
    geoInputs: () => [],
    geo: () => new Geometry(),
    field: (name) => fields[name] ?? Field.of(0),
    num: () => 0,
    vec: () => [0, 0, 0],
    bool: () => false,
    str: () => "",
    ref: () => null,
    prop: (name, fallback) => (props[name] ?? fallback) as never,
    resolve: () => [],
  };
}

function close(actual: number[], expected: number[], tolerance = 2e-6): void {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) =>
    assert.ok(Math.abs(value - expected[index]) <= tolerance, `${value} != ${expected[index]}`));
}

function rotate(quaternion: Quaternion, vector: Vec3): Vec3 {
  const [x, y, z, w] = quaternion;
  const uv: Vec3 = [
    y * vector[2] - z * vector[1],
    z * vector[0] - x * vector[2],
    x * vector[1] - y * vector[0],
  ];
  const uuv: Vec3 = [
    y * uv[2] - z * uv[1],
    z * uv[0] - x * uv[2],
    x * uv[1] - y * uv[0],
  ];
  return [
    vector[0] + 2 * (w * uv[0] + uuv[0]),
    vector[1] + 2 * (w * uv[1] + uuv[1]),
    vector[2] + 2 * (w * uv[2] + uuv[2]),
  ];
}

function integer(operation: string, a: number, b = 0, c = 0): number {
  const handler = REGISTRY.get("FunctionNodeIntegerMath");
  assert.ok(handler);
  return (handler(fieldApi("FunctionNodeIntegerMath", {
    Value: Field.of(a),
    Value_001: Field.of(b),
    Value_002: Field.of(c),
  }, { operation })).Value as Field).value as number;
}

test("Integer Math matches Blender's signed integer operation semantics", () => {
  const cases: [string, number, number, number, number][] = [
    ["ADD", 7, -3, 0, 4],
    ["SUBTRACT", 7, -3, 0, 10],
    ["MULTIPLY", 7, -3, 0, -21],
    ["DIVIDE", -7, 3, 0, -2],
    ["MULTIPLY_ADD", 7, -3, 5, -16],
    ["ABSOLUTE", -7, 0, 0, 7],
    ["NEGATE", 7, 0, 0, -7],
    ["POWER", -2, 3, 0, -8],
    ["MINIMUM", 7, -3, 0, -3],
    ["MAXIMUM", 7, -3, 0, 7],
    ["SIGN", -7, 0, 0, -1],
    ["DIVIDE_ROUND", -5, 2, 0, -3],
    ["DIVIDE_FLOOR", -7, 3, 0, -3],
    ["DIVIDE_CEIL", -7, 3, 0, -2],
    ["FLOORED_MODULO", -7, 3, 0, 2],
    ["MODULO", -7, 3, 0, -1],
    ["GCD", -12, 18, 0, 6],
    ["LCM", -12, 18, 0, 36],
  ];
  for (const [operation, a, b, c, expected] of cases)
    assert.equal(integer(operation, a, b, c), expected, operation);
});

test("Integer Math keeps divide-by-zero, overflow, and negative-power behavior bounded", () => {
  for (const operation of [
    "DIVIDE", "DIVIDE_ROUND", "DIVIDE_FLOOR", "DIVIDE_CEIL", "FLOORED_MODULO", "MODULO",
  ]) assert.equal(integer(operation, 7, 0), 0, operation);
  assert.equal(integer("MULTIPLY", 0x7fffffff, 2), -2);
  assert.equal(integer("LCM", 0x7fffffff, 2), -2);
  assert.equal(integer("ABSOLUTE", -0x80000000), -0x80000000);
  assert.equal(integer("POWER", 2, -2), 0);
  assert.equal(integer("POWER", -1, -5), -1);
  assert.equal(integer("POWER", 2, 31), 0x7fffffff);
});

test("Integer Math evaluates linked values per element", () => {
  const handler = REGISTRY.get("FunctionNodeIntegerMath");
  assert.ok(handler);
  const value = handler(fieldApi("FunctionNodeIntegerMath", {
    Value: Field.perElem((index) => index + 1),
    Value_001: Field.of(10),
    Value_002: Field.of(0),
  }, { operation: "MULTIPLY" })).Value as Field;
  const context: FieldCtx = { size: 3, domain: "POINT" };
  assert.deepEqual(value.array(context), [10, 20, 30]);
});

test("Axes to Rotation matches Blender's orthogonalized X/Y frame", () => {
  const handler = REGISTRY.get("FunctionNodeAxesToRotation");
  assert.ok(handler);
  const result = (handler(fieldApi("FunctionNodeAxesToRotation", {
    "Primary Axis": Field.of([1, 1, 0]),
    "Secondary Axis": Field.of([0, 1, 1]),
  }, { primary_axis: "X", secondary_axis: "Y" })).Rotation as Field).value as TaggedRotation;
  close(result, [0.9553167223930359, 0, 0.7853981256484985]);
  assert.ok(result[ROTATION_QUATERNION]);
  close(rotate(result[ROTATION_QUATERNION]!, [1, 0, 0]), [Math.SQRT1_2, Math.SQRT1_2, 0]);
});

test("Axes to Rotation preserves handedness for every ordered axis pair", () => {
  const handler = REGISTRY.get("FunctionNodeAxesToRotation");
  assert.ok(handler);
  const units: Record<string, Vec3> = {
    X: [1, 0, 0],
    Y: [0, 1, 0],
    Z: [0, 0, 1],
  };
  for (const primary of Object.keys(units)) {
    for (const secondary of Object.keys(units)) {
      if (primary === secondary) continue;
      const result = (handler(fieldApi("FunctionNodeAxesToRotation", {
        "Primary Axis": Field.of(units[primary]),
        "Secondary Axis": Field.of(units[secondary]),
      }, { primary_axis: primary, secondary_axis: secondary })).Rotation as Field).value as TaggedRotation;
      close(result, [0, 0, 0]);
    }
  }
});

test("Axes to Rotation follows Blender's deterministic degenerate-axis fallbacks", () => {
  const handler = REGISTRY.get("FunctionNodeAxesToRotation");
  assert.ok(handler);
  const zeroPrimary = (handler(fieldApi("FunctionNodeAxesToRotation", {
    "Primary Axis": Field.of([0, 0, 0]),
    "Secondary Axis": Field.of([0, 1, 0]),
  }, { primary_axis: "X", secondary_axis: "Y" })).Rotation as Field).value as TaggedRotation;
  const quaternion = zeroPrimary[ROTATION_QUATERNION];
  assert.ok(quaternion);
  close(rotate(quaternion, [1, 0, 0]), [-1, 0, 0]);
  close(rotate(quaternion, [0, 1, 0]), [0, 1, 0]);

  const equalAxes = (handler(fieldApi("FunctionNodeAxesToRotation", {
    "Primary Axis": Field.of([0, 1, 0]),
    "Secondary Axis": Field.of([1, 0, 0]),
  }, { primary_axis: "Y", secondary_axis: "Y" })).Rotation as Field).value as TaggedRotation;
  close(equalAxes, [0, 0, 0]);
});

test("Rotation input preserves its authored Euler value as a native quaternion", () => {
  const handler = REGISTRY.get("FunctionNodeInputRotation");
  assert.ok(handler);
  const rotation = (handler(fieldApi(
    "FunctionNodeInputRotation",
    {},
    { rotation_euler: [0.25, -0.5, 1] },
  )).Rotation as Field).value as TaggedRotation;
  close(rotation, [0.25, -0.5, 1]);
  assert.ok(rotation[ROTATION_QUATERNION]);
});
