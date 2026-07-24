import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createBlenderColorProfilePass,
  sampleBlenderColorProfile,
  validateBlenderColorProfileLut,
} from "./blender-color-management";

const lut = validateBlenderColorProfileLut(JSON.parse(readFileSync(
  new URL("../public/dojo/color-management/standard-medium-high-contrast-lut.json", import.meta.url),
  "utf8",
)));

function linearToSrgb(value: number): number {
  if (value <= 0.0031308) return value * 12.92;
  return 1.055 * value ** (1 / 2.4) - 0.055;
}

test("Blender Standard Medium High Contrast LUT preserves OCIO reference samples", () => {
  const anchors: Array<[number, number]> = [
    [0, 0.002274819416925311],
    [0.01, 0.07248356193304062],
    [0.18, 0.4613889455795288],
    [0.5, 0.781056821346283],
    [0.8, 0.9804510474205017],
    [1, 1.0887110233306885],
  ];
  for (const [input, expectedDisplaySrgb] of anchors) {
    const actual = linearToSrgb(sampleBlenderColorProfile(lut, input));
    assert.ok(
      Math.abs(actual - expectedDisplaySrgb) < 8e-4,
      `${input}: ${actual} versus ${expectedDisplaySrgb}`,
    );
  }
});

test("Blender color-profile LUT is monotonic and constructs a final display pass", () => {
  for (let index = 1; index < lut.values.length; index++)
    assert.ok(lut.values[index] >= lut.values[index - 1]);
  const profile = createBlenderColorProfilePass(lut);
  try {
    assert.equal(profile.pass.material.toneMapped, false);
    assert.equal(profile.pass.uniforms.profileLutSize.value, 256);
    assert.equal(profile.pass.uniforms.profileLut.value.colorSpace, "");
    assert.match(profile.pass.material.fragmentShader, /linearToSrgb\(applyProfile\(source\.r\)\)/);
  } finally {
    profile.dispose();
  }
});
