// Geometry data structures for the GN-VM. Deliberately THREE-free so the whole
// engine runs under plain node/tsx for self-tests; the browser viewer converts
// the triangle soup to a BufferGeometry.

import { Vec3, Domain, Elem, vadd, vscale, vnorm } from "./core";

export interface Attribute {
  domain: Domain;
  data: Elem[];
}

// A mesh with ngon faces. Corners are implied by faces (face i's corners are its
// vertex-index list, in order).
export class Mesh {
  positions: Vec3[] = [];
  edges: [number, number][] = [];
  faces: number[][] = []; // each face = ordered vertex indices
  faceMaterial: number[] = []; // material slot per face
  materialSlots: (string | null)[] = []; // slot index -> material name
  attributes: Map<string, Attribute> = new Map();

  domainSize(d: Domain): number {
    switch (d) {
      case "POINT": return this.positions.length;
      case "EDGE": return this.edges.length;
      case "FACE": return this.faces.length;
      case "CORNER": return this.faces.reduce((n, f) => n + f.length, 0);
      default: return 0;
    }
  }

  faceCenter(fi: number): Vec3 {
    const f = this.faces[fi];
    let c: Vec3 = [0, 0, 0];
    for (const vi of f) c = vadd(c, this.positions[vi]);
    return vscale(c, 1 / f.length);
  }

  faceNormal(fi: number): Vec3 {
    const f = this.faces[fi];
    if (f.length < 3) return [0, 0, 1];
    // Newell's method (robust for ngons).
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < f.length; i++) {
      const cur = this.positions[f[i]];
      const nxt = this.positions[f[(i + 1) % f.length]];
      nx += (cur[1] - nxt[1]) * (cur[2] + nxt[2]);
      ny += (cur[2] - nxt[2]) * (cur[0] + nxt[0]);
      nz += (cur[0] - nxt[0]) * (cur[1] + nxt[1]);
    }
    return vnorm([nx, ny, nz]);
  }

  // Smooth per-vertex normals (area-weighted from face normals).
  vertexNormals(): Vec3[] {
    const acc: Vec3[] = this.positions.map(() => [0, 0, 0]);
    for (let fi = 0; fi < this.faces.length; fi++) {
      const n = this.faceNormal(fi);
      for (const vi of this.faces[fi]) acc[vi] = vadd(acc[vi], n);
    }
    return acc.map((n) => vnorm(n));
  }

  ensureMaterialSlot(name: string | null): number {
    const idx = this.materialSlots.indexOf(name);
    if (idx >= 0) return idx;
    this.materialSlots.push(name);
    return this.materialSlots.length - 1;
  }

  clone(): Mesh {
    const m = new Mesh();
    m.positions = this.positions.map((p) => [...p] as Vec3);
    m.edges = this.edges.map((e) => [...e] as [number, number]);
    m.faces = this.faces.map((f) => [...f]);
    m.faceMaterial = [...this.faceMaterial];
    m.materialSlots = [...this.materialSlots];
    for (const [k, a] of this.attributes) m.attributes.set(k, { domain: a.domain, data: [...a.data] });
    return m;
  }
}

export interface InstanceRef {
  geometry: Geometry;
  position: Vec3;
  rotation: Vec3; // euler XYZ radians
  scale: Vec3;
  attributes?: Map<string, Elem>; // per-instance attribute values (broadcast on realize)
}

// A single spline (control-point polyline). We treat all splines as poly after
// resample; bezier handles are not modelled.
export interface Spline {
  points: Vec3[];
  cyclic: boolean;
}

// A geometry set: mesh + curves (splines) + instances.
export class Geometry {
  mesh?: Mesh;
  curves: Spline[] = [];
  instances: InstanceRef[] = [];
  // Attributes on the curve component: POINT domain over flattened control points.
  curveAttributes: Map<string, Attribute> = new Map();

  static empty(): Geometry {
    return new Geometry();
  }

  // Number of flattened curve control points (curve POINT domain).
  curvePointCount(): number {
    return this.curves.reduce((n, s) => n + s.points.length, 0);
  }

