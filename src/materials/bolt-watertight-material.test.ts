import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const readJson = (path: string): any => JSON.parse(fs.readFileSync(
  new URL(`../../${path}`, import.meta.url),
  "utf8",
));

test("Watertight Bolt preserves its unassigned Blender surface and native variance evidence", () => {
  const catalog = readJson("public/dojo/chrome-assets/catalog.json");
  const asset = catalog.find((entry: { id: string }) => entry.id === "n03d-bolt-watertight");
  assert.equal(asset.authoredReference, "dojo/references/n03d/bolt-watertight-shader.png");
  assert.equal(asset.authoredLightScale, 7.5);
  assert.equal(asset.authoredEnvironmentIntensity, 0.8);
  assert.match(asset.note, /no material slots/);

  const evidence = readJson("public/dojo/n03d/bolt-watertight/material-parity.json");
  assert.equal(evidence.source.material, null);
  assert.equal(evidence.surface.borrowedFilamentShader, false);
  assert.deepEqual(evidence.geometry.currentCleanGnvm, {
    commit: "53e699a",
    verts: 16_230,
    faces: 16_232,
    cliEvaluationMs: 257_978,
  });
  assert.deepEqual(evidence.geometry.browserCaptureCheckpoint, {
    commit: "6e7ebd1",
    verts: 16_284,
    faces: 16_286,
    matchingBrowserRuns: 2,
    cliEvaluationMs: 384_412,
  });
  assert.match(evidence.geometry.interpretation, /predates the current/);
  assert.ok(evidence.comparison.surfaceMaskIou > 0.96);
  assert.ok(evidence.comparison.pixelLuminanceCorrelation > 0.78);
  assert.ok(evidence.comparison.macroLuminanceCorrelation > 0.86);

  const blender = readJson("public/dojo/references/n03d/bolt-watertight-shader.json");
  assert.deepEqual(blender.evaluated_material_faces, { "<none>": blender.faces });
  assert.equal(blender.zero_location, true);
  assert.equal(blender.frozen_evaluated_mesh, true);
  assert.ok(blender.verts >= 16_526 && blender.verts <= 16_598);
  assert.ok(fs.statSync(
    new URL("../../public/dojo/references/n03d/bolt-watertight-shader.png", import.meta.url),
  ).size > 100_000);
  assert.ok(fs.statSync(
    new URL("../../public/dojo/references/n03d/bolt-watertight-shader-webgl.png", import.meta.url),
  ).size > 100_000);
});

test("Watertight Bolt comparison records appearance without claiming topology identity", () => {
  const comparison = readJson("public/dojo/n03d/bolt-watertight/material-comparison.json");
  assert.equal(comparison.captures.blender, "bolt-watertight-shader.png");
  assert.equal(comparison.captures.webgl, "bolt-watertight-shader-webgl.png");
  assert.ok(comparison.comparison.surface_mask_iou > 0.96);
  assert.ok(comparison.comparison.pixel_luminance_correlation > 0.78);
  assert.match(comparison.interpretation, /does not imply exact Eevee pixels|Renderer lighting|renderer/i);
});
