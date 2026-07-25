// Freeze the smallest reproducible Watertight Bolt repeat boundary:
// the one-pass mesh and the second pass's raw 43x43x71 scalar grid.
//
// Usage:
//   npx tsx tools/watertight_cross_grid_capture.ts \
//     public/dojo/n03d/bolt-watertight/dump.json \
//     "Bolt Gen_DHTS_Thru Head v03.003" \
//     OUT_DIR
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { runGenerator, type Dump } from "../src/gnvm/index";
import {
  setVolumeGridDiagnosticSink,
  type VolumeGridDiagnostics,
} from "../src/gnvm/nodes/volume";

const [, , dumpPath, objectName, outputDirectory] = process.argv;
if (!dumpPath || !objectName || !outputDirectory) {
  throw new Error(
    "usage: watertight_cross_grid_capture DUMP OBJECT OUT_DIR",
  );
}

const dumpBytes = readFileSync(dumpPath);
const dump = JSON.parse(dumpBytes.toString("utf8")) as Dump;
const repeatInput = dump.node_groups?.["hole patch"]?.nodes.find(
  (node) => node.name === "Repeat Input",
);
const iterations = repeatInput?.inputs.find(
  (socket) => socket.name === "Iterations" || socket.identifier === "Iterations",
);
if (!iterations) {
  throw new Error("hole patch / Repeat Input / Iterations was not found");
}

function fnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function gzipJson(value: unknown): Buffer {
  return gzipSync(`${JSON.stringify(value)}\n`, { level: 9, mtime: 0 });
}

const source = {
  dump: dumpPath,
  dumpSha256: createHash("sha256").update(dumpBytes).digest("hex"),
  object: objectName,
  repeatGroup: "hole patch",
  repeatNode: "Repeat Input",
};

iterations.value = 1;
const passOneStarted = performance.now();
const passOne = await runGenerator(dump, { object: objectName });
const passOneElapsedMs = Math.round(performance.now() - passOneStarted);
const passOneMesh = passOne.geometry.mesh;

const volumeEvents: VolumeGridDiagnostics[] = [];
setVolumeGridDiagnosticSink((event) => {
  volumeEvents.push(event);
});
iterations.value = 2;
const passTwoStarted = performance.now();
const passTwo = await runGenerator(dump, { object: objectName });
const passTwoElapsedMs = Math.round(performance.now() - passTwoStarted);
setVolumeGridDiagnosticSink(null);

const rawEvents = volumeEvents.filter((event) => event.stage === "volume-cube");
if (rawEvents.length !== 2) {
  throw new Error(`expected 2 Volume Cube events, received ${rawEvents.length}`);
}
const raw = rawEvents[1];
const rawBytes = new Uint8Array(
  raw.values.buffer,
  raw.values.byteOffset,
  raw.values.byteLength,
);
const { values: _values, ...rawMetadata } = raw;

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  join(outputDirectory, "pass1-mesh.json.gz"),
  gzipJson({
    source: { ...source, repeatIterations: 1 },
    elapsedMs: passOneElapsedMs,
    stats: passOne.soup.stats,
    positions: passOneMesh.positions,
    faces: passOneMesh.faces,
  }),
);
writeFileSync(
  join(outputDirectory, "pass2-raw.f32.gz"),
  gzipSync(rawBytes, { level: 9, mtime: 0 }),
);
writeFileSync(
  join(outputDirectory, "pass2-raw.json"),
  `${JSON.stringify({
    source: { ...source, repeatIterations: 2, volumeCubeEvent: 2 },
    elapsedMs: passTwoElapsedMs,
    finalStats: passTwo.soup.stats,
    ...rawMetadata,
    valueCount: raw.values.length,
    fnv1a64: fnv1a64(rawBytes),
    sha256: createHash("sha256").update(rawBytes).digest("hex"),
  }, null, 2)}\n`,
);
console.log(
  `WATERTIGHT_CROSS_GRID_CAPTURE_OK: ${passOneMesh.positions.length}v/${passOneMesh.faces.length}f`
    + ` + ${raw.values.length} samples -> ${outputDirectory}`,
);
