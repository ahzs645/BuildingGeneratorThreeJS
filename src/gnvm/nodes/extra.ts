// Additional geometry-node handlers needed by the bubble-vase dump. These are
// focused VM semantics: field-aware math where cheap, topology-preserving
// passthroughs where Blender's richer data model is out of scope, and documented
// approximations for boolean operations.
import {
  Field,
  fieldMap,
  Vec3,
  Elem,
  Domain,
  asNum,
  asVec3,
  vadd,
  vsub,
  vscale,
  vdot,
  vcross,
  vlen,
  vnorm,
} from "../core";
import { Geometry, Mesh, mergeMeshInto, rotateEulerXYZ, Spline, buildTopology } from "../geometry";
import { splineLength, splineSegments } from "../curves";
import { makeFieldCtx } from "../evaluator";
import { reg, EvalAPI } from "../registry";

const DOMAINS = new Set<Domain>(["POINT", "EDGE", "FACE", "CORNER", "CURVE", "INSTANCE"]);
const EPS = 1e-9;

function domainProp(api: EvalAPI, dflt: Domain = "POINT"): Domain {
  const d = api.prop<string>("domain", dflt);
  return DOMAINS.has(d as Domain) ? (d as Domain) : dflt;
}

function boolOn(v: Elem | undefined): boolean {
  return asNum(v ?? 0) > 0;
}

function avgVec(points: Vec3[]): Vec3 {
  if (!points.length) return [0, 0, 0];
  const c: Vec3 = [0, 0, 0];
  for (const p of points) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return [c[0] / points.length, c[1] / points.length, c[2] / points.length];
}

function itemIndex(id: string): number {
  const m = /^Item_(\d+)$/.exec(id);
  return m ? Number(m[1]) : -1;
}

function enumNamesFromProps(props: Record<string, any> | undefined): string[] {
  if (!props) return [];
  const candidates = ["enum_items", "enum_definition", "items", "menu_items"];
  for (const key of candidates) {
    const raw = props[key];
    if (!Array.isArray(raw)) continue;
    const names = raw
      .map((x) => typeof x === "string" ? x : typeof x?.name === "string" ? x.name : typeof x?.identifier === "string" ? x.identifier : "")
      .filter(Boolean);
    if (names.length) return names;
  }
  return [];
}

function menuSwitchIndex(api: EvalAPI): number {
  const items = api.node.inputs
    .filter((s) => itemIndex(s.identifier) >= 0)
    .sort((a, b) => itemIndex(a.identifier) - itemIndex(b.identifier));
  const propNames = enumNamesFromProps(api.node.props);
  const names = propNames.length ? propNames : items.map((s) => s.name || s.identifier);
  const raw = api.input("Menu");
  let menu = "";
  if (typeof raw === "string") menu = raw;
  else if (raw instanceof Field && raw.isConst) {
    const v = raw.value;
    if (typeof v === "number") return Math.max(0, Math.min(items.length - 1, Math.round(v)));
    menu = String(asNum(v));
  }
  let idx = names.findIndex((n) => n === menu);
  if (idx < 0) idx = names.findIndex((n) => n.toLowerCase() === menu.toLowerCase());
  const activeName = api.prop<{ name?: string } | undefined>("active_item", undefined)?.name;
  if (idx < 0 && activeName && menu === activeName) idx = api.prop<number>("active_index", 0);
  if (idx < 0 && /^-?\d+$/.test(menu)) idx = Number(menu);
  return idx >= 0 && idx < items.length ? idx : 0;
}

reg("GeometryNodeMenuSwitch", (api) => {
  const idx = menuSwitchIndex(api);
  const picked = api.input(`Item_${idx}`);
  const dt = api.prop<string>("data_type", "");
  if (dt === "GEOMETRY") return { Output: picked instanceof Geometry ? picked : new Geometry() };
  if (picked instanceof Field) return { Output: picked };
  return { Output: Field.of(0) };
});

