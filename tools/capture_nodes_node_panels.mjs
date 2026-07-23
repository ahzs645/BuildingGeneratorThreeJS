import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const baseUrl = process.argv[2] ?? "http://127.0.0.1:5173";
const referenceDirectory = path.join(root, "public/dojo/references/nodes-node");
const reportDirectory = path.join(root, "public/dojo/nodes-node");
const reportPath = path.join(reportDirectory, "panel-authored-material-parity.json");
const fontOverride = path.join(root, "public/dojo/fonts/DejaVuSans-ExtraLight.ttf");
const variants = [
  { id: "nodes-node-noodle-segment", object: "Cube.001", slug: "cube-001", lightScale: 6.6, ambientIntensity: 0, samples: null },
  { id: "nodes-node-full-panel", object: "Cube", slug: "cube", lightScale: 8, ambientIntensity: 0.5, samples: 64 },
  { id: "nodes-node-group-output", object: "Cube.006", slug: "cube-006", lightScale: 4, ambientIntensity: 3.2, samples: 64 },
  { id: "nodes-node-group-io", object: "Cube.007", slug: "cube-007", lightScale: 4, ambientIntensity: 3.2, samples: 64 },
  { id: "nodes-node-selection-bar", object: "Cube.005", slug: "cube-005", lightScale: 4, ambientIntensity: 3.2, samples: 64 },
  { id: "nodes-node-checkbox-panel", object: "Cube.004", slug: "cube-004", lightScale: 4, ambientIntensity: 3.2, samples: 64 },
  { id: "nodes-node-dual-input-bar", object: "Cube.003", slug: "cube-003", lightScale: 4, ambientIntensity: 3.2, samples: 64 },
];

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

fs.mkdirSync(referenceDirectory, { recursive: true });
const results = [];
for (const variant of variants) {
  const blenderImage = path.join(referenceDirectory, `${variant.slug}-authored.png`);
  const blenderMetadata = path.join(referenceDirectory, `${variant.slug}-authored.json`);
  const browserImage = path.join(referenceDirectory, `${variant.slug}-authored-webgl.png`);
  const comparisonReport = path.join(reportDirectory, `${variant.slug}-material-comparison.json`);

  run(process.execPath, [
    "tools/materialx/run_node_dojo_blender.mjs",
    "nodes-node",
    "tools/render_blender_reference.py",
    "--",
    variant.object,
    blenderImage,
    blenderMetadata,
    "LOCAL",
  ], {
    NODE_DOJO_GN_ONLY: "1",
    NODE_DOJO_AUTHORED_MATERIAL: "1",
    NODE_DOJO_FONT_OVERRIDE: fontOverride,
  });

  const browserOutput = run(process.execPath, [
    "tools/capture_authored_asset.mjs",
    baseUrl,
    variant.id,
    browserImage,
    String(variant.lightScale),
    "authored",
  ], variant.samples === null ? {} : {
    NODE_DOJO_CAPTURE_SAMPLES: String(variant.samples),
  });

  run(process.execPath, [
    "tools/materialx/run_node_dojo_blender.mjs",
    "nodes-node",
    "tools/compare_stippler_shader_masks.py",
    "--",
    blenderImage,
    browserImage,
    comparisonReport,
  ]);

  const blender = JSON.parse(fs.readFileSync(blenderMetadata, "utf8"));
  const comparison = JSON.parse(fs.readFileSync(comparisonReport, "utf8")).comparison;
  const readinessMatch = browserOutput.match(/AUTHORED_ASSET_WEB_REFERENCE (\{.+\})/);
  const browser = readinessMatch ? JSON.parse(readinessMatch[1]) : null;
  results.push({
    id: variant.id,
    object: variant.object,
    blenderReference: `../references/nodes-node/${variant.slug}-authored.png`,
    blenderMetadata: `../references/nodes-node/${variant.slug}-authored.json`,
    browserReference: `../references/nodes-node/${variant.slug}-authored-webgl.png`,
    comparisonReport: `${variant.slug}-material-comparison.json`,
    blender: {
      verts: blender.verts,
      faces: blender.faces,
      evaluatedMaterialFaces: blender.evaluated_material_faces,
    },
    browser: {
      readiness: browser?.readiness ?? null,
      count: browser?.count ?? null,
      lightScale: variant.lightScale,
      ambientIntensity: variant.ambientIntensity,
      temporalSamples: variant.samples,
    },
    comparison: {
      surfaceMaskIoU: comparison.surface_mask_iou,
      surfaceMaskIoUDilated1px: comparison.surface_mask_iou_dilated_1px,
      blenderSurfaceCoveredWithin1px: comparison.blender_surface_covered_within_1px_fraction,
      browserSurfaceCoveredWithin1px: comparison.webgl_surface_covered_within_1px_fraction,
      pixelLuminanceMae: comparison.pixel_luminance_mae,
      pixelLuminanceCorrelation: comparison.pixel_luminance_correlation,
      macroLuminanceMae: comparison.macro_luminance_mae,
      macroLuminanceCorrelation: comparison.macro_luminance_correlation,
      meanLuminanceDelta: comparison.mean_luminance_delta,
    },
  });
}

const report = {
  updated: "2026-07-23",
  scope: "Controlled Blender Eevee versus browser captures for the remaining surfaced Nodes Node roots.",
  capture: {
    resolution: [768, 768],
    camera: "square orthographic, direction [1,-1.25,0.85], frame scale 1.45",
    geometry: "Geometry Nodes only, local object transform",
    font: "DejaVuSans-ExtraLight.ttf is injected into the supplied missing matching font sockets in Blender; the browser uses the committed Blender-evaluated outline atlas.",
    blenderLighting: "shared two-area-light authored rig",
    panelTemporalResolve: "64-sample Eevee-style Blackman-Harris jitter; the noodle segment uses a single thin-surface sample to avoid presentation blur.",
  },
  variants: results,
  interpretation: "Geometry, material ownership, recovered glyph outlines, scalar material contracts, and renderer pixels are reported separately. The browser's magenta capture key is excluded from every metric. Exact material ownership does not imply exact Eevee pixels: Three.js lighting, bump derivatives, and view transform remain measured renderer residuals.",
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`NODES_NODE_PANEL_CAPTURE ${JSON.stringify(report)}`);
