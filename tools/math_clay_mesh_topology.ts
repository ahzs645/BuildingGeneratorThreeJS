// Report polygon/edge topology for a GN-VM result without triangulating it.
// Usage: npx tsx tools/math_clay_mesh_topology.ts <dump.json> <ObjectName>
import { readFileSync } from "node:fs";
import { Dump, runGenerator } from "../src/gnvm/index";
import { setSurfaceNetsDiagnosticSink } from "../src/gnvm/nodes/volume";
import type { SurfaceNetsDiagnostics } from "../src/gnvm/nodes/volume";

const [, , dumpPath = "public/dojo/math-clay/dump.json", objectName = "Dsurface"] = process.argv;
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
const surfaceNets: SurfaceNetsDiagnostics[] = [];
setSurfaceNetsDiagnosticSink((diagnostics) => surfaceNets.push(diagnostics));
const result = await runGenerator(dump, { object: objectName });
setSurfaceNetsDiagnosticSink(null);
const mesh = result.geometry.mesh;

const edgeFaces = new Map<string, number>();
const faceSizes = new Map<number, number>();
for (const face of mesh.faces) {
  faceSizes.set(face.length, (faceSizes.get(face.length) ?? 0) + 1);
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
  surfaceNets,
}, null, 2));
