// Per-node test harness for the GN-VM (inspired by ThreeGN's per-node tests, but
// built against our EvalAPI directly — no graph machinery needed).
// Run: npx tsx tools/gnvm-nodetest.ts
import { Field, Vec3 } from "../src/gnvm/core";
import { Geometry, Mesh, orientClosedSurface, toTriSoup, topologyOf } from "../src/gnvm/geometry";
import { DUMP_CONTEXT, EvalAPI, REGISTRY, SockVal, RawSocket } from "../src/gnvm/registry";
import { Evaluator, makeFieldCtx } from "../src/gnvm/evaluator";
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

const curves = (items: { points: Vec3[]; cyclic: boolean }[]): Geometry =>
  Object.assign(new Geometry(), { curves: items });

const box = (min: Vec3, max: Vec3): Geometry => {
  const m = new Mesh();
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  m.positions = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  m.faces = [
    [0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1],
    [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0],
  ];
  m.faceMaterial = m.faces.map(() => 0);
  m.materialSlots = [null];
  const g = new Geometry();
  g.mesh = m;
  return g;
};

const openCylinder = (segments: number, zs: number[], radius: number): Geometry => {
  const m = new Mesh();
  for (const z of zs) {
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      m.positions.push([Math.cos(a) * radius, Math.sin(a) * radius, z]);
    }
  }
  for (let r = 0; r + 1 < zs.length; r++) {
    const base = r * segments;
    const next = (r + 1) * segments;
    for (let i = 0; i < segments; i++) {
      m.faces.push([base + i, base + ((i + 1) % segments), next + ((i + 1) % segments), next + i]);
      m.faceMaterial.push(0);
    }
  }
  m.materialSlots = [null];
  const g = new Geometry();
  g.mesh = m;
  return g;
};

