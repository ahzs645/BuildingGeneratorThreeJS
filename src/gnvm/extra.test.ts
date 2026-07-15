import assert from "node:assert/strict";
import test from "node:test";
import { blenderNoiseTexture3D } from "./nodes/extra";

test("3D Noise Texture stores its Factor at Blender's float32 field boundary", () => {
  const samples = [
    { position: [-15.653032302856445, -13.776257514953613, 0.9236533641815186], expected: 0.5221064686775208 },
    { position: [24.38067626953125, -38.2547721862793, 0.9236533641815186], expected: 0.5691377520561218 },
    { position: [25.558135986328125, -37.08912658691406, 0.9236533641815186], expected: 0.5661042928695679 },
  ] as const;

  for (const sample of samples) {
    const actual = blenderNoiseTexture3D(
      [...sample.position],
      0.0020000000949949026,
      2,
      0.5,
      2,
      0,
      true,
    );
    // Blender's CPU node and the VM can differ by two final float ULPs when
    // Clang contracts the Perlin interpolation. Both store the same float32
    // field precision before downstream geometry math.
    assert.ok(
      Math.abs(actual - sample.expected) <= 1.1920928955078125e-7,
      `${sample.position.join(",")}: expected ${sample.expected}, got ${actual}`,
    );
  }
});

test("3D Noise Texture distortion uses Blender's hash-derived axis offsets", () => {
  const samples = [
    { position: [0, 0, 0], expected: 0.47466596961021423 },
    { position: [0.6170229911804199, -0.48010432720184326, 0.8702353835105896], expected: 0.4924473464488983 },
    { position: [1.0589056015014648, -0.8011471033096313, 1.2077997922897339], expected: 0.49565860629081726 },
    { position: [0.4482421278953552, -0.9995671510696411, 1.2077996730804443], expected: 0.4914730489253998 },
    { position: [-1.2, 2.3, -3.4], expected: 0.43739578127861023 },
  ] as const;

  for (const sample of samples) {
    const actual = blenderNoiseTexture3D(
      [...sample.position],
      -0.05206298828125,
      2,
      0.5,
      2,
      0.38458251953125,
      true,
    );
    assert.ok(
      Math.abs(actual - sample.expected) < 3e-6,
      `${sample.position.join(",")}: expected ${sample.expected}, got ${actual}`,
    );
  }
});
