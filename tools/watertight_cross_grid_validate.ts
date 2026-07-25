// Validate the committed Watertight Bolt frozen-source fixture without
// evaluating either Geometry Nodes engine.
// Usage: npx tsx tools/watertight_cross_grid_validate.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "watertight-cross-grid");
const evidence = JSON.parse(readFileSync(join(fixture, "evidence.json"), "utf8"));

function uncompressed(path: string): Buffer {
  const bytes = readFileSync(path);
  return path.endsWith(".gz") ? gunzipSync(bytes) : bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function grid(path: string): Float32Array {
  const bytes = uncompressed(path);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

const gnvmMeshPath = join(fixture, "gnvm-current", "pass1-mesh.json.gz");
const blenderMeshPath = join(fixture, "blender-current", "pass1-mesh.json.gz");
const gnvmGridPath = join(fixture, "gnvm-current", "pass2-raw.f32.gz");
const blenderGridPath = join(fixture, "blender-current", "pass2-raw.f32.gz");
const gnvmMeshBytes = uncompressed(gnvmMeshPath);
const blenderMeshBytes = uncompressed(blenderMeshPath);
const gnvmMesh = JSON.parse(gnvmMeshBytes.toString("utf8"));
const blenderMesh = JSON.parse(blenderMeshBytes.toString("utf8"));
const gnvmGrid = grid(gnvmGridPath);
const blenderGrid = grid(blenderGridPath);

assert.equal(sha256(gnvmMeshBytes), evidence.gnvmFrozenSource.passOne.meshJsonSha256);
assert.equal(sha256(blenderMeshBytes), evidence.blenderFrozenSource.passOne.meshJsonSha256);
assert.equal(sha256(new Uint8Array(gnvmGrid.buffer, gnvmGrid.byteOffset, gnvmGrid.byteLength)),
  evidence.gnvmFrozenSource.crossSampler.sha256);
assert.equal(sha256(new Uint8Array(blenderGrid.buffer, blenderGrid.byteOffset, blenderGrid.byteLength)),
  evidence.blenderFrozenSource.crossSampler.sha256);
assert.equal(gnvmMesh.positions.length, evidence.gnvmFrozenSource.passOne.verts);
assert.equal(gnvmMesh.faces.length, evidence.gnvmFrozenSource.passOne.faces);
assert.equal(blenderMesh.positions.length, evidence.blenderFrozenSource.passOne.verts);
assert.equal(blenderMesh.faces.length, evidence.blenderFrozenSource.passOne.faces);
assert.equal(gnvmGrid.length, evidence.lattice.valueCount);
assert.equal(blenderGrid.length, evidence.lattice.valueCount);

let exact = 0;
let signMismatches = 0;
for (let index = 0; index < gnvmGrid.length; index++) {
  if (gnvmGrid[index] === blenderGrid[index]) exact++;
  const gnvmSign = gnvmGrid[index] < 0 ? -1 : gnvmGrid[index] > 0 ? 1 : 0;
  const blenderSign = blenderGrid[index] < 0 ? -1 : blenderGrid[index] > 0 ? 1 : 0;
  if (gnvmSign !== blenderSign) signMismatches++;
}
assert.equal(exact, evidence.sourceSwap.exactGridValues);
assert.equal(signMismatches, evidence.sourceSwap.signMismatches);

console.log(JSON.stringify({
  fixtureBytes: [
    gnvmMeshPath,
    blenderMeshPath,
    gnvmGridPath,
    blenderGridPath,
  ].reduce((sum, path) => sum + statSync(path).size, 0),
  gnvm: {
    mesh: `${gnvmMesh.positions.length}v/${gnvmMesh.faces.length}f`,
    gridValues: gnvmGrid.length,
    gridSha256: evidence.gnvmFrozenSource.crossSampler.sha256,
  },
  blender: {
    mesh: `${blenderMesh.positions.length}v/${blenderMesh.faces.length}f`,
    gridValues: blenderGrid.length,
    gridSha256: evidence.blenderFrozenSource.crossSampler.sha256,
  },
  sourceSwap: {
    exactValues: exact,
    differentValues: gnvmGrid.length - exact,
    signMismatches,
  },
}, null, 2));
