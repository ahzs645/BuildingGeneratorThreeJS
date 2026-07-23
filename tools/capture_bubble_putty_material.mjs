import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const baseUrl = process.argv[2] ?? "http://127.0.0.1:5173";
const referenceDirectory = path.join(root, "public/dojo/references/joints");
const reportDirectory = path.join(root, "public/dojo/joints/bubble-putty");
const blenderImage = path.join(referenceDirectory, "bubble-putty-authored.png");
const blenderMetadata = path.join(referenceDirectory, "bubble-putty-authored.json");
const browserImage = path.join(referenceDirectory, "bubble-putty-authored-webgl.png");
const comparisonReport = path.join(reportDirectory, "material-comparison.json");
const parityReport = path.join(reportDirectory, "material-parity.json");

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
fs.mkdirSync(reportDirectory, { recursive: true });

run(process.execPath, [
  "tools/materialx/run_node_dojo_blender.mjs",
  "joint-generators",
  "tools/render_blender_reference.py",
  "--",
  "PUTTY.002",
  blenderImage,
  blenderMetadata,
], {
  NODE_DOJO_OVERRIDES: JSON.stringify({ "finalize for export": true }),
  NODE_DOJO_FREEZE_EVALUATED_MESH: "1",
  NODE_DOJO_AUTHORED_MATERIAL: "1",
  NODE_DOJO_AUTHORED_LIGHT_SCALE: "0",
  NODE_DOJO_STUDIO_ENVIRONMENT: "1",
  NODE_DOJO_STUDIO_ENVIRONMENT_STRENGTH: "1",
});

const browserOutput = run(process.execPath, [
  "tools/capture_authored_asset.mjs",
  baseUrl,
  "joint-bubble-putty",
  browserImage,
]);

run(process.execPath, [
  "tools/materialx/run_node_dojo_blender.mjs",
  "joint-generators",
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
const report = {
  updated: "2026-07-23",
  asset: "joint-bubble-putty",
  object: "PUTTY.002",
  root: "Bubble Putty Generator_9OCT2024_01",
  scope: "Blender Eevee versus the browser reconstruction of the supplied Filament and Cross Section material on the same finalized evaluated surface.",
  capture: {
    resolution: [768, 768],
    camera: "square orthographic, direction [1,-1.25,0.85], frame scale 1.45",
    geometry: "Authored world transform; Blender evaluated mesh frozen before render because the source dependency cycle changes on a second render-time evaluation.",
    overrides: { "finalize for export": true },
    studioEnvironmentStrength: 1,
    browserEnvironmentIntensity: 1,
    browserEnvironmentRotation: Math.PI,
    blenderReference: "../../references/joints/bubble-putty-authored.png",
    browserReference: "../../references/joints/bubble-putty-authored-webgl.png",
    comparisonReport: "material-comparison.json",
  },
  geometry: {
    blender: { verts: blender.verts, polygons: blender.faces, triangles: 6608 },
    browser: { verts: 3302, triangles: 6608 },
    bidirectionalSurfaceError: 0,
    surfaceMaskIoU: comparison.surface_mask_iou,
    blenderSurfaceCoveredWithin1px: comparison.blender_surface_covered_within_1px_fraction,
    browserSurfaceCoveredWithin1px: comparison.webgl_surface_covered_within_1px_fraction,
  },
  material: {
    name: "Filament and Cross Section 1OCT2024",
    blenderFaceAssignments: blender.evaluated_material_faces,
    pointAttributes: {
      col: [0.0008284280193038285, 0.8002511262893677, 0],
      layer: 1.5015965700149536,
      rough: 0.48828125,
    },
    browserReadiness: browser?.readiness ?? null,
    browserCount: browser?.count ?? null,
    appearance: {
      macroLuminanceCorrelation: comparison.macro_luminance_correlation,
      macroLuminanceMae: comparison.macro_luminance_mae,
      pixelLuminanceMae: comparison.pixel_luminance_mae,
      meanLuminanceDelta: comparison.mean_luminance_delta,
    },
  },
  interpretation: "The generated mesh is the design surface. The layer-line look is the authored procedural viewport material on that unchanged mesh, not a slicer result, toolpath, or source G-code. Eevee and Three.js retain renderer-specific high-frequency bump and reflection differences.",
};
fs.writeFileSync(parityReport, `${JSON.stringify(report, null, 2)}\n`);
console.log(`BUBBLE_PUTTY_MATERIAL_CAPTURE ${JSON.stringify(report)}`);
