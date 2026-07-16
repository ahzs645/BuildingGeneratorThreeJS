// Pull-based dataflow evaluator for dumped geometry-node graphs.
//
//  - Groups are evaluated recursively: a GeometryNodeGroup binds its inputs, runs
//    the subtree, and reads the subtree's Group Output.
//  - Reroute is passthrough, Frame is ignored, Group Input yields the invocation
//    bindings.
//  - Every other node type dispatches through the REGISTRY. Unhandled types are
//    recorded in MISSING and fall back to passing the first geometry input through,
//    so evaluation never crashes and we get a coverage report + partial mesh.

import { Field, Vec3, Domain, FieldCtx, asNum, asVec3, fieldMap, vadd, vcross, vdot, vnorm, vnormBlenderFloat, vscale, vsub } from "./core";
import { Geometry, Mesh, mergeMeshInto, realizeInstances, topologyOf, Topology } from "./geometry";
import { splineFrames, splineLength } from "./curves";
import { EvalAPI, RawNode, REGISTRY, MISSING, SockVal, DataRef } from "./registry";

export interface RawGroup {
  name: string;
  type: string;
  nodes: RawNode[];
  links: { from_node: string; from_socket: string; to_node: string; to_socket: string; multi_input_sort_id?: number | null; muted?: boolean }[];
  interface: any[];
}
export type Program = Record<string, RawGroup>;

// Per-node geometry trace for debugging (off by default; near-zero cost when off).
export const TRACE: { on: boolean; log: { group: string; node: string; type: string; out: string; verts: number; faces: number; curves: number; inst: number; bbox?: string }[] } = { on: false, log: [] };
export const FIELD_PROBE: {
  group: string | null;
  node: string | null;
  socket: string | null;
  batches: { domain: Domain; positions: Vec3[]; values: import("./core").Elem[]; targets?: Vec3[] }[];
} = { group: null, node: null, socket: null, batches: [] };

export const GEOMETRY_PROBE: { group: string | null; node: string | null; socket: string | null; geometry: Geometry | null } = {
  group: null,
  node: null,
  socket: null,
  geometry: null,
};

export const GEOMETRY_PROBES: {
  targets: { group: string; node: string; socket: string }[];
  geometries: Map<string, Geometry[]>;
} = { targets: [], geometries: new Map() };

// Const-value counterpart to GEOMETRY_PROBE, used to compare integer/float
// control flow inside deeply nested asset groups without modifying the graph.
export const VALUE_PROBE: { group: string | null; node: string | null; socket: string | null; values: import("./core").Elem[] } = {
  group: null,
  node: null,
  socket: null,
  values: [],
};

const ROTATION_QUATERNION = Symbol.for("gnvm.rotationQuaternion");
type NativeQuaternion = [number, number, number, number];

/**
 * Match Blender's mat3_normalized_to_quat_fast() for an extracted row-major
 * instance matrix. Rotation sockets carry this quaternion internally; using
 * only their displayed Euler value changes quarter-turn transforms by ULPs.
 */
function tagInstanceMatrixQuaternion(rotationValue: Vec3, matrix: number[][]): Vec3 {
  const f = Math.fround;
  const rowMajor = [0, 1, 2].map((row) => [0, 1, 2].map((column) => f(matrix[row]?.[column] ?? (row === column ? 1 : 0))));
  for (let column = 0; column < 3; column++) {
    const length = Math.hypot(rowMajor[0][column], rowMajor[1][column], rowMajor[2][column]) || 1;
    for (let row = 0; row < 3; row++) rowMajor[row][column] = f(rowMajor[row][column] / length);
  }
  // Blender matrices are indexed [column][row].
  const m = [0, 1, 2].map((column) => [0, 1, 2].map((row) => rowMajor[row][column]));
  const q = [0, 0, 0, 0]; // Blender order: W, X, Y, Z.
  if (m[2][2] < 0) {
    if (m[0][0] > m[1][1]) {
      const trace = f(f(f(1 + m[0][0]) - m[1][1]) - m[2][2]);
      let s = f(2 * f(Math.sqrt(trace)));
      if (m[1][2] < m[2][1]) s = f(-s);
      q[1] = f(0.25 * s);
      s = f(1 / s);
      q[0] = f(f(m[1][2] - m[2][1]) * s);
      q[2] = f(f(m[0][1] + m[1][0]) * s);
      q[3] = f(f(m[2][0] + m[0][2]) * s);
    } else {
      const trace = f(f(f(1 - m[0][0]) + m[1][1]) - m[2][2]);
      let s = f(2 * f(Math.sqrt(trace)));
      if (m[2][0] < m[0][2]) s = f(-s);
      q[2] = f(0.25 * s);
      s = f(1 / s);
      q[0] = f(f(m[2][0] - m[0][2]) * s);
      q[1] = f(f(m[0][1] + m[1][0]) * s);
      q[3] = f(f(m[1][2] + m[2][1]) * s);
    }
  } else if (m[0][0] < -m[1][1]) {
    const trace = f(f(f(1 - m[0][0]) - m[1][1]) + m[2][2]);
    let s = f(2 * f(Math.sqrt(trace)));
    if (m[0][1] < m[1][0]) s = f(-s);
    q[3] = f(0.25 * s);
    s = f(1 / s);
    q[0] = f(f(m[0][1] - m[1][0]) * s);
    q[1] = f(f(m[2][0] + m[0][2]) * s);
    q[2] = f(f(m[1][2] + m[2][1]) * s);
  } else {
    const trace = f(f(f(1 + m[0][0]) + m[1][1]) + m[2][2]);
    let s = f(2 * f(Math.sqrt(trace)));
    q[0] = f(0.25 * s);
    s = f(1 / s);
    q[1] = f(f(m[1][2] - m[2][1]) * s);
    q[2] = f(f(m[2][0] - m[0][2]) * s);
    q[3] = f(f(m[0][1] - m[1][0]) * s);
  }
  const rotation = [...rotationValue] as Vec3 & { [ROTATION_QUATERNION]?: NativeQuaternion };
  Object.defineProperty(rotation, ROTATION_QUATERNION, {
    value: [q[1], q[2], q[3], q[0]] as NativeQuaternion,
    enumerable: false,
  });
  return rotation;
}

function bboxOf(g: Geometry): string {
  const realized = g.instances.length ? realizeInstances(g) : g;
  const pts: Vec3[] = [...(realized.mesh?.positions ?? []), ...realized.curves.flatMap((s) => s.points)];
  if (!pts.length) return "-";
  const mn: Vec3 = [Infinity, Infinity, Infinity];
  const mx: Vec3 = [-Infinity, -Infinity, -Infinity];
  let bad = 0;
  for (const p of pts) {
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(p[k])) { bad++; break; }
      if (p[k] < mn[k]) mn[k] = p[k];
      if (p[k] > mx[k]) mx[k] = p[k];
    }
  }
  const f = (v: number) => (Number.isFinite(v) ? v.toFixed(4) : "?");
  return `[${f(mn[0])},${f(mn[1])},${f(mn[2])}]..[${f(mx[0])},${f(mx[1])},${f(mx[2])}]${bad ? ` !!${bad}nonfinite` : ""}`;
}

