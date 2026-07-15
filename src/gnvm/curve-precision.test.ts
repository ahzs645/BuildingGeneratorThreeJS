import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBezierSpline } from "./bezier";
import { Field, Vec3 } from "./core";
import { resampleSpline, sweep } from "./curves";
import { makeFieldCtx } from "./evaluator";
import { Geometry } from "./geometry";
import "./nodes/crayon";
import "./nodes/curves";
import "./nodes/geometry";
import "./nodes/inputs";
import "./nodes/fields";
import { EvalAPI, REGISTRY } from "./registry";

test("Bezier evaluation follows Blender float32 forward differences", () => {
  const points = evaluateBezierSpline(
    [
      [70.57221984863281, 27.26752281188965, 1.370941162109375],
      [68.10789489746094, 33.674781799316406, 1.370941162109375],
      [75.41950988769531, -65.96450805664062, 1.370941162109375],
    ],
    false,
    [
      [70.08015441894531, 29.23576545715332, 1.370941162109375],
      [67.29458618164062, 35.533443450927734, 1.370941162109375],
      [107.98237609863281, -38.64707946777344, 1.370941162109375],
    ],
    [
      [71.06428527832031, 25.299285888671875, 1.370941162109375],
      [75.33576202392578, 17.1568660736084, 1.370941162109375],
      [51.957603454589844, -85.64701843261719, 1.370941162109375],
    ],
    12,
  );

  assert.equal(points.length, 25);
  assert.deepEqual(points[1], [70.61156463623047, 27.015621185302734, 1.370941162109375]);
  assert.deepEqual(points[11], [67.99492645263672, 33.901573181152344, 1.370941162109375]);
  assert.deepEqual(points[12], [68.10789489746094, 33.674781799316406, 1.370941162109375]);
  assert.deepEqual(points[24], [75.41950988769531, -65.96450805664062, 1.370941162109375]);
});

test("curve resampling preserves Blender float32 length parameterization", () => {
  const result = resampleSpline({
    cyclic: false,
    points: [[0.1, 0.2, 0.3], [2.4, 0.3, -0.2], [2.9, 3.1, 0.7]],
  }, 4);

  assert.deepEqual(result.points, [
    [0.10000000149011612, 0.20000000298023224, 0.30000001192092896],
    [1.8375232219696045, 0.27554449439048767, -0.07772241532802582],
    [2.601719856262207, 1.429631233215332, 0.16309577226638794],
    [2.9000000953674316, 3.0999999046325684, 0.699999988079071],
  ]);
});

test("Curve Circle follows Blender float32 sincos sampling", () => {
  const handler = REGISTRY.get("GeometryNodeCurvePrimitiveCircle");
  assert.ok(handler);
  const output = handler({
    num: (name: string) => name === "Resolution" ? 33 : 15.556474685668945,
  } as EvalAPI).Curve as Geometry;

  assert.equal(output.curves[0].points.length, 33);
  assert.deepEqual(output.curves[0].points[1], [15.275348663330078, 2.944082260131836, 0]);
  assert.deepEqual(output.curves[0].points[24], [-2.2139124870300293, -15.398133277893066, 0]);
  assert.deepEqual(output.curves[0].points[32], [15.275348663330078, -2.9440810680389404, 0]);
});

test("Bounding Box includes Blender's implicit curve-point radius", () => {
  const geometry = new Geometry();
  geometry.curves = [{ cyclic: false, points: [[2, 3, 4], [5, 7, 11]] }];
  const handler = REGISTRY.get("GeometryNodeBoundBox");
  assert.ok(handler);
  const outputs = handler({ geo: () => geometry } as EvalAPI);

  assert.deepEqual((outputs.Min as Field).value, [1, 2, 3]);
  assert.deepEqual((outputs.Max as Field).value, [6, 8, 12]);

  geometry.curveAttributes.set("radius", { domain: "POINT", data: [0.5, 2] });
  const explicit = handler({ geo: () => geometry } as EvalAPI);
  assert.deepEqual((explicit.Min as Field).value, [1.5, 2.5, 3.5]);
  assert.deepEqual((explicit.Max as Field).value, [7, 9, 13]);
});

test("Curve to Points rebuilds stale imported tangents after Poly conversion", () => {
  const geometry = new Geometry();
  geometry.curves = [{ cyclic: false, points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]] }];
  geometry.curveAttributes.set("__curve_tangent", {
    domain: "POINT",
    data: [[1, 0, 0], [1, 0, 0], [1, 0, 0]],
  });
  geometry.curveAttributes.set("__curve_imported_tangent", { domain: "CURVE", data: [1] });

  const handler = REGISTRY.get("GeometryNodeCurveToPoints");
  assert.ok(handler);
  const outputs = handler({
    geo: () => geometry,
    num: (name: string) => name === "Count" ? 3 : 0.1,
    prop: (_name: string, fallback: unknown) => fallback === "COUNT" ? "COUNT" : fallback,
    node: { name: "Curve to Points", inputs: [] },
  } as unknown as EvalAPI);
  const points = outputs.Points as Geometry;
  const tangents = (outputs.Tangent as Field).array(makeFieldCtx(points, "POINT"));

  assert.ok(Math.abs((tangents[1] as number[])[0] - Math.SQRT1_2) < 1e-12);
  assert.ok(Math.abs((tangents[1] as number[])[1] - Math.SQRT1_2) < 1e-12);
});

