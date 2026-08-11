import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Field, type Vec3 } from "./core";
import { MISSING, REGISTRY, type EvalAPI } from "./registry";
import { VECTOR_MATH_OPS } from "./nodes/math";
import { Geometry } from "./geometry";
import "./index";

const mathSource = await readFile(fileURLToPath(new URL("./nodes/math.ts", import.meta.url)), "utf8");

const vectorMathApi = (fields: Record<string, Field>, operation: string): EvalAPI => ({
  node: { name: "Vector Math", type: "ShaderNodeVectorMath", label: null, inputs: [], outputs: [] },
  input: (name) => fields[name],
  inputs: () => [],
  geoInputs: () => [],
  geo: () => new Geometry(),
  field: (name) => fields[name] ?? Field.of(0),
  num: () => 0,
  vec: () => [0, 0, 0],
  bool: () => false,
  str: () => "",
  ref: () => null,
  prop: (name, fallback) => (name === "operation" ? operation : fallback) as never,
  resolve: () => [],
});

const refract = (incident: Vec3, normal: Vec3, ior: number): number[] => {
  const handler = REGISTRY.get("ShaderNodeVectorMath");
  assert.ok(handler);
  const result = handler(vectorMathApi({
    Vector: Field.of(incident),
    Vector_001: Field.of(normal),
    Scale: Field.of(ior),
  }, "REFRACT")).Vector as Field;
  return result.value as number[];
};

const close = (actual: number[], expected: number[], epsilon = 1e-5): void => {
  assert.equal(actual.length, expected.length);
  for (const [index, value] of expected.entries()) {
    assert.ok(Math.abs(actual[index] - value) < epsilon, `component ${index}: ${actual[index]} vs ${value}`);
  }
};

/**
 * The bug this file exists for: `VECTOR_MATH_OPS` is the set the `default`
 * branch consults before recording a miss, so an operation listed there without
 * a `case` is the one failure mode the miss counter cannot report — it passes
 * Vector A straight out and says nothing. REFRACT was in that state.
 */
test("every operation Vector Math claims to support has a case in its switch", () => {
  const start = mathSource.indexOf('reg("ShaderNodeVectorMath"');
  assert.ok(start > 0, "math.ts must register ShaderNodeVectorMath");
  const end = mathSource.indexOf("\nreg(", start + 1);
  // Bounded to this registration: a `case "WRAP"` in a neighbouring handler
  // would otherwise read as coverage this one does not have.
  const handler = mathSource.slice(start, end < 0 ? undefined : end);
  const implemented = new Set([...handler.matchAll(/case "([A-Z_0-9]+)":/g)].map((match) => match[1]));
  const claimed = [...VECTOR_MATH_OPS].filter((op) => !implemented.has(op));
  assert.deepEqual(claimed, [], "listed in VECTOR_MATH_OPS with no case: these fall through silently");
});

test("Refract follows Blender's math::refract rather than passing the incident through", () => {
  const diagonal: Vec3 = [Math.SQRT1_2, -Math.SQRT1_2, 0];
  const up: Vec3 = [0, 1, 0];

  // Straight on, any IOR: the ray does not bend.
  close(refract([0, -1, 0], up, 0.5), [0, -1, 0]);

  // 45° into a denser medium (eta 0.5): Snell's law puts the tangential
  // component at eta * sin(theta), and the result stays unit length.
  const bent = refract(diagonal, up, 0.5);
  close(bent, [0.5 * Math.SQRT1_2, -Math.sqrt(1 - 0.125), 0]);
  assert.ok(Math.abs(Math.hypot(...bent) - 1) < 1e-5);

  // The regression itself: the old `default` branch returned Vector A verbatim.
  assert.notDeepEqual(bent.map((part) => Number(part.toFixed(4))), diagonal.map((part) => Number(part.toFixed(4))));

  // Total internal reflection (k < 0) is the zero vector, as in GLSL refract.
  close(refract(diagonal, up, 2), [0, 0, 0]);

  // The normal is normalized first, so its length cannot change the answer.
  close(refract(diagonal, [0, 4, 0], 0.5), bent as Vec3);
});

test("an operation outside the supported set still records a miss", () => {
  MISSING.delete("ShaderNodeVectorMath:WRAP");
  const handler = REGISTRY.get("ShaderNodeVectorMath");
  assert.ok(handler);
  const incident: Vec3 = [1, 2, 3];
  const result = handler(vectorMathApi({
    Vector: Field.of(incident),
    Vector_001: Field.of([0, 1, 0] as Vec3),
    Scale: Field.of(1),
  }, "WRAP")).Vector as Field;
  assert.deepEqual(result.value, incident);
  assert.equal(MISSING.get("ShaderNodeVectorMath:WRAP"), 1);
});
