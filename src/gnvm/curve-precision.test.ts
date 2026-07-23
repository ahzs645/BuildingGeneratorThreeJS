import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBezierSpline } from "./bezier";
import { Field, Vec3 } from "./core";
import {
  polySplineNormalsBlender,
  polySplineTangentsBlender,
  resampleSpline,
  resampleSplineWithSamples,
  sweep,
} from "./curves";
import { makeFieldCtx } from "./evaluator";
import { Geometry, Mesh } from "./geometry";
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

test("open curve resampling preserves Blender's cached final-segment factor", () => {
  const result = resampleSpline({
    cyclic: false,
    points: [
      [1.8138039112091064, 6.738673210144043, -5.298481464385986],
      [9.61691951751709, 7.217741966247559, -3.4624898433685303],
      [3.65205454826355, 0.6291822791099548, -5.681159973144531],
      [-7.909315586090088, -8.58909797668457, -3.6223859786987305],
    ],
  }, 4);

  // `sample_at_length` checks its cached segment before the explicit final
  // point path. The cached multiplication rounds to a factor one ULP below 1.
  assert.deepEqual(result.points[3], [
    -7.90931510925293, -8.589097023010254, -3.6223859786987305,
  ]);
});

test("curve resampling exposes the exact segment factors used for positions", () => {
  const result = resampleSplineWithSamples({
    cyclic: false,
    points: [[0.1, 0.2, 0.3], [2.4, 0.3, -0.2], [2.9, 3.1, 0.7]],
  }, 4);

  assert.deepEqual(result.samples, [
    { a: 0, b: 1, factor: 0 },
    { a: 0, b: 1, factor: 0.7554448246955872 },
    { a: 1, b: 2, factor: 0.4034397602081299 },
    { a: 1, b: 2, factor: 1 },
  ]);
  assert.deepEqual(result.spline, resampleSpline({
    cyclic: false,
    points: [[0.1, 0.2, 0.3], [2.4, 0.3, -0.2], [2.9, 3.1, 0.7]],
  }, 4));
});

