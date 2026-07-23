import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const baseUrl = process.argv[2] ?? "http://127.0.0.1:5173";
const referenceDirectory = path.join(root, "public/dojo/references/nodes-node");
const reportDirectory = path.join(root, "public/dojo/nodes-node");
const reportPath = path.join(reportDirectory, "authored-material-parity.json");
const variants = [
  {
    id: "nodes-node-base-plate",
    object: "Plane",
    slug: "plane",
    material: "node base.001 + grid dots",
    browserLightScale: 1,
  },
  {
    id: "nodes-node-noodle-pair",
    object: "Point.001",
    slug: "point-001",
    material: "node color.geometry",
    browserLightScale: 6.6,
  },
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
  });

  const browserOutput = run(process.execPath, [
    "tools/capture_authored_asset.mjs",
    baseUrl,
    variant.id,
    browserImage,
    String(variant.browserLightScale),
    "authored",
  ]);

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
    material: variant.material,
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
      lightScale: variant.browserLightScale,
    },
    comparison: {
      surfaceMaskIoU: comparison.surface_mask_iou,
      surfaceMaskIoUDilated1px: comparison.surface_mask_iou_dilated_1px,
      blenderSurfaceCoveredWithin1px: comparison.blender_surface_covered_within_1px_fraction,
      browserSurfaceCoveredWithin1px: comparison.webgl_surface_covered_within_1px_fraction,
      pixelLuminanceMae: comparison.pixel_luminance_mae,
      macroLuminanceMae: comparison.macro_luminance_mae,
      macroLuminanceCorrelation: comparison.macro_luminance_correlation,
      meanLuminanceDelta: comparison.mean_luminance_delta,
    },
  });
}

const report = {
  updated: "2026-07-23",
  scope: "Blender Eevee versus the browser reconstructions of the authored Nodes Node base-plate and noodle materials on exact GN-VM geometry.",
  capture: {
    resolution: [768, 768],
    camera: "square orthographic, direction [1,-1.25,0.85], frame scale 1.45",
    geometry: "Geometry Nodes only, local object transform",
    blenderLighting: "shared two-area-light authored rig",
  },
  variants: results,
  interpretation: "The graph topology, extracted material constants, scalar procedural fields, material ownership, and geometry are tested separately from renderer pixels. Three.js lighting and screen-derivative bump filtering remain disclosed Eevee residuals.",
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`NODES_NODE_MATERIAL_CAPTURE ${JSON.stringify(report)}`);
