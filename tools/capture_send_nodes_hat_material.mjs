import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const baseUrl = process.argv[2] ?? "http://127.0.0.1:5173";
const referenceDirectory = path.join(root, "public/dojo/references/send-nodes-hat");
const reportDirectory = path.join(root, "public/dojo/send-nodes-hat");
const blenderImage = path.join(referenceDirectory, "embroidery-authored.png");
const blenderMetadata = path.join(referenceDirectory, "embroidery-authored.json");
const browserImage = path.join(referenceDirectory, "embroidery-authored-webgl.png");
const comparisonReport = path.join(reportDirectory, "embroidery-material-comparison.json");

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

function runWithRetry(command, args, env = {}, attempts = 3) {
  let error;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return run(command, args, env);
    } catch (caught) {
      error = caught;
      if (attempt === attempts) break;
      process.stderr.write(`Retrying Hat browser capture after attempt ${attempt}/${attempts} failed\n`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 1000);
    }
  }
  throw error;
}

fs.mkdirSync(referenceDirectory, { recursive: true });
fs.mkdirSync(reportDirectory, { recursive: true });

run(process.execPath, [
  "tools/materialx/run_node_dojo_blender.mjs",
  "send-nodes-hat",
  "tools/render_blender_reference.py",
  "--",
  "embroidery crv",
  blenderImage,
  blenderMetadata,
  "LOCAL",
], {
  NODE_DOJO_FREEZE_HAT_FRONT: "1",
  NODE_DOJO_GN_ONLY: "1",
  NODE_DOJO_AUTHORED_MATERIAL: "1",
  NODE_DOJO_STUDIO_ENVIRONMENT: "1",
  NODE_DOJO_STUDIO_ENVIRONMENT_STRENGTH: "0.8",
});

const browserOutput = runWithRetry(process.execPath, [
  "tools/capture_authored_asset.mjs",
  baseUrl,
  "send-nodes-hat-embroidery",
  browserImage,
  "1",
  "authored",
]);

run(process.execPath, [
  "tools/materialx/run_node_dojo_blender.mjs",
  "send-nodes-hat",
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
const result = {
  blender: {
    verts: blender.verts,
    faces: blender.faces,
    bbox: blender.bbox,
    studioEnvironmentStrength: blender.studio_environment_strength,
  },
  browser: {
    readiness: browser?.readiness ?? null,
    count: browser?.count ?? null,
    studioEnvironmentIntensity: 32,
  },
  comparison: {
    surfaceMaskIoU: comparison.surface_mask_iou,
    surfaceCornerRmsePixels: comparison.surface_corner_rmse_pixels,
    pixelLuminanceMae: comparison.pixel_luminance_mae,
    macroLuminanceMae: comparison.macro_luminance_mae,
    meanLuminanceDelta: comparison.mean_luminance_delta,
    macroLuminanceCorrelation: comparison.macro_luminance_correlation,
  },
};
console.log(`SEND_NODES_HAT_MATERIAL_CAPTURE ${JSON.stringify(result)}`);
