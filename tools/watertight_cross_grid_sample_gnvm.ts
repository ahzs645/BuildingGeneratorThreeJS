// Evaluate the Watertight Bolt's Mesh To SDF field on a frozen mesh/lattice
// using the production GN-VM Geometry Proximity and Raycast handlers.
//
// Usage:
//   npx tsx tools/watertight_cross_grid_sample_gnvm.ts \
//     MESH.json[.gz] GRID_META.json OUT.f32 OUT.json
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { asNum, asVec3, Field, type Vec3 } from "../src/gnvm/core";
import { makeFieldCtx } from "../src/gnvm/evaluator";
import { Geometry, Mesh } from "../src/gnvm/geometry";
import "../src/gnvm/index";
import {
  REGISTRY,
  type EvalAPI,
  type RawNode,
  type SockVal,
} from "../src/gnvm/registry";

interface FrozenMesh {
  positions: Vec3[];
  faces: number[][];
}

interface GridMetadata {
  background: number;
  resolution: Vec3;
  origin: Vec3;
  spacing: Vec3;
}

const [, , meshPath, metadataPath, binaryPath, summaryPath] = process.argv;
if (!meshPath || !metadataPath || !binaryPath || !summaryPath) {
  throw new Error(
    "usage: watertight_cross_grid_sample_gnvm MESH GRID_META OUT.f32 OUT.json",
  );
}

function readMaybeGzip(path: string): Buffer {
  const bytes = readFileSync(path);
  return path.endsWith(".gz") ? gunzipSync(bytes) : bytes;
}

function fnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

const frozen = JSON.parse(readMaybeGzip(meshPath).toString("utf8")) as FrozenMesh;
const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as GridMetadata;
const target = new Geometry();
const targetMesh = new Mesh();
targetMesh.positions = frozen.positions;
targetMesh.faces = frozen.faces;
target.mesh = targetMesh;

const samples = new Geometry();
const sampleMesh = new Mesh();
const [rx, ry, rz] = metadata.resolution;
for (let z = 0; z < rz; z++) {
  for (let y = 0; y < ry; y++) {
    for (let x = 0; x < rx; x++) {
      sampleMesh.positions.push([
        metadata.origin[0] + x * metadata.spacing[0],
        metadata.origin[1] + y * metadata.spacing[1],
        metadata.origin[2] + z * metadata.spacing[2],
      ]);
    }
  }
}
samples.mesh = sampleMesh;
const context = makeFieldCtx(samples, "POINT");
const position = Field.make((ctx) =>
  Array.from({ length: ctx.size }, (_, index) => ctx.position?.(index) ?? [0, 0, 0] as Vec3));

function nodeApi(
  type: string,
  props: Record<string, unknown>,
  geos: Record<string, Geometry>,
  fields: Record<string, Field>,
  linked: string[],
): EvalAPI {
  const names = [...new Set([...Object.keys(geos), ...Object.keys(fields)])];
  const node: RawNode = {
    name: type,
    type,
    label: null,
    inputs: names.map((name, index) => ({
      name,
      identifier: name,
      type: geos[name] ? "NodeSocketGeometry" : "NodeSocketFloat",
      linked: linked.includes(name),
      enabled: true,
      hide: false,
      hide_value: false,
      display_shape: "CIRCLE",
      idx: index,
      value: null,
    })),
    outputs: [],
    props,
  };
  const value = (name: string): SockVal => geos[name] ?? fields[name] ?? Field.of(0);
  const constant = (name: string) => {
    const field = fields[name] ?? Field.of(0);
    return field.isConst ? field.value : 0;
  };
  return {
    node,
    input: value,
    inputs: (name) => [value(name)],
    geoInputs: (name) => geos[name] ? [geos[name]] : [],
    geo: (name) => geos[name] ?? new Geometry(),
    field: (name) => fields[name] ?? Field.of(0),
    num: (name) => asNum(constant(name)),
    vec: (name) => asVec3(constant(name)),
    bool: (name) => asNum(constant(name)) !== 0,
    str: () => "",
    ref: () => null,
    prop: (name, fallback) => name in props ? props[name] as never : fallback,
    resolve: (field, geometry, domain) => field.array(makeFieldCtx(geometry, domain)),
  };
}

const proximity = REGISTRY.get("GeometryNodeProximity");
const raycast = REGISTRY.get("GeometryNodeRaycast");
if (!proximity || !raycast) {
  throw new Error("Geometry Proximity or Raycast handler is not registered");
}

const started = performance.now();
const proximityOutputs = proximity(nodeApi(
  "GeometryNodeProximity",
  { target_element: "FACES" },
  { Target: target },
  { "Source Position": Field.of([0, 0, 0]) },
  [],
));
const raycastOutputs = raycast(nodeApi(
  "GeometryNodeRaycast",
  { data_type: "FLOAT" },
  { "Target Geometry": target },
  {
    "Source Position": Field.of([0, 0, 0]),
    "Ray Direction": position,
    "Ray Length": Field.of(100),
  },
  ["Ray Direction"],
));
const distances = (proximityOutputs.Distance as Field).array(context).map(asNum);
const normals = (raycastOutputs["Hit Normal"] as Field).array(context).map(asVec3);
const signed = new Float32Array(context.size);
const f = Math.fround;
for (let index = 0; index < signed.length; index++) {
  const point = sampleMesh.positions[index];
  const normal = normals[index] ?? [0, 0, 0];
  const dot = f(
    f(f(f(point[0]) * f(normal[0])) + f(f(point[1]) * f(normal[1])))
      + f(f(point[2]) * f(normal[2])),
  );
  signed[index] = f(f(distances[index] ?? 0) * (dot > 0 ? -1 : 1));
}
const elapsedMs = Math.round(performance.now() - started);
const bytes = new Uint8Array(signed.buffer, signed.byteOffset, signed.byteLength);
let minimum = Number.POSITIVE_INFINITY;
let maximum = Number.NEGATIVE_INFINITY;
let negative = 0;
let zero = 0;
for (const value of signed) {
  minimum = Math.min(minimum, value);
  maximum = Math.max(maximum, value);
  if (value < 0) negative++;
  if (value === 0) zero++;
}
writeFileSync(
  binaryPath,
  binaryPath.endsWith(".gz") ? gzipSync(bytes, { level: 9, mtime: 0 }) : bytes,
);
writeFileSync(
  summaryPath,
  `${JSON.stringify({
    mode: "sample",
    sourceMesh: meshPath,
    sourceMetadata: metadataPath,
    resolution: metadata.resolution,
    origin: metadata.origin,
    spacing: metadata.spacing,
    background: metadata.background,
    valueCount: signed.length,
    fnv1a64: fnv1a64(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    minimum,
    maximum,
    negative,
    zero,
    elapsedMs,
  }, null, 2)}\n`,
);
console.log(
  `WATERTIGHT_CROSS_GRID_GNVM_SAMPLE_OK: ${signed.length} values -> ${binaryPath}`,
);