const KEY = (n: string, s: string) => `${n}::${s}`;

function wrapConst(socketType: string, value: any): SockVal {
  const t = socketType;
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.attribute === "string") {
    const fallback = t.includes("Vector") || t.includes("Rotation") || t.includes("Color")
      ? (Array.isArray(value.value) ? value.value.slice(0, 3) as Vec3 : [0, 0, 0] as Vec3)
      : t.includes("Bool")
        ? (value.value ? 1 : 0)
        : (typeof value.value === "number" ? value.value : Number(value.value) || 0);
    return Field.perElem((index, context) => context.attr?.(value.attribute, index) ?? fallback);
  }
  if (value == null) {
    if (t === "NodeSocketGeometry") return new Geometry();
    if (t.includes("Vector") || t.includes("Rotation")) return Field.of([0, 0, 0]);
    if (t.includes("Material") || t.includes("Object") || t.includes("Image") || t.includes("Collection")) return null;
    if (t.includes("String") || t.includes("Menu")) return "";
    return Field.of(0);
  }
  if (t === "NodeSocketGeometry") return value instanceof Geometry ? value : new Geometry();
  if (t.includes("Float") || t.includes("Int")) return Field.of(typeof value === "number" ? value : Number(value) || 0);
  if (t.includes("Bool")) return Field.of(value ? 1 : 0);
  if (t.includes("Vector") || t.includes("Rotation")) return Field.of(Array.isArray(value) ? (value.slice(0, 3) as Vec3) : [value, value, value]);
  if (t.includes("Color")) return Field.of(Array.isArray(value) ? (value.slice(0, 3) as Vec3) : [value, value, value]);
  if (t.includes("String") || t.includes("Menu")) return String(value);
  if (t.includes("Material") || t.includes("Object") || t.includes("Image") || t.includes("Collection"))
    return typeof value === "object" ? (value as DataRef) : { name: String(value) };
  if (typeof value === "number") return Field.of(value);
  if (Array.isArray(value)) return Field.of(value.slice(0, 3) as Vec3);
  return value;
}

// A group input is still a socket boundary: Blender converts a linked value to
// the interface socket's type before fields inside the group read it. In
// particular, the vase's Spin group receives a fractional density as `Steps`.
// Without this coercion Repeat Input rounded its iteration count while the
// in-group angle division kept the fraction, leaving a visible open seam.
function coerceSocketValue(value: SockVal, socketType: string): SockVal {
  if (!(value instanceof Field)) return value;
  const average = (v: import("./core").Elem) => Array.isArray(v) ? (v[0] + v[1] + v[2]) / 3 : v;
  if (socketType.includes("Bool")) {
    return fieldMap([value], (v) => average(v) > 0 ? 1 : 0);
  }
  // Blender converts a vector feeding a scalar Value socket to the average of
  // its XYZ components (the UI-window Fit Size graph relies on its zero Z).
  if (socketType.includes("Float")) return fieldMap([value], average);
  if (socketType.includes("Vector") || socketType.includes("Rotation"))
    return fieldMap([value], (v) => Array.isArray(v) ? v : [v, v, v]);
  return value;
}

function coerceGroupInput(value: SockVal, socketType: string): SockVal {
  const coerced = coerceSocketValue(value, socketType);
  if (!(coerced instanceof Field)) return coerced;
  // Linked Float -> Integer group sockets discard the fractional part. Split n
  // Tap measures this directly: its 37.806 loft resolution enters Blender as
  // 37, not 38. This is distinct from explicit Float to Integer node modes.
  if (socketType.includes("Int")) return fieldMap([coerced], (v) => Math.trunc(asNum(v)));
  return coerced;
}

// Average a set of field elements (numbers or vec3), for domain interpolation.
function avgElems(vals: (import("./core").Elem | undefined)[] | undefined): import("./core").Elem | undefined {
  if (!vals || !vals.length) return undefined;
  const first = vals[0];
  if (Array.isArray(first)) {
    const acc: Vec3 = [0, 0, 0];
    let n = 0;
    for (const v of vals) { if (Array.isArray(v)) { acc[0] += v[0]; acc[1] += v[1]; acc[2] += v[2]; n++; } }
    return n ? [acc[0] / n, acc[1] / n, acc[2] / n] : [0, 0, 0];
  }
  let s = 0, n = 0;
  for (const v of vals) { if (typeof v === "number") { s += v; n++; } }
  return n ? s / n : 0;
}