function rotX(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

function rotY(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

function rotZ(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}

function rotateAxisAngle(p: Vec3, axis: Vec3, angle: number): Vec3 {
  const a = vnorm(axis);
  if (vlen(a) <= EPS) return p;
  const c = Math.cos(angle), s = Math.sin(angle);
  return vadd(vadd(vscale(p, c), vscale(vcross(a, p), s)), vscale(a, vdot(a, p) * (1 - c)));
}

function inverseEulerXYZ(p: Vec3, e: Vec3): Vec3 {
  return rotX(rotY(rotZ(p, -e[2]), -e[1]), -e[0]);
}

reg("ShaderNodeVectorRotate", (api) => {
  const type = api.prop<string>("rotation_type", "AXIS_ANGLE");
  const invert = api.prop<boolean>("invert", false);
  const vector = api.field("Vector");
  const center = api.field("Center");
  const axis = api.field("Axis");
  const angle = api.field("Angle");
  const rotation = api.field("Rotation");
  return {
    Vector: fieldMap([vector, center, axis, angle, rotation], (v0, c0, a0, ang0, r0) => {
      const c = asVec3(c0);
      const p = vsub(asVec3(v0), c);
      const ang = asNum(ang0) * (invert ? -1 : 1);
      let r: Vec3;
      switch (type) {
        case "X_AXIS": r = rotX(p, ang); break;
        case "Y_AXIS": r = rotY(p, ang); break;
        case "Z_AXIS": r = rotZ(p, ang); break;
        case "EULER_XYZ": r = invert ? inverseEulerXYZ(p, asVec3(r0)) : rotateEulerXYZ(p, asVec3(r0)); break;
        case "AXIS_ANGLE":
        default: r = rotateAxisAngle(p, asVec3(a0), ang); break;
      }
      return vadd(c, r);
    }),
  };
});

function pointTopologyField(kind: "VERTEX" | "FACE"): Field {
  return Field.make((ctx) => {
    const pointCtx = ctx.domain === "POINT" ? ctx : ctx.fork?.("POINT") ?? ctx;
    const edgeCtx = pointCtx.fork?.("EDGE") ?? ctx.fork?.("EDGE") ?? pointCtx;
    const counts = new Array(pointCtx.size).fill(0);
    const faceApprox = new Array(pointCtx.size).fill(0);
    if (edgeCtx.edgeVerts) {
      for (let ei = 0; ei < edgeCtx.size; ei++) {
        const [a, b] = edgeCtx.edgeVerts(ei);
        const faceCount = edgeCtx.edgeFaceCount?.(ei) ?? 0;
        // Loose-wire edges count toward vertex adjacency (Blender semantics).
        // They were skipped while Repeat Zones were unimplemented; the Spin
        // lathe's boundary-point selection needs them on pure wires.
        if (a >= 0 && a < pointCtx.size) {
          counts[a]++;
          faceApprox[a] += faceCount / 2;
        }
        if (b >= 0 && b < pointCtx.size) {
          counts[b]++;
          faceApprox[b] += faceCount / 2;
        }
      }
    }
    const pointArr = kind === "VERTEX" ? counts : faceApprox.map((n) => Math.round(n));
    if (ctx.domain === "POINT" || !ctx.toDomain) return pointArr;
    const out: Elem[] = new Array(ctx.size);
    for (let i = 0; i < ctx.size; i++) out[i] = ctx.toDomain("POINT", pointArr, i) ?? 0;
    return out;
  });
}

reg("GeometryNodeInputMeshVertexNeighbors", () => ({
  "Vertex Count": pointTopologyField("VERTEX"),
  "Face Count": pointTopologyField("FACE"),
}));

reg("GeometryNodeCurveSplineType", (api) => {
  // The VM stores only poly splines; non-POLY target types are preserved as the
  // same control polygon and later resample/fill nodes provide the needed shape.
  return { Curve: api.geo("Curve").clone() };
});

function sampleSplineAt(s: Spline, distance: number): Vec3 {
  const pts = s.points;
  if (!pts.length) return [0, 0, 0];
  if (pts.length === 1) return [...pts[0]] as Vec3;
  const segs = splineSegments(s);
  const total = splineLength(s);
  if (total <= EPS) return [...pts[0]] as Vec3;
  let d = s.cyclic ? ((distance % total) + total) % total : Math.max(0, Math.min(total, distance));
  if (!s.cyclic && d >= total - EPS) return [...pts[pts.length - 1]] as Vec3;
  for (const [a, b] of segs) {
    const len = vlen(vsub(pts[b], pts[a]));
    if (d <= len + EPS) {
      const t = len > EPS ? Math.max(0, Math.min(1, d / len)) : 0;
      return vadd(pts[a], vscale(vsub(pts[b], pts[a]), t));
    }
    d -= len;
  }
  return [...pts[pts.length - 1]] as Vec3;
}

function samePoint(a: Vec3, b: Vec3): boolean {
  return vlen(vsub(a, b)) <= 1e-7;
}

function pushDistinct(out: Vec3[], p: Vec3): void {
  if (!out.length || !samePoint(out[out.length - 1], p)) out.push(p);
}

function trimSpline(s: Spline, startF: number, endF: number): Spline {
  const total = splineLength(s);
  if (s.points.length < 2 || total <= EPS) return { points: s.points.map((p) => [...p] as Vec3), cyclic: s.cyclic };
  const a = Math.max(0, Math.min(1, startF));
  const b = Math.max(0, Math.min(1, endF));
  if (a <= EPS && b >= 1 - EPS) return { points: s.points.map((p) => [...p] as Vec3), cyclic: s.cyclic };
  const startD = Math.min(a, b) * total;
  const endD = Math.max(a, b) * total;
  const out: Vec3[] = [];
  pushDistinct(out, sampleSplineAt(s, startD));
  let cursor = 0;
  for (const [ia, ib] of splineSegments(s)) {
    const len = vlen(vsub(s.points[ib], s.points[ia]));
    const next = cursor + len;
    if (next > startD + EPS && next < endD - EPS) pushDistinct(out, [...s.points[ib]] as Vec3);
    cursor = next;
  }
  pushDistinct(out, sampleSplineAt(s, endD));
  if (out.length === 1) out.push([...out[0]] as Vec3);
  return { points: out, cyclic: false };
}

function firstResolvedNumber(api: EvalAPI, name: string, g: Geometry, fallback: number): number {
  const f = api.field(name);
  if (f.isConst) return asNum(f.value);
  const ctx = makeFieldCtx(g, "POINT");
  const arr = f.array(ctx);
  return arr.length ? asNum(arr[0] ?? fallback) : fallback;
}

reg("GeometryNodeTrimCurve", (api) => {
  const g = api.geo("Curve");
  const mode = api.prop<string>("mode", "FACTOR");
  const out = g.clone();
  out.curves = g.curves.map((s) => {
    const len = splineLength(s);
    let start = firstResolvedNumber(api, mode === "LENGTH" ? "Start_001" : "Start", g, 0);
    let end = firstResolvedNumber(api, mode === "LENGTH" ? "End_001" : "End", g, mode === "LENGTH" ? len : 1);
    if (mode === "LENGTH") {
      start = len > EPS ? start / len : 0;
      end = len > EPS ? end / len : 0;
    }
    return trimSpline(s, start, end);
  });
  return { Curve: out };
});

class DSU {
  parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x: number): number { return this.parent[x] === x ? x : (this.parent[x] = this.find(this.parent[x])); }
  union(a: number, b: number): void { this.parent[this.find(a)] = this.find(b); }
}

function selectedElementGroups(elements: number[][], selected: boolean[]): Map<number, number[]> {
  const dsu = new DSU(elements.length);
  const byVert = new Map<number, number>();
  for (let ei = 0; ei < elements.length; ei++) {
    if (!selected[ei]) continue;
    for (const v of elements[ei]) {
      const prev = byVert.get(v);
      if (prev === undefined) byVert.set(v, ei);
      else dsu.union(prev, ei);
    }
  }
  const groups = new Map<number, number[]>();
  for (let ei = 0; ei < elements.length; ei++) {
    if (!selected[ei]) continue;
    const r = dsu.find(ei);
    const arr = groups.get(r);
    if (arr) arr.push(ei);
    else groups.set(r, [ei]);
  }
  return groups;
}

reg("GeometryNodeScaleElements", (api) => {
  const g = api.geo("Geometry").clone();
  if (!g.mesh) return { Geometry: g };
  const domain = domainProp(api, "FACE");
  if (domain !== "FACE" && domain !== "EDGE") return { Geometry: g };
  const mesh = g.mesh;
  const ctx = makeFieldCtx(g, domain);
  const selArr = api.field("Selection").array(ctx);
  const scaleArr = api.field("Scale").array(ctx);
  const centerLinked = api.node.inputs.find((s) => s.identifier === "Center")?.linked ?? false;
  const centerArr = centerLinked ? api.field("Center").array(ctx) : null;
  const elements = domain === "FACE"
    ? mesh.faces.map((f) => [...f])
    : buildTopology(mesh).edges.map((e) => [...e.verts]);
  const selected = elements.map((_, i) => boolOn(selArr[i] ?? 1));
  const groups = selectedElementGroups(elements, selected);
  const next = mesh.positions.map((p) => [...p] as Vec3);
  for (const eis of groups.values()) {
    const verts = [...new Set(eis.flatMap((ei) => elements[ei]))];
    const center = centerArr
      ? avgVec(eis.map((ei) => asVec3(centerArr[ei] ?? [0, 0, 0])))
      : avgVec(verts.map((vi) => mesh.positions[vi]));
    const scale = eis.reduce((n, ei) => n + asNum(scaleArr[ei] ?? 1), 0) / eis.length;
    for (const vi of verts) next[vi] = vadd(center, vscale(vsub(mesh.positions[vi], center), scale));
  }
  mesh.positions = next;
  return { Geometry: g };
});

function sortedOrder(size: number, selected: boolean[], groupIds: Elem[], weights: Elem[]): number[] {
  const order = Array.from({ length: size }, (_, i) => i);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < size; i++) {
    if (!selected[i]) continue;
    const gid = Math.round(asNum(groupIds[i] ?? 0));
    const arr = groups.get(gid);
    if (arr) arr.push(i);
    else groups.set(gid, [i]);
  }
  for (const slots of groups.values()) {
    const sorted = [...slots].sort((a, b) => {
      const d = asNum(weights[a] ?? 0) - asNum(weights[b] ?? 0);
      return d || a - b;
    });
    for (let i = 0; i < slots.length; i++) order[slots[i]] = sorted[i];
  }
  return order;
}

