// Run a single node GROUP from a dump in the VM on a known input mesh (unit quad,
// 3x3 grid, or an injected @mesh.json) and print/dump the resulting mesh — the VM
// twin of tools/isolate_group_mesh.py, for per-group Blender diffing.
// Usage: node --import tsx tools/gnvm-isolate.ts <dump.json> <GROUP> [quad|grid|@mesh.json] [out.json] [params.json]
import { readFileSync, writeFileSync } from "node:fs";
import { Evaluator } from "../src/gnvm/index";
import { DUMP_CONTEXT } from "../src/gnvm/registry";
import { Geometry, Mesh } from "../src/gnvm/geometry";
import { Field, Vec3 } from "../src/gnvm/core";

const [, , dumpPath, groupName, shape = "quad", outPath, paramsPath] = process.argv;
const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
DUMP_CONTEXT.objects = dump.objects ?? []; // ObjectInfo needs the scene objects
const ev = new Evaluator(dump.node_groups);
const g = dump.node_groups[groupName];
if (!g) { console.error(`group not found: ${groupName}`); process.exit(1); }

function inputMesh(): Geometry {
  const geo = new Geometry();
  const m = new Mesh();
  m.materialSlots = [null];
  if (shape.startsWith("@")) {
    const src = JSON.parse(readFileSync(shape.slice(1), "utf8"));
    m.positions = src.verts.map((p: number[]) => [p[0], p[1], p[2]] as Vec3);
    m.faces = (src.faces ?? []).map((f: number[]) => [...f]);
    m.faceMaterial = m.faces.map(() => 0);
    m.edges = (src.edges ?? []).map((e: number[]) => [e[0], e[1]] as [number, number]);
    geo.mesh = m;
    return geo;
  }
  if (shape === "grid") {
    const N = 3;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) m.positions.push([i / (N - 1) - 0.5, j / (N - 1) - 0.5, 0]);
    for (let j = 0; j < N - 1; j++)
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i;
        m.faces.push([a, a + 1, a + N + 1, a + N]);
        m.faceMaterial.push(0);
      }
  } else {
    m.positions = [[-0.5, -0.5, 0], [0.5, -0.5, 0], [0.5, 0.5, 0], [-0.5, 0.5, 0]] as Vec3[];
    m.faces.push([0, 1, 2, 3]);
    m.faceMaterial.push(0);
  }
  geo.mesh = m;
  return geo;
}

// Bind interface defaults (overridden by params.json when given, keyed by
// identifier); the geometry input gets the test mesh.
const overrides: Record<string, unknown> = paramsPath ? JSON.parse(readFileSync(paramsPath, "utf8")) : {};
const bindings: Record<string, any> = {};
for (const item of g.interface) {
  if (item.item_type !== "SOCKET" || item.in_out !== "INPUT") continue;
  const v = item.identifier in overrides ? overrides[item.identifier] : item.default;
  if (item.socket_type === "NodeSocketGeometry") bindings[item.identifier] = inputMesh();
  else if (item.socket_type === "NodeSocketVector") bindings[item.identifier] = Field.of((v ?? [0, 0, 0]) as Vec3);
  else bindings[item.identifier] = Field.of(typeof v === "number" ? v : v ? 1 : 0);
}

const outputs = ev.evalGroup(groupName, bindings);
let geo: Geometry | null = null;
for (const k in outputs) if (outputs[k] instanceof Geometry) { geo = outputs[k] as Geometry; break; }
if (!geo) { console.error("no geometry output"); process.exit(1); }

const m = geo.mesh;
const nan = m ? m.positions.filter((p) => p.some((c) => !Number.isFinite(c))).length : 0;
console.log(`RESULT: ${m?.positions.length ?? 0} verts, ${m?.faces.length ?? 0} faces, curvePts=${geo.curvePointCount()}${nan ? `  !! ${nan} NaN/Inf verts` : ""}`);
if (outPath && m) {
  writeFileSync(outPath, JSON.stringify({
    group: groupName, shape,
    verts: m.positions.map((p) => p.map((c) => Math.round(c * 1e5) / 1e5)),
    faces: m.faces,
  }));
  console.log("->", outPath);
}