test("Poly tangents and minimum-twist normals preserve Blender float32 sharp turns", () => {
  const points: Vec3[] = [
    [-45.144691467285156, 52.26039123535156, -14.58215618133545],
    [-16.855819702148438, 48.51123046875, -14.58215618133545],
    [19.333629608154297, 34.855125427246094, -14.58215618133545],
    [58.52538299560547, 34.855125427246094, -14.58215618133545],
    [92.96728515625, 34.855125427246094, -14.58215618133545],
    [-36.211570739746094, 10.224287033081055, -14.58215618133545],
  ];
  const tangents = polySplineTangentsBlender(points, false);
  const normals = polySplineNormalsBlender(
    tangents,
    false,
    [0, 0, 0, 0, -3.2314400672912598, -3.188948154449463],
  );

  // Blender switches to a cross-product formulation near opposing segments;
  // the normalized sum suffers catastrophic cancellation at this corner.
  assert.deepEqual(tangents[4], [0.09406611323356628, -0.9955659508705139, 0]);
  assert.deepEqual(normals[2], [-0.17943772673606873, -0.9837693572044373, 0]);
  assert.deepEqual(normals[4], [
    0.9915502667427063,
    0.09368663281202316,
    -0.08972658216953278,
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

test("Bounding Box keeps local Mesh to Curve wires positional", () => {
  const geometry = new Geometry();
  geometry.curves = [{ cyclic: false, points: [[2, 3, 4], [5, 7, 11]] }];
  geometry.curveAttributes.set("__gnvm_planar_mesh_curve", { domain: "POINT", data: [1, 1] });
  const handler = REGISTRY.get("GeometryNodeBoundBox");
  assert.ok(handler);
  const outputs = handler({ geo: () => geometry } as EvalAPI);

  assert.deepEqual((outputs.Min as Field).value, [2, 3, 4]);
  assert.deepEqual((outputs.Max as Field).value, [5, 7, 11]);

  geometry.curveAttributes.set("__gnvm_object_info_mesh_curve", { domain: "POINT", data: [1, 1] });
  const objectInfo = handler({ geo: () => geometry } as EvalAPI);
  assert.deepEqual((objectInfo.Min as Field).value, [2, 3, 4].map((value) => Math.fround(value - Math.fround(0.01))));
  assert.deepEqual((objectInfo.Max as Field).value, [5, 7, 11].map((value) => Math.fround(value + Math.fround(0.01))));
});

test("Bounding Box pads pure String to Curves outlines by implicit radius", () => {
  const geometry = new Geometry();
  geometry.curves = [{ cyclic: true, points: [[2, 3, 4], [5, 7, 11]] }];
  geometry.curveAttributes.set("__gnvm_planar_font_curve", { domain: "CURVE", data: [1] });
  const handler = REGISTRY.get("GeometryNodeBoundBox");
  assert.ok(handler);
  const outputs = handler({ geo: () => geometry } as EvalAPI);

  assert.deepEqual((outputs.Min as Field).value, [1, 2, 3]);
  assert.deepEqual((outputs.Max as Field).value, [6, 8, 12]);
});

test("String to Curves keeps an explicitly unassigned Blender font empty", () => {
  const handler = REGISTRY.get("GeometryNodeStringToCurves");
  assert.ok(handler);
  const outputs = handler({
    node: {
      name: "String to Curves",
      type: "GeometryNodeStringToCurves",
      label: null,
      inputs: [{
        name: "Font",
        identifier: "Font",
        type: "NodeSocketFont",
        linked: false,
        value: null,
      }],
      outputs: [],
    },
    str: () => "MAT",
    ref: () => null,
  } as unknown as EvalAPI);

  const geometry = outputs["Curve Instances"] as Geometry;
  assert.equal(geometry.instances.length, 0);
  assert.equal(geometry.curves.length, 0);
  assert.equal(geometry.mesh == null, true);
  assert.equal(outputs.Remainder, "MAT");
});

test("Bounding Box uses positions for font curves beside a mesh component", () => {
  const geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [[10, 10, 10]];
  geometry.curves = [{ cyclic: true, points: [[2, 3, 4], [5, 7, 11]] }];
  geometry.curveAttributes.set("__gnvm_planar_font_curve", { domain: "CURVE", data: [1] });
  const handler = REGISTRY.get("GeometryNodeBoundBox");
  assert.ok(handler);
  const outputs = handler({ geo: () => geometry } as EvalAPI);

  assert.deepEqual((outputs.Min as Field).value, [2, 3, 4]);
  assert.deepEqual((outputs.Max as Field).value, [10, 10, 11]);
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

  // The sampled float32 tangent is already normalized. Preserve its stored
  // value instead of perturbing it with another normalization pass.
  assert.equal((tangents[1] as number[])[0], 0.7071068286895752);
  assert.equal((tangents[1] as number[])[1], 0.7071068286895752);
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

test("Curve to Mesh gives filled endpoint caps Blender's authored winding", () => {
  const result = sweep(
    { cyclic: false, points: [[0, 0, -1], [0, 0, 1]] },
    { cyclic: true, points: [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]] },
    true,
  );

  assert.deepEqual(result.faces.slice(-2), [
    [3, 2, 1, 0],
    [4, 5, 6, 7],
  ]);
});

test("Resample Curve count truncates a fractional integer-socket value", () => {
  const source = new Geometry();
  source.curves = [{ cyclic: false, points: [[0, 0, 0], [1, 0, 0]] }];
  const handler = REGISTRY.get("GeometryNodeResampleCurve");
  assert.ok(handler);
  const result = handler({
    geo: () => source,
    str: () => "COUNT",
    prop: (_name: string, fallback: unknown) => fallback,
    num: (name: string) => name === "Count" ? 3.9 : 0.1,
  } as unknown as EvalAPI).Curve as Geometry;

  assert.equal(result.curvePointCount(), 3);
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

test("Curve to Mesh rebuilds NURBS normals after Set Spline Type", () => {
  const rail = {
    cyclic: true,
    splineType: "NURBS" as const,
    points: [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]] as Vec3[],
  };
  const profile = {
    cyclic: true,
    points: [[0.2, 0, 0], [0, 0.1, 0], [-0.2, 0, 0], [0, -0.1, 0]] as Vec3[],
  };
  const tangents: Vec3[] = [[0, 1, 0], [-1, 0, 0], [0, -1, 0], [1, 0, 0]];
  const stalePolyNormals: Vec3[] = [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1]];

  const rebuilt = sweep(rail, profile, false, undefined, tangents, stalePolyNormals);
  const expected = sweep(rail, profile, false, undefined, tangents);

  assert.deepEqual(rebuilt.positions, expected.positions);
});

test("Curve to Mesh keeps converted profile +X inward on cyclic planar rails", () => {
  const rail = {
    cyclic: true,
    points: [[0, 0, 0], [4, 0, 0], [4, 3, 0], [0, 3, 0]] as Vec3[],
  };
  const asymmetricProfile = {
    cyclic: false,
    points: [[0, 0, 0], [1, 0, 0]] as Vec3[],
  };

  const native = sweep(rail, asymmetricProfile, false);
  const converted = sweep(rail, asymmetricProfile, false, undefined, undefined, undefined, false, true);
  assert.ok(Math.min(...native.positions.map((point) => point[0])) < 0);
  assert.ok(Math.min(...converted.positions.map((point) => point[0])) >= 0);
  assert.ok(Math.max(...converted.positions.map((point) => point[0])) <= 4);
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

test("Align Rotation AUTO pivot matches Blender's float32 near-half-turn path", () => {
  const rotation = [0, 0, 0] as Vec3 & { [key: symbol]: number[] };
  Object.defineProperty(rotation, Symbol.for("gnvm.rotationQuaternion"), {
    value: [0.9990286827087402, -0.04404761642217636, 0.0012336671352386475, -0.00005441904067993164],
    enumerable: false,
  });
  const handler = REGISTRY.get("FunctionNodeAlignRotationToVector");
  assert.ok(handler);
  const output = handler({
    field: (name: string) => Field.of(name === "Rotation" ? rotation : name === "Vector" ? [0, 0, 1] : 1),
    prop: (name: string, fallback: unknown) => name === "axis" ? "Z" : name === "pivot_axis" ? "AUTO" : fallback,
  } as unknown as EvalAPI).Rotation as Field;
  const geometry = new Geometry();
  geometry.curves = [{ cyclic: false, points: [[0, 0, 0]] }];
  const result = output.array(makeFieldCtx(geometry, "POINT"))[0] as Vec3 & { [key: symbol]: number[] };

  assert.deepEqual(result[Symbol.for("gnvm.rotationQuaternion")], [
    -2.176966518163681e-8,
    9.566640812863625e-10,
    0.9990285038948059,
    -0.044068753719329834,
  ]);
});

test("Align Rotation keeps Blender's left-associated quaternion product", () => {
  const rotation = [0, 0, 0] as Vec3 & { [key: symbol]: number[] };
  Object.defineProperty(rotation, Symbol.for("gnvm.rotationQuaternion"), {
    value: [-0.0769425630569458, 0.7557306885719299, -0.06587272882461548, 0.6470020413398743],
    enumerable: false,
  });
  const handler = REGISTRY.get("FunctionNodeAlignRotationToVector");
  assert.ok(handler);
  const output = handler({
    field: (name: string) => Field.of(name === "Rotation" ? rotation : name === "Vector" ? [0, 0, 1] : 1),
    prop: (name: string, fallback: unknown) => name === "axis" ? "Z" : name === "pivot_axis" ? "AUTO" : fallback,
  } as unknown as EvalAPI).Rotation as Field;
  const geometry = new Geometry();
  geometry.curves = [{ cyclic: false, points: [[0, 0, 0]] }];
  const result = output.array(makeFieldCtx(geometry, "POINT"))[0] as Vec3 & { [key: symbol]: number[] };

  assert.deepEqual(result[Symbol.for("gnvm.rotationQuaternion")], [
    0,
    -4.527954899913311e-9,
    -0.10128861665725708,
    0.9948570728302002,
  ]);
});