reg("GeometryNodeSortElements", (api) => {
  const g = api.geo("Geometry").clone();
  if (!g.mesh) return { Geometry: g };
  const mesh = g.mesh;
  const domain = domainProp(api, "POINT");
  if (domain === "POINT") {
    const ctx = makeFieldCtx(g, "POINT");
    const order = sortedOrder(mesh.positions.length, api.field("Selection").array(ctx).map((v) => boolOn(v ?? 1)), api.field("Group ID").array(ctx), api.field("Sort Weight").array(ctx));
    const inv = new Array(order.length);
    for (let ni = 0; ni < order.length; ni++) inv[order[ni]] = ni;
    mesh.positions = order.map((oi) => [...mesh.positions[oi]] as Vec3);
    mesh.faces = mesh.faces.map((f) => f.map((vi) => inv[vi]));
    mesh.edges = mesh.edges.map(([a, b]) => [inv[a], inv[b]] as [number, number]);
    for (const [name, a] of mesh.attributes)
      if (a.domain === "POINT") mesh.attributes.set(name, { domain: "POINT", data: order.map((oi) => a.data[oi]) });
  } else if (domain === "FACE") {
    const ctx = makeFieldCtx(g, "FACE");
    const order = sortedOrder(mesh.faces.length, api.field("Selection").array(ctx).map((v) => boolOn(v ?? 1)), api.field("Group ID").array(ctx), api.field("Sort Weight").array(ctx));
    const oldFaces = mesh.faces;
    const cornerStart: number[] = [];
    let cursor = 0;
    for (const f of oldFaces) { cornerStart.push(cursor); cursor += f.length; }
    mesh.faces = order.map((oi) => [...oldFaces[oi]]);
    mesh.faceMaterial = order.map((oi) => mesh.faceMaterial[oi] ?? 0);
    for (const [name, a] of mesh.attributes) {
      if (a.domain === "FACE") mesh.attributes.set(name, { domain: "FACE", data: order.map((oi) => a.data[oi]) });
      else if (a.domain === "CORNER") {
        const data: Elem[] = [];
        for (const oi of order) for (let k = 0; k < oldFaces[oi].length; k++) data.push(a.data[cornerStart[oi] + k]);
        mesh.attributes.set(name, { domain: "CORNER", data });
      }
    }
  }
  return { Geometry: g };
});

