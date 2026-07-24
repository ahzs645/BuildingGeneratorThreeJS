import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  blenderLayerWeightFresnel,
  blenderRoughnessFresnel,
  blenderScalarLutCoordinate,
  sampleBlenderScalarLut,
} from "../materialx/blender-shader-semantics";

type LutReport = {
  sampling: {
    count: number;
    coordinate: string;
    sha256: string;
    bytes: number;
  };
  samples: Array<{
    factor: number;
    response: number;
  }>;
};

const report = JSON.parse(fs.readFileSync(
  new URL("../../public/materialx/gold-roughness-fresnel-lut.json", import.meta.url),
  "utf8",
)) as LutReport;

test("Layer Weight Fresnel follows Blender's front-face eta transform", () => {
  const eta = 1 / (1 - 0.1);
  const expectedNormalIncidence = ((eta - 1) / (eta + 1)) ** 2;
  assert.ok(Math.abs(
    blenderLayerWeightFresnel(1, 0.1) - expectedNormalIncidence,
  ) < 1e-15);
  assert.equal(blenderLayerWeightFresnel(0, 0.1), 1);
  assert.ok(blenderLayerWeightFresnel(0.25, 0.1) > blenderLayerWeightFresnel(0.75, 0.1));
});

test("roughness Fresnel preserves Blender's MULTIPLY mix semantics", () => {
  assert.equal(blenderRoughnessFresnel(0.35, 0, 0.2), 0.35);
  assert.equal(blenderRoughnessFresnel(0.35, 1, 0), 0);
  assert.ok(Math.abs(blenderRoughnessFresnel(0.35, 0.5, 0.25) - 0.21875) < 1e-15);
});

test("the centered RGBA8 LUT stays within the scalar roughness error budget", () => {
  assert.equal(report.samples.length, 256);
  assert.equal(report.sampling.count, 256);
  assert.match(report.sampling.coordinate, /factor \* \(count - 1\) \/ count/);
  assert.ok(Math.abs(blenderScalarLutCoordinate(0, 256) - 0.5 / 256) < 1e-15);
  assert.ok(Math.abs(blenderScalarLutCoordinate(1, 256) - 255.5 / 256) < 1e-15);

  const source = report.samples.map(({ response }) => response);
  const rgba8 = source.map((value) => Math.round(value * 255) / 255);
  let maximumResponseError = 0;
  let maximumRoughnessError = 0;
  for (let index = 0; index <= 4096; index += 1) {
    const factor = index / 4096;
    const expected = sampleBlenderScalarLut(source, factor);
    const actual = sampleBlenderScalarLut(rgba8, factor);
    maximumResponseError = Math.max(maximumResponseError, Math.abs(expected - actual));
    maximumRoughnessError = Math.max(
      maximumRoughnessError,
      Math.abs(
        blenderRoughnessFresnel(0.35, factor, expected)
          - blenderRoughnessFresnel(0.35, factor, actual),
      ),
    );
  }
  assert.ok(maximumResponseError <= 0.5 / 255 + 1e-12);
  assert.ok(maximumRoughnessError < 0.0007);
});
