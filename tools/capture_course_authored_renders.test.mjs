import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCourseEvidence,
  inspectPngHeader,
  parseArguments,
  parseBrowserCapture,
  parseCountLabel,
  selectEntries,
  upsertLastTopLevelProperty,
  validateManifest,
} from "./capture_course_authored_renders.mjs";

const asset = {
  id: "course-example",
  object: "Example",
  dump: "dojo/course-modules/example/dump.json",
  reference: "dojo/references/course-modules/example.png",
  blenderStats: { verts: 48, faces: 38 },
};

test("validates complete, unique course manifests and filters requested ids", () => {
  const entries = validateManifest({
    version: 1,
    assets: [{ id: asset.id, sourceProject: "intro-module" }],
  }, [asset]);
  assert.equal(entries[0].asset, asset);
  assert.deepEqual(selectEntries(entries, [asset.id]).map((entry) => entry.id), [asset.id]);
  assert.throws(() => selectEntries(entries, ["course-missing"]), /unknown course asset/);
  assert.throws(() => validateManifest({
    version: 1,
    assets: [
      { id: asset.id, sourceProject: "intro-module" },
      { id: asset.id, sourceProject: "intro-module" },
    ],
  }, [asset]), /duplicate/);
});

test("parses CLI, PNG headers, browser capture records, and count labels", () => {
  assert.deepEqual(parseArguments([
    "--base-url", "http://127.0.0.1:5179",
    "--asset", asset.id,
    "--dry-run",
  ]), {
    baseUrl: "http://127.0.0.1:5179",
    requestedIds: [asset.id],
    dryRun: true,
  });
  const png = Buffer.alloc(29);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  png.writeUInt32BE(768, 16);
  png.writeUInt32BE(768, 20);
  png[24] = 8;
  png[25] = 6;
  assert.deepEqual(inspectPngHeader(png), {
    width: 768,
    height: 768,
    bitDepth: 8,
    colorType: 6,
    hasAlphaChannel: true,
  });
  assert.deepEqual(parseCountLabel("104,454 verts · 44,423 faces"), {
    verts: 104454,
    faces: 44423,
  });
  assert.equal(parseBrowserCapture(
    'AUTHORED_ASSET_WEB_REFERENCE {"readiness":"exact","count":"48 verts · 38 faces"}\n',
  ).readiness, "exact");
});

test("accepts only count-exact, alpha-backed, sufficiently aligned captures", () => {
  const input = {
    asset,
    browser: { readiness: "exact", count: "48 verts · 38 faces" },
    browserReference: "public/browser.png",
    comparisonReport: "public/comparison.json",
    capture: {
      resolution: [768, 768],
      previewMode: "workbench",
      lightScale: 1,
      temporalSamples: null,
      backgroundHex: "ff00ff",
      minimumValidSurfaceMaskIoU: 0.5,
    },
    comparisonPayload: {
      captures: { blender_alpha_gt_0_5_surface_pixels: 1000 },
      comparison: {
        surface_mask_iou: 0.9,
        surface_mask_iou_dilated_1px: 0.95,
        surface_corner_rmse_pixels: 0.2,
        blender_surface_covered_within_1px_fraction: 1,
        webgl_surface_covered_within_1px_fraction: 1,
        pixel_rgb_mae: 0.1,
        pixel_luminance_mae: 0.1,
        pixel_luminance_correlation: 0.8,
        binary_mask_disagreement_fraction: 0.2,
        macro_luminance_mae: 0.05,
        macro_luminance_correlation: 0.9,
        mean_luminance_delta: -0.02,
      },
    },
  };
  const valid = buildCourseEvidence(input);
  assert.equal(valid.valid, true);
  assert.equal(valid.validation.countMatch, true);
  assert.equal(buildCourseEvidence({
    ...input,
    browser: { readiness: "inexact", count: "48 verts · 38 faces" },
  }).valid, false);
  const misplaced = buildCourseEvidence({
    ...input,
    comparisonPayload: {
      ...input.comparisonPayload,
      comparison: { ...input.comparisonPayload.comparison, surface_mask_iou: 0.49 },
    },
  });
  assert.equal(misplaced.valid, false);
  assert.equal(misplaced.validation.surfacePlacementAligned, false);
});

test("updates only the owned final status property without reformatting existing JSON", () => {
  const source = '{\n  "bbox": {"min": [0, 0, 0], "max": [1, 1, 1]},\n  "status": "exact"\n}\n';
  const first = upsertLastTopLevelProperty(source, "workbenchRender", { valid: true });
  assert.match(first, /"bbox": \{"min": \[0, 0, 0\], "max": \[1, 1, 1\]\}/);
  assert.deepEqual(JSON.parse(first).workbenchRender, { valid: true });
  const second = upsertLastTopLevelProperty(first, "workbenchRender", { valid: false });
  assert.deepEqual(JSON.parse(second).workbenchRender, { valid: false });
  assert.equal(second.match(/"workbenchRender"/g)?.length, 1);
});
