import assert from "node:assert/strict";
import test from "node:test";
import {
  colorRampGlsl,
  filamentFbm3,
  filamentSignedNoise3,
  filamentWaveFunctionGlsl,
  filamentWaveHeightAtCoordinate,
  generatedCoordinateGlsl,
  mapRangeGlsl,
  mixColorGlsl,
  planOctaves,
  voronoiGlsl,
} from "./blender-glsl";

test("plans and evaluates Blender's fractional final fBM octave", () => {
  const plan = planOctaves(2.5, 0.5, 2);
  assert.deepEqual(plan, {
    fullOctaves: [
      { amplitude: 1, frequency: 1 },
      { amplitude: 0.5, frequency: 2 },
      { amplitude: 0.25, frequency: 4 },
    ],
    fractionalOctave: { amplitude: 0.125, frequency: 8 },
    remainderWeight: 0.5,
  });

  const point = [0.17, 0.31, 0.73];
  const samples = plan.fullOctaves.map((octave) =>
    octave.amplitude * filamentSignedNoise3(point.map((value) => value * octave.frequency)));
  const fullSum = samples.reduce((sum, value) => sum + value, 0);
  const nextSum = fullSum + plan.fractionalOctave.amplitude
    * filamentSignedNoise3(point.map((value) => value * plan.fractionalOctave.frequency));
  const expected = 0.5 * (0.5 * fullSum / 1.75 + 0.5)
    + 0.5 * (0.5 * nextSum / 1.875 + 0.5);
  assert.ok(Math.abs(filamentFbm3(point, {
    detail: 2.5, roughness: 0.5, lacunarity: 2, normalize: true,
  }) - expected) < 1e-15);
});

test("fractional Wave detail emits the same remainder blend used by its CPU oracle", () => {
  const config = {
    distortion: 3.25,
    detail: 2.5,
    detailScale: 1.7,
    detailRoughness: 0.5,
    direction: "X" as const,
  };
  const source = filamentWaveFunctionGlsl("probe", "probeWave", config);
  assert.match(source, /float noise = mix\([\s\S]*, 0\.5\);/);
  assert.match(source, /0\.125 \* probeNoise\(point \* 13\.6\)/);

  const coordinate = [0.13, 0.27, 0.61];
  const point = coordinate.map((value) => (value * 2.3 + 1e-6) * 0.999999);
  const plan = planOctaves(config.detail, config.detailRoughness, 2);
  const fullSum = plan.fullOctaves.reduce((sum, octave) => sum + octave.amplitude
    * filamentSignedNoise3(point.map((value) => value * (config.detailScale * octave.frequency))), 0);
  const maximum = plan.fullOctaves.reduce((sum, octave) => sum + octave.amplitude, 0);
  const nextSum = fullSum + plan.fractionalOctave.amplitude * filamentSignedNoise3(
    point.map((value) => value * (config.detailScale * plan.fractionalOctave.frequency)),
  );
  const distortion = 0.5 * fullSum / maximum
    + 0.5 * nextSum / (maximum + plan.fractionalOctave.amplitude);
  const expected = 0.5 + 0.5 * Math.sin(20 * point[0] + config.distortion * distortion - Math.PI / 2);
  assert.ok(Math.abs(filamentWaveHeightAtCoordinate(coordinate, 2.3, config) - expected) < 1e-15);
});

test("generates arbitrary Blender Color Ramp stops for Constant, Linear, and Ease", () => {
  const stops = [
    { position: 0, color: [1, 0, 0, 1] },
    { position: 0.35, color: [0, 1, 0, 0.5] },
    { position: 1, color: [0, 0, 1, 1] },
  ];
  assert.match(colorRampGlsl("constantRamp", stops, "CONSTANT"), /amount < 0\.35\) return vec4\(1\.0, 0\.0, 0\.0, 1\.0\)/);
  assert.match(colorRampGlsl("linearRamp", stops, "LINEAR"), /return mix\(vec4\(1\.0, 0\.0, 0\.0, 1\.0\), vec4\(0\.0, 1\.0, 0\.0, 0\.5\), t\)/);
  assert.match(colorRampGlsl("easeRamp", stops, "EASE"), /t = t \* t \* \(3\.0 - 2\.0 \* t\)/);
});

test("generates Blender Linear Map Range with optional target-range clamp", () => {
  const source = mapRangeGlsl({
    name: "remap", fromMin: -1, fromMax: 1, toMin: 2, toMax: 4, clamp: true,
  });
  assert.match(source, /\(value - -1\.0\) \* \(4\.0 - 2\.0\) \/ \(1\.0 - -1\.0\)/);
  assert.match(source, /clamp\(remapResult, min\(2\.0, 4\.0\), max\(2\.0, 4\.0\)\)/);
  assert.doesNotMatch(mapRangeGlsl({
    name: "unclamped", fromMin: 0, fromMax: 1, toMin: 0, toMax: 2,
  }), /return clamp/);
});

test("generates Blender Mix Color modes with A/B semantics", () => {
  assert.match(mixColorGlsl("MIX"), /mix\(a, b, factor\)/);
  assert.match(mixColorGlsl("MULTIPLY"), /mix\(a, a \* b, factor\)/);
  assert.match(mixColorGlsl("OVERLAY"), /step\(vec3\(0\.5\), a\)/);
  const color = mixColorGlsl("COLOR");
  assert.match(color, /vec3\(hsvB\.xy, hsvA\.z\)/);
  assert.match(color, /mix\(a, blenderHsvToRgb/);
});

test("shares Generated-coordinate and Voronoi generators across adapters", () => {
  assert.equal(generatedCoordinateGlsl("vProbe", { min: [-1, 0, 2], max: [3, 5, 2] }),
    "vProbeGenerated = (position - vec3(-1.0, 0.0, 2.0)) / vec3(4.0, 5.0, 1e-20);");
  assert.match(voronoiGlsl({ prefix: "f1", feature: "F1" }), /z = -1; z <= 1/);
  assert.match(voronoiGlsl({ prefix: "smooth", feature: "SMOOTH_F1" }), /z = -2; z <= 2/);
});
