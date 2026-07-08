// Per-node test harness for the GN-VM (inspired by ThreeGN's per-node tests, but
// built against our EvalAPI directly — no graph machinery needed).
// Run: npx tsx tools/gnvm-nodetest.ts
import { Field, Vec3 } from "../src/gnvm/core";
import { Geometry, Mesh } from "../src/gnvm/geometry";
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

// (H) Switch: linked numeric fields convert to bool with Blender's >0 rule
{
  const sw = Field.perElem((i) => i - 1);
  const out = runNode("GeometryNodeSwitch", { Switch: sw, False: 10, True: 20 }, { input_type: "FLOAT" }).Output as Field;
  const arr = out.array({ size: 3, domain: "POINT" });
  check("Switch field uses >0 truthiness", approx(arr as number[], [10, 10, 20]));
}

// (I) Mix RGBA: dumped graphs link the active output as Result_Color
{
  const mixed = runNode("ShaderNodeMix", { Factor_Float: 0.25, A_Color: [0, 0, 0], B_Color: [4, 8, 12] }, { data_type: "RGBA" }).Result_Color as Field;
  check("Mix RGBA exposes Result_Color", approx(mixed.value as number[], [1, 2, 3]));
}

// (J) FieldAtIndex samples Value on its declared source domain, not the consumer domain
{
  const value = Field.perElem((i) => i * 10);
  const index = Field.perElem((i) => i + 1);
  const out = runNode("GeometryNodeFieldAtIndex", { Value: value, Index: index }, { domain: "POINT" }).Value as Field;
  const arr = out.array({
    size: 2,
    domain: "FACE",
    fork: (domain) => ({ size: domain === "POINT" ? 4 : 2, domain }),
  });
  check("FieldAtIndex samples source domain", approx(arr as number[], [10, 20]));
}

// (K) MeshToCurve carries FACE attrs to curve POINT attrs for captured factors
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  m.faces = [[0, 1, 2, 3]];
  m.faceMaterial = [0];
  m.attributes.set("split", { domain: "FACE", data: [[0.25, 0.75, 0]] });
  const g = new Geometry();
  g.mesh = m;
  const c = runNode("GeometryNodeMeshToCurve", { Mesh: g }).Curve as Geometry;
  const carried = c.curveAttributes.get("split")?.data ?? [];
  check("MeshToCurve maps FACE attr to curve points", carried.length === 4 && carried.every((v) => approx(v as number[], [0.25, 0.75, 0])));
}

// (L) MergeByDistance welds duplicated quad seams and carries attrs/materials
{
  const m = new Mesh();
  m.positions = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [1, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0],
  ];
  m.faces = [[0, 1, 2, 3], [4, 5, 6, 7]];
  m.edges = [[1, 4], [4, 7], [1, 2], [5, 6]];
  m.faceMaterial = [1, 2];
  m.materialSlots = [null, "left", "right"];
  m.attributes.set("pid", { domain: "POINT", data: [0, 1, 2, 3, 4, 5, 6, 7] });
  m.attributes.set("fid", { domain: "FACE", data: [100, 200] });
  m.attributes.set("cid", { domain: "CORNER", data: [10, 11, 12, 13, 20, 21, 22, 23] });
  const g = new Geometry();
  g.mesh = m;
  const out = runNode("GeometryNodeMergeByDistance", { Geometry: g, Selection: true, Distance: 1e-4, Mode: "All" }).Geometry as Geometry;
  const om = out.mesh!;
  const edgeKeys = om.edges.map(([a, b]) => (a < b ? `${a}_${b}` : `${b}_${a}`)).sort();
  check("MergeByDistance welds two quad seam verts", om.positions.length === 6 && om.faces.length === 2, `got ${om.positions.length}v/${om.faces.length}f`);
  check("MergeByDistance carries POINT attrs from first reps", approx(om.attributes.get("pid")!.data as number[], [0, 1, 2, 3, 5, 6]));
  check("MergeByDistance carries FACE attrs/materials", approx(om.attributes.get("fid")!.data as number[], [100, 200]) && approx(om.faceMaterial, [1, 2]));
  check("MergeByDistance carries CORNER attrs and remaps edges", approx(om.attributes.get("cid")!.data as number[], [10, 11, 12, 13, 20, 21, 22, 23]) && edgeKeys.join(",") === "1_2,4_5");
  check("MergeByDistance preserves material slots", JSON.stringify(om.materialSlots) === JSON.stringify([null, "left", "right"]));
}

// (M) MergeByDistance selection=false vertices do not participate in welding
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [0, 0, 0]];
  m.edges = [[0, 1]];
  const g = new Geometry();
  g.mesh = m;
  const sel = Field.perElem((i) => (i === 0 ? 1 : 0));
  const out = runNode("GeometryNodeMergeByDistance", { Geometry: g, Selection: sel, Distance: 1e-4, Mode: "All" }).Geometry as Geometry;
  check("MergeByDistance leaves unselected coincident verts separate", out.mesh!.positions.length === 2 && out.mesh!.edges.length === 1);
}

// (N) MergeByDistance checks neighboring hash cells
{
  const d = 1e-5;
  const m = new Mesh();
  m.positions = [[0.49 * d, 0, 0], [1.01 * d, 0, 0]];
  const g = new Geometry();
  g.mesh = m;
  const out = runNode("GeometryNodeMergeByDistance", { Geometry: g, Selection: true, Distance: d, Mode: "All" }).Geometry as Geometry;
  const crossesCell = Math.floor(m.positions[0][0] / d) !== Math.floor(m.positions[1][0] / d);
  check("MergeByDistance merges cross-cell pair within distance", crossesCell && out.mesh!.positions.length === 1, `got ${out.mesh!.positions.length} verts`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
