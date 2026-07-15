import assert from "node:assert/strict";
import test from "node:test";
import { blenderNoiseTexture3D } from "./nodes/extra";

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
