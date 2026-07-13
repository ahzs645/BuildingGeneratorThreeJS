// Pull-based dataflow evaluator for dumped geometry-node graphs.
//
//  - Groups are evaluated recursively: a GeometryNodeGroup binds its inputs, runs
//    the subtree, and reads the subtree's Group Output.
//  - Reroute is passthrough, Frame is ignored, Group Input yields the invocation
//    bindings.
//  - Every other node type dispatches through the REGISTRY. Unhandled types are
//    recorded in MISSING and fall back to passing the first geometry input through,
//    so evaluation never crashes and we get a coverage report + partial mesh.

import { Field, Vec3, Domain, FieldCtx, asNum, fieldMap, vadd, vcross, vdot, vnorm, vscale, vsub } from "./core";
import { Geometry, realizeInstances, topologyOf, Topology } from "./geometry";
import { splineFrames, splineLength } from "./curves";
import { EvalAPI, RawNode, REGISTRY, MISSING, SockVal, DataRef } from "./registry";

export interface RawGroup {
  name: string;
  type: string;
  nodes: RawNode[];
  links: { from_node: string; from_socket: string; to_node: string; to_socket: string; multi_input_sort_id?: number | null }[];
  interface: any[];
}
export type Program = Record<string, RawGroup>;

// Per-node geometry trace for debugging (off by default; near-zero cost when off).
export const TRACE: { on: boolean; log: { group: string; node: string; type: string; out: string; verts: number; faces: number; curves: number; inst: number; bbox?: string }[] } = { on: false, log: [] };
export const FIELD_PROBE: {
  node: string | null;
  socket: string | null;
  batches: { domain: Domain; positions: Vec3[]; values: import("./core").Elem[]; targets?: Vec3[] }[];
} = { node: null, socket: null, batches: [] };

export const GEOMETRY_PROBE: { group: string | null; node: string | null; socket: string | null; geometry: Geometry | null } = {
  group: null,
  node: null,
  socket: null,
  geometry: null,
};

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
  if (socketType.includes("Int")) return fieldMap([coerced], (v) => Math.round(asNum(v)));
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
    if (src === domain || !mesh) return arr[i];
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
      if (!edge || edge.faces.length < 2) return 0;
      const first = mesh.faceNormal(edge.faces[0]);
      const second = mesh.faceNormal(edge.faces[1]);
      const angle = Math.acos(Math.max(-1, Math.min(1, vdot(first, second))));
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
      if (!normals) normals = mesh.vertexNormals();
      return normals[i] ?? [0, 0, 1];
    },
    index: (i) => i,
    attr: (name, i) => {
      if (domain === "INSTANCE") return geo.instances[i]?.attributes?.get(name);
      if (!mesh) {
        // curve geometry: read curve-component attributes (POINT over control points)
        const ca = geo.curveAttributes.get(name);
        return ca ? ca.data[i] : undefined;
      }
      const a = mesh.attributes.get(name);
      if (!a) return undefined;
      // cross-domain interpolation (geometry-nodes evaluates fields across domains)
      return toDomain(a.domain, a.data, i);
    },
  };
}

class Invocation {
  private byName = new Map<string, RawNode>();
  private incoming = new Map<string, { from_node: string; from_socket: string; multi_input_sort_id?: number | null }[]>();
  private memo = new Map<string, Record<string, SockVal>>();
  private visiting = new Set<string>();
  // Active repeat-zone state: RepeatInput node name -> its current-iteration outputs.
  private repeatState = new Map<string, Record<string, SockVal>>();

  constructor(private ev: Evaluator, private group: RawGroup, private bindings: Record<string, SockVal>) {
    for (const n of group.nodes) this.byName.set(n.name, n);
    for (const l of group.links) {
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
    this.visiting.delete(name);
    this.memo.set(name, outs);
    if (node && (!GEOMETRY_PROBE.group || GEOMETRY_PROBE.group === this.group.name) && GEOMETRY_PROBE.node === node.name) {
      const value = GEOMETRY_PROBE.socket ? outs[GEOMETRY_PROBE.socket] : Object.values(outs).find((output) => output instanceof Geometry);
      if (value instanceof Geometry) GEOMETRY_PROBE.geometry = value.clone();
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
        if (l.from_node === cur && !zone.has(l.to_node)) { zone.add(l.to_node); queue.push(l.to_node); }
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
