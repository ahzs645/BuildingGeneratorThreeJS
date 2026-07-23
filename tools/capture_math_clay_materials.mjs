import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const baseUrl = process.argv[2] ?? "http://127.0.0.1:5173";
const requestedIds = new Set(process.argv.slice(3));
const catalogPath = path.join(root, "public/dojo/chrome-assets/catalog.json");
const outputDirectory = path.join(root, "public/dojo/references/math-clay");
const reportPath = path.join(root, "public/dojo/math-clay/material-parity-all.json");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const assets = catalog.filter((asset) => (
  asset.dump === "dojo/math-clay/dump.json"
  && (!requestedIds.size || requestedIds.has(asset.id))
));

if (!assets.length) {
  throw new Error(`No Math Clay assets matched: ${[...requestedIds].join(", ") || "(all)"}`);
}

const browserLightScale = 0.62;
const blenderReferenceRadius = 11.06;

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
      process.stderr.write(
        `Retrying ${path.basename(args[0] ?? command)} after attempt ${attempt}/${attempts} failed\n`,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 1000);
    }
  }
  throw error;
}

function boundsRadius(metadata) {
  const size = metadata.bbox.max.map((value, index) => value - metadata.bbox.min[index]);
  return Math.max(Math.hypot(...size) * 0.5, 0.5);
}

const prior = fs.existsSync(reportPath)
  ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
  : { updated: null, browserLightScale, blenderReferenceRadius, variants: [] };
const variants = new Map((prior.variants ?? []).map((variant) => [variant.id, variant]));

for (const asset of assets) {
  const slug = asset.id.replace(/^math-clay-/, "");
  const geometryMetadataPath = path.join(
    root,
    `public/dojo/math-clay/references/math-${slug}-blender.json`,
  );
  const geometryMetadata = JSON.parse(fs.readFileSync(geometryMetadataPath, "utf8"));
  const radius = boundsRadius(geometryMetadata);
  const blenderLightScale = (radius / blenderReferenceRadius) ** 2;
  const blenderImage = path.join(outputDirectory, `${slug}-authored.png`);
  const blenderMetadata = path.join(outputDirectory, `${slug}-authored.json`);
  const browserImage = path.join(outputDirectory, `${slug}-authored-webgl.png`);
  const comparisonPath = path.join(
    root,
    `public/dojo/math-clay/${slug}-material-comparison.json`,
  );

  run(process.execPath, [
    "tools/materialx/run_node_dojo_blender.mjs",
    "math-clay",
    "tools/render_blender_reference.py",
    "--",
    asset.object,
    blenderImage,
    blenderMetadata,
    "LOCAL",
  ], {
    NODE_DOJO_GN_ONLY: "1",
    NODE_DOJO_AUTHORED_MATERIAL: "1",
    NODE_DOJO_AUTHORED_LIGHT_SCALE: String(blenderLightScale),
  });

  const browserOutput = runWithRetry(process.execPath, [
    "tools/capture_authored_asset.mjs",
    baseUrl,
    asset.id,
    browserImage,
    String(browserLightScale),
    "authored",
  ]);

  run(process.execPath, [
    "tools/materialx/run_node_dojo_blender.mjs",
    "math-clay",
    "tools/compare_stippler_shader_masks.py",
    "--",
    blenderImage,
    browserImage,
    comparisonPath,
  ]);

  const blender = JSON.parse(fs.readFileSync(blenderMetadata, "utf8"));
  const comparison = JSON.parse(fs.readFileSync(comparisonPath, "utf8")).comparison;
  const readinessMatch = browserOutput.match(/AUTHORED_ASSET_WEB_REFERENCE (\{.+\})/);
  const browser = readinessMatch ? JSON.parse(readinessMatch[1]) : null;
  const variant = {
    id: asset.id,
    object: asset.object,
    blenderReference: `../references/math-clay/${slug}-authored.png`,
    blenderMetadata: `../references/math-clay/${slug}-authored.json`,
    browserReference: `../references/math-clay/${slug}-authored-webgl.png`,
    comparisonReport: `${slug}-material-comparison.json`,
    blenderLightScale,
    browserLightScale,
    blender: {
      verts: blender.verts,
      faces: blender.faces,
      evaluatedMaterialFaces: blender.evaluated_material_faces,
    },
    browser: {
      readiness: browser?.readiness ?? null,
      count: browser?.count ?? null,
    },
    comparison: {
      surfaceMaskIoU: comparison.surface_mask_iou,
      surfaceCornerRmsePixels: comparison.surface_corner_rmse_pixels,
      pixelLuminanceMae: comparison.pixel_luminance_mae,
      pixelLuminanceCorrelation: comparison.pixel_luminance_correlation,
      binaryMaskDisagreementFraction: comparison.binary_mask_disagreement_fraction,
      macroLuminanceMae: comparison.macro_luminance_mae,
      macroLuminanceCorrelation: comparison.macro_luminance_correlation,
      blackFractionDelta: comparison.black_fraction_delta,
      meanLuminanceDelta: comparison.mean_luminance_delta,
    },
  };
  variants.set(asset.id, variant);
  console.log(`MATH_CLAY_MATERIAL_CAPTURE ${JSON.stringify(variant)}`);
}

const report = {
  updated: (() => {
    const now = new Date();
    return [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
  })(),
  scope: "Authored Eevee material versus the reusable browser material implementation on every cataloged Math Clay generator.",
  capture: {
    resolution: [768, 768],
    camera: "square orthographic, direction [1,-1.25,0.85], frame scale 1.45",
    geometry: "Geometry Nodes only, local object transform",
    browserRoute: "/chrome-assets?asset=<id>&capture=authored&lightScale=0.62&preview=authored",
  },
  lighting: {
    browserLightScale,
    blenderReferenceRadius,
    blenderScaleRule: "(evaluated bounds radius / 11.06)^2, compensating Blender Area light power for the shared radius-scaled rig",
  },
  variants: catalog
    .filter((asset) => asset.dump === "dojo/math-clay/dump.json")
    .map((asset) => variants.get(asset.id))
    .filter(Boolean),
  interpretation: "Each comparison measures the same extracted Filament and Cross Section shader implementation on a distinct evaluated surface. Geometry and camera alignment are reported separately from luminance parity. Eevee/Three high-frequency procedural filtering remains a renderer residual and is not labeled exact.",
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`MATH_CLAY_MATERIAL_REPORT ${reportPath}`);
