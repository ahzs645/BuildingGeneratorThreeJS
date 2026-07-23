// Report polygon/edge topology for a GN-VM result without triangulating it.
// Usage: npx tsx tools/math_clay_mesh_topology.ts <dump.json> <ObjectName> [--volume-grid-dir <dir>]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Dump, runGenerator } from "../src/gnvm/index";
import type { Vec3 } from "../src/gnvm/core";
import { setSurfaceNetsDiagnosticSink, setVolumeGridDiagnosticSink } from "../src/gnvm/nodes/volume";
import type { SurfaceNetsDiagnostics, VolumeGridDiagnostics } from "../src/gnvm/nodes/volume";

const [, , dumpPath = "public/dojo/math-clay/dump.json", objectName = "Dsurface"] = process.argv;
const volumeGridDirFlag = process.argv.indexOf("--volume-grid-dir");
const volumeGridDir = volumeGridDirFlag >= 0 ? process.argv[volumeGridDirFlag + 1] : undefined;
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
const graphOverrides = JSON.parse(process.env.GNVM_PROBE_GRAPH_OVERRIDES ?? "[]") as Array<{
  group: string;
  node: string;
  inputs: Record<string, unknown>;
}>;
for (const override of graphOverrides) {
  const node = dump.node_groups?.[override.group]?.nodes.find((candidate) => candidate.name === override.node);
  if (!node) throw new Error(`invalid graph override: ${JSON.stringify(override)}`);
  for (const [name, value] of Object.entries(override.inputs)) {
    const socket = node.inputs.find((candidate) => candidate.name === name || candidate.identifier === name);
    if (!socket) throw new Error(`invalid graph override input: ${override.group}.${override.node}.${name}`);
    socket.value = value as never;
  }
}
const surfaceNets: SurfaceNetsDiagnostics[] = [];
const volumeGrids: Omit<VolumeGridDiagnostics, "values">[] & { valueCount?: number }[] = [];

function fnv1a64(values: Float32Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

setSurfaceNetsDiagnosticSink((diagnostics) => surfaceNets.push(diagnostics));
setVolumeGridDiagnosticSink((diagnostics) => {
  const { values, ...metadata } = diagnostics;
  let minimum = Number.POSITIVE_INFINITY, maximum = Number.NEGATIVE_INFINITY;
  let belowIsolation = 0, exactZero = 0;
  for (const value of values) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    if (value === 0) exactZero++;
    if (diagnostics.isolation !== undefined && value < diagnostics.isolation) belowIsolation++;
  }
  const index = volumeGrids.length;
  const summary = {
    ...metadata,
    valueCount: values.length,
    minimum,
    maximum,
    exactZero,
    belowIsolation: diagnostics.isolation === undefined ? undefined : belowIsolation,
    fnv1a64: fnv1a64(values),
  };
  volumeGrids.push(summary);
  if (volumeGridDir) {
    mkdirSync(volumeGridDir, { recursive: true });
    const base = `${String(index).padStart(2, "0")}-${diagnostics.stage}`;
    writeFileSync(join(volumeGridDir, `${base}.f32`), new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
    writeFileSync(join(volumeGridDir, `${base}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  }
});
const result = await runGenerator(dump, { object: objectName });
setSurfaceNetsDiagnosticSink(null);
setVolumeGridDiagnosticSink(null);
const mesh = result.geometry.mesh;

const edgeFaces = new Map<string, number>();
const faceSizes = new Map<number, number>();
let signedVolume = 0;
const radialOrientation = { outward: 0, inward: 0 };
for (const face of mesh.faces) {
  faceSizes.set(face.length, (faceSizes.get(face.length) ?? 0) + 1);
  const points = face.map((index) => mesh.positions[index]);
  const center = points.reduce(
    (sum, point) => [sum[0] + point[0] / points.length, sum[1] + point[1] / points.length, sum[2] + point[2] / points.length],
    [0, 0, 0] as Vec3,
  );
  const edgeA: Vec3 = [points[1][0] - points[0][0], points[1][1] - points[0][1], points[1][2] - points[0][2]];
  const edgeB: Vec3 = [points[2][0] - points[0][0], points[2][1] - points[0][1], points[2][2] - points[0][2]];
  const normal: Vec3 = [
    edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1],
    edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2],
    edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0],
  ];
  const radial = normal[0] * center[0] + normal[1] * center[1] + normal[2] * center[2];
  radialOrientation[radial >= 0 ? "outward" : "inward"]++;
  for (let corner = 1; corner < points.length - 1; corner++) {
    const a = points[corner], b = points[corner + 1];
    const cross: Vec3 = [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    signedVolume += (points[0][0] * cross[0] + points[0][1] * cross[1] + points[0][2] * cross[2]) / 6;
  }
  for (let corner = 0; corner < face.length; corner++) {
    const a = face[corner], b = face[(corner + 1) % face.length];
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    edgeFaces.set(key, (edgeFaces.get(key) ?? 0) + 1);
  }
}
const incidence = new Map<number, number>();
for (const count of edgeFaces.values()) incidence.set(count, (incidence.get(count) ?? 0) + 1);

console.log(JSON.stringify({
  object: objectName,
  verts: mesh.positions.length,
  edges: edgeFaces.size,
  faces: mesh.faces.length,
  faceSizes: Object.fromEntries([...faceSizes].sort(([a], [b]) => a - b)),
  edgeFaceIncidence: Object.fromEntries([...incidence].sort(([a], [b]) => a - b)),
  eulerCharacteristic: mesh.positions.length - edgeFaces.size + mesh.faces.length,
  signedVolume,
  radialOrientation,
  volumeGrids,
  surfaceNets,
}, null, 2));
