import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const COURSE_PREFIX = "course-";

export function parseArguments(argv) {
  const result = {
    baseUrl: "http://127.0.0.1:5173",
    requestedIds: [],
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--base-url") {
      const value = argv[index += 1];
      if (!value) throw new Error("--base-url requires a value");
      result.baseUrl = value;
    } else if (argument === "--asset") {
      const value = argv[index += 1];
      if (!value) throw new Error("--asset requires an id");
      result.requestedIds.push(value);
    } else if (argument === "--dry-run") {
      result.dryRun = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return result;
}

function integer(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

export function validateManifest(manifest, catalog) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.assets)) {
    throw new Error("course authored-render manifest must be version 1 with an assets array");
  }
  const catalogCourses = catalog.filter((asset) => asset.id.startsWith(COURSE_PREFIX));
  const catalogById = new Map(catalogCourses.map((asset) => [asset.id, asset]));
  const seen = new Set();
  const entries = manifest.assets.map((entry) => {
    if (!entry || typeof entry.id !== "string" || typeof entry.sourceProject !== "string") {
      throw new Error("each course render entry requires id and sourceProject");
    }
    if (seen.has(entry.id)) throw new Error(`duplicate course render entry: ${entry.id}`);
    seen.add(entry.id);
    const asset = catalogById.get(entry.id);
    if (!asset) throw new Error(`course render entry is absent from the catalog: ${entry.id}`);
    if (!asset.reference?.endsWith(".png")) throw new Error(`course Blender reference must be PNG: ${entry.id}`);
    integer(asset.blenderStats?.verts, `${entry.id} Blender verts`);
    integer(asset.blenderStats?.faces, `${entry.id} Blender faces`);
    if (asset.blenderStats.triangles !== undefined) {
      integer(asset.blenderStats.triangles, `${entry.id} Blender triangles`);
    }
    return { ...entry, asset };
  });
  const missing = catalogCourses.filter((asset) => !seen.has(asset.id)).map((asset) => asset.id);
  if (missing.length) throw new Error(`manifest omits course catalog entries: ${missing.join(", ")}`);
  return entries;
}

export function selectEntries(entries, requestedIds) {
  if (!requestedIds.length) return entries;
  const requested = new Set(requestedIds);
  const selected = entries.filter((entry) => requested.has(entry.id));
  const missing = [...requested].filter((id) => !entries.some((entry) => entry.id === id));
  if (missing.length) throw new Error(`unknown course asset id: ${missing.join(", ")}`);
  return selected;
}