export function makeFieldCtx(geo: Geometry, domain: Domain): FieldCtx {
  // Geometry sets can carry an allocated but empty mesh alongside real curves
  // (notably after Realize Instances). Blender resolves fields on the populated
  // component; treating the empty mesh object as authoritative produced a
  // zero-sized POINT context and deleted the entire Chrome Crayon SPIRO branch.
  const mesh = geo.mesh && (geo.mesh.positions.length || geo.mesh.edges.length || geo.mesh.faces.length)
    ? geo.mesh
    : undefined;
  // Flattened curve control points (for curve geometry with no mesh), with the
  // per-spline local index/factor for SplineParameter.
  const curvePts: Vec3[] = [];
  const splineLocalIdx: number[] = [];
  const splineLocalFactor: number[] = [];
  const splineOfPoint: number[] = [];
  if (!mesh && geo.curves.length)
    for (let si = 0; si < geo.curves.length; si++) {
      const s = geo.curves[si];
      for (let j = 0; j < s.points.length; j++) {
        curvePts.push(s.points[j]);
        splineLocalIdx.push(j);
        splineLocalFactor.push(s.points.length > 1 ? j / (s.points.length - 1) : 0);
        splineOfPoint.push(si);
      }
    }
  // Lazy topology (edges/adjacency/islands) — only built when a topology query needs it.
  let topo: Topology | null = null;
  const T = (): Topology => (topo ??= topologyOf(mesh!));
  // Lazy corner maps: corner i -> (vertex, face); vertex -> corners; face -> first corner slot.
  let corners: { vert: number[]; face: number[]; faceStart: number[] } | null = null;
  const C = () => {
    if (!corners) {
      const vert: number[] = [], face: number[] = [], faceStart: number[] = [];
      for (let fi = 0; fi < mesh!.faces.length; fi++) {
        faceStart.push(vert.length);
        for (const vi of mesh!.faces[fi]) { vert.push(vi); face.push(fi); }
      }
      corners = { vert, face, faceStart };
    }
    return corners;
  };
  let vertCorners: number[][] | null = null;
  const VC = () => {
    if (!vertCorners) {
      vertCorners = mesh!.positions.map(() => []);
      const c = C();
      for (let i = 0; i < c.vert.length; i++) vertCorners[c.vert[i]]?.push(i);
    }
    return vertCorners;
  };
  let vertEdges: number[][] | null = null;
  const VE = () => {
    if (!vertEdges) {
      vertEdges = mesh!.positions.map(() => []);
      const es = T().edges;
      for (let ei = 0; ei < es.length; ei++) for (const vi of es[ei].verts) vertEdges[vi]?.push(ei);
    }
    return vertEdges;
  };
  const edgeKeyOf = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  let edgeKeyIdx: Map<string, number> | null = null;
  const EK = () => {
    if (!edgeKeyIdx) {
      edgeKeyIdx = new Map();
      const es = T().edges;
      for (let ei = 0; ei < es.length; ei++) edgeKeyIdx.set(edgeKeyOf(es[ei].verts[0], es[ei].verts[1]), ei);
    }
    return edgeKeyIdx;
  };
  const size = domain === "INSTANCE"
    ? geo.instances.length
    : domain === "CURVE"
      ? geo.curves.length
      : mesh
      ? domain === "EDGE"
      ? T().edges.length // canonical edges (from faces), not just explicit ones
      : mesh.domainSize(domain)
      : curvePts.length; // POINT/CURVE domain over control points
  let normals: Vec3[] | null = null;
  let curveNormals: Vec3[] | null = null;
  let pointNeighbors: number[][] | null = null;
  let faceNeighborsList: number[][] | null = null;
  let edgeNeighborsList: number[][] | null = null;
  // Map element i of THIS domain from an array resolved on another domain
  // (Blender's implicit attribute interpolation).
  const toDomain = (src: Domain, arr: (import("./core").Elem | undefined)[], i: number): import("./core").Elem | undefined => {
    if (src === domain) return arr[i];
    if (!mesh) {
      // Curve-domain fields are constant for every point of their spline.
      // Returning arr[i] here broadcast only the first N spline values to the
      // first N points and defaulted the rest to zero (the 3D Fill Curve helper
      // consequently stacked nearly every outline on the same unit circle).
      if (src === "CURVE" && domain === "POINT") return arr[splineOfPoint[i] ?? 0];
      if (src === "POINT" && domain === "CURVE") {
        let start = 0;
        for (let spline = 0; spline < i; spline++) start += geo.curves[spline]?.points.length ?? 0;
        const count = geo.curves[i]?.points.length ?? 0;
        return avgElems(arr.slice(start, start + count));
      }
      return arr[i];
    }
    if (src === "POINT") {
      if (domain === "FACE") return avgElems(mesh.faces[i]?.map((vi) => arr[vi]));
      if (domain === "CORNER") return arr[C().vert[i]];
      if (domain === "EDGE") {
        // Blender's boolean point->edge rule is AND (both endpoints); min() gives
        // that exactly for 0/1 masks. Averaging selected the lathe's vertical
        // edges (one hot endpoint) and doubled the Spin zone every iteration.
        const vs = T().edges[i]?.verts.map((vi) => arr[vi]);
        if (!vs) return undefined;
        const nums = vs.map((v) => (typeof v === "number" ? v : v === undefined ? 0 : 0));
        if (vs.every((v) => typeof v === "number" || v === undefined)) return Math.min(nums[0] ?? 0, nums[1] ?? 0);
        return avgElems(vs);
      }
    }
    if (src === "FACE") {
      if (domain === "POINT") return avgElems(T().pointFaces[i]?.map((fi) => arr[fi]));
      if (domain === "CORNER") return arr[C().face[i]];
      if (domain === "EDGE") return avgElems(T().edges[i]?.faces.map((fi) => arr[fi]));
    }
    if (src === "CORNER") {
      if (domain === "POINT") return avgElems(VC()[i]?.map((ci) => arr[ci]));
      if (domain === "FACE") {
        const c = C();
        const f = mesh.faces[i];
        return avgElems(f?.map((_, k) => arr[c.faceStart[i] + k]));
      }
    }
    if (src === "EDGE") {
      if (domain === "POINT") return avgElems(VE()[i]?.map((ei) => arr[ei]));
      if (domain === "FACE") {
        const f = mesh.faces[i];
        return avgElems(f?.map((_, k) => {
          const ei = EK().get(edgeKeyOf(f[k], f[(k + 1) % f.length]));
          return ei === undefined ? undefined : arr[ei];
        }));
      }
      if (domain === "CORNER") {
        // a corner maps to its loop edge (this corner's vert -> next in the face)
        const c = C();
        const f = mesh.faces[c.face[i]];
        const slot = i - c.faceStart[c.face[i]];
        const ei = EK().get(edgeKeyOf(f[slot], f[(slot + 1) % f.length]));
        return ei === undefined ? undefined : arr[ei];
      }
    }
    return arr[i]; // same-index fallback
  };
  return {
    size,
    domain,
    component: domain === "INSTANCE" ? "INSTANCE" : domain === "CURVE" ? "CURVE" : mesh ? "MESH" : geo.curves.length ? "CURVE" : "EMPTY",
    fork: (d) => makeFieldCtx(geo, d),
    toDomain,
    faceVertCount: (i) => (mesh ? mesh.faces[i]?.length ?? 0 : 0),
    faceArea: (i) => (mesh ? mesh.faceArea(i) : 0),
    faceNeighborCount: (i) => (mesh ? T().faceNeighbors[i] ?? 0 : 0),
    edgeVerts: (i) => (mesh ? T().edges[i]?.verts ?? [0, 0] : [0, 0]),
    edgeFaceCount: (i) => (mesh ? T().edges[i]?.faces.length ?? 0 : 0),
    edgeAngle: (i, signed = false) => {
      if (!mesh) return 0;
      const edge = T().edges[i];
      // Blender defines Edge Angle only for manifold edges with exactly two
      // adjacent faces. Boundary and 3+ face non-manifold edges return zero.
      if (!edge || edge.faces.length !== 2) return 0;
      const first = mesh.faceNormalCalc(edge.faces[0]);
      const second = mesh.faceNormalCalc(edge.faces[1]);
      // Blender's angle_normalized_v3v3 deliberately avoids acos(dot): it
      // measures the (possibly negated) normal delta and calls float asinf.
      // The more accurate formulation is observable at Auto Smooth cutoffs,
      // where acos selected a different set of Chrome Crayon edges.
      const f = Math.fround;
      const dotFloat = (a: Vec3, b: Vec3) => {
        let value = f(f(a[0] * b[0]) + f(a[1] * b[1]));
        value = f(value + f(a[2] * b[2]));
        return value;
      };
      const lengthBetween = (a: Vec3, b: Vec3) => {
        const x = f(a[0] - b[0]), y = f(a[1] - b[1]), z = f(a[2] - b[2]);
        let squared = f(f(x * x) + f(y * y));
        squared = f(squared + f(z * z));
        return f(Math.sqrt(squared));
      };
      const safeAsin = (value: number) => value <= -1
        ? f(-Math.PI / 2)
        : value >= 1
          ? f(Math.PI / 2)
          : f(Math.asin(value));
      let angle: number;
      if (dotFloat(first, second) >= 0) {
        angle = f(f(2) * safeAsin(f(lengthBetween(first, second) / f(2))));
      } else {
        const negated: Vec3 = [f(-second[0]), f(-second[1]), f(-second[2])];
        angle = f(f(Math.PI) - f(f(2) * safeAsin(f(lengthBetween(first, negated) / f(2)))));
      }
      if (!signed) return angle;
      const direction = vnorm(vsub(mesh.positions[edge.verts[1]], mesh.positions[edge.verts[0]]));
      return vdot(vcross(first, second), direction) < 0 ? -angle : angle;
    },
    islandIndex: (i) => (mesh ? (domain === "FACE" ? T().faceIsland[i] : T().pointIsland[i]) ?? 0 : 0),
    islandCount: () => (mesh ? (domain === "FACE" ? T().faceIslandCount : T().pointIslandCount) : 0),
    splineIndex: (i) => splineLocalIdx[i] ?? 0,
    splineFactor: (i) => splineLocalFactor[i] ?? 0,
    splineCyclic: (i) => {
      const si = domain === "CURVE" ? i : splineOfPoint[i] ?? 0;
      return geo.curves[si]?.cyclic ?? false;
    },
    splineLength: (i) => {
      const si = domain === "CURVE" ? i : splineOfPoint[i] ?? 0;
      const s = geo.curves[si];
      return s ? splineLength(s) : 0;
    },
    splinePointCount: (i) => {
      const si = domain === "CURVE" ? i : splineOfPoint[i] ?? 0;
      return geo.curves[si]?.points.length ?? 0;
    },
    splineResolution: (i) => {
      const si = domain === "CURVE" ? i : splineOfPoint[i] ?? 0;
      return Math.max(1, Math.round(geo.curves[si]?.resolution ?? 1));
    },
    neighbors: (i) => {
      if (mesh) {
        if (domain === "POINT") {
          if (!pointNeighbors) {
            pointNeighbors = mesh.positions.map(() => []);
            for (const edge of T().edges) {
              pointNeighbors[edge.verts[0]].push(edge.verts[1]);
              pointNeighbors[edge.verts[1]].push(edge.verts[0]);
            }
          }
          return pointNeighbors[i] ?? [];
        }
        if (domain === "FACE") {
          if (!faceNeighborsList) {
            const sets = mesh.faces.map(() => new Set<number>());
            for (const edge of T().edges) for (const fa of edge.faces) for (const fb of edge.faces) if (fa !== fb) sets[fa].add(fb);
            faceNeighborsList = sets.map((set) => [...set]);
          }
          return faceNeighborsList[i] ?? [];
        }
        if (domain === "EDGE") {
          if (!edgeNeighborsList) {
            edgeNeighborsList = T().edges.map(() => []);
            const incident = mesh.positions.map(() => [] as number[]);
            T().edges.forEach((edge, ei) => { incident[edge.verts[0]].push(ei); incident[edge.verts[1]].push(ei); });
            for (let ei = 0; ei < T().edges.length; ei++) {
              const edge = T().edges[ei];
              edgeNeighborsList[ei] = [...new Set([...incident[edge.verts[0]], ...incident[edge.verts[1]]].filter((other) => other !== ei))];
            }
          }
          return edgeNeighborsList[i] ?? [];
        }
        return [];
      }
      if (domain === "CURVE") return [];
      const si = splineOfPoint[i] ?? 0;
      const s = geo.curves[si];
      if (!s) return [];
      let base = 0;
      for (let k = 0; k < si; k++) base += geo.curves[k].points.length;
      const local = i - base;
      const out: number[] = [];
      if (local > 0) out.push(i - 1);
      else if (s.cyclic && s.points.length > 1) out.push(base + s.points.length - 1);
      if (local + 1 < s.points.length) out.push(i + 1);
      else if (s.cyclic && s.points.length > 1) out.push(base);
      return out;
    },
    position: (i) => {
      if (domain === "INSTANCE") return geo.instances[i]?.position ?? [0, 0, 0];
      if (mesh) {
        if (domain === "FACE") return mesh.faceCenter(i);
        if (domain === "CORNER") return mesh.positions[C().vert[i]] ?? [0, 0, 0];
        if (domain === "EDGE") {
          const edge = T().edges[i]?.verts;
          return edge ? vscale(vadd(mesh.positions[edge[0]], mesh.positions[edge[1]]), 0.5) : [0, 0, 0];
        }
        return mesh.positions[i] ?? [0, 0, 0];
      }
      if (domain === "CURVE") {
        const pts = geo.curves[i]?.points ?? [];
        return pts.length ? pts.reduce((sum, p) => vadd(sum, p), [0, 0, 0] as Vec3).map((v) => v / pts.length) as Vec3 : [0, 0, 0];
      }
      return curvePts[i] ?? [0, 0, 0];
    },
    instanceRotation: (i) => {
      const instance = geo.instances[i];
      if (!instance) return [0, 0, 0];
      return instance.transformMatrix
        ? tagInstanceMatrixQuaternion(instance.rotation, instance.transformMatrix)
        : instance.rotation;
    },
    normal: (i) => {
      if (!mesh) {
        // Curve control-point normals from the spline frames — the constant
        // [0,0,1] placeholder pinned the vase's bubble rings onto the shell
        // (their placement offsets along curve normals).
        if (!curveNormals) {
          curveNormals = [];
          for (const s of geo.curves) {
            const frames = splineFrames(s.points, s.cyclic);
            const z = s.points[0]?.[2] ?? 0;
            const planarXY = s.cyclic && s.points.length >= 3 && s.points.every((point) => Math.abs(point[2] - z) <= 1e-7);
            let area2 = 0;
            if (planarXY) {
              for (let i = 0; i < s.points.length; i++) {
                const a = s.points[i], b = s.points[(i + 1) % s.points.length];
                area2 += a[0] * b[1] - b[0] * a[1];
              }
            }
            if (planarXY && Math.abs(area2) > 1e-12) {
              // Blender gives planar cyclic curves an in-plane normal pointing
              // toward the loop interior. Reversing the spline reverses this
              // normal, which keeps inner/counter-wound font outlines correct.
              const orientation = area2 > 0 ? 1 : -1;
              for (const frame of frames) curveNormals.push(vnorm([
                -frame.tangent[1] * orientation,
                frame.tangent[0] * orientation,
                0,
              ]));
            } else {
              for (const f of frames) curveNormals.push(f.normal);
            }
          }
        }
        return curveNormals[i] ?? [0, 0, 1];
      }
      if (domain === "FACE") return mesh.faceNormal(i);
      // Corner normals are face-split (per-face), unlike smooth vertex normals —
      // the solidify angle-compensation trick depends on this distinction.
      if (domain === "CORNER") return mesh.faceNormal(C().face[i]);
      // Blender assigns a no-profile Curve to Mesh wire a radial normal from
      // object origin. Ordinary point clouds keep their own +Z default, so the
      // conversion marks only curve-derived wires for this intrinsic behavior.
      if (!mesh.faces.length && domain === "POINT" && mesh.attributes.has("__curve_wire"))
        return vnormBlenderFloat(mesh.positions[i] ?? [0, 0, 0]);
      if (!normals) normals = mesh.vertexNormals();
      return normals[i] ?? [0, 0, 1];
    },
    index: (i) => i,
    attr: (name, i) => {
      if (domain === "INSTANCE") return geo.instances[i]?.attributes?.get(name);
      if (!mesh) {
        // Curve attributes can be stored once per spline or once per control
        // point. Convert CURVE -> POINT by broadcasting the spline value; this
        // is Blender's implicit domain adaptation used by loft/index graphs.
        const ca = geo.curveAttributes.get(name);
        if (!ca) return undefined;
        if (ca.domain === domain) return ca.data[i];
        if (ca.domain === "CURVE" && domain === "POINT") return ca.data[splineOfPoint[i] ?? 0];
        if (ca.domain === "POINT" && domain === "CURVE") {
          let offset = 0;
          for (let spline = 0; spline < i; spline++) offset += geo.curves[spline]?.points.length ?? 0;
          return avgElems(ca.data.slice(offset, offset + (geo.curves[i]?.points.length ?? 0)));
        }
        return ca.data[i];
      }
      const a = mesh.attributes.get(name);
      if (!a) return undefined;
      // cross-domain interpolation (geometry-nodes evaluates fields across domains)
      return toDomain(a.domain, a.data, i);
    },
  };
}

