// Evaluate GN-VM's Dual Mesh node for a JSON mesh.
// Usage: npx tsx tools/gnvm-dual-mesh-probe.ts INPUT.json OUT.json
import { readFileSync, writeFileSync } from "node:fs";
import { Field, type Vec3 } from "../src/gnvm/core";
import { makeFieldCtx } from "../src/gnvm/evaluator";
import { Geometry, Mesh } from "../src/gnvm/geometry";
import { REGISTRY, type EvalAPI, type RawSocket, type SockVal } from "../src/gnvm/registry";
import "../src/gnvm/index";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) throw new Error("usage: gnvm-dual-mesh-probe INPUT.json OUT.json");
const source = JSON.parse(readFileSync(inputPath, "utf8")) as { positions: Vec3[]; faces: number[][] };
const mesh = new Mesh();
mesh.positions = source.positions;
mesh.faces = source.faces;
const geometry = new Geometry();
geometry.mesh = mesh;

const inputs: RawSocket[] = [{
  name: "Mesh", identifier: "Mesh", idx: 0, type: "NodeSocketGeometry", linked: true, value: null,
}];
const api: EvalAPI = {
  node: { name: "Dual Mesh", type: "GeometryNodeDualMesh", label: null, inputs, outputs: [], props: {} },
  input: () => geometry,
  inputs: () => [geometry],
  geoInputs: () => [geometry],
  geo: () => geometry,
  field: () => Field.of(0),
  num: () => 0,
  vec: () => [0, 0, 0],
  bool: () => false,
  str: () => "",
  ref: () => null,
  prop: (_name, fallback) => fallback,
  resolve: (field, value, domain) => field.array(makeFieldCtx(value, domain)),
};
const handler = REGISTRY.get("GeometryNodeDualMesh");
if (!handler) throw new Error("GeometryNodeDualMesh is not registered");
const result = handler(api) as Record<string, SockVal>;
const dual = result["Dual Mesh"];
if (!(dual instanceof Geometry) || !dual.mesh) throw new Error("Dual Mesh returned no mesh");
writeFileSync(outputPath, `${JSON.stringify({
  positions: dual.mesh.positions,
  edges: dual.mesh.edges,
  faces: dual.mesh.faces,
}, null, 2)}\n`);
console.log(`GNVM_DUAL_MESH_PROBE_OK: ${dual.mesh.positions.length} verts, ${dual.mesh.faces.length} faces -> ${outputPath}`);