export function inspectPngHeader(buffer, label = "PNG") {
  const signature = "89504e470d0a1a0a";
  if (buffer.length < 29 || buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error(`${label} is not a PNG`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  return {
    width,
    height,
    bitDepth,
    colorType,
    hasAlphaChannel: colorType === 4 || colorType === 6,
  };
}

export function parseBrowserCapture(output) {
  const match = output.match(/AUTHORED_ASSET_WEB_REFERENCE (\{.+\})/);
  if (!match) throw new Error("browser capture did not emit AUTHORED_ASSET_WEB_REFERENCE");
  return JSON.parse(match[1]);
}

export function parseCountLabel(label) {
  const match = String(label ?? "").match(/([\d,]+) verts · ([\d,]+) faces/);
  if (!match) return null;
  return {
    verts: Number(match[1].replaceAll(",", "")),
    faces: Number(match[2].replaceAll(",", "")),
  };
}

export function buildCourseEvidence({
  asset,
  browser,
  comparisonPayload,
  browserReference,
  comparisonReport,
  capture,
}) {
  const metrics = comparisonPayload.comparison;
  const alphaSurfacePixels = comparisonPayload.captures?.blender_alpha_gt_0_5_surface_pixels;
  const totalPixels = capture.resolution[0] * capture.resolution[1];
  const browserCounts = parseCountLabel(browser.count);
  // The Chrome assets page's visible count is the evaluated GN-VM face count.
  // Course catalog entries intentionally store Blender polygon faces here;
  // triangle counts, when present in their status, are separate evidence.
  const expectedFaces = asset.blenderStats.faces;
  const validation = {
    topologyReady: browser.readiness === "exact",
    countMatch: browserCounts?.verts === asset.blenderStats.verts
      && browserCounts?.faces === expectedFaces,
    alphaBackedReference: Number.isInteger(alphaSurfacePixels)
      && alphaSurfacePixels > 0
      && alphaSurfacePixels < totalPixels,
    comparableSurfaceMask: Number.isFinite(metrics?.surface_mask_iou),
    minimumSurfaceMaskIoU: capture.minimumValidSurfaceMaskIoU,
    surfacePlacementAligned: Number.isFinite(metrics?.surface_mask_iou)
      && metrics.surface_mask_iou >= capture.minimumValidSurfaceMaskIoU,
  };
  const valid = validation.topologyReady
    && validation.countMatch
    && validation.alphaBackedReference
    && validation.comparableSurfaceMask
    && validation.surfacePlacementAligned;
  return {
    status: valid ? "measured-workbench-renderer-residual" : "invalid-matched-capture",
    valid,
    validation,
    blenderReference: `public/${asset.reference}`,
    browserReference,
    comparisonReport,
    capture: {
      resolution: capture.resolution,
      previewMode: capture.previewMode,
      lightScale: capture.lightScale,
      temporalSamples: capture.temporalSamples,
      backgroundHex: capture.backgroundHex,
      browserReadiness: browser.readiness,
      browserCount: browser.count,
      blenderAlphaSurfacePixels: alphaSurfacePixels,
    },
    comparison: {
      surfaceMaskIoU: metrics.surface_mask_iou,
      surfaceMaskIoUDilated1px: metrics.surface_mask_iou_dilated_1px,
      surfaceCornerRmsePixels: metrics.surface_corner_rmse_pixels,
      blenderSurfaceCoveredWithin1px: metrics.blender_surface_covered_within_1px_fraction,
      browserSurfaceCoveredWithin1px: metrics.webgl_surface_covered_within_1px_fraction,
      pixelRgbMae: metrics.pixel_rgb_mae,
      pixelLuminanceMae: metrics.pixel_luminance_mae,
      pixelLuminanceCorrelation: metrics.pixel_luminance_correlation,
      binaryMaskDisagreementFraction: metrics.binary_mask_disagreement_fraction,
      macroLuminanceMae: metrics.macro_luminance_mae,
      macroLuminanceCorrelation: metrics.macro_luminance_correlation,
      meanLuminanceDelta: metrics.mean_luminance_delta,
    },
    interpretation: "The cataloged Blender Workbench reference and live GN-VM Workbench-approximation canvas use the same square orthographic framing. Matching topology and silhouette validate the comparison context; Blender Workbench versus Three.js lighting, cavity, shadows, color management, and raster differences remain measured rather than normalized away.",
  };
}

export function upsertLastTopLevelProperty(source, key, value) {
  JSON.parse(source);
  const marker = `\n  ${JSON.stringify(key)}: `;
  const existing = source.lastIndexOf(marker);
  const rootClose = source.lastIndexOf("\n}");
  if (rootClose < 0) throw new Error("status JSON must end with a top-level object");
  let prefix = source.slice(0, rootClose).trimEnd();
  if (existing >= 0) {
    if (existing > rootClose) throw new Error(`invalid ${key} property location`);
    // Evidence written by this tool is always the final top-level property.
    // Refuse to rewrite unfamiliar placement rather than reformatting or
    // accidentally deleting another maintainer's status fields.
    const tailObject = JSON.parse(`{${source.slice(existing + 1, rootClose)}\n}`);
    if (Object.keys(tailObject).length !== 1 || !(key in tailObject)) {
      throw new Error(`${key} must remain the final top-level status property`);
    }
    prefix = source.slice(0, existing).trimEnd();
    if (prefix.endsWith(",")) prefix = prefix.slice(0, -1).trimEnd();
  }
  const lines = JSON.stringify(value, null, 2).split("\n");
  const serialized = [
    `  ${JSON.stringify(key)}: ${lines[0]}`,
    ...lines.slice(1).map((line) => `  ${line}`),
  ].join("\n");
  return `${prefix},\n${serialized}\n}\n`;
}

function run(root, command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    process.stderr.write(output);
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
  return output;
}

function today() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

export async function main(argv = process.argv.slice(2)) {
  const root = path.resolve(import.meta.dirname, "..");
  const options = parseArguments(argv);
  const manifestPath = path.join(root, "tools/course-authored-render-manifest.json");
  const catalogPath = path.join(root, "public/dojo/chrome-assets/catalog.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const entries = selectEntries(validateManifest(manifest, catalog), options.requestedIds);
  const capture = manifest.capture;
  const reportPath = path.join(root, "public/dojo/course-audit/workbench-render-report.json");

  if (options.dryRun) {
    console.log(`COURSE_AUTHORED_RENDER_PLAN ${JSON.stringify({
      baseUrl: options.baseUrl,
      assets: entries.map((entry) => entry.id),
      capture,
    })}`);
    return;
  }

  const priorReport = fs.existsSync(reportPath)
    ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
    : { variants: [] };
  const variants = new Map((priorReport.variants ?? []).map((variant) => [variant.id, variant]));
  const failures = [];

  for (const entry of entries) {
    const { asset } = entry;
    const slug = asset.id.slice(COURSE_PREFIX.length);
    const blenderPath = path.join(root, "public", asset.reference);
    const browserPath = path.join(
      root,
      `public/dojo/references/course-modules/${slug}-workbench-webgl.png`,
    );
    const comparisonPath = path.join(
      root,
      `public/dojo/course-modules/${slug}/workbench-comparison.json`,
    );
    const browserReference = `public/dojo/references/course-modules/${slug}-workbench-webgl.png`;
    const comparisonReport = `public/dojo/course-modules/${slug}/workbench-comparison.json`;

    let candidateEvidence = null;
    try {
      const png = inspectPngHeader(fs.readFileSync(blenderPath), `${asset.id} Blender reference`);
      if (png.width !== capture.resolution[0] || png.height !== capture.resolution[1]) {
        throw new Error(`Blender reference resolution is ${png.width}x${png.height}`);
      }
      if (!png.hasAlphaChannel) throw new Error("Blender reference lacks an alpha channel");

      const captureArgs = [
        "tools/capture_authored_asset.mjs",
        options.baseUrl,
        asset.id,
        browserPath,
        String(capture.lightScale),
        capture.previewMode,
      ];
      const captureEnv = {
        NODE_DOJO_CAPTURE_BACKGROUND_HEX: capture.backgroundHex,
      };
      if (capture.temporalSamples !== null) {
        captureEnv.NODE_DOJO_CAPTURE_SAMPLES = String(capture.temporalSamples);
      }
      const browser = parseBrowserCapture(run(root, process.execPath, captureArgs, captureEnv));

      run(root, process.execPath, [
        "tools/materialx/run_node_dojo_blender.mjs",
        entry.sourceProject,
        "tools/compare_stippler_shader_masks.py",
        "--",
        blenderPath,
        browserPath,
        comparisonPath,
        capture.backgroundHex,
        ...(capture.temporalSamples === null ? [] : [String(capture.temporalSamples)]),
      ]);

      const rawComparison = JSON.parse(fs.readFileSync(comparisonPath, "utf8"));
      const comparisonPayload = {
        target: { id: asset.id, object: asset.object },
        geometryContract: {
          verts: asset.blenderStats.verts,
          faces: asset.blenderStats.faces,
          ...(asset.blenderStats.triangles === undefined
            ? {}
            : { triangles: asset.blenderStats.triangles }),
        },
        ...rawComparison,
      };
      fs.writeFileSync(comparisonPath, `${JSON.stringify(comparisonPayload, null, 2)}\n`);
      const evidence = buildCourseEvidence({
        asset,
        browser,
        comparisonPayload,
        browserReference,
        comparisonReport,
        capture,
      });
      candidateEvidence = evidence;
      if (!evidence.valid) throw new Error(`matched capture validation failed: ${JSON.stringify(evidence.capture)}`);

      const statusPath = path.join(root, "public", path.dirname(asset.dump), "status.json");
      const statusSource = fs.readFileSync(statusPath, "utf8");
      fs.writeFileSync(
        statusPath,
        upsertLastTopLevelProperty(statusSource, "workbenchRender", evidence),
      );
      variants.set(asset.id, { id: asset.id, object: asset.object, ...evidence });
      console.log(`COURSE_AUTHORED_RENDER_OK ${JSON.stringify({
        id: asset.id,
        surfaceMaskIoU: evidence.comparison.surfaceMaskIoU,
        pixelLuminanceMae: evidence.comparison.pixelLuminanceMae,
        macroLuminanceCorrelation: evidence.comparison.macroLuminanceCorrelation,
      })}`);
    } catch (error) {
      const failure = {
        id: asset.id,
        error: error instanceof Error ? error.message : String(error),
        ...(candidateEvidence ? { candidateEvidence } : {}),
      };
      failures.push(failure);
      console.error(`COURSE_AUTHORED_RENDER_FAILED ${JSON.stringify(failure)}`);
    }
  }

  const report = {
    updated: today(),
    status: failures.length ? "partial" : "complete",
    scope: "Matched cataloged Blender Workbench references versus live GN-VM Workbench-approximation browser canvases for all thirteen course presentation entries.",
    manifest: "tools/course-authored-render-manifest.json",
    capture,
    variants: manifest.assets.map((entry) => variants.get(entry.id)).filter(Boolean),
    failures,
    interpretation: "This batch preserves the current Blender Workbench references and browser Workbench approximation without per-asset appearance fitting. Geometry readiness, alpha-backed reference validity, silhouette alignment, and renderer metrics are independently recorded.",
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`COURSE_AUTHORED_RENDER_REPORT ${reportPath}`);
  if (failures.length) process.exitCode = 1;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) await main();
