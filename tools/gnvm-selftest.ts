// Headless correctness gate for the GN-VM: builds a synthetic graph in the dump
// format and asserts the resulting geometry stats. Run: npx tsx tools/gnvm-selftest.ts
import { Evaluator } from "../src/gnvm/evaluator";
import { toTriSoup } from "../src/gnvm/geometry";
import { MISSING } from "../src/gnvm/registry";
import "../src/gnvm/nodes/math";
import "../src/gnvm/nodes/inputs";
import "../src/gnvm/nodes/geometry";
import "../src/gnvm/nodes/meshops";
import "../src/gnvm/nodes/fields";

type In = { name: string; identifier: string; idx: number; type: string; linked: boolean; value: any };
const fin = (name: string, type: string, value: any, id = name, idx = 0): In => ({ name, identifier: id, idx, type, linked: false, value });
const out = (name: string, id = name) => ({ name, identifier: id });
const node = (name: string, type: string, inputs: In[], outputs: any[], props: any = {}) => ({ name, type, label: null, inputs, outputs, props });
const link = (fn: string, fs: string, tn: string, ts: string) => ({ from_node: fn, from_socket: fs, to_node: tn, to_socket: ts });

const G = "NodeSocketGeometry", F = "NodeSocketFloat", I = "NodeSocketInt", V = "NodeSocketVector", B = "NodeSocketBool", M = "NodeSocketMaterial";

const main = {
  name: "Main",
  type: "GeometryNodeTree",
  interface: [{ item_type: "SOCKET", identifier: "Geometry", in_out: "OUTPUT", socket_type: G, name: "Geometry" }],
  nodes: [
    node("grid", "GeometryNodeMeshGrid",
      [fin("Size X", F, 4), fin("Size Y", F, 4), fin("Vertices X", I, 5), fin("Vertices Y", I, 5)],
      [out("Mesh")]),
    node("cube", "GeometryNodeMeshCube",
      [fin("Size", V, [0.4, 0.4, 0.4]), fin("Vertices X", I, 2), fin("Vertices Y", I, 2), fin("Vertices Z", I, 2)],
      [out("Mesh")]),
    node("index", "GeometryNodeInputIndex", [], [out("Index")]),
    node("mul", "ShaderNodeMath",
      [fin("Value", F, 0, "Value", 0), fin("Value", F, 0.15, "Value_001", 1), fin("Value", F, 0, "Value_002", 2)],
      [out("Value")], { operation: "MULTIPLY" }),
    node("comb", "ShaderNodeCombineXYZ",
      [fin("X", F, 0), fin("Y", F, 0), fin("Z", F, 0)], [out("Vector")]),
    node("setpos", "GeometryNodeSetPosition",
      [fin("Geometry", G, null), fin("Selection", B, true), fin("Position", V, [0, 0, 0]), fin("Offset", V, [0, 0, 0])],
      [out("Geometry")]),
    node("inst", "GeometryNodeInstanceOnPoints",
      [fin("Points", G, null), fin("Selection", B, true), fin("Instance", G, null),
       fin("Pick Instance", B, false), fin("Instance Index", I, 0), fin("Rotation", V, [0, 0, 0]), fin("Scale", V, [1, 1, 1])],
      [out("Instances")]),
    node("realize", "GeometryNodeRealizeInstances", [fin("Geometry", G, null)], [out("Geometry")]),
    node("setmat", "GeometryNodeSetMaterial",
      [fin("Geometry", G, null), fin("Selection", B, true), fin("Material", M, { datablock: "Material", name: "BinMat" })],
      [out("Geometry")]),
    node("output", "NodeGroupOutput", [fin("Geometry", G, null)], []),
  ],
  links: [
    link("grid", "Mesh", "setpos", "Geometry"),
    link("index", "Index", "mul", "Value"),
    link("mul", "Value", "comb", "Z"),
    link("comb", "Vector", "setpos", "Offset"),
    link("setpos", "Geometry", "inst", "Points"),
    link("cube", "Mesh", "inst", "Instance"),
    link("inst", "Instances", "realize", "Geometry"),
    link("realize", "Geometry", "setmat", "Geometry"),
    link("setmat", "Geometry", "output", "Geometry"),
  ],
};

// Mark linked sockets so SetPosition/InstanceOnPoints see Position/Scale link state.
for (const l of main.links) {
  const tn = main.nodes.find((n) => n.name === l.to_node)!;
  const s = tn.inputs.find((x) => x.identifier === l.to_socket || x.name === l.to_socket);
  if (s) s.linked = true;
}

const ev = new Evaluator({ Main: main } as any);
MISSING.clear();
const { geometry } = ev.evalModifierGroup("Main");
const soup = toTriSoup(geometry);

const zs: number[] = [];
for (let i = 0; i < soup.positions.length; i += 3) zs.push(soup.positions[i + 2]);
const zmin = Math.min(...zs), zmax = Math.max(...zs);

const checks: [string, boolean][] = [
  ["25 cubes -> 200 verts", soup.stats.verts === 200],
  ["25 cubes -> 150 faces", soup.stats.faces === 150],
  ["150 quads -> 300 tris", soup.stats.tris === 300],
  // points offset 0..3.6 by index*0.15, plus cube half-height +/-0.2 -> span 4.0
  ["staircase in Z (index-driven, span 4.0)", Math.abs(zmax - zmin - 4.0) < 1e-6 && Math.abs(zmin + 0.2) < 1e-6],
  ["material slot 'BinMat'", soup.groups.length === 1 && soup.groups[0].material === "BinMat"],
  ["no missing node types", MISSING.size === 0],
];
// --- second graph: extrude one quad into a box ---
const ex = {
  name: "Ex", type: "GeometryNodeTree",
  interface: [{ item_type: "SOCKET", identifier: "Geometry", in_out: "OUTPUT", socket_type: G, name: "Geometry" }],
  nodes: [
    node("g", "GeometryNodeMeshGrid", [fin("Size X", F, 2), fin("Size Y", F, 2), fin("Vertices X", I, 2), fin("Vertices Y", I, 2)], [out("Mesh")]),
    node("ext", "GeometryNodeMeshExtrude" as any, [], [] as any), // placeholder, replaced below
    node("output", "NodeGroupOutput", [fin("Geometry", G, null)], []),
  ],
  links: [link("g", "Mesh", "ext", "Mesh"), link("ext", "Mesh", "output", "Geometry")],
};
ex.nodes[1] = node("ext", "GeometryNodeExtrudeMesh",
  [fin("Mesh", G, null), fin("Selection", B, true), fin("Offset", V, [0, 0, 0]), fin("Offset Scale", F, 1), fin("Individual", B, false)],
  [out("Mesh"), out("Top"), out("Side")], { mode: "FACES" });
const evx = new Evaluator({ Ex: ex } as any);
const rx = evx.evalModifierGroup("Ex").geometry;
const sx = toTriSoup(rx);

checks.push(["extrude quad -> box (8 verts)", sx.stats.verts === 8]);
checks.push(["extrude quad -> box (5 faces: top+4 walls)", sx.stats.faces === 5]);

let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}
console.log(`\nstats: ${JSON.stringify(soup.stats)}  z=[${zmin.toFixed(2)}, ${zmax.toFixed(2)}]  missing=${[...MISSING.keys()].join(",") || "none"}`);
console.log(ok ? "\nSELFTEST_OK" : "\nSELFTEST_FAIL");
process.exit(ok ? 0 : 1);