  clone(): Geometry {
    const g = new Geometry();
    if (this.mesh) g.mesh = this.mesh.clone();
    g.curves = this.curves.map((s) => ({ cyclic: s.cyclic, points: s.points.map((p) => [...p] as Vec3) }));
    g.instances = this.instances.map((i) => ({
      ...i,
      position: [...i.position] as Vec3, rotation: [...i.rotation] as Vec3, scale: [...i.scale] as Vec3,
      attributes: i.attributes ? new Map(i.attributes) : undefined,
    }));
    for (const [k, a] of this.curveAttributes) g.curveAttributes.set(k, { domain: a.domain, data: [...a.data] });
    return g;
  }
}

// ---- mesh topology (canonical edges, adjacency, islands) ------------------
export interface Topology {
  edges: { verts: [number, number]; faces: number[] }[]; // canonical unique edges
  faceNeighbors: number[]; // # faces sharing an edge with face i
  faceIsland: number[]; // connected-component id per face
  faceIslandCount: number;
  pointIsland: number[]; // connected-component id per vertex
  pointIslandCount: number;
  pointFaces: number[][]; // faces incident to each vertex (for domain interpolation)
}

export function buildTopology(mesh: Mesh): Topology {
  const ekey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const emap = new Map<string, { verts: [number, number]; faces: number[] }>();
  const addFaceEdge = (a: number, b: number, fi: number) => {
    const k = ekey(a, b);
    let e = emap.get(k);
    if (!e) { e = { verts: [Math.min(a, b), Math.max(a, b)], faces: [] }; emap.set(k, e); }
    if (fi >= 0) e.faces.push(fi);
  };
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const f = mesh.faces[fi];
    for (let i = 0; i < f.length; i++) addFaceEdge(f[i], f[(i + 1) % f.length], fi);
  }
  for (const [a, b] of mesh.edges) addFaceEdge(a, b, -1);
  const edges = [...emap.values()];

  // face adjacency via shared edges
  const faceNeighborSets: Set<number>[] = mesh.faces.map(() => new Set<number>());
  for (const e of edges) for (const fa of e.faces) for (const fb of e.faces) if (fa !== fb) faceNeighborSets[fa].add(fb);
  const faceNeighbors = faceNeighborSets.map((s) => s.size);

  // union-find helper
  const uf = (n: number, unions: [number, number][]) => {
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (const [a, b] of unions) parent[find(a)] = find(b);
    const label = new Map<number, number>();
    const out = new Array(n);
    let count = 0;
    for (let i = 0; i < n; i++) { const r = find(i); if (!label.has(r)) label.set(r, count++); out[i] = label.get(r)!; }
    return { out, count };
  };

  const faceUnions: [number, number][] = [];
  for (const e of edges) for (let i = 1; i < e.faces.length; i++) faceUnions.push([e.faces[0], e.faces[i]]);
  const fu = uf(mesh.faces.length, faceUnions);

  const pointUnions: [number, number][] = edges.map((e) => e.verts);
  const pu = uf(mesh.positions.length, pointUnions);

  const pointFaces: number[][] = mesh.positions.map(() => []);
  for (let fi = 0; fi < mesh.faces.length; fi++) for (const v of mesh.faces[fi]) pointFaces[v]?.push(fi);

  return {
    edges,
    faceNeighbors,
    faceIsland: fu.out,
    faceIslandCount: fu.count,
    pointIsland: pu.out,
    pointIslandCount: pu.count,
    pointFaces,
  };
}

// ---- euler rotation of a point (Blender XYZ order) ------------------------
export function rotateEulerXYZ(p: Vec3, e: Vec3): Vec3 {
  let [x, y, z] = p;
  // X
  let cy = Math.cos(e[0]), sy = Math.sin(e[0]);
  [y, z] = [y * cy - z * sy, y * sy + z * cy];
  // Y
  let cx = Math.cos(e[1]), sx = Math.sin(e[1]);
  [x, z] = [x * cx + z * sx, -x * sx + z * cx];
  // Z
  let cz = Math.cos(e[2]), sz = Math.sin(e[2]);
  [x, y] = [x * cz - y * sz, x * sz + y * cz];
  return [x, y, z];
}