// Contract of Node Dojo's reusable "Gradient Direction" group. The authored
// graph evaluates one finite-difference direction for every triangle in the
// polygon's corner-order fan (0, 1, 2), (0, 2, 3), ... . The final two corner
// slots are zero, so CORNER -> FACE interpolation averages the n-2 fan values
// with those two zeros before normalizing. Evaluating the legacy nested field
// graph generically loses its locked CORNER/FACE contexts, so preserve the
// group contract explicitly.
export function gradientDirectionField(gradient: Field, solenoidal: boolean): Field {
  return Field.make((ctx) => {
    const faceCtx = ctx.domain === "FACE" ? ctx : ctx.fork?.("FACE");
    const cornerCtx = ctx.domain === "CORNER" ? ctx : ctx.fork?.("CORNER");
    if (!faceCtx || !cornerCtx || !faceCtx.faceVertCount || !cornerCtx.position) return Array.from({ length: ctx.size }, () => [0, 0, 0] as Vec3);
    const scalar = gradient.array(cornerCtx);
    const faceDirections: Vec3[] = new Array(faceCtx.size);
    let cornerStart = 0;
    for (let face = 0; face < faceCtx.size; face++) {
      const count = faceCtx.faceVertCount(face);
      if (count < 3) {
        faceDirections[face] = [0, 0, 0];
        cornerStart += count;
        continue;
      }
      const p0 = cornerCtx.position(cornerStart);
      const s0 = asNum(scalar[cornerStart] ?? 0);
      let fanDirection: Vec3 = [0, 0, 0];
      for (let triangle = 0; triangle < count - 2; triangle++) {
        const p1 = cornerCtx.position(cornerStart + triangle + 1);
        const p2 = cornerCtx.position(cornerStart + triangle + 2);
        const s1 = asNum(scalar[cornerStart + triangle + 1] ?? 0);
        const s2 = asNum(scalar[cornerStart + triangle + 2] ?? 0);
        const raw = vadd(vscale(vsub(p2, p1), s0 - s2), vscale(vsub(p0, p2), s1 - s2));
        fanDirection = vadd(fanDirection, vnorm(raw));
      }
      const gradientDirection = vnorm(fanDirection);
      const direction = solenoidal ? gradientDirection : vcross(faceCtx.normal?.(face) ?? [0, 0, 0], gradientDirection);
      // Dividing by n for the two zero corner slots is immaterial after the
      // authored Normalize node, but keeping the factor documents that step.
      faceDirections[face] = vscale(direction, (count - 2) / count);
      cornerStart += count;
    }
    // The authored group evaluates this corner field on the FACE domain and
    // normalizes it there before Blender adapts the result to the consuming
    // point domain. Normalize every face first: carrying the corner-average
    // magnitude into FACE -> POINT interpolation incorrectly weights triangles
    // by 1/3 and quads by 1/2.
    const normalizedFaceDirections = faceDirections.map(vnorm);
    if (ctx.domain === "FACE") return normalizedFaceDirections;
    if (!ctx.toDomain) return Array.from({ length: ctx.size }, () => [0, 0, 0] as Vec3);
    return Array.from({ length: ctx.size }, (_, i) => vnorm(asVec3(ctx.toDomain!("FACE", normalizedFaceDirections, i) ?? [0, 0, 0])));
  });
}

