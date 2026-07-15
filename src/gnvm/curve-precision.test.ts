import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBezierSpline } from "./bezier";
import { Field } from "./core";
import { resampleSpline } from "./curves";
import { makeFieldCtx } from "./evaluator";
import { Geometry } from "./geometry";
import "./nodes/crayon";
import "./nodes/geometry";
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