export function transformPoint(p: Vec3, pos: Vec3, rot: Vec3, scl: Vec3): Vec3 {
  return vadd(rotateEulerXYZ([p[0] * scl[0], p[1] * scl[1], p[2] * scl[2]], rot), pos);
}

const zeroLike = (e: Elem | undefined): Elem => (Array.isArray(e) ? [0, 0, 0] : 0);

// Merge mesh b into a, offsetting vertex indices; preserves materials + attributes.
// Unique undirected edge keys in buildTopology's enumeration order
// (face-derived first-seen, then explicit wires) so EDGE attr data stays aligned.
const ekeyG = (x: number, y: number) => (x < y ? `${x}_${y}` : `${y}_${x}`);
function canonicalEdgeKeys(m: Mesh): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (k: string) => { if (!seen.has(k)) { seen.add(k); out.push(k); } };
  for (const f of m.faces) for (let i = 0; i < f.length; i++) add(ekeyG(f[i], f[(i + 1) % f.length]));
  for (const [x, y] of m.edges) add(ekeyG(x, y));
  return out;
}

export function mergeMeshInto(a: Mesh, b: Mesh): void {
  // Canonical edge maps must be taken before mutation for the EDGE-attr reconcile.
  const hasEdgeAttr = (m: Mesh) => [...m.attributes.values()].some((x) => x.domain === "EDGE");
  const needEdge = hasEdgeAttr(a) || hasEdgeAttr(b);
  const aEdgeIdx = needEdge ? new Map(canonicalEdgeKeys(a).map((k, i) => [k, i])) : null;
  const bEdgeIdx = needEdge ? new Map(canonicalEdgeKeys(b).map((k, i) => [k, i])) : null;
  const baseV = a.positions.length;
  const baseF = a.faces.length;
  for (const p of b.positions) a.positions.push([...p] as Vec3);
  for (const e of b.edges) a.edges.push([e[0] + baseV, e[1] + baseV]);
  const slotMap = b.materialSlots.map((name) => a.ensureMaterialSlot(name));
  for (let fi = 0; fi < b.faces.length; fi++) {
    a.faces.push(b.faces[fi].map((vi) => vi + baseV));
    a.faceMaterial.push(slotMap[b.faceMaterial[fi] ?? 0] ?? 0);
  }
  // reconcile POINT + FACE (+ EDGE when present) attributes across the union of names
  const reconcile = (domain: "POINT" | "FACE" | "EDGE", baseCount: number, addCount: number) => {
    const names = new Set<string>();
    for (const [k, x] of a.attributes) if (x.domain === domain) names.add(k);
    for (const [k, x] of b.attributes) if (x.domain === domain) names.add(k);
    for (const name of names) {
      let aa = a.attributes.get(name);
      const ba = b.attributes.get(name);
      const dflt = zeroLike(aa?.data[0] ?? ba?.data[0]);
      if (!aa) { aa = { domain, data: [] }; a.attributes.set(name, aa); }
      while (aa.data.length < baseCount) aa.data.push(dflt);
      for (let i = 0; i < addCount; i++) aa.data.push(ba ? ba.data[i] ?? dflt : dflt);
    }
  };
  reconcile("POINT", baseV, b.positions.length);
  reconcile("FACE", baseF, b.faces.length);
  // EDGE attrs can't just concatenate: buildTopology enumerates ALL face-derived
  // edges before ANY loose wires, so when A has loose edges the joined order
  // interleaves. Map each joined canonical edge back to its source explicitly.
  if (needEdge && aEdgeIdx && bEdgeIdx) {
    const joined = canonicalEdgeKeys(a); // after mutation
    // a joined edge belongs to B iff both endpoints are >= baseV
    const srcOf = joined.map((k) => {
      const [u, v] = k.split("_").map(Number);
      if (u >= baseV && v >= baseV) {
        const bi = bEdgeIdx.get(ekeyG(u - baseV, v - baseV));
        return bi === undefined ? null : { from: "b" as const, i: bi };
      }
      const ai = aEdgeIdx.get(k);
      return ai === undefined ? null : { from: "a" as const, i: ai };
    });
    const names = new Set<string>();
    for (const [k, x] of a.attributes) if (x.domain === "EDGE") names.add(k);
    for (const [k, x] of b.attributes) if (x.domain === "EDGE") names.add(k);
    for (const name of names) {
      const aa = a.attributes.get(name);
      const ba = b.attributes.get(name);
      const dflt = zeroLike(aa?.data[0] ?? ba?.data[0]);
      const data = srcOf.map((s) =>
        s === null ? dflt : s.from === "a" ? aa?.data[s.i] ?? dflt : ba?.data[s.i] ?? dflt
      );
      a.attributes.set(name, { domain: "EDGE", data });
    }
  }
}