class Invocation {
  private byName = new Map<string, RawNode>();
  private incoming = new Map<string, { from_node: string; from_socket: string; multi_input_sort_id?: number | null }[]>();
  private memo = new Map<string, Record<string, SockVal>>();
  private visiting = new Set<string>();
  // Active repeat-zone state: RepeatInput node name -> its current-iteration outputs.
  private repeatState = new Map<string, Record<string, SockVal>>();
  // Active per-element state for a For Each Geometry Element zone.
  private foreachState = new Map<string, Record<string, SockVal>>();

  constructor(private ev: Evaluator, private group: RawGroup, private bindings: Record<string, SockVal>) {
    for (const n of group.nodes) this.byName.set(n.name, n);
    for (const l of group.links) {
      if (l.muted) continue;
      const k = KEY(l.to_node, l.to_socket);
      const arr = this.incoming.get(k);
      const incoming = { from_node: l.from_node, from_socket: l.from_socket, multi_input_sort_id: l.multi_input_sort_id };
      if (arr) arr.push(incoming);
      else this.incoming.set(k, [incoming]);
    }
  }

  // Result of the group = its Group Output node's inputs, keyed by socket identifier.
  result(): Record<string, SockVal> {
    const out: Record<string, SockVal> = {};
    const go = this.group.nodes.find((n) => n.type === "NodeGroupOutput");
    if (!go) return out;
    for (const s of go.inputs) {
      if (!s.identifier) continue;
      out[s.identifier] = this.pull(go, s.identifier);
    }
    return out;
  }

  private socketId(node: RawNode, key: string): string {
    const s = node.inputs.find((x) => x.identifier === key || x.name === key);
    return s?.identifier ?? key;
  }

