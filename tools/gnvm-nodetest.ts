// Per-node test harness for the GN-VM (inspired by ThreeGN's per-node tests, but
// built against our EvalAPI directly — no graph machinery needed).
// Run: npx tsx tools/gnvm-nodetest.ts
import { Field, Vec3 } from "../src/gnvm/core";
import { Geometry } from "../src/gnvm/geometry";
import { EvalAPI, REGISTRY, SockVal, RawSocket } from "../src/gnvm/registry";
import { makeFieldCtx } from "../src/gnvm/evaluator";
import "../src/gnvm/index"; // registers all handlers

type Input = SockVal | number | number[] | boolean;
const wrap = (v: Input): SockVal =>
  v instanceof Geometry || v instanceof Field ? v :
  typeof v === "number" ? Field.of(v) :
  typeof v === "boolean" ? Field.of(v ? 1 : 0) :
  Array.isArray(v) ? Field.of(v as Vec3) :
  (v as SockVal);

// `linked` marks which named inputs should report as connected (for nodes that
// branch on socket.linked, e.g. SetPosition / InstanceOnPoints).
function runNode(type: string, inputs: Record<string, Input>, props: Record<string, any> = {}, linked: string[] = []) {
  const h = REGISTRY.get(type);
  if (!h) throw new Error(`no handler: ${type}`);
  const rawInputs: RawSocket[] = Object.keys(inputs).map((name, idx) => ({
    name, identifier: name, idx, type: "NodeSocketFloat", linked: linked.includes(name), value: null,
  }));
  const raw = (n: string) => inputs[n];
  const api: EvalAPI = {
    node: { name: "t", type, label: null, inputs: rawInputs, outputs: [], props },
    input: (n) => wrap(raw(n)),
    inputs: (n) => (n in inputs ? [wrap(raw(n))] : []),
    geoInputs: (n) => { const v = wrap(raw(n)); return v instanceof Geometry ? [v] : []; },
    geo: (n) => { const v = raw(n); return v instanceof Geometry ? v : new Geometry(); },
    field: (n) => { const v = wrap(raw(n)); return v instanceof Field ? v : Field.of(0); },
    num: (n) => { const v = raw(n); return typeof v === "number" ? v : Array.isArray(v) ? v[0] : 0; },
    vec: (n) => (Array.isArray(raw(n)) ? raw(n) : [0, 0, 0]) as Vec3,
    bool: (n) => !!raw(n),
    str: (n) => (typeof raw(n) === "string" ? (raw(n) as string) : ""),
    ref: (n) => { const v = raw(n); return v && typeof v === "object" ? (v as any) : null; },
    prop: (n, d) => (n in props ? props[n] : d),
    resolve: (f, g, dom) => f.array(makeFieldCtx(g, dom)),
  };
  return h(api) as Record<string, SockVal>;
}

const curve = (points: Vec3[], cyclic: boolean): Geometry =>
  Object.assign(new Geometry(), { curves: [{ points, cyclic }] });