// Realize instances into the mesh (bakes transforms, merges geometry, propagates
// per-instance attributes onto the realized vertices — Blender's realize semantics).
export function realizeInstances(g: Geometry): Geometry {
  const out = new Geometry();
  const mesh = g.mesh ? g.mesh.clone() : new Mesh();
  for (const inst of g.instances) {
    const rg = realizeInstances(inst.geometry); // recursive
    if (!rg.mesh) continue;
    const tm = rg.mesh.clone();
    tm.positions = tm.positions.map((p) => transformPoint(p, inst.position, inst.rotation, inst.scale));
    const baseV = mesh.positions.length;
    mergeMeshInto(mesh, tm); // carries the instance geometry's own attributes
    if (inst.attributes && inst.attributes.size) {
      for (const [name, val] of inst.attributes) {
        let a = mesh.attributes.get(name);
        if (!a) { a = { domain: "POINT", data: [] }; mesh.attributes.set(name, a); }
        while (a.data.length < mesh.positions.length) a.data.push(zeroLike(val));
        for (let k = baseV; k < mesh.positions.length; k++) a.data[k] = val;
      }
    }
  }
  out.mesh = mesh;
  return out;
}

// ---- triangle-soup export for the renderer --------------------------------
export interface TriSoup {
  positions: Float32Array; // xyz per vertex (indexed)
  normals: Float32Array;
  indices: Uint32Array;
  groups: { start: number; count: number; material: string | null }[]; // per material slot
  stats: { verts: number; faces: number; tris: number };
}

export function toTriSoup(g: Geometry): TriSoup {
  const realized = g.instances.length ? realizeInstances(g) : g;
  const mesh = realized.mesh ?? new Mesh();
  const normals = mesh.vertexNormals();
  const positions = new Float32Array(mesh.positions.length * 3);
  const normArr = new Float32Array(mesh.positions.length * 3);
  for (let i = 0; i < mesh.positions.length; i++) {
    positions[i * 3] = mesh.positions[i][0];
    positions[i * 3 + 1] = mesh.positions[i][1];
    positions[i * 3 + 2] = mesh.positions[i][2];
    normArr[i * 3] = normals[i][0];
    normArr[i * 3 + 1] = normals[i][1];
    normArr[i * 3 + 2] = normals[i][2];
  }
  // group faces by material slot, fan-triangulate
  const slotCount = Math.max(1, mesh.materialSlots.length);
  const perSlot: number[][] = Array.from({ length: slotCount }, () => []);
  let triCount = 0;
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const f = mesh.faces[fi];
    const slot = mesh.faceMaterial[fi] ?? 0;
    for (let k = 1; k + 1 < f.length; k++) {
      perSlot[slot].push(f[0], f[k], f[k + 1]);
      triCount++;
    }
  }
  const indices = new Uint32Array(triCount * 3);
  const groups: TriSoup["groups"] = [];
  let cursor = 0;
  for (let s = 0; s < slotCount; s++) {
    const tri = perSlot[s];
    if (!tri.length) continue;
    groups.push({ start: cursor, count: tri.length, material: mesh.materialSlots[s] ?? null });
    indices.set(tri, cursor);
    cursor += tri.length;
  }
  return {
    positions,
    normals: normArr,
    indices,
    groups,
    stats: { verts: mesh.positions.length, faces: mesh.faces.length, tris: triCount },
  };
}