  // Pull the value feeding node.socket (from the first link, or the constant).
  pull(node: RawNode, key: string): SockVal {
    const id = this.socketId(node, key);
    const sock = node.inputs.find((s) => s.identifier === id);
    const links = this.incoming.get(KEY(node.name, id));
    if (links && links.length) {
      const outs = this.evalNode(links[0].from_node);
      return coerceSocketValue(outs[links[0].from_socket] ?? firstGeoOr0(outs), sock?.type ?? "NodeSocketFloat");
    }
    return wrapConst(sock?.type ?? "NodeSocketFloat", sock?.value);
  }

  // Pull all values feeding a multi-input socket (e.g. Join Geometry).
  pullMulti(node: RawNode, key: string): SockVal[] {
    const id = this.socketId(node, key);
    const links = this.incoming.get(KEY(node.name, id));
    if (!links || !links.length) {
      const sock = node.inputs.find((s) => s.identifier === id);
      const c = wrapConst(sock?.type ?? "NodeSocketGeometry", sock?.value);
      return c ? [c] : [];
    }
    const ordered = links.some((link) => link.multi_input_sort_id != null)
      ? [...links].sort((a, b) => (b.multi_input_sort_id ?? 0) - (a.multi_input_sort_id ?? 0))
      : links;
    return ordered.map((l) => {
      const outs = this.evalNode(l.from_node);
      return outs[l.from_socket] ?? firstGeoOr0(outs);
    });
  }

  private evalNode(name: string): Record<string, SockVal> {
    const cached = this.memo.get(name);
    if (cached) return cached;
    if (this.visiting.has(name)) return {}; // cycle guard
    this.visiting.add(name);
    const node = this.byName.get(name);
    let outs: Record<string, SockVal> = {};
    if (node) outs = this.dispatch(node);
    if (node
      && (!FIELD_PROBE.group || FIELD_PROBE.group === this.group.name)
      && FIELD_PROBE.node === node.name
      && FIELD_PROBE.socket) {
      const original = outs[FIELD_PROBE.socket];
      if (original instanceof Field) {
        outs = { ...outs, [FIELD_PROBE.socket]: Field.make((context) => {
          const values = original.array(context);
          FIELD_PROBE.batches.push({
            domain: context.domain,
            positions: Array.from({ length: context.size }, (_, index) => context.position?.(index) ?? [0, 0, 0]),
            values: [...values],
          });
          return values;
        }) };
      }
    }
    this.visiting.delete(name);
    this.memo.set(name, outs);
    if (node && (!GEOMETRY_PROBE.group || GEOMETRY_PROBE.group === this.group.name) && GEOMETRY_PROBE.node === node.name) {
      const value = GEOMETRY_PROBE.socket ? outs[GEOMETRY_PROBE.socket] : Object.values(outs).find((output) => output instanceof Geometry);
      if (value instanceof Geometry) GEOMETRY_PROBE.geometry = value.clone();
    }
    if (node && GEOMETRY_PROBES.targets.length) {
      for (const target of GEOMETRY_PROBES.targets) {
        if (target.group !== this.group.name || target.node !== node.name) continue;
        const value = outs[target.socket];
        if (!(value instanceof Geometry)) continue;
        const key = `${target.group}\u0000${target.node}\u0000${target.socket}`;
        const values = GEOMETRY_PROBES.geometries.get(key) ?? [];
        values.push(value.clone());
        GEOMETRY_PROBES.geometries.set(key, values);
      }
    }
    if (node && (!VALUE_PROBE.group || VALUE_PROBE.group === this.group.name) && VALUE_PROBE.node === node.name) {
      const value = VALUE_PROBE.socket ? outs[VALUE_PROBE.socket] : undefined;
      if (value instanceof Field && value.isConst) VALUE_PROBE.values.push(value.value);
    }
    if (TRACE.on && node) {
      for (const k in outs) {
        const v = outs[k];
        if (v instanceof Geometry)
          TRACE.log.push({ group: this.group.name, node: node.name, type: node.type, out: k, verts: v.mesh?.positions.length ?? 0, faces: v.mesh?.faces.length ?? 0, curves: v.curvePointCount(), inst: v.instances.length, bbox: bboxOf(v) });
      }
    }
    return outs;
  }