// ---- assertions -----------------------------------------------------------
let pass = 0, fail = 0;
const approx = (a: number[], b: number[], eps = 1e-4) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < eps);
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "   " + detail}`);
  cond ? pass++ : fail++;
}

function meshSignedAreaXY(m: Mesh): number {
  let area = 0;
  for (const f of m.faces) {
    for (let i = 0; i < f.length; i++) {
      const p = m.positions[f[i]];
      const q = m.positions[f[(i + 1) % f.length]];
      area += p[0] * q[1] - q[0] * p[1];
    }
  }
  return area * 0.5;
}

// (A) CurveCircle: res=4, r=1 -> 4 pts, cyclic, +X start, CCW (Blender-correct)
{
  const c = runNode("GeometryNodeCurvePrimitiveCircle", { Resolution: 4, Radius: 1 }).Curve as Geometry;
  const s = c.curves[0];
  check("CurveCircle res=4 -> 4 cyclic pts", s.points.length === 4 && s.cyclic === true, `got ${s.points.length}`);
  check("CurveCircle p0=(1,0,0)", approx(s.points[0], [1, 0, 0]));
  check("CurveCircle p1=(0,1,0) CCW", approx(s.points[1], [0, 1, 0]), JSON.stringify(s.points[1]));
}

{
  const arc = runNode("GeometryNodeCurveArc", {
    Resolution: 4, Radius: 2, "Start Angle": 0, "Sweep Angle": Math.PI / 2,
    "Connect Center": true, "Invert Arc": false,
  }, { mode: "RADIUS" }).Curve as Geometry;
  check("Curve Arc connects center into a cyclic fill loop", arc.curves[0].cyclic && arc.curves[0].points.length === 5);
  check("Curve Arc preserves radius endpoints", approx(arc.curves[0].points[0], [2, 0, 0]) && approx(arc.curves[0].points[3], [0, 2, 0]));
}

// (B) CombineXYZ / SeparateXYZ round-trip
{
  const v = runNode("ShaderNodeCombineXYZ", { X: 2, Y: 3, Z: 4 }).Vector as Field;
  check("CombineXYZ -> (2,3,4)", approx(v.value as number[], [2, 3, 4]));
}

// (B2) Align Euler antiparallel AUTO pivot remains a proper rotation. A tiny
// Mesh Circle cosine at -Y must not normalize to a zero axis / reflection.
{
  const rotation = runNode(
    "FunctionNodeAlignEulerToVector",
    { Vector: [-3.7e-16, -1, 0], Factor: 1 },
    { axis: "Y", pivot_axis: "AUTO" },
  ).Rotation as Field;
  const value = rotation.array({ size: 1, domain: "POINT" })[0] as Vec3;
  check("AlignEuler antiparallel Y uses stable Z pivot", Math.abs(Math.abs(value[2]) - Math.PI) < 1e-6 && Math.abs(value[0]) < 1e-6, JSON.stringify(value));
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

// (D2) Set Spline Type NURBS: open cubic smoothing approximates interior controls
{
  const c = runNode(
    "GeometryNodeCurveSplineType",
    { Curve: curve([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], false) },
    { spline_type: "NURBS" },
  ).Curve as Geometry;
  const pts = c.curves[0].points;
  const maxX = Math.max(...pts.map((p) => p[0]));
  check("SetSplineType NURBS uses Blender's non-zero knot spans", pts.length === 13, `got ${pts.length}`);
  check("SetSplineType NURBS endpoints preserved", approx(pts[0], [0, 0, 0]) && approx(pts[pts.length - 1], [0, 1, 0]));
  check("SetSplineType NURBS cuts inward from control corner", maxX < 0.76 && maxX > 0.74, `maxX=${maxX}`);
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

// Blender Grid is X-major, and Mesh to Curve follows its stored edge order.
{
  const grid = runNode("GeometryNodeMeshGrid", { "Size X": 2, "Size Y": 2, "Vertices X": 2, "Vertices Y": 2 }).Mesh as Geometry;
  check("MeshGrid uses Blender X-major vertex order", JSON.stringify(grid.mesh!.positions) === JSON.stringify([[-1, -1, 0], [-1, 1, 0], [1, -1, 0], [1, 1, 0]]));
  const boundary = runNode("GeometryNodeMeshToCurve", { Mesh: grid, Selection: true }).Curve as Geometry;
  check("MeshToCurve follows stored Grid edge order", JSON.stringify(boundary.curves[0]?.points) === JSON.stringify([[-1, -1, 0], [-1, 1, 0], [1, 1, 0], [1, -1, 0]]));
}

// (F) FillCurve NGON: triangle -> 1 face, 3 verts
{
  const g = runNode("GeometryNodeFillCurve", { Curve: curve([[0, 0, 0], [1, 0, 0], [0, 1, 0]], true) }, { mode: "NGONS" }).Mesh as Geometry;
  check("FillCurve NGON triangle -> 1 face", g.mesh!.faces.length === 1 && g.mesh!.positions.length === 3);
}

// (F2) FillCurve NGONS: single simple loop keeps exact ngon vertex order
{
  const pts: Vec3[] = [[-2, -1, 0], [2, -1, 0], [2, 1, 0], [-2, 1, 0]];
  const g = runNode("GeometryNodeFillCurve", { Curve: curve(pts, true) }, { mode: "NGONS" }).Mesh as Geometry;
  const m = g.mesh!;
  check("FillCurve NGON single loop keeps one ngon", m.faces.length === 1 && m.positions.length === 4);
  check("FillCurve NGON single loop preserves vertex order", JSON.stringify(m.faces[0]) === JSON.stringify([0, 1, 2, 3]) && m.positions.every((p, i) => approx(p, pts[i])));
}

// Fill Curve is defined in the curve component's local XY plane.
{
  const g = runNode("GeometryNodeFillCurve", { Curve: curve([[0, 0, -0.019], [1, 0, -0.019], [0, 1, -0.019]], true) }, { mode: "NGONS" }).Mesh as Geometry;
  check("FillCurve projects translated curves onto local XY", g.mesh!.positions.every((p) => Math.abs(p[2]) < 1e-9));
}

// (F3) FillCurve nested squares: inner loop is a hole and ring triangulates
{
  const outer: Vec3[] = [[-2, -2, 0], [2, -2, 0], [2, 2, 0], [-2, 2, 0]];
  const inner: Vec3[] = [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]];
  const g = runNode("GeometryNodeFillCurve", { Curve: curves([{ points: outer, cyclic: true }, { points: inner, cyclic: true }]) }, { mode: "TRIANGLES" }).Mesh as Geometry;
  const m = g.mesh!;
  check("FillCurve nested squares -> original loop verts only", m.positions.length === 8, `got ${m.positions.length}`);
  check("FillCurve nested squares -> triangles only", m.faces.length > 0 && m.faces.every((f) => f.length === 3));
  check("FillCurve nested squares area subtracts hole", Math.abs(meshSignedAreaXY(m) - 12) < 1e-6, `area=${meshSignedAreaXY(m)}`);
}

// (F4) FillCurve three-level nesting: middle is a hole, inner is an island
{
  const outer: Vec3[] = [[-3, -3, 0], [3, -3, 0], [3, 3, 0], [-3, 3, 0]];
  const middle: Vec3[] = [[-2, -2, 0], [2, -2, 0], [2, 2, 0], [-2, 2, 0]];
  const inner: Vec3[] = [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]];
  const g = runNode("GeometryNodeFillCurve", { Curve: curves([{ points: outer, cyclic: true }, { points: middle, cyclic: true }, { points: inner, cyclic: true }]) }, { mode: "TRIANGLES" }).Mesh as Geometry;
  const m = g.mesh!;
  check("FillCurve three-level nesting -> triangles only", m.faces.length > 0 && m.faces.every((f) => f.length === 3));
  check("FillCurve three-level nesting keeps inner island", Math.abs(meshSignedAreaXY(m) - 24) < 1e-6, `area=${meshSignedAreaXY(m)}`);
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

// (I2) MenuSwitch: string menu selects the matching enum item
{
  const out = runNode(
    "GeometryNodeMenuSwitch",
    { Menu: "Beta", Item_0: 10, Item_1: 20 },
    { data_type: "FLOAT", enum_items: [{ name: "Alpha" }, { name: "Beta" }] },
  ).Output as Field;
  check("MenuSwitch picks enum string item", out.value === 20, `got ${out.value}`);
}

// (I3) VectorRotate: axis-angle 90deg around +Z
{
  const out = runNode("ShaderNodeVectorRotate", { Vector: [1, 0, 0], Center: [0, 0, 0], Axis: [0, 0, 1], Angle: Math.PI / 2, Rotation: [0, 0, 0] }, { rotation_type: "AXIS_ANGLE", invert: false }).Vector as Field;
  check("VectorRotate axis-angle z90", approx(out.value as number[], [0, 1, 0]));
}

// (I4) TrimCurve: factor range interpolates endpoints on a straight segment
{
  const out = runNode("GeometryNodeTrimCurve", { Curve: curve([[0, 0, 0], [4, 0, 0]], false), Start: 0.25, End: 0.75, Start_001: 0, End_001: 1 }, { mode: "FACTOR" }).Curve as Geometry;
  const pts = out.curves[0].points;
  check("TrimCurve factor keeps two interpolated endpoints", pts.length === 2 && approx(pts[0], [1, 0, 0]) && approx(pts[1], [3, 0, 0]), JSON.stringify(pts));
}

// (I5) ScaleElements: one selected quad scales as an island about its center
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  m.faces = [[0, 1, 2, 3]];
  m.faceMaterial = [0];
  const g = new Geometry();
  g.mesh = m;
  const out = runNode("GeometryNodeScaleElements", { Geometry: g, Selection: true, Scale: 2, Center: [0, 0, 0], "Scale Mode": "Uniform", Axis: [1, 0, 0] }, { domain: "FACE" }).Geometry as Geometry;
  const p = out.mesh!.positions;
  check("ScaleElements quad scale 2 about center", approx(p[0], [-0.5, -0.5, 0]) && approx(p[2], [1.5, 1.5, 0]), JSON.stringify(p));
}

// (I6) AttributeStatistic: scalar mean/min/max on a known POINT attribute
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
  m.attributes.set("a", { domain: "POINT", data: [2, 4, 8] });
  const g = new Geometry();
  g.mesh = m;
  const attr = Field.perElem((i, ctx) => ctx.attr?.("a", i) ?? 0);
  const out = runNode("GeometryNodeAttributeStatistic", { Geometry: g, Selection: true, Attribute: attr }, { domain: "POINT", data_type: "FLOAT" });
  check("AttributeStatistic mean/min/max", (out.Mean as Field).value === 14 / 3 && (out.Min as Field).value === 2 && (out.Max as Field).value === 8);
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

// A collapsed long quad still carries a valid center-to-rim triangle after
// Blender's triangulation; the exporter must preserve that topology.
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [0, 0, 0], [10, 0, 0], [10, 1, 0]];
  m.faces = [[0, 1, 2, 3]];
  const g = new Geometry();
  g.mesh = m;
  const soup = toTriSoup(g);
  check("toTriSoup preserves a collapsed long fan quad", soup.indices.length === 6, `tris=${soup.indices.length / 3}`);
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

// (O) Derived topology is cached per Mesh instance and invalidated by clone mutation
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  m.faces = [[0, 1, 2, 3]];
  const t1 = topologyOf(m);
  const t2 = topologyOf(m);
  const c = m.clone();
  const ct1 = topologyOf(c);
  c.faces = [...c.faces, [0, 2, 3]];
  const ct2 = topologyOf(c);
  check("topologyOf returns same object for same mesh", t1 === t2);
  check("mutated clone gets fresh topology", ct1 !== ct2 && t1 !== ct2 && ct2.edges.length === 5, `edges=${ct2.edges.length}`);
}

// (O2) Vertex normals split opposing face-normal fans instead of canceling.
{
  const m = new Mesh();
  m.positions = [[1, 0, 0], [1, 1, 0], [1, 0, 1], [1, -1, 0], [1, 0, -1], [0, 0, 0]];
  m.faces = [[0, 2, 1], [0, 3, 2], [0, 4, 1], [0, 3, 4]];
  m.edges = [[0, 5]];
  const n = m.vertexNormals()[0];
  check("vertex normal chooses outward opposing fan", approx(n, [1, 0, 0]), JSON.stringify(n));
}

// (P) MeshBoolean respects Blender's FLOAT / EXACT solver selection.
{
  const { ensureManifold } = await import("../src/gnvm/boolean");
  await ensureManifold();

  // With a non-AABB cutter, FLOAT must retain its topology-preserving fallback
  // while EXACT is allowed to use Manifold's solid CSG.
  const a = box([-1, -1, -1], [1, 1, 1]);
  const tilted = box([-1, -1, -1], [1, 1, 1]);
  const c = Math.cos(Math.PI / 4), s = Math.sin(Math.PI / 4);
  tilted.mesh!.positions = tilted.mesh!.positions.map(([x, y, z]) => [
    x * c - y * s + 0.75,
    x * s + y * c,
    z,
  ]);
  const floatInter = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": a, "Mesh 2": tilted },
    { operation: "INTERSECT", solver: "FLOAT" },
  ).Mesh as Geometry;
  const floatMinX = Math.min(...floatInter.mesh!.positions.map((p) => p[0]));
  check("MeshBoolean FLOAT keeps non-AABB input topology", floatInter.mesh!.faces.length === a.mesh!.faces.length && floatMinX === -1, `faces=${floatInter.mesh!.faces.length} minX=${floatMinX}`);

  const exactInter = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": a, "Mesh 2": tilted },
    { operation: "INTERSECT", solver: "EXACT" },
  ).Mesh as Geometry;
  const exactMinX = Math.min(...exactInter.mesh!.positions.map((p) => p[0]));
  check("MeshBoolean EXACT uses solid CSG", exactInter.mesh!.faces.length > 0 && exactMinX > -0.99, `faces=${exactInter.mesh!.faces.length} minX=${exactMinX}`);

  // FLOAT still clips an axis-aligned box using the local fallback.
  const solid = box([-1, -1, -1], [1, 1, 1]);
  const cutter = box([-2, -2, 0], [2, 2, 2]); // 8 verts, 6 faces — axis box
  const clipped = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": solid, "Mesh 2": cutter },
    { operation: "INTERSECT", solver: "FLOAT" },
  ).Mesh as Geometry;
  const m = clipped.mesh!;
  const maxZ = Math.max(...m.positions.map((p) => p[2]));
  const minZ = Math.min(...m.positions.map((p) => p[2]));
  check("MeshBoolean box INTERSECT keeps upper half", minZ >= -1e-3 && maxZ <= 1 + 1e-3 && m.faces.length > 0, `z=[${minZ},${maxZ}] f=${m.faces.length}`);

  // A clipped hollow shell has two large nested boundary loops. FLOAT should
  // bridge them with an annulus at the cutter plane, not leave a jagged open
  // rim and not fill the inner opening with a disk.
  const tube = new Geometry();
  const tm = new Mesh();
  const segments = 12;
  const zs = [-1, -0.2, 0.2];
  for (const radius of [2, 1]) for (const z of zs) for (let i = 0; i < segments; i++) {
    const angle = i / segments * Math.PI * 2;
    tm.positions.push([Math.cos(angle) * radius, Math.sin(angle) * radius, z]);
  }
  const ring = (inner: number, zi: number, i: number) => ((inner * zs.length + zi) * segments + i);
  for (const inner of [0, 1]) for (let zi = 0; zi + 1 < zs.length; zi++) for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const face = [ring(inner, zi, i), ring(inner, zi, j), ring(inner, zi + 1, j), ring(inner, zi + 1, i)];
    tm.faces.push(inner ? face.reverse() : face);
    tm.faceMaterial.push(0);
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    tm.faces.push([ring(0, 0, i), ring(1, 0, i), ring(1, 0, j), ring(0, 0, j)]);
    tm.faceMaterial.push(0);
  }
  tube.mesh = tm;
  const tubeClip = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": tube, "Mesh 2": box([-3, -3, -2], [3, 3, 0]) },
    { operation: "INTERSECT", solver: "FLOAT" },
  ).Mesh as Geometry;
  const cutFaces = tubeClip.mesh!.faces.filter((f) => {
    const zs = f.map((vi) => tubeClip.mesh!.positions[vi][2]);
    return Math.max(...zs) - Math.min(...zs) < 1e-6 && Math.max(...zs) > -0.5;
  });
  const cutMinRadius = Math.min(...cutFaces.flatMap((f) => f.map((vi) => Math.hypot(tubeClip.mesh!.positions[vi][0], tubeClip.mesh!.positions[vi][1]))));
  check("MeshBoolean FLOAT caps a clipped hollow shell with an annulus", cutFaces.length > 0 && cutMinRadius > 0.9, `faces=${cutFaces.length} minRadius=${cutMinRadius}`);

  // EXACT gracefully falls back when Manifold rejects an open shell.
  const cyl = openCylinder(12, [-2, -1, 0.5, 1.5], 1);
  const openClip = runNode(
    "GeometryNodeMeshBoolean",
    { "Mesh 1": cyl, "Mesh 2": box([-2, -2, 0], [2, 2, 2]) },
    { operation: "INTERSECT", solver: "EXACT" },
  ).Mesh as Geometry;
  check("MeshBoolean open-shell INTERSECT non-empty", (openClip.mesh?.faces.length ?? 0) > 0, `faces=${openClip.mesh?.faces.length}`);
}

// (Q) Critical-path: ValueToString / StringJoin / StringToCurves
{
  const s = runNode("FunctionNodeValueToString", { Value: 12.6, Decimals: 0 }).String as string;
  check("ValueToString decimals=0 truncates", s === "12", `got ${s}`);
  const s2 = runNode("FunctionNodeValueToString", { Value: Math.PI, Decimals: 2 }).String as string;
  check("ValueToString decimals=2", s2 === "3.14", `got ${s2}`);
  // Multi-input join via direct REGISTRY harness: inputs() returns one value per key;
  // exercise the handler by feeding a synthetic multi-input through a custom api below.
  const joinH = REGISTRY.get("GeometryNodeStringJoin")!;
  const joinOut = joinH({
    node: { name: "j", type: "GeometryNodeStringJoin", label: null, inputs: [
      { name: "Delimiter", identifier: "Delimiter", type: "NodeSocketString", linked: false, value: ":" },
      { name: "Strings", identifier: "Strings", type: "NodeSocketString", linked: true, value: null },
    ], outputs: [], props: {} },
    input: (n) => (n === "Delimiter" ? ":" : ""),
    inputs: (n) => (n === "Strings" ? ["W", "12"] : n === "Delimiter" ? [":"] : []),
    geoInputs: () => [],
    geo: () => new Geometry(),
    field: () => Field.of(0),
    num: () => 0,
    vec: () => [0, 0, 0],
    bool: () => false,
    str: (n) => (n === "Delimiter" ? ":" : ""),
    ref: () => null,
    prop: (_n, d) => d,
    resolve: (f, g, dom) => f.array(makeFieldCtx(g, dom)),
  }) as Record<string, SockVal>;
  check("StringJoin joins with delimiter", joinOut.String === "W:12", `got ${joinOut.String}`);

  const curves = runNode("GeometryNodeStringToCurves", { String: "AB", Size: 1, "Character Spacing": 1, "Word Spacing": 1, "Line Spacing": 1 }, { align_x: "LEFT" })["Curve Instances"] as Geometry;
  check("StringToCurves yields one instance per char", curves.instances.length === 2, `got ${curves.instances.length}`);
  check("StringToCurves instances carry glyph curves", curves.instances.every((inst) => inst.geometry.curves.length > 0));
}

// (R) InputTangent on a straight curve segment
{
  const c = curve([[0, 0, 0], [2, 0, 0], [4, 0, 0]], false);
  const tan = runNode("GeometryNodeInputTangent", {}).Tangent as Field;
  const arr = tan.array(makeFieldCtx(c, "POINT")) as number[][];
  check("InputTangent mid-point ~ +X", arr.length === 3 && approx(arr[1] as number[], [1, 0, 0]), JSON.stringify(arr[1]));
}

// (S) MeshCone frustum
{
  const cone = runNode("GeometryNodeMeshCone", {
    Vertices: 8, "Side Segments": 1, "Fill Segments": 1,
    "Radius Top": 0, "Radius Bottom": 1, Depth: 2,
  }, { fill_type: "NGON" }).Mesh as Geometry;
  const m = cone.mesh!;
  check("MeshCone has verts and faces", m.positions.length >= 9 && m.faces.length >= 8, `v=${m.positions.length} f=${m.faces.length}`);
  const zs = m.positions.map((p) => p[2]);
  check("MeshCone spans depth +/-1", Math.abs(Math.min(...zs) + 1) < 1e-6 && Math.abs(Math.max(...zs) - 1) < 1e-6);
}

// (T) FloatToInt floor mode
{
  const out = runNode("FunctionNodeFloatToInt", { Float: 3.9 }, { rounding_mode: "FLOOR" }).Integer as Field;
  check("FloatToInt FLOOR 3.9 -> 3", out.value === 3, `got ${out.value}`);
}

// (U) CornersOfFace on a quad: unlinked face index uses context index
{
  const m = new Mesh();
  m.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [2, 0, 0], [3, 0, 0], [3, 1, 0], [2, 1, 0]];
  m.faces = [[0, 1, 2, 3], [4, 5, 6, 7]];
  m.faceMaterial = [0, 0];
  const g = new Geometry();
  g.mesh = m;
  // Build API with unlinked Face Index
  const h = REGISTRY.get("GeometryNodeCornersOfFace")!;
  const result = h({
    node: {
      name: "c", type: "GeometryNodeCornersOfFace", label: null,
      inputs: [
        { name: "Face Index", identifier: "Face Index", type: "NodeSocketInt", linked: false, value: 0 },
        { name: "Weights", identifier: "Weights", type: "NodeSocketFloat", linked: false, value: 0 },
        { name: "Sort Index", identifier: "Sort Index", type: "NodeSocketInt", linked: false, value: 0 },
      ],
      outputs: [], props: {},
    },
    input: () => Field.of(0),
    inputs: () => [],
    geoInputs: () => [],
    geo: () => g,
    field: (n) => Field.of(n === "Sort Index" ? 0 : 0),
    num: () => 0,
    vec: () => [0, 0, 0],
    bool: () => false,
    str: () => "",
    ref: () => null,
    prop: (_n, d) => d,
    resolve: (f, geo, dom) => f.array(makeFieldCtx(geo, dom)),
  }) as Record<string, SockVal>;
  const corner = result["Corner Index"] as Field;
  const total = result.Total as Field;
  const ctx = makeFieldCtx(g, "FACE");
  const corners = corner.array(ctx) as number[];
  const totals = total.array(ctx) as number[];
  check("CornersOfFace totals are 4 per quad", totals[0] === 4 && totals[1] === 4, JSON.stringify(totals));
  check("CornersOfFace corner indices start each face", corners[0] === 0 && corners[1] === 4, JSON.stringify(corners));
}

// (V) SubdivisionSurface densifies a cube
{
  const cube = runNode("GeometryNodeMeshCube", { Size: [1, 1, 1], "Vertices X": 2, "Vertices Y": 2, "Vertices Z": 2 }).Mesh as Geometry;
  const before = cube.mesh!.faces.length;
  const sub = runNode("GeometryNodeSubdivisionSurface", { Mesh: cube, Level: 1 }).Mesh as Geometry;
  check("SubdivisionSurface densifies faces", (sub.mesh?.faces.length ?? 0) > before, `before=${before} after=${sub.mesh?.faces.length}`);
  check("SubdivisionSurface densifies verts", (sub.mesh?.positions.length ?? 0) > 8, `verts=${sub.mesh?.positions.length}`);
}

// (W) SMOOTH_MIN is softer than min; unknown VectorMath is not ADD
{
  // |a-b| < k so the smooth term subtracts from min
  const sm = runNode("ShaderNodeMath", { Value: 0.4, Value_001: 0.5, Value_002: 0.5 }, { operation: "SMOOTH_MIN" }).Value as Field;
  const mn = runNode("ShaderNodeMath", { Value: 0.4, Value_001: 0.5, Value_002: 0.5 }, { operation: "MINIMUM" }).Value as Field;
  check("SMOOTH_MIN finite and < raw min for close values", Number.isFinite(sm.value as number) && (sm.value as number) < (mn.value as number), `smooth=${sm.value} min=${mn.value}`);
  const unk = runNode("ShaderNodeVectorMath", { Vector: [1, 2, 3], Vector_001: [10, 20, 30] }, { operation: "NOT_A_REAL_OP" }).Vector as Field;
  const got = unk.value as number[];
  check("unknown VectorMath does not ADD", !approx(got, [11, 22, 33]) && approx(got, [1, 2, 3]), JSON.stringify(got));
}

// (X) A linked float entering a group Int socket is rounded at the boundary.
// Spin uses the same socket both for Repeat Input's count and its angle divisor;
// retaining the incoming fraction in only the divisor leaves a closure gap.
{
  const socket = (name: string, identifier: string, in_out: "INPUT" | "OUTPUT", socket_type: string, dflt = 0) => ({ name, identifier, item_type: "SOCKET", in_out, socket_type, default: dflt });
  const program: any = {
    inner: {
      name: "inner", type: "GeometryNodeTree",
      interface: [socket("Steps", "Steps", "INPUT", "NodeSocketInt"), socket("Result", "Result", "OUTPUT", "NodeSocketInt")],
      nodes: [
        { name: "Group Input", type: "NodeGroupInput", label: null, inputs: [], outputs: [{ name: "Steps", identifier: "Steps" }], props: {} },
        { name: "Group Output", type: "NodeGroupOutput", label: null, inputs: [{ name: "Result", identifier: "Result", type: "NodeSocketInt", linked: true, value: null }], outputs: [], props: {} },
      ],
      links: [{ from_node: "Group Input", from_socket: "Steps", to_node: "Group Output", to_socket: "Result" }],
    },
    outer: {
      name: "outer", type: "GeometryNodeTree",
      interface: [socket("Density", "Density", "INPUT", "NodeSocketFloat"), socket("Result", "Result", "OUTPUT", "NodeSocketInt")],
      nodes: [
        { name: "Group Input", type: "NodeGroupInput", label: null, inputs: [], outputs: [{ name: "Density", identifier: "Density" }], props: {} },
        { name: "Inner", type: "GeometryNodeGroup", label: null, group: "inner", inputs: [{ name: "Steps", identifier: "Steps", type: "NodeSocketInt", linked: true, value: null }], outputs: [{ name: "Result", identifier: "Result" }], props: {} },
        { name: "Group Output", type: "NodeGroupOutput", label: null, inputs: [{ name: "Result", identifier: "Result", type: "NodeSocketInt", linked: true, value: null }], outputs: [], props: {} },
      ],
      links: [
        { from_node: "Group Input", from_socket: "Density", to_node: "Inner", to_socket: "Steps" },
        { from_node: "Inner", from_socket: "Result", to_node: "Group Output", to_socket: "Result" },
      ],
    },
  };
  const result = new Evaluator(program).evalGroup("outer", { Density: Field.of(349.38) }).Result as Field;
  check("Group input coerces linked float to Int", result.value === 349, `got ${result.value}`);
}

// (Y) Repeated EDGE extrude must carry the source profile's direction through
// every new top edge. Spin rotates that top edge and welds the last ring to the
// first; alternating the direction makes the two faces at an odd-step closure
// both point inward, producing a bad seam normal after Solidify.
{
  const m = new Mesh();
  // At -X, a top-to-bottom profile extruded around +Z produces outward faces.
  m.positions = [[-1, 0, 3], [-1, 0, 2], [-1, 0, 1], [-1, 0, 0]];
  m.edges = [[0, 1], [1, 2], [2, 3]];
  let spun = new Geometry();
  spun.mesh = m;
  let selection: Field = Field.of(1);
  const steps = 5;
  const angle = (Math.PI * 2) / steps;
  const turn = Field.perElem((i, ctx) => {
    const [x, y, z] = ctx.position?.(i) ?? [0, 0, 0];
    return [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), z];
  });
  for (let step = 0; step < steps; step++) {
    const extruded = runNode(
      "GeometryNodeExtrudeMesh",
      { Mesh: spun, Selection: selection, Offset: [0, 0, 0], "Offset Scale": 0, Individual: true },
      { mode: "EDGES" },
    );
    spun = extruded.Mesh as Geometry;
    selection = extruded.Top as Field;
    spun = runNode(
      "GeometryNodeSetPosition",
      { Geometry: spun, Selection: selection, Position: turn, Offset: [0, 0, 0] },
      {},
      ["Position"],
    ).Geometry as Geometry;
  }
  spun = runNode(
    "GeometryNodeMergeByDistance",
    { Geometry: spun, Selection: true, Distance: 1e-4, Mode: "All" as any },
  ).Geometry as Geometry;
  spun = runNode("GeometryNodeFlipFaces", { Mesh: spun, Selection: true }).Mesh as Geometry;
  const sm = spun.mesh!;
  const radialDots = sm.faces.map((f, fi) => {
    const c = sm.faceCenter(fi);
    const n = sm.faceNormal(fi);
    return { z: c[2], dot: c[0] * n[0] + c[1] * n[1] };
  }).filter(({ z }) => z > 1 && z < 2).map(({ dot }) => dot);
  check(
    "repeated EDGE extrude keeps outward winding through closure",
    sm.faces.length === 15 && radialDots.length === steps && radialDots.every((d) => d > 0.5),
    `faces=${sm.faces.length} radialDots=${radialDots.map((d) => d.toFixed(3)).join(",")}`,
  );
  check(
    "repeated EDGE extrude weld has no boundary seam",
    topologyOf(sm).edges.every((e) => {
      const [a, b] = e.verts;
      const crossesProfile = Math.abs(sm.positions[a][2] - sm.positions[b][2]) > 0.5;
      return !crossesProfile || e.faces.length === 2;
    }),
  );
  const ringAt = (z: number) => sm.positions
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => Math.abs(p[2] - z) < 1e-6)
    .sort((a, b) => Math.atan2(a.p[1], a.p[0]) - Math.atan2(b.p[1], b.p[0]))
    .map(({ i }) => i);
  sm.faces.push(ringAt(3), ringAt(0).reverse());
  sm.faceMaterial.push(0, 0);
  const repairedFaces = orientClosedSurface(sm);
  const directedEdges = new Map<string, { direction: number; face: number }[]>();
  for (let fi = 0; fi < sm.faces.length; fi++) {
    const face = sm.faces[fi];
    for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const directions = directedEdges.get(key) ?? [];
      directions.push({ direction: a < b ? 1 : -1, face: fi });
      directedEdges.set(key, directions);
    }
  }
  const windingConflicts = [...directedEdges.entries()].filter(
    ([, edges]) => edges.length === 2 && edges[0].direction === edges[1].direction,
  );
  check(
    "closed repeated EDGE extrude repairs endpoint-strip winding",
    repairedFaces > 0 && windingConflicts.length === 0 && topologyOf(sm).edges.every((edge) => edge.faces.length === 2),
    `repaired=${repairedFaces} conflicts=${windingConflicts.length} ${JSON.stringify(windingConflicts.slice(0, 6))}`,
  );
}

// (Z) A realized geometry set may retain an allocated empty Mesh alongside
// populated curves. Field evaluation must select the populated component.
{
  const mixed = curve([[0, 0, 0], [1, 0, 0], [2, 0, 0]], false);
  mixed.mesh = new Mesh();
  const ctx = makeFieldCtx(mixed, "POINT");
  const split = runNode(
    "GeometryNodeSeparateGeometry",
    { Geometry: mixed, Selection: Field.of(1) },
    { domain: "POINT" },
  ).Selection as Geometry;
  check("empty mesh does not mask populated curve field domain", ctx.size === 3, `size=${ctx.size}`);
  check("Separate Geometry retains curve points beside empty mesh", split.curvePointCount() === 3, `points=${split.curvePointCount()}`);
}

// (AA) String nodes use Unicode characters rather than UTF-16 code units.
{
  const length = runNode("FunctionNodeStringLength", { String: "A🙂B" }).Length as Field;
  const slice = runNode("FunctionNodeSliceString", { String: "A🙂BC", Position: 1, Length: 2 }).String;
  const special = runNode("FunctionNodeInputSpecialCharacters", {});
  check("String Length counts Unicode characters", length.value === 3, `length=${length.value}`);
  check("Slice String extracts Unicode characters", slice === "🙂B", `slice=${String(slice)}`);
  check("Special Characters exposes newline and tab", special["Line Break"] === "\n" && special.Tab === "\t");
}

// (AB) Length-mode curve resampling floors the number of fitted segments and
// includes both endpoints. This is the count rule used by Periodic Brush.
{
  const source = curve([[0, 0, 0], [4.9, 0, 0]], false);
  const sampled = runNode("GeometryNodeResampleCurve", { Curve: source, Mode: "Length" as any, Count: 12, Length: 2 }).Curve as Geometry;
  check("Resample Curve length mode floors fitted segments", sampled.curvePointCount() === 3, `points=${sampled.curvePointCount()}`);
}

// (AC) Blender 5 treats an instances component as position-bearing points.
{
  const payload = box([0, 0, 0], [1, 1, 1]);
  const instances = new Geometry();
  instances.instances = [0, 1, 2].map((i) => ({ geometry: payload, position: [i, 0, 0] as Vec3, rotation: [0, 0, 0], scale: [1, 1, 1] }));
  const moved = runNode("GeometryNodeSetPosition", {
    Geometry: instances,
    Selection: true,
    Position: [0, 0, 0],
    Offset: Field.perElem((i) => [0, 0, i * .01]),
  }).Geometry as Geometry;
  check("Set Position offsets instance points", approx(moved.instances[2].position, [2, 0, .02]));
}

// (AD) Collection Info materializes evaluated child geometry as pickable
// instances and Reset Children strips authored object transforms.
{
  const savedObjects = DUMP_CONTEXT.objects;
  const savedCollections = DUMP_CONTEXT.collections;
  DUMP_CONTEXT.objects = [
    { name: "dot-a", location: [5, 0, 0], evaluated_mesh: { verts: [[0, 0, 0]], faces: [] } },
    { name: "dot-b", location: [8, 0, 0], evaluated_mesh: { verts: [[1, 0, 0]], faces: [] } },
  ];
  DUMP_CONTEXT.collections = [{ name: "period pack", objects: ["dot-a", "dot-b"] }];
  const collection = runNode("GeometryNodeCollectionInfo", {
    Collection: { datablock: "Collection", name: "period pack" },
    "Separate Children": true,
    "Reset Children": true,
  }).Instances as Geometry;
  check("Collection Info emits one instance per evaluated child", collection.instances.length === 2, `instances=${collection.instances.length}`);
  check("Collection Info Reset Children clears transforms", collection.instances.every((instance) => approx(instance.position, [0, 0, 0])));
  DUMP_CONTEXT.objects = savedObjects;
  DUMP_CONTEXT.collections = savedCollections;
}

// (AE) Curve Tilt is a point field, and an unlinked Instance Index cycles the
// Geometry-to-Instance list in Blender's authored Flat Stickie Pack.
{
  const points = curve([[0, 0, 0], [2, 0, 0]], false);
  points.curveAttributes.set("tilt", { domain: "POINT", data: [.2, -.4] });
  const tilt = runNode("GeometryNodeInputCurveTilt", {}).Tilt as Field;
  check("Curve Tilt reads curve point attributes", approx(tilt.array(makeFieldCtx(points, "POINT")) as number[], [.2, -.4]));
  const sourceA = box([0, 0, 0], [1, 1, 1]);
  const sourceB = box([0, 0, 0], [2, 2, 2]);
  const choices = new Geometry();
  choices.instances = [sourceA, sourceB].map((geometry) => ({ geometry, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }));
  const placed = runNode("GeometryNodeInstanceOnPoints", {
    Points: points, Selection: true, Instance: choices, "Pick Instance": true,
    "Instance Index": 0, Rotation: [0, 0, 0], Scale: [1, 1, 1],
  }, {}, ["Points", "Instance"]).Instances as Geometry;
  check("unlinked Pick Instance index cycles by point", placed.instances[0].geometry === sourceA && placed.instances[1].geometry === sourceB);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