function elemZero(vector: boolean): Elem {
  return vector ? [0, 0, 0] : 0;
}

function componentStats(vals: number[]): { mean: number; median: number; sum: number; min: number; max: number; range: number; variance: number; std: number } {
  if (!vals.length) return { mean: 0, median: 0, sum: 0, min: 0, max: 0, range: 0, variance: 0, std: 0 };
  const sum = vals.reduce((n, v) => n + v, 0);
  const mean = sum / vals.length;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const variance = vals.reduce((n, v) => n + (v - mean) ** 2, 0) / vals.length;
  return { mean, median, sum, min, max, range: max - min, variance, std: Math.sqrt(variance) };
}

reg("GeometryNodeAttributeStatistic", (api) => {
  const g = api.geo("Geometry");
  const domain = domainProp(api, "POINT");
  const vector = api.prop<string>("data_type", "FLOAT").includes("VECTOR");
  const ctx = makeFieldCtx(g, domain);
  const vals = api.field("Attribute").array(ctx);
  const sel = api.field("Selection").array(ctx);
  const picked = vals.filter((_, i) => boolOn(sel[i] ?? 1));
  if (!picked.length) {
    const z = Field.of(elemZero(vector));
    return { Mean: z, Median: z, Sum: z, Min: z, Max: z, Range: z, "Standard Deviation": z, Variance: z };
  }
  if (vector) {
    const comps = [0, 1, 2].map((k) => componentStats(picked.map((v) => asVec3(v ?? [0, 0, 0])[k])));
    const vec = (key: keyof ReturnType<typeof componentStats>): Vec3 => [comps[0][key], comps[1][key], comps[2][key]];
    return {
      Mean: Field.of(vec("mean")),
      Median: Field.of(vec("median")),
      Sum: Field.of(vec("sum")),
      Min: Field.of(vec("min")),
      Max: Field.of(vec("max")),
      Range: Field.of(vec("range")),
      "Standard Deviation": Field.of(vec("std")),
      Variance: Field.of(vec("variance")),
    };
  }
  const st = componentStats(picked.map((v) => asNum(v ?? 0)));
  return {
    Mean: Field.of(st.mean),
    Median: Field.of(st.median),
    Sum: Field.of(st.sum),
    Min: Field.of(st.min),
    Max: Field.of(st.max),
    Range: Field.of(st.range),
    "Standard Deviation": Field.of(st.std),
    Variance: Field.of(st.variance),
  };
});