  private dispatch(node: RawNode): Record<string, SockVal> {
    if (node.ui?.mute) return this.mutedPassthrough(node);
    switch (node.type) {
      case "NodeReroute":
        return { [node.outputs[0]?.identifier ?? "Output"]: this.pull(node, node.inputs[0]?.identifier ?? "Input") };
      case "NodeFrame":
        return {};
      case "NodeGroupInput": {
        const o: Record<string, SockVal> = {};
        for (const out of node.outputs) if (out.identifier) o[out.identifier] = this.bindings[out.identifier];
        return o;
      }
      case "GeometryNodeGroup": {
        if (!node.group) return {};
        if (node.group === "Gradient Direction") {
          const input = this.pull(node, "Input_1");
          const mode = this.pull(node, "Input_2");
          const gradient = input instanceof Field ? input : Field.of(0);
          const solenoidal = mode instanceof Field && mode.isConst ? asNum(mode.value) > 0 : false;
          return { Output_0: gradientDirectionField(gradient, solenoidal) };
        }
        // This Blender 3.4-era utility pack implements large socket selectors
        // as nested math/switch node groups. Evaluating the legacy boolean
        // ladder field-by-field is both expensive and prone to float/bool
        // coercion differences, while the group contract itself is exact.
        if (node.group === "_SWITCH.GEOMETRY 25 slot" || node.group === "_SWITCH.accumalative geo") {
          const rawValue = this.pull(node, "Input_0");
          const value = Math.max(0, Math.round(rawValue instanceof Field && rawValue.isConst ? asNum(rawValue.value) : 0));
          const geometryInputs = node.inputs.filter((socket) => socket.type === "NodeSocketGeometry" && /^\d+$/.test(socket.name));
          if (node.group === "_SWITCH.GEOMETRY 25 slot") {
            const socket = geometryInputs[value - 1];
            return { Output_19: socket ? this.pull(node, socket.identifier) : new Geometry() };
          }
          const joined = new Geometry();
          joined.mesh = new Mesh();
          // The authored control is the highest visible row index, not a
          // count: value 0 keeps row 1, value 1 keeps rows 1 and 2, and so on.
          // The legacy switch ladder therefore accumulates through the
          // selected index inclusively.
          for (const [rowIndex, socket] of geometryInputs.slice(0, value + 1).entries()) {
            const part = this.pull(node, socket.identifier);
            if (!(part instanceof Geometry)) continue;
            const shifted = part.clone();
            const z = rowIndex * -0.6299998760223389;
            const move = (point: Vec3): Vec3 => [point[0], point[1], point[2] + z];
            if (shifted.mesh) shifted.mesh.positions = shifted.mesh.positions.map(move);
            for (const spline of shifted.curves) {
              spline.points = spline.points.map(move);
              if (spline.controlPoints) spline.controlPoints = spline.controlPoints.map(move);
              if (spline.bezierLeft) spline.bezierLeft = spline.bezierLeft.map(move);
              if (spline.bezierRight) spline.bezierRight = spline.bezierRight.map(move);
            }
            for (const instance of shifted.instances) instance.position = move(instance.position);
            if (shifted.mesh) mergeMeshInto(joined.mesh, shifted.mesh);
            joined.curves.push(...shifted.curves);
            joined.instances.push(...shifted.instances);
          }
          if (!joined.mesh.positions.length && !joined.mesh.faces.length && !joined.mesh.edges.length) joined.mesh = undefined;
          return { Output_19: joined };
        }
        if (node.group === "_SWITCH.Materials 15 slot") {
          const rawValue = this.pull(node, "Input_0");
          const value = Math.max(0, Math.round(rawValue instanceof Field && rawValue.isConst ? asNum(rawValue.value) : 0));
          const sockets = node.inputs.filter((socket) => socket.type === "NodeSocketMaterial" && /^\d+$/.test(socket.name));
          return { Output_19: sockets[value - 1] ? this.pull(node, sockets[value - 1].identifier) : null };
        }
        const sub: Record<string, SockVal> = {};
        for (const s of node.inputs)
          if (s.identifier) sub[s.identifier] = coerceGroupInput(this.pull(node, s.identifier), s.type);
        return this.ev.evalGroup(node.group, sub);
      }
      // Repeat zones: pulling from the output node runs the whole loop; the input
      // node serves the current iteration's state (or the initial values when no
      // loop is active — iteration-0 semantics).
      case "GeometryNodeRepeatInput": {
        const active = this.repeatState.get(node.name);
        if (active) return active;
        const init: Record<string, SockVal> = { Iteration: Field.of(0) };
        for (const s of node.inputs)
          if (s.identifier && s.identifier !== "Iterations" && s.identifier !== "__extend__")
            init[s.identifier] = this.pull(node, s.identifier);
        return init;
      }
      case "GeometryNodeRepeatOutput":
        return this.runRepeatZone(node);
      case "GeometryNodeForeachGeometryElementInput": {
        const active = this.foreachState.get(node.name);
        if (active) return active;
        return { Index: Field.of(0), Element: this.pull(node, "Geometry") };
      }
      case "GeometryNodeForeachGeometryElementOutput":
        return this.runForeachZone(node);
    }
    const handler = REGISTRY.get(node.type);
    if (!handler) {
      MISSING.set(node.type, (MISSING.get(node.type) ?? 0) + 1);
      return this.fallback(node);
    }
    return handler(this.api(node));
  }

  private mutedPassthrough(node: RawNode): Record<string, SockVal> {
    const out: Record<string, SockVal> = {};
    for (const output of node.outputs) {
      const input = node.inputs.find((socket) => socket.identifier === output.identifier)
        ?? node.inputs.find((socket) => socket.name === output.name && (!output.type || socket.type === output.type))
        ?? node.inputs.find((socket) => output.type && socket.type === output.type && socket.identifier !== "__extend__")
        ?? node.inputs.find((socket) => socket.identifier !== "__extend__");
      out[output.identifier] = input ? this.pull(node, input.identifier) : Field.of(0);
    }
    return out;
  }

