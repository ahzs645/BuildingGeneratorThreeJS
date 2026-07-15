import assert from "node:assert/strict";
import test from "node:test";
import { Geometry, realizeInstances } from "./geometry";

test("Realize Instances drops extraction-only font sampling metadata", () => {
  const glyph = new Geometry();
  glyph.curves = [{ cyclic: true, points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] }];
  glyph.curveAttributes.set("__font_sample_stride", { domain: "CURVE", data: [12] });
  glyph.curveAttributes.set("authored", { domain: "CURVE", data: [7] });

  const source = new Geometry();
  source.instances = [{
    geometry: glyph,
    position: [2, 3, 4],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  }];

  const realized = realizeInstances(source);
  assert.equal(realized.curveAttributes.has("__font_sample_stride"), false);
  assert.deepEqual(realized.curveAttributes.get("authored"), { domain: "CURVE", data: [7] });
});