function joinedMesh(parts: Geometry[]): Geometry {
  const out = new Geometry();
  out.mesh = new Mesh();
  for (const g of parts) {
    if (g.mesh) mergeMeshInto(out.mesh, g.mesh);
    for (const s of g.curves) out.curves.push({ cyclic: s.cyclic, points: s.points.map((p) => [...p] as Vec3) });
    for (const inst of g.instances) out.instances.push({ ...inst });
  }
  return out;
}

reg("GeometryNodeMeshBoolean", (api) => {
  const op = api.prop<string>("operation", "DIFFERENCE");
  const mesh1 = api.geo("Mesh 1");
  const mesh2s = api.geoInputs("Mesh 2");
  let mesh: Geometry;
  if (op === "UNION") {
    mesh = joinedMesh([mesh1, ...mesh2s]);
  } else if (op === "INTERSECT") {
    // Approximation: intersect is typically an outer clip (vase ∩ bounds-box),
    // so the main geometry is by far the better passthrough — returning the
    // cutter rendered the bubble vase as its own clip box.
    mesh = mesh1.mesh || mesh1.curves.length || mesh1.instances.length
      ? mesh1.clone()
      : (mesh2s[0]?.clone() ?? new Geometry());
  } else {
    // Approximation: difference preserves the main geometry unchanged.
    mesh = mesh1.clone();
  }
  return { Mesh: mesh, "Intersecting Edges": Field.of(0) };
});