  // Run a repeat zone to completion. State items are keyed by socket identifier
  // (Item_k): RepeatInput's non-Iterations inputs are the initial values, its
  // outputs expose the current state (+ Iteration counter), RepeatOutput's inputs
  // produce the next state, and its outputs are the final state after N passes.
  private runRepeatZone(outNode: RawNode): Record<string, SockVal> {
    const inNode = this.group.nodes.find(
      (n) => n.type === "GeometryNodeRepeatInput" && n.paired_output === outNode.name
    ) ?? this.group.nodes.find((n) => n.type === "GeometryNodeRepeatInput");
    if (!inNode) return {};
    const iterV = this.pull(inNode, "Iterations");
    const nIter = Math.max(0, Math.round(iterV instanceof Field && iterV.isConst ? Number(iterV.value) || 0 : 0));
    // initial state
    let state: Record<string, SockVal> = {};
    for (const s of inNode.inputs)
      if (s.identifier && s.identifier !== "Iterations" && s.identifier !== "__extend__")
        state[s.identifier] = this.pull(inNode, s.identifier);
    // zone members: nodes forward-reachable from the RepeatInput — their memoized
    // values change per iteration and must be re-evaluated.
    const zone = new Set<string>();
    const queue = [inNode.name];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const l of this.group.links)
        if (!l.muted && l.from_node === cur && !zone.has(l.to_node)) { zone.add(l.to_node); queue.push(l.to_node); }
    }
    for (let it = 0; it < nIter; it++) {
      for (const nm of zone) this.memo.delete(nm);
      this.memo.delete(inNode.name);
      this.repeatState.set(inNode.name, { Iteration: Field.of(it), ...state });
      const next: Record<string, SockVal> = {};
      for (const s of outNode.inputs)
        if (s.identifier && s.identifier !== "__extend__") next[s.identifier] = this.pull(outNode, s.identifier);
      state = next;
    }
    this.repeatState.delete(inNode.name);
    // leave the zone's per-iteration memos cleared so later out-of-zone pulls
    // don't see stale last-iteration values for zone nodes
    for (const nm of zone) this.memo.delete(nm);
    this.memo.delete(inNode.name);
    return state;
  }

  // Blender's For Each Geometry Element zone evaluates its body once for every
  // selected element, then joins each Generation output. New Joint's sleeve
  // builder uses the INSTANCE domain, with one collection child per iteration.
  private runForeachZone(outNode: RawNode): Record<string, SockVal> {
    const inNode = this.group.nodes.find(
      (node) => node.type === "GeometryNodeForeachGeometryElementInput" && node.paired_output === outNode.name,
    ) ?? this.group.nodes.find((node) => node.type === "GeometryNodeForeachGeometryElementInput");
    if (!inNode) return {};
    const sourceValue = this.pull(inNode, "Geometry");
    const source = sourceValue instanceof Geometry ? sourceValue : new Geometry();
    const domain = (outNode.props?.domain ?? "INSTANCE") as Domain;
    const sourceContext = makeFieldCtx(source, domain);
    const selectionValue = this.pull(inNode, "Selection");
    const selection = selectionValue instanceof Field ? selectionValue.array(sourceContext) : [];
    const generated = new Map<string, Geometry[]>();
    for (const socket of outNode.inputs) {
      if (socket.identifier.startsWith("Generation_")) generated.set(socket.identifier, []);
    }

    const zone = new Set<string>();
    const queue = [inNode.name];
    while (queue.length) {
      const current = queue.pop()!;
      for (const link of this.group.links) {
        if (!link.muted && link.from_node === current && !zone.has(link.to_node)) {
          zone.add(link.to_node);
          queue.push(link.to_node);
        }
      }
    }

    for (let index = 0; index < sourceContext.size; index++) {
      if (selection.length && !asNum(selection[index] ?? 0)) continue;
      const element = new Geometry();
      const sourceInstance = domain === "INSTANCE" ? source.instances[index] : undefined;
      if (sourceInstance) {
        // Blender's extract_instances() carries the complete source instance
        // into the zone body. Geometry nodes inside the body therefore see the
        // authored position/rotation/scale before Generation geometry is
        // joined. Modern Pipe realizes, rotates and sweeps this transformed
        // rail inside the body, so evaluating at identity and reapplying the
        // matrix afterward changes float32 curve frames.
        element.instances.push({
          ...sourceInstance,
          position: [...sourceInstance.position] as Vec3,
          rotation: [...sourceInstance.rotation] as Vec3,
          scale: [...sourceInstance.scale] as Vec3,
          transformMatrix: sourceInstance.transformMatrix?.map((row) => [...row]),
          attributes: sourceInstance.attributes ? new Map(sourceInstance.attributes) : undefined,
        });
      }
      for (const name of zone) this.memo.delete(name);
      this.memo.delete(inNode.name);
      this.foreachState.set(inNode.name, { Index: Field.of(index), Element: element });
      for (const [identifier, parts] of generated) {
        const value = this.pull(outNode, identifier);
        if (!(value instanceof Geometry)) continue;
        parts.push(value.clone());
      }
    }
    this.foreachState.delete(inNode.name);
    for (const name of zone) this.memo.delete(name);
    this.memo.delete(inNode.name);

    const outputs: Record<string, SockVal> = { Geometry: source.clone() };
    for (const [identifier, parts] of generated) {
      const joined = new Geometry();
      joined.mesh = new Mesh();
      for (const part of parts) {
        // The zone output calls join_geometries() on every generated result;
        // it does not add an identity instance boundary per iteration.
        if (part.mesh) mergeMeshInto(joined.mesh, part.mesh);
        joined.curves.push(...part.curves.map((spline) => ({
          cyclic: spline.cyclic,
          resolution: spline.resolution,
          splineType: spline.splineType,
          points: spline.points.map((point) => [...point] as Vec3),
          controlPoints: spline.controlPoints?.map((point) => [...point] as Vec3),
          bezierLeft: spline.bezierLeft?.map((point) => [...point] as Vec3),
          bezierRight: spline.bezierRight?.map((point) => [...point] as Vec3),
        })));
        joined.instances.push(...part.instances.map((instance) => ({
          ...instance,
          position: [...instance.position] as Vec3,
          rotation: [...instance.rotation] as Vec3,
          scale: [...instance.scale] as Vec3,
          transformMatrix: instance.transformMatrix?.map((row) => [...row]),
          attributes: instance.attributes ? new Map(instance.attributes) : undefined,
        })));
      }
      if (!joined.mesh.positions.length && !joined.mesh.faces.length && !joined.mesh.edges.length) joined.mesh = undefined;
      outputs[identifier] = joined;
    }
    return outputs;
  }

  // Unknown node: pass the first geometry input through to every geometry output.
  private fallback(node: RawNode): Record<string, SockVal> {
    let geo: Geometry | null = null;
    for (const s of node.inputs) {
      if (s.type === "NodeSocketGeometry") {
        const v = this.pull(node, s.identifier);
        if (v instanceof Geometry) { geo = v; break; }
      }
    }
    const out: Record<string, SockVal> = {};
    for (const o of node.outputs) out[o.identifier] = o.name === "Geometry" || node.outputs.length === 1 ? geo ?? new Geometry() : (geo ?? new Geometry());
    return out;
  }

  private api(node: RawNode): EvalAPI {
    const self = this;
    const field = (name: string): Field => {
      const v = self.pull(node, name);
      return v instanceof Field ? v : Field.of(0);
    };
    return {
      node,
      input: (name) => self.pull(node, name),
      inputs: (name) => self.pullMulti(node, name),
      geoInputs: (name) => self.pullMulti(node, name).filter((v): v is Geometry => v instanceof Geometry),
      geo: (name) => {
        const v = self.pull(node, name);
        return v instanceof Geometry ? v : new Geometry();
      },
      field,
      num: (name) => {
        const f = field(name);
        const v = f.isConst ? f.value : 0;
        return Array.isArray(v) ? v[0] : v;
      },
      vec: (name) => {
        const f = field(name);
        const v = f.isConst ? f.value : [0, 0, 0];
        return (Array.isArray(v) ? v : [v, v, v]) as Vec3;
      },
      bool: (name) => {
        const f = field(name);
        const v = f.isConst ? f.value : 0;
        return (Array.isArray(v) ? v[0] : v) > 0;
      },
      str: (name) => {
        const v = self.pull(node, name);
        return typeof v === "string" ? v : "";
      },
      ref: (name) => {
        const v = self.pull(node, name);
        return v && typeof v === "object" && !(v instanceof Geometry) && !(v instanceof Field) ? (v as DataRef) : null;
      },
      prop: (name, dflt) => (node.props && name in node.props ? node.props[name] : dflt),
      resolve: (f, geo, domain) => f.array(makeFieldCtx(geo, domain)),
    };
  }
}

function firstGeoOr0(outs: Record<string, SockVal>): SockVal {
  for (const k in outs) if (outs[k] instanceof Geometry) return outs[k];
  return Field.of(0);
}

export class Evaluator {
  constructor(public program: Program) {}

  evalGroup(name: string, bindings: Record<string, SockVal>): Record<string, SockVal> {
    const g = this.program[name];
    if (!g) return {};
    return new Invocation(this, g, bindings).result();
  }

  // Evaluate a modifier: bind interface inputs from defaults + overrides, return geometry.
  evalModifierGroup(groupName: string, overrides: Record<string, any> = {}): { geometry: Geometry; outputs: Record<string, SockVal> } {
    const g = this.program[groupName];
    if (!g) throw new Error(`group not found: ${groupName}`);
    const bindings: Record<string, SockVal> = {};
    for (const item of g.interface) {
      if (item.item_type === "SOCKET" && item.in_out === "INPUT") {
        // Blender permits duplicate interface names. Modifier dumps therefore
        // bind by socket identifier first; human-friendly name overrides remain
        // available for the common unambiguous case.
        const val = item.identifier in overrides ? overrides[item.identifier] : item.name in overrides ? overrides[item.name] : item.default;
        bindings[item.identifier] = wrapConst(item.socket_type, val);
      }
    }
    const outputs = this.evalGroup(groupName, bindings);
    let geometry = new Geometry();
    for (const k in outputs) if (outputs[k] instanceof Geometry) { geometry = outputs[k] as Geometry; break; }
    return { geometry, outputs };
  }
}
