import assert from "node:assert/strict";
import test from "node:test";
import { Field } from "./core";
import { Geometry } from "./geometry";
import { REGISTRY } from "./registry";
import "./index";

test("Set Curve Normal stores a Z-up point-domain frame", () => {
  const curve = new Geometry();
  curve.curves = [{
    points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
    cyclic: false,
  }];

  const handler = REGISTRY.get("GeometryNodeSetCurveNormal");
  assert.ok(handler);
  const result = handler({
    geo: () => curve,
    field: (name: string) => Field.of(name === "Selection" ? 1 : [1, 1, 0]),
    resolve: (field: Field, geometry: Geometry) =>
      field.array({
        size: geometry.curvePointCount(),
        domain: "POINT",
        component: "CURVE",
      }),
    str: () => "Z Up",
  } as never).Curve as Geometry;

  assert.deepEqual(result.curveAttributes.get("__curve_normal"), {
    domain: "POINT",
    data: [[0, 0, 1], [0, 0, 1], [0, 0, 1]],
  });
  assert.notEqual(result, curve);
});

test("Set Curve Normal projects a free normal perpendicular to the tangent", () => {
  const curve = new Geometry();
  curve.curves = [{
    points: [[0, 0, 0], [0, 1, 0]],
    cyclic: false,
  }];

  const handler = REGISTRY.get("GeometryNodeSetCurveNormal");
  assert.ok(handler);
  const result = handler({
    geo: () => curve,
    field: (name: string) => Field.of(name === "Selection" ? 1 : [1, 1, 0]),
    resolve: (field: Field, geometry: Geometry) =>
      field.array({
        size: geometry.curvePointCount(),
        domain: "POINT",
        component: "CURVE",
      }),
    str: () => "Free",
  } as never).Curve as Geometry;

  const normals = result.curveAttributes.get("__curve_normal")?.data;
  assert.ok(normals);
  for (const normal of normals) {
    assert.ok(Array.isArray(normal));
    assert.ok(Math.abs(normal[1]) < 1e-12);
  }
});