// ---- assertions -----------------------------------------------------------
let pass = 0, fail = 0;
const approx = (a: number[], b: number[], eps = 1e-4) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < eps);
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "   " + detail}`);
  cond ? pass++ : fail++;
}

// (A) CurveCircle: res=4, r=1 -> 4 pts, cyclic, +X start, CCW (Blender-correct)
{
  const c = runNode("GeometryNodeCurvePrimitiveCircle", { Resolution: 4, Radius: 1 }).Curve as Geometry;
  const s = c.curves[0];
  check("CurveCircle res=4 -> 4 cyclic pts", s.points.length === 4 && s.cyclic === true, `got ${s.points.length}`);
  check("CurveCircle p0=(1,0,0)", approx(s.points[0], [1, 0, 0]));
  check("CurveCircle p1=(0,1,0) CCW", approx(s.points[1], [0, 1, 0]), JSON.stringify(s.points[1]));
}

// (B) CombineXYZ / SeparateXYZ round-trip
{
  const v = runNode("ShaderNodeCombineXYZ", { X: 2, Y: 3, Z: 4 }).Vector as Field;
  check("CombineXYZ -> (2,3,4)", approx(v.value as number[], [2, 3, 4]));
}

// (C) MeshCube size (1,1,1) -> 8 verts, spans +/-0.5
{
  const g = runNode("GeometryNodeMeshCube", { Size: [1, 1, 1], "Vertices X": 2, "Vertices Y": 2, "Vertices Z": 2 }).Mesh as Geometry;
  const xs = g.mesh!.positions.map((p) => p[0]);
  check("MeshCube -> 8 verts", g.mesh!.positions.length === 8);
  check("MeshCube spans +/-0.5", Math.abs(Math.min(...xs) + 0.5) < 1e-6 && Math.abs(Math.max(...xs) - 0.5) < 1e-6);
}

// (D) FilletCurve: 90deg open corner A(0,0,0) B(1,0,0) C(1,1,0), radius .5, count 2
{
  const f = runNode("GeometryNodeFilletCurve", { Curve: curve([[0, 0, 0], [1, 0, 0], [1, 1, 0]], false), Radius: 0.5, Count: 2 }).Curve as Geometry;
  const fp = f.curves[0].points;
  check("FilletCurve -> 5 pts (endpoint + arc + endpoint)", fp.length === 5, `got ${fp.length}`);
  check("FilletCurve endpoints preserved", approx(fp[0], [0, 0, 0]) && approx(fp[4], [1, 1, 0]));
  check("FilletCurve tangent pt on BA = (0.5,0,0)", approx(fp[1], [0.5, 0, 0]), JSON.stringify(fp[1]));
  check("FilletCurve arc mid = (0.85355,0.14645,0)", approx(fp[2], [0.85355, 0.14645, 0]), JSON.stringify(fp[2]));
  check("FilletCurve tangent pt on BC = (1,0.5,0)", approx(fp[3], [1, 0.5, 0]), JSON.stringify(fp[3]));
}

// (E) CurveToMesh: straight Z rail (open) + diamond profile (cyclic), no caps
{
  const rail = curve([[0, 0, 0], [0, 0, 2]], false);
  const prof = curve([[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]], true);
  const m = (runNode("GeometryNodeCurveToMesh", { Curve: rail, "Profile Curve": prof, "Fill Caps": false }).Mesh as Geometry).mesh!;
  check("CurveToMesh -> 8 verts / 4 faces", m.positions.length === 8 && m.faces.length === 4, `got ${m.positions.length}v/${m.faces.length}f`);
  const zs = m.positions.map((p) => p[2]);
  check("CurveToMesh spans rail z 0..2", Math.abs(Math.min(...zs)) < 1e-6 && Math.abs(Math.max(...zs) - 2) < 1e-6);
}

// (F) FillCurve NGON: triangle -> 1 face, 3 verts
{
  const g = runNode("GeometryNodeFillCurve", { Curve: curve([[0, 0, 0], [1, 0, 0], [0, 1, 0]], true) }, { mode: "NGONS" }).Mesh as Geometry;
  check("FillCurve NGON triangle -> 1 face", g.mesh!.faces.length === 1 && g.mesh!.positions.length === 3);
}

// (G) SetPosition with linked offset moves points
{
  const grid = runNode("GeometryNodeMeshGrid", { "Size X": 2, "Size Y": 2, "Vertices X": 2, "Vertices Y": 2 }).Mesh as Geometry;
  const moved = runNode("GeometryNodeSetPosition", { Geometry: grid, Selection: true, Position: [0, 0, 0], Offset: [0, 0, 5] }, {}, ["Offset"]).Geometry as Geometry;
  check("SetPosition offset z+5", moved.mesh!.positions.every((p) => Math.abs(p[2] - 5) < 1e-6));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
