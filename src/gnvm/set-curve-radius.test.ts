import assert from "node:assert/strict";
import test from "node:test";
import { Field } from "./core";
import { Geometry } from "./geometry";
import { REGISTRY } from "./registry";
import "./index";

test("Set Curve Radius maps signed taper fields through shared curve instances", () => {
  const strand = new Geometry();
  strand.curves = [{
    cyclic: false,
    points: [[0, 0, 0], [0, 0, 0.25], [0, 0, 2]],
  }];
  const instances = new Geometry();
  instances.instances = [0, 1].map((x) => ({
    geometry: strand,
    position: [x, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  }));

  const handler = REGISTRY.get("GeometryNodeSetCurveRadius");
  assert.ok(handler);
  const result = handler({
    geo: () => instances,
    field: (name: string) => name === "Selection"
      ? Field.of(1)
      : Field.perElem((_index, ctx) => (ctx.splineFactor?.(_index) ?? 0) - 1.05),
  } as never).Curve as Geometry;

  assert.notEqual(result.instances[0].geometry, strand);
  assert.equal(result.instances[0].geometry, result.instances[1].geometry);
  assert.deepEqual(result.instances[0].geometry.curveAttributes.get("radius")?.data, [
    -1.05,
    -0.925,
    -0.050000000000000044,
  ]);
});
