// Re-mesh a frozen Watertight Bolt scalar grid with the deterministic GN-VM
// Volume to Mesh implementation.
//
// Usage:
//   npx tsx tools/watertight_cross_grid_gnvm.ts \
//     raw GRID.f32 GRID_META.json OUT.json
//
//   npx tsx tools/watertight_cross_grid_gnvm.ts \
//     resampled GRID.f32 GRID_META.json OUT.json
//
// "raw" applies the production sparse-grid resampling pass before contouring.
// "resampled" contours an already captured Volume to Mesh grid directly.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { Vec3 } from "../src/gnvm/core";
import {
  resampleVolumeGridForTest,
  setSurfaceNetsDiagnosticSink,
  surfaceNetsForTest,
  type SurfaceNetsDiagnostics,
} from "../src/gnvm/nodes/volume";
import type { VolumeGrid } from "../src/gnvm/registry";

type Mode = "raw" | "resampled";

interface GridMetadata {
  background: number;
  min?: Vec3;
  max?: Vec3;
  resolution: Vec3;
  origin: Vec3;
  spacing: Vec3;
  requestedSpacing?: number;
  isolation?: number;
}

const [, , modeArg, binaryPath, metadataPath, outputPath] = process.argv;
if (
  (modeArg !== "raw" && modeArg !== "resampled")
  || !binaryPath
  || !metadataPath
  || !outputPath
) {
  throw new Error(
    "usage: watertight_cross_grid_gnvm (raw|resampled) GRID.f32 GRID_META.json OUT.json",
  );
}
const mode = modeArg as Mode;
const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as GridMetadata;
const storedBinary = readFileSync(binaryPath);
const binary = binaryPath.endsWith(".gz") ? gunzipSync(storedBinary) : storedBinary;
const expected = metadata.resolution[0] * metadata.resolution[1] * metadata.resolution[2];
if (binary.byteLength !== expected * Float32Array.BYTES_PER_ELEMENT) {
  throw new Error(
    `expected ${expected * Float32Array.BYTES_PER_ELEMENT} bytes, received ${binary.byteLength}`,
  );
}
const values = new Float32Array(
  binary.buffer,
  binary.byteOffset,
  binary.byteLength / Float32Array.BYTES_PER_ELEMENT,
);

function fnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

let surfaceValues = values;
let surfaceResolution = metadata.resolution;
let surfaceOrigin = metadata.origin;
let surfaceSpacing = metadata.spacing;
let resampled:
  | ReturnType<typeof resampleVolumeGridForTest>
  | undefined;

if (mode === "raw") {
  if (!metadata.min || !metadata.max || metadata.requestedSpacing === undefined) {
    throw new Error("raw metadata requires min, max, and requestedSpacing");
  }
  const volume: VolumeGrid = {
    kind: "GNVM_VOLUME_GRID",
    background: metadata.background,
    min: metadata.min,
    max: metadata.max,
    resolution: metadata.resolution,
    origin: metadata.origin,
    voxelSize: metadata.spacing,
    values,
    requestedVoxelSize: metadata.requestedSpacing,
    requestedSampleCount: expected,
    budgetAdjusted: false,
    sampleBudget: 1_000_000,
  };
  resampled = resampleVolumeGridForTest(volume, metadata.requestedSpacing);
  surfaceValues = resampled.values;
  surfaceResolution = resampled.resolution;
  surfaceOrigin = resampled.origin;
  surfaceSpacing = resampled.spacing;
}

let diagnostics: SurfaceNetsDiagnostics | undefined;
setSurfaceNetsDiagnosticSink((value) => {
  diagnostics = value;
});
const started = performance.now();
const mesh = surfaceNetsForTest(
  surfaceValues,
  surfaceResolution,
  metadata.isolation ?? 0,
  surfaceOrigin,
  surfaceSpacing,
);
const elapsedMs = Math.round(performance.now() - started);
setSurfaceNetsDiagnosticSink(null);

const surfaceBytes = new Uint8Array(
  surfaceValues.buffer,
  surfaceValues.byteOffset,
  surfaceValues.byteLength,
);
const output = {
  mode,
  sourceGrid: binaryPath,
  sourceMetadata: metadataPath,
  source: {
    resolution: metadata.resolution,
    origin: metadata.origin,
    spacing: metadata.spacing,
    valueCount: values.length,
    fnv1a64: fnv1a64(binary),
    sha256: createHash("sha256").update(binary).digest("hex"),
  },
  surfaceGrid: {
    resolution: surfaceResolution,
    origin: surfaceOrigin,
    spacing: surfaceSpacing,
    valueCount: surfaceValues.length,
    requestedSpacing: resampled?.requestedSpacing ?? metadata.requestedSpacing,
    requestedSampleCount: resampled?.requestedSampleCount,
    budgetAdjusted: resampled?.budgetAdjusted,
    fnv1a64: fnv1a64(surfaceBytes),
    sha256: createHash("sha256").update(surfaceBytes).digest("hex"),
  },
  mesh: {
    verts: mesh.positions.length,
    faces: mesh.faces.length,
    elapsedMs,
  },
  diagnostics,
};
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `WATERTIGHT_CROSS_GRID_GNVM_OK: ${mesh.positions.length} verts / ${mesh.faces.length} faces -> ${outputPath}`,
);