test("Curve Tangent prefers the evaluated Resample Curve frame", () => {
  const geometry = new Geometry();
  geometry.curves = [{ cyclic: false, points: [[0, 0, 0], [1, 0, 0], [1, 3, 0]] }];
  geometry.curveAttributes.set("__curve_tangent", {
    domain: "POINT",
    data: [[1, 0, 0], [Math.SQRT1_2, Math.SQRT1_2, 0], [0, 1, 0]],
  });

  const handler = REGISTRY.get("GeometryNodeInputTangent");
  assert.ok(handler);
  const tangent = handler({} as EvalAPI).Tangent as Field;
  const values = tangent.array(makeFieldCtx(geometry, "POINT"));

  assert.deepEqual(values[0], [1, 0, 0]);
  assert.deepEqual(values[1], [Math.SQRT1_2, Math.SQRT1_2, 0]);
  assert.deepEqual(values[2], [0, 1, 0]);
});

test("Curve to Mesh preserves the evaluated Resample Curve frame", () => {
  const result = sweep(
    { cyclic: false, points: [[0, 0, 1], [0, 0, -1]] },
    { cyclic: true, points: [[2, 0, 0], [0, 3, 0], [-2, 0, 0], [0, -3, 0]] },
    false,
    undefined,
    [[0, 0, -1], [0, 0, -1]],
  );

  // Blender's evaluated frame maps profile +X to world +X and profile +Y to
  // world -Y on a descending Z rail. Reapplying the generic half-turn maps
  // the first ring to the opposite side of the rail instead.
  assert.deepEqual(result.positions.slice(0, 4), [
    [2, 0, 1],
    [0, -3, 1],
    [-2, 0, 1],
    [0, 3, 1],
  ]);
});

test("Resample Curve preserves Blender float32 minimum-twist frames through sweep", () => {
  const circleHandler = REGISTRY.get("GeometryNodeCurvePrimitiveCircle");
  const resampleHandler = REGISTRY.get("GeometryNodeResampleCurve");
  assert.ok(circleHandler && resampleHandler);
  const circle = circleHandler({
    num: (name: string) => name === "Resolution" ? 33 : 15.556474685668945,
  } as EvalAPI).Curve as Geometry;
  const resampled = resampleHandler({
    geo: () => circle,
    str: () => "COUNT",
    prop: (_name: string, fallback: unknown) => fallback,
    num: (name: string) => name === "Count" ? 86 : 0.1,
  } as unknown as EvalAPI).Curve as Geometry;
  const tangents = resampled.curveAttributes.get("__curve_tangent")?.data as number[][];
  const normals = resampled.curveAttributes.get("__curve_normal")?.data as number[][];

  assert.deepEqual(resampled.curves[0].points[34], [-12.302580833435059, 9.50066089630127, 0]);
  assert.deepEqual(tangents[34], [-0.6090847849845886, -0.7931051254272461, 0]);
  assert.deepEqual(normals[34], [-0.7931050658226013, 0.609084963798523, 0]);

  const mesh = sweep(
    resampled.curves[0],
    { cyclic: true, points: [[-0.43476709723472595, 0.14126437902450562, 0], [0, 0, 0]] },
    false,
    undefined,
    tangents as Vec3[],
    normals as Vec3[],
  );
  assert.deepEqual(mesh.positions[34 * 2], [-11.957764625549316, 9.23585033416748, -0.14126437902450562]);
});

test("Align Rotation preserves native Curve to Points quaternion at 180 degrees", () => {
  const curve = new Geometry();
  curve.curves = [{ cyclic: false, points: [[0, 0, 1], [0, 0, -1]] }];
  const curveToPoints = REGISTRY.get("GeometryNodeCurveToPoints");
  const alignRotation = REGISTRY.get("FunctionNodeAlignRotationToVector");
  assert.ok(curveToPoints && alignRotation);

  const sampled = curveToPoints({
    geo: () => curve,
    num: (name: string) => name === "Count" ? 2 : 0.1,
    prop: (_name: string, fallback: unknown) => fallback === "COUNT" ? "COUNT" : fallback,
    node: { name: "Curve to Points", inputs: [] },
  } as unknown as EvalAPI);
  const points = sampled.Points as Geometry;
  const nativeRotation = sampled.Rotation as Field;
  const aligned = alignRotation({
    field: (name: string) => name === "Rotation"
      ? nativeRotation
      : Field.of(name === "Vector" ? [0, 0, 1] : 1),
    prop: (_name: string, fallback: unknown) => fallback === "X" ? "Z" : fallback,
  } as unknown as EvalAPI).Rotation as Field;
  const values = aligned.array(makeFieldCtx(points, "POINT")) as number[][];

  for (const value of values) {
    assert.ok(Math.abs(value[0]) < 1e-6);
    assert.ok(Math.abs(value[1]) < 1e-6);
    assert.ok(Math.abs(Math.abs(value[2]) - Math.PI) < 1e-6);
  }

  const eulerConstant = alignRotation({
    field: (name: string) => Field.of(name === "Rotation" ? [Math.PI, 0, 0] : name === "Vector" ? [0, 0, 1] : 1),
    prop: (_name: string, fallback: unknown) => fallback === "X" ? "Z" : fallback,
  } as unknown as EvalAPI).Rotation as Field;
  const constantValue = eulerConstant.array(makeFieldCtx(points, "POINT"))[0] as number[];
  assert.ok(constantValue.every((component) => Math.abs(component) < 1e-6));
});
