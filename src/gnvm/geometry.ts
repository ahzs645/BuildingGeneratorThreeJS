// Geometry data structures for the GN-VM. Deliberately THREE-free so the whole
// engine runs under plain node/tsx for self-tests; the browser viewer converts
// the triangle soup to a BufferGeometry.

import { Vec3, Domain, Elem, asNum, asVec3, vadd, vscale, vsub, vdot, vlen, vnorm } from "./core";

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

  faceArea(fi: number): number {
    const face = this.faces[fi];
    if (!face || face.length < 3) return 0;
    const origin = this.positions[face[0]];
    let area = 0;
    for (let i = 1; i + 1 < face.length; i++) {
      const a = vsub(this.positions[face[i]], origin);
      const b = vsub(this.positions[face[i + 1]], origin);
      area += vlen([
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ]) * 0.5;
    }
    return area;
  }

  // Smooth per-vertex normals (area-weighted from face normals).
  vertexNormals(): Vec3[] {
    return vertexNormalsOf(this);
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

/** Triangulate one ordered 3D polygon without assuming it is convex. */
export function triangulateFaceIndices(mesh: Mesh, face: number[]): [number, number, number][] {
  if (face.length < 3) return [];
  if (face.length === 3) return [[face[0], face[1], face[2]]];
  if (face.length === 4) {
    // Blender's corner-triangle cache starts with the 0-2 diagonal and flips
    // only when that split produces opposing triangle directions. Geometry
    // Proximity samples these triangles directly, so a generic ear-clipping
    // diagonal visibly changes nearest positions on non-planar quad meshes.
    const f = Math.fround;
    const [v1, v2, v3, v4] = face.map((index) => mesh.positions[index].map(f) as Vec3);
    const subtract = (a: Vec3, b: Vec3): Vec3 => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
    const cross = (a: Vec3, b: Vec3): Vec3 => [
      f(f(a[1] * b[2]) - f(a[2] * b[1])),
      f(f(a[2] * b[0]) - f(a[0] * b[2])),
      f(f(a[0] * b[1]) - f(a[1] * b[0])),
    ];
    const dot = (a: Vec3, b: Vec3) => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
    const d12 = subtract(v2, v1), d13 = subtract(v3, v1), d14 = subtract(v4, v1);
    const flip = dot(cross(d12, d13), cross(d14, d13)) > 0;
    return flip
      ? [[face[0], face[1], face[3]], [face[1], face[2], face[3]]]
      : [[face[0], face[1], face[2]], [face[0], face[2], face[3]]];
  }
  // Blender projects n-gons onto an orthonormal basis and passes them to
  // BLI_polyfill_calc. Besides concavity handling, that ear clipper deliberately
  // advances by two corners after every cut to avoid fan-filling convex faces.
  // Volume to Mesh produces many non-planar pentagons and hexagons; using a
  // conventional first-ear clipper changes both Proximity FACES and Raycast.
  const f = Math.fround;
  const positions = face.map((vertex) => mesh.positions[vertex].map(f) as Vec3);
  let normal: Vec3 = [0, 0, 0];
  for (let i = 0; i < positions.length; i++) {
    const previous = positions[(i - 1 + positions.length) % positions.length];
    const current = positions[i];
    normal = [
      f(normal[0] + f(f(previous[1] - current[1]) * f(previous[2] + current[2]))),
      f(normal[1] + f(f(previous[2] - current[2]) * f(previous[0] + current[0]))),
      f(normal[2] + f(f(previous[0] - current[0]) * f(previous[1] + current[1]))),
    ];
  }
  const normalSquared = f(f(f(normal[0] * normal[0]) + f(normal[1] * normal[1])) + f(normal[2] * normal[2]));
  if (normalSquared > 1e-35) {
    const normalLength = f(Math.sqrt(normalSquared));
    const inverseLength = f(1 / normalLength);
    normal = [f(-normal[0] * inverseLength), f(-normal[1] * inverseLength), f(-normal[2] * inverseLength)];
  } else {
    // normalize_v3 clears a degenerate vector, then mesh tessellation selects +Z;
    // axis_dominant_v3_to_m3_negate therefore receives -Z here.
    normal = [0, 0, -1];
  }
  const basisLengthSquared = f(f(normal[0] * normal[0]) + f(normal[1] * normal[1]));
  let basisX: Vec3;
  let basisY: Vec3;
  if (basisLengthSquared > 1.1920928955078125e-7) {
    const inverseLength = f(1 / f(Math.sqrt(basisLengthSquared)));
    basisX = [f(normal[1] * inverseLength), f(-normal[0] * inverseLength), 0];
    basisY = [
      f(-normal[2] * basisX[1]),
      f(normal[2] * basisX[0]),
      f(f(normal[0] * basisX[1]) - f(normal[1] * basisX[0])),
    ];
  } else {
    basisX = [normal[2] < 0 ? -1 : 1, 0, 0];
    basisY = [0, 1, 0];
  }
  const dot = (a: Vec3, b: Vec3) => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
  const projected = positions.map((position) => [dot(basisX, position), dot(basisY, position)] as [number, number]);
  const area = (a: number, b: number, c: number) => {
    const d2x = f(projected[b][0] - projected[a][0]);
    const d2y = f(projected[b][1] - projected[a][1]);
    const d3x = f(projected[c][0] - projected[a][0]);
    const d3y = f(projected[c][1] - projected[a][1]);
    return f(f(d2x * d3y) - f(d3x * d2y));
  };
  // BLI's span_tri_v2_sign(v1, v2, v3) evaluates area(v3, v2, v1).
  const sign = (previous: number, current: number, next: number) => Math.sign(area(next, current, previous));
  const remaining = Array.from({ length: face.length }, (_, index) => index);
  const signs = new Map(remaining.map((index, i) => [index, sign(
    remaining[(i - 1 + remaining.length) % remaining.length], index, remaining[(i + 1) % remaining.length],
  )]));
  let concaveCount = [...signs.values()].filter((value) => value !== 1).length;
  const triangles: [number, number, number][] = [];
  let earInit = 0;
  let reverse = false;
  const positionOf = (index: number) => remaining.indexOf(index);
  const adjacent = (index: number, offset: number) => {
    const at = positionOf(index);
    return remaining[(at + offset + remaining.length) % remaining.length];
  };
  const containsNonConvex = (ear: number) => {
    const next = adjacent(ear, 1), previous = adjacent(ear, -1);
    const triangle = [ear, next, previous];
    const edgeTests = triangle.map((start, index) => {
      const end = triangle[(index + 1) % 3];
      const edgeX = f(projected[end][0] - projected[start][0]);
      const edgeY = f(projected[end][1] - projected[start][1]);
      const constant = f(f(edgeX * projected[start][1]) - f(projected[start][0] * edgeY));
      return (candidate: number) => f(
        f(f(edgeY * projected[candidate][0]) - f(edgeX * projected[candidate][1])) + constant,
      ) >= 0;
    });
    for (const candidate of remaining) {
      if (candidate === ear || candidate === next || candidate === previous || signs.get(candidate) === 1) continue;
      // Blender's KD-tree path uses a precomputed edge equation. Keeping that
      // form matters for almost-collinear OpenVDB boundary polygons: expanding
      // it into translated cross products changes cancellation by one ULP.
      if (edgeTests.every((test) => test(candidate))) return true;
    }
    return false;
  };
  while (remaining.length > 3) {
    let ear: number | undefined;
    for (const accepted of [1, 0]) {
      let candidate = earInit;
      for (let scanned = 0; scanned < remaining.length; scanned++) {
        if ((concaveCount === 0 || signs.get(candidate) === accepted) && !containsNonConvex(candidate)) {
          ear = candidate;
          break;
        }
        candidate = adjacent(candidate, reverse ? -1 : 1);
      }
      if (ear !== undefined) break;
    }
    if (ear === undefined) {
      let candidate = earInit;
      for (let scanned = 0; scanned < remaining.length; scanned++) {
        if (signs.get(candidate) !== -1) { ear = candidate; break; }
        candidate = adjacent(candidate, 1);
      }
      ear ??= candidate;
    }
    const previous = adjacent(ear, -1), next = adjacent(ear, 1);
    triangles.push([face[previous], face[ear], face[next]]);
    if (signs.get(ear) !== 1) concaveCount--;
    remaining.splice(positionOf(ear), 1);
    for (const neighbor of [previous, next]) {
      if (signs.get(neighbor) === 1) continue;
      const updated = sign(adjacent(neighbor, -1), neighbor, adjacent(neighbor, 1));
      if (updated === 1) concaveCount--;
      signs.set(neighbor, updated);
    }
    earInit = reverse ? adjacent(previous, -1) : adjacent(next, 1);
    if (signs.get(earInit) !== 1) {
      earInit = adjacent(earInit, reverse ? -1 : 1);
      reverse = !reverse;
    }
  }
  triangles.push([face[remaining[0]], face[remaining[1]], face[remaining[2]]]);
  return triangles;
}

export interface InstanceRef {
  geometry: Geometry;
  position: Vec3;
  rotation: Vec3; // euler XYZ radians
  scale: Vec3;
  // Preserve an evaluated Relative Object/Collection Info affine transform.
  // Blender realizes the stored matrix directly; decomposing it to Euler and
  // recomposing a quaternion changes axis-aligned quarter turns by several ULPs.
  transformMatrix?: number[][];
  attributes?: Map<string, Elem>; // per-instance attribute values (broadcast on realize)
}

// A single spline. `points` is the evaluated polyline consumed by downstream
// mesh operations; Bézier splines additionally retain their authored knots and
// handles so handle-editing nodes can regenerate that evaluated polyline.
export interface Spline {
  points: Vec3[];
  cyclic: boolean;
  // Retain the authored representation when a node converts the spline type.
  // This lets a later Set Spline Resolution re-evaluate the same controls
  // instead of treating the already tessellated polyline as new controls.
  splineType?: "POLY" | "BEZIER" | "NURBS" | "CATMULL_ROM";
  // Blender's evaluated points-per-segment setting. Poly splines use 1.
  resolution?: number;
  // Evaluated polyline points may be denser than the authored spline knots.
  // Set Spline Type -> Poly must retain the original control-point count.
  controlPoints?: Vec3[];
  bezierLeft?: Vec3[];
  bezierRight?: Vec3[];
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
    g.curves = this.curves.map((s) => ({
      cyclic: s.cyclic,
      resolution: s.resolution,
      splineType: s.splineType,
      points: s.points.map((p) => [...p] as Vec3),
      controlPoints: s.controlPoints?.map((p) => [...p] as Vec3),
      bezierLeft: s.bezierLeft?.map((p) => [...p] as Vec3),
      bezierRight: s.bezierRight?.map((p) => [...p] as Vec3),
    }));
    g.instances = this.instances.map((i) => ({
      ...i,
      position: [...i.position] as Vec3, rotation: [...i.rotation] as Vec3, scale: [...i.scale] as Vec3,
      transformMatrix: i.transformMatrix?.map((row) => [...row]),
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

// Mutation-safety audit, 2026-07-08:
// src/gnvm construction paths mutate fresh Mesh instances before any derived
// query. The current query-then-mutate handlers are SetPosition (positions
// assignment), DeleteGeometry EDGE (edges assignment), FlipFaces (face-row
// reverse), and mergeMeshInto's EDGE-attribute reconciliation (canonical keys
// before append). Cache validation records array identities/counts plus face
// and counts, so assignments and appends invalidate without turning hot mesh
// arrays into accessor/proxy arrays. The audited in-place face reversals call
// invalidateMeshCaches explicitly.
// The audit found no in-place Vec3 coordinate writes; if those are added later
// they must assign a fresh positions array or explicitly invalidate the cache.
interface TopologyCacheMeta {
  positions: Vec3[];
  faces: number[][];
  edges: [number, number][];
  positionCount: number;
  faceCount: number;
  edgeCount: number;
}

interface VertexNormalsCacheMeta {
  positions: Vec3[];
  faces: number[][];
  positionCount: number;
  faceCount: number;
}

const topologyCache = new WeakMap<Mesh, Topology>();
const topologyCacheMeta = new WeakMap<Mesh, TopologyCacheMeta>();
const vertexNormalsCache = new WeakMap<Mesh, Vec3[]>();
const vertexNormalsCacheMeta = new WeakMap<Mesh, VertexNormalsCacheMeta>();

export function invalidateMeshCaches(mesh: Mesh): void {
  topologyCache.delete(mesh);
  topologyCacheMeta.delete(mesh);
  vertexNormalsCache.delete(mesh);
  vertexNormalsCacheMeta.delete(mesh);
}

function computeVertexNormals(mesh: Mesh): Vec3[] {
  const faceNormalWeights = mesh.faces.map((f) => {
    // Newell vector before normalization. Its magnitude tracks face area, which
    // keeps tiny rim/cap faces from dominating smooth vertex normals.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < f.length; i++) {
      const cur = mesh.positions[f[i]];
      const nxt = mesh.positions[f[(i + 1) % f.length]];
      nx += (cur[1] - nxt[1]) * (cur[2] + nxt[2]);
      ny += (cur[2] - nxt[2]) * (cur[0] + nxt[0]);
      nz += (cur[0] - nxt[0]) * (cur[1] + nxt[1]);
    }
    return [nx, ny, nz] as Vec3;
  });
  const faceNormals = faceNormalWeights.map((n) => vnorm(n));
  const incident: number[][] = mesh.positions.map(() => []);
  // Blender's mesh point normals are corner-angle weighted. Equal face
  // weighting badly tilts a rounded n-gon rim toward its two wall quads: the
  // n-gon's almost-pi corner must contribute about twice each quad's pi/2
  // corner. The Dojo bin's normal-based thickness offset exposes this directly.
  const acc: Vec3[] = mesh.positions.map(() => [0, 0, 0]);
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const f = mesh.faces[fi];
    const n = faceNormals[fi];
    for (let k = 0; k < f.length; k++) {
      const vi = f[k];
      incident[vi]?.push(fi);
      const p = mesh.positions[vi];
      const prev = mesh.positions[f[(k - 1 + f.length) % f.length]];
      const next = mesh.positions[f[(k + 1) % f.length]];
      const a = vnorm(vsub(prev, p));
      const b = vnorm(vsub(next, p));
      const angle = Math.acos(Math.max(-1, Math.min(1, vdot(a, b))));
      acc[vi] = vadd(acc[vi], vscale(n, Number.isFinite(angle) ? angle : 0));
    }
  }

  return acc.map((n, vi) => {
    const fis = incident[vi];
    if (!fis.length) return [0, 0, 1] as Vec3;
    // Blender does not select one of several opposing normal fans on a
    // non-manifold point. It corner-angle-weights every incident face and
    // normalizes the resulting sum. This is observable on the Bolt Generator's
    // tap thread: choosing one fan moves nine seam points by about 0.5 units and
    // prevents the authored Heal Mesh weld from closing the surface.
    return vnorm(n);
  });
}

function vertexNormalsOf(mesh: Mesh): Vec3[] {
  const cached = vertexNormalsCache.get(mesh);
  const meta = vertexNormalsCacheMeta.get(mesh);
  if (
    cached &&
    meta &&
    meta.positions === mesh.positions &&
    meta.faces === mesh.faces &&
    meta.positionCount === mesh.positions.length &&
    meta.faceCount === mesh.faces.length
  ) {
    return cached;
  }
  const normals = computeVertexNormals(mesh);
  vertexNormalsCache.set(mesh, normals);
  vertexNormalsCacheMeta.set(mesh, {
    positions: mesh.positions,
    faces: mesh.faces,
    positionCount: mesh.positions.length,
    faceCount: mesh.faces.length,
  });
  return normals;
}

export function topologyOf(mesh: Mesh): Topology {
  const cached = topologyCache.get(mesh);
  const meta = topologyCacheMeta.get(mesh);
  if (
    cached &&
    meta &&
    meta.positions === mesh.positions &&
    meta.faces === mesh.faces &&
    meta.edges === mesh.edges &&
    meta.positionCount === mesh.positions.length &&
    meta.faceCount === mesh.faces.length &&
    meta.edgeCount === mesh.edges.length
  ) {
    return cached;
  }
  const topo = computeTopology(mesh);
  topologyCache.set(mesh, topo);
  topologyCacheMeta.set(mesh, {
    positions: mesh.positions,
    faces: mesh.faces,
    edges: mesh.edges,
    positionCount: mesh.positions.length,
    faceCount: mesh.faces.length,
    edgeCount: mesh.edges.length,
  });
  return topo;
}

export function buildTopology(mesh: Mesh): Topology {
  return topologyOf(mesh);
}

function computeTopology(mesh: Mesh): Topology {
  type EdgeKey = number | string;
  const edgeKeyBase = 2 ** 21;
  const ekey = (a: number, b: number): EdgeKey => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    // A numeric pair key is exact while both indices fit in 21 bits and avoids
    // allocating a string for every face corner on normal browser-sized meshes.
    return hi < edgeKeyBase ? lo * edgeKeyBase + hi : `${lo}_${hi}`;
  };
  const emap = new Map<EdgeKey, { verts: [number, number]; faces: number[] }>();
  const addFaceEdge = (a: number, b: number, fi: number) => {
    const k = ekey(a, b);
    let e = emap.get(k);
    if (!e) { e = { verts: [Math.min(a, b), Math.max(a, b)], faces: [] }; emap.set(k, e); }
    if (fi >= 0) e.faces.push(fi);
  };
  // Blender's Edge Index follows the mesh's stored edge order. Generated
  // meshes often carry that order explicitly (notably Edge Extrude); seed the
  // topology map from it before adding any implicit polygon boundaries.
  for (const [a, b] of mesh.edges) addFaceEdge(a, b, -1);
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const f = mesh.faces[fi];
    for (let i = 0; i < f.length; i++) addFaceEdge(f[i], f[(i + 1) % f.length], fi);
  }
  const edges = [...emap.values()];

  // Most consumers only need canonical edges. Build adjacency and connected
  // components lazily so an EDGE-domain field does not also allocate several
  // full-mesh union/find and incidence tables.
  const uf = (n: number, addUnions: (join: (a: number, b: number) => void) => void) => {
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const join = (a: number, b: number) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };
    addUnions(join);
    const label = new Map<number, number>();
    const out = new Array(n);
    let count = 0;
    for (let i = 0; i < n; i++) { const r = find(i); if (!label.has(r)) label.set(r, count++); out[i] = label.get(r)!; }
    return { out, count };
  };

  let faceNeighbors: number[] | null = null;
  let faceIslands: { out: number[]; count: number } | null = null;
  let pointIslands: { out: number[]; count: number } | null = null;
  let pointFaces: number[][] | null = null;
  const getFaceNeighbors = () => {
    if (!faceNeighbors) {
      const sets: Set<number>[] = mesh.faces.map(() => new Set<number>());
      for (const e of edges)
        for (const fa of e.faces)
          for (const fb of e.faces)
            if (fa !== fb) sets[fa].add(fb);
      faceNeighbors = sets.map((s) => s.size);
    }
    return faceNeighbors;
  };
  const getFaceIslands = () => (faceIslands ??= uf(mesh.faces.length, (join) => {
    for (const e of edges) for (let i = 1; i < e.faces.length; i++) join(e.faces[0], e.faces[i]);
  }));
  const getPointIslands = () => (pointIslands ??= uf(mesh.positions.length, (join) => {
    for (const e of edges) join(e.verts[0], e.verts[1]);
  }));
  const getPointFaces = () => {
    if (!pointFaces) {
      pointFaces = mesh.positions.map(() => []);
      for (let fi = 0; fi < mesh.faces.length; fi++)
        for (const v of mesh.faces[fi]) pointFaces[v]?.push(fi);
    }
    return pointFaces;
  };

  return {
    edges,
    get faceNeighbors() { return getFaceNeighbors(); },
    get faceIsland() { return getFaceIslands().out; },
    get faceIslandCount() { return getFaceIslands().count; },
    get pointIsland() { return getPointIslands().out; },
    get pointIslandCount() { return getPointIslands().count; },
    get pointFaces() { return getPointFaces(); },
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

export function inverseTransformPoint(p: Vec3, pos: Vec3, rot: Vec3, scl: Vec3): Vec3 {
  let [x, y, z] = vsub(p, pos);
  // Invert Blender XYZ by applying the opposite rotations in reverse order.
  let c = Math.cos(-rot[2]), s = Math.sin(-rot[2]); [x, y] = [x * c - y * s, x * s + y * c];
  c = Math.cos(-rot[1]); s = Math.sin(-rot[1]); [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(-rot[0]); s = Math.sin(-rot[0]); [y, z] = [y * c - z * s, y * s + z * c];
  return [x / (scl[0] || 1), y / (scl[1] || 1), z / (scl[2] || 1)];
}

export function transformPoint(p: Vec3, pos: Vec3, rot: Vec3, scl: Vec3): Vec3 {
  return vadd(rotateEulerXYZ([p[0] * scl[0], p[1] * scl[1], p[2] * scl[2]], rot), pos);
}

/** Apply Blender's float32 geometry-component transform operation order. */
export function transformPointFloat32(p: Vec3, pos: Vec3, rot: Vec3, scl: Vec3): Vec3 {
  const f = Math.fround;
  const x = f(f(p[0]) * f(scl[0]));
  const y = f(f(p[1]) * f(scl[1]));
  const z = f(f(p[2]) * f(scl[2]));

  // Transform Geometry's Rotation socket stores a quaternion. Vector/Euler
  // inputs are converted to that quaternion before the transform matrix is
  // built; rotating XYZ components in sequence is close, but differs by a few
  // ULPs on repeated curves. Match Blender's EulerXYZ -> quaternion grouping.
  const hx = f(f(rot[0]) * 0.5), hy = f(f(rot[1]) * 0.5), hz = f(f(rot[2]) * 0.5);
  const cx = f(Math.cos(hx)), cy = f(Math.cos(hy)), cz = f(Math.cos(hz));
  const sx = f(Math.sin(hx)), sy = f(Math.sin(hy)), sz = f(Math.sin(hz));
  const qw = f(cx * f(cy * cz) + sx * f(sy * sz));
  const qx = f(sx * f(cy * cz) - cx * f(sy * sz));
  const qy = f(cx * f(sy * cz) + sx * f(cy * sz));
  const qz = f(cx * f(cy * sz) - sx * f(sy * cz));

  // Blender's quaternion-to-matrix path rounds the completed expressions,
  // allowing the compiler's fused products before their float32 store.
  const m00 = f(1 - 2 * (qy * qy + qz * qz));
  const m01 = f(2 * (qx * qy - qw * qz));
  const m02 = f(2 * (qx * qz + qw * qy));
  const m10 = f(2 * (qx * qy + qw * qz));
  const m11 = f(1 - 2 * (qx * qx + qz * qz));
  const m12 = f(2 * (qy * qz - qw * qx));
  const m20 = f(2 * (qx * qz - qw * qy));
  const m21 = f(2 * (qy * qz + qw * qx));
  const m22 = f(1 - 2 * (qx * qx + qy * qy));
  const dot = (a: number, b: number, c: number): number => f(f(f(a * x) + f(b * y)) + f(c * z));

  return [
    f(dot(m00, m01, m02) + f(pos[0])),
    f(dot(m10, m11, m12) + f(pos[1])),
    f(dot(m20, m21, m22) + f(pos[2])),
  ];
}

/** Apply an extracted Blender float32 affine matrix to a geometry point. */
export function transformPointMatrixFloat32(p: Vec3, matrix: number[][]): Vec3 {
  const f = Math.fround;
  const x = f(p[0]), y = f(p[1]), z = f(p[2]);
  return [0, 1, 2].map((axis) => {
    const row = matrix[axis] ?? [];
    let value = f(f(f(row[0] ?? 0) * x) + f(f(row[1] ?? 0) * y));
    value = f(value + f(f(row[2] ?? 0) * z));
    return f(value + f(row[3] ?? 0));
  }) as Vec3;
}

const zeroLike = (e: Elem | undefined): Elem => (Array.isArray(e) ? [0, 0, 0] : 0);

// Merge mesh b into a, offsetting vertex indices; preserves materials + attributes.
// Unique undirected edge keys in buildTopology's enumeration order
// (face-derived first-seen, then explicit wires) so EDGE attr data stays aligned.
const ekeyG = (x: number, y: number) => (x < y ? `${x}_${y}` : `${y}_${x}`);
function canonicalEdgeKeys(m: Mesh): string[] {
  // computeTopology inserts unique edges in the same order this function needs:
  // face-derived first-seen edges, followed by explicit loose edges.
  return topologyOf(m).edges.map((e) => ekeyG(e.verts[0], e.verts[1]));
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
  invalidateMeshCaches(a);
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
  // base curves pass through; instanced curves get appended transformed below
  out.curves = g.curves.map((s) => ({
    cyclic: s.cyclic,
    points: s.points.map((p) => [...p] as Vec3),
    controlPoints: s.controlPoints?.map((p) => [...p] as Vec3),
    bezierLeft: s.bezierLeft?.map((p) => [...p] as Vec3),
    bezierRight: s.bezierRight?.map((p) => [...p] as Vec3),
  }));
  for (const [k, a] of g.curveAttributes) out.curveAttributes.set(k, { domain: a.domain, data: [...a.data] });
  for (const inst of g.instances) {
    const rg = realizeInstances(inst.geometry); // recursive
    if (rg.mesh) {
      const tm = rg.mesh.clone();
      tm.positions = tm.positions.map((p) => inst.transformMatrix
        ? transformPointMatrixFloat32(p, inst.transformMatrix)
        : transformPointFloat32(p, inst.position, inst.rotation, inst.scale));
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
    // Curve-only payloads must survive realize — the bubble vase's proximity
    // target is 58 instanced curves; `if (!rg.mesh) continue` emptied the field.
    const pointBase = out.curvePointCount();
    const curveBase = out.curves.length;
    const addedPoints = rg.curvePointCount();
    const addedCurves = rg.curves.length;
    for (const s of rg.curves)
      out.curves.push({
        cyclic: s.cyclic,
        points: s.points.map((p) => inst.transformMatrix
          ? transformPointMatrixFloat32(p, inst.transformMatrix)
          : transformPointFloat32(p, inst.position, inst.rotation, inst.scale)),
        controlPoints: s.controlPoints?.map((p) => inst.transformMatrix
          ? transformPointMatrixFloat32(p, inst.transformMatrix)
          : transformPointFloat32(p, inst.position, inst.rotation, inst.scale)),
        bezierLeft: s.bezierLeft?.map((p) => inst.transformMatrix
          ? transformPointMatrixFloat32(p, inst.transformMatrix)
          : transformPointFloat32(p, inst.position, inst.rotation, inst.scale)),
        bezierRight: s.bezierRight?.map((p) => inst.transformMatrix
          ? transformPointMatrixFloat32(p, inst.transformMatrix)
          : transformPointFloat32(p, inst.position, inst.rotation, inst.scale)),
      });
    if (addedCurves) {
      // Realizing a scaled curve instance transforms its built-in radius along
      // with its positions. Mesh to Curve creates radius=1; an Instance on
      // Points scale of .27 therefore makes a following Curve to Mesh profile
      // .27 times as wide. Preserve all curve attributes while flattening and
      // apply the transform's uniform scale to that radius field.
      const matrixScales = inst.transformMatrix
        ? [0, 1, 2].map((column) => Math.hypot(
            inst.transformMatrix?.[0]?.[column] ?? 0,
            inst.transformMatrix?.[1]?.[column] ?? 0,
            inst.transformMatrix?.[2]?.[column] ?? 0,
          ))
        : inst.scale.map(Math.abs);
      const radiusScale = Math.cbrt(Math.max(0, matrixScales[0] * matrixScales[1] * matrixScales[2]));
      const names = new Set([...out.curveAttributes.keys(), ...rg.curveAttributes.keys()]);
      for (const name of names) {
        const source = rg.curveAttributes.get(name);
        const target = out.curveAttributes.get(name);
        const domain = source?.domain ?? target?.domain;
        if (!domain || (target && target.domain !== domain)) continue;
        const before = domain === "POINT" ? pointBase : curveBase;
        const count = domain === "POINT" ? addedPoints : addedCurves;
        const fallback = zeroLike(target?.data[0] ?? source?.data[0]);
        const data = target?.data ?? [];
        while (data.length < before) data.push(fallback);
        for (let index = 0; index < count; index++) {
          const value = source?.data[index] ?? fallback;
          data.push(name === "radius" && domain === "POINT"
            ? asNum(value) * radiusScale
            : value);
        }
        out.curveAttributes.set(name, { domain, data });
      }
    }
  }
  if (g.mesh || mesh.positions.length || mesh.faces.length || mesh.edges.length) out.mesh = mesh;
  return out;
}

// ---- triangle-soup export for the renderer --------------------------------
export interface TriSoup {
  positions: Float32Array; // xyz per vertex (indexed)
  normals: Float32Array;
  indices: Uint32Array;
  attributes: Record<string, { itemSize: 1 | 3; data: Float32Array }>;
  groups: { start: number; count: number; material: string | null }[]; // per material slot
  stats: { verts: number; faces: number; tris: number };
}

/**
 * Make a geometrically closed mesh consistently oriented without moving it.
 *
 * Geometry Nodes can intentionally carry coincident vertices and collapsed
 * faces (the vase's axial fans do both), so adjacency is built from lightly
 * welded position keys rather than raw vertex indices. Open or non-manifold
 * inputs are left untouched. For each closed component, only the smaller
 * parity set is flipped; this repairs a local winding patch without globally
 * reversing an otherwise-correct shell or affecting fields evaluated earlier.
 */
export function orientClosedSurface(mesh: Mesh, eps = 1e-5): number {
  if (mesh.faces.length < 4 || mesh.positions.length < 4) return 0;
  const positionIds = new Map<string, number>();
  const welded: number[] = new Array(mesh.positions.length);
  const keyOf = (p: Vec3) => p.map((value) => Math.round(value / eps)).join("_");
  for (let i = 0; i < mesh.positions.length; i++) {
    const key = keyOf(mesh.positions[i]);
    let id = positionIds.get(key);
    if (id === undefined) {
      id = positionIds.size;
      positionIds.set(key, id);
    }
    welded[i] = id;
  }

  type Use = { face: number; direction: number };
  const edgeUses = new Map<string, Use[]>();
  const participating = new Set<number>();
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const raw = mesh.faces[fi].map((vi) => welded[vi]);
    const ring: number[] = [];
    for (const vi of raw) if (ring.at(-1) !== vi) ring.push(vi);
    if (ring.length > 1 && ring[0] === ring.at(-1)) ring.pop();
    if (ring.length < 3) continue;
    // A repeated non-consecutive point is a self-touching polygon. Do not
    // guess at its topology in an export-time orientation pass.
    if (new Set(ring).size !== ring.length) return 0;
    participating.add(fi);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const uses = edgeUses.get(key) ?? [];
      uses.push({ face: fi, direction: a < b ? 1 : -1 });
      edgeUses.set(key, uses);
    }
  }
  if (!participating.size || [...edgeUses.values()].some((uses) => uses.length !== 2 || uses[0].face === uses[1].face)) return 0;

  const adjacency = new Map<number, { face: number; parity: number }[]>();
  for (const fi of participating) adjacency.set(fi, []);
  for (const uses of edgeUses.values()) {
    const parity = uses[0].direction === uses[1].direction ? 1 : 0;
    adjacency.get(uses[0].face)!.push({ face: uses[1].face, parity });
    adjacency.get(uses[1].face)!.push({ face: uses[0].face, parity });
  }

  const parity = new Map<number, number>();
  const flips = new Set<number>();
  for (const seed of participating) {
    if (parity.has(seed)) continue;
    parity.set(seed, 0);
    const queue = [seed];
    const component: number[] = [];
    for (let head = 0; head < queue.length; head++) {
      const face = queue[head];
      component.push(face);
      for (const edge of adjacency.get(face) ?? []) {
        const wanted = parity.get(face)! ^ edge.parity;
        const found = parity.get(edge.face);
        if (found === undefined) {
          parity.set(edge.face, wanted);
          queue.push(edge.face);
        } else if (found !== wanted) {
          return 0; // non-orientable component
        }
      }
    }
    const ones = component.filter((face) => parity.get(face) === 1);
    const chosen = ones.length <= component.length - ones.length
      ? ones
      : component.filter((face) => parity.get(face) === 0);
    for (const face of chosen) flips.add(face);
  }
  for (const fi of flips) mesh.faces[fi].reverse();
  if (flips.size) invalidateMeshCaches(mesh);
  return flips.size;
}

/**
 * For shell-like meshes (vase / bin walls), ensure face windings give
 * predominantly outward radial normals. Solidify + Flip chains often leave the
 * outer wall inverted; FrontSide materials then look like an empty or inverted
 * interior even when the envelope matches Blender.
 */
export function orientShellOutward(mesh: Mesh): void {
  if (!mesh.faces.length || mesh.positions.length < 8) return;
  const nrm = mesh.vertexNormals();
  let out = 0, inn = 0;
  // Sample mid-height verts away from the axis.
  let zmin = Infinity, zmax = -Infinity;
  for (const p of mesh.positions) {
    zmin = Math.min(zmin, p[2]);
    zmax = Math.max(zmax, p[2]);
  }
  const z0 = zmin + (zmax - zmin) * 0.35;
  const z1 = zmin + (zmax - zmin) * 0.75;
  for (let i = 0; i < mesh.positions.length; i++) {
    const p = mesh.positions[i];
    if (p[2] < z0 || p[2] > z1) continue;
    const r = Math.hypot(p[0], p[1]);
    if (r < 1e-6) continue;
    const radial = (nrm[i][0] * p[0] + nrm[i][1] * p[1]) / r;
    if (radial > 0.12) out++;
    else if (radial < -0.12) inn++;
  }
  if (inn <= out * 1.15) return;
  for (const f of mesh.faces) f.reverse();
  invalidateMeshCaches(mesh);
}

export function toTriSoup(g: Geometry): TriSoup {
  const realized = g.instances.length ? realizeInstances(g) : g;
  const realizedMesh = realized.mesh ?? new Mesh();
  // Point-cloud components are represented internally as loose mesh positions
  // so existing field/instance code can share the POINT domain. Blender's
  // evaluated mesh output does not include those points, though. Strip only
  // positions explicitly stamped as point-cloud data and still unreferenced by
  // a mesh face/edge; a later conversion that gives them topology remains a
  // normal mesh and is retained.
  const marker = realizedMesh.attributes.get("__gnvm_point_cloud");
  let source = realizedMesh;
  if (marker?.domain === "POINT") {
    const referenced = new Set<number>();
    for (const face of realizedMesh.faces) for (const vertex of face) referenced.add(vertex);
    for (const edge of realizedMesh.edges) { referenced.add(edge[0]); referenced.add(edge[1]); }
    const retained = realizedMesh.positions.map((_, vertex) => referenced.has(vertex) || asNum(marker.data[vertex] ?? 0) <= 0);
    if (retained.some((value) => !value)) {
      const filtered = new Mesh();
      filtered.materialSlots = [...realizedMesh.materialSlots];
      const remap = new Map<number, number>();
      for (let vertex = 0; vertex < realizedMesh.positions.length; vertex++) if (retained[vertex]) {
        remap.set(vertex, filtered.positions.length);
        filtered.positions.push([...realizedMesh.positions[vertex]] as Vec3);
      }
      filtered.faces = realizedMesh.faces.map((face) => face.map((vertex) => remap.get(vertex)!));
      filtered.faceMaterial = [...realizedMesh.faceMaterial];
      filtered.edges = realizedMesh.edges.map(([a, b]) => [remap.get(a)!, remap.get(b)!]);
      for (const [name, attribute] of realizedMesh.attributes) {
        filtered.attributes.set(name, attribute.domain === "POINT"
          ? { domain: "POINT", data: attribute.data.filter((_, vertex) => retained[vertex]) }
          : { domain: attribute.domain, data: [...attribute.data] });
      }
      source = filtered;
    }
  }
  const mesh = new Mesh();
  mesh.positions = source.positions;
  mesh.materialSlots = [...source.materialSlots];
  for (let fi = 0; fi < source.faces.length; fi++) {
    const face = source.faces[fi];
    mesh.faces.push([...face]);
    mesh.faceMaterial.push(source.faceMaterial[fi] ?? 0);
  }
  orientClosedSurface(mesh);
  orientShellOutward(mesh);
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
  // Group faces by material slot. Concave Geometry Nodes ngons (notably the
  // Procedural Box wall profiles) must be ear-clipped; a fan can escape the
  // polygon and render long triangular spikes even though the mesh topology is
  // otherwise identical to Blender.
  const slotCount = Math.max(1, mesh.materialSlots.length);
  const perSlot: number[][] = Array.from({ length: slotCount }, () => []);
  let triCount = 0;
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const f = mesh.faces[fi];
    const slot = mesh.faceMaterial[fi] ?? 0;
    for (const triangle of triangulateFaceIndices(mesh, f)) {
      perSlot[slot].push(...triangle);
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
  const attributes: TriSoup["attributes"] = {};
  for (const [name, attribute] of source.attributes) {
    // Curve radius is a built-in evaluation property, not a generic mesh
    // attribute after Blender converts the curve component.
    if (name === "radius") continue;
    if (name.startsWith("__") || !["POINT", "FACE", "CORNER"].includes(attribute.domain)) continue;
    const itemSize: 1 | 3 = Array.isArray(attribute.data.find((value) => value !== undefined)) ? 3 : 1;
    const pointValues: Elem[] = source.positions.map(() => itemSize === 3 ? [0, 0, 0] as Vec3 : 0);
    const counts = source.positions.map(() => 0);
    if (attribute.domain === "POINT") {
      for (let i = 0; i < source.positions.length; i++) { pointValues[i] = attribute.data[i] ?? pointValues[i]; counts[i] = 1; }
    } else if (attribute.domain === "FACE") {
      for (let fi = 0; fi < source.faces.length; fi++) for (const vi of source.faces[fi]) {
        pointValues[vi] = itemSize === 3 ? vadd(asVec3(pointValues[vi]), asVec3(attribute.data[fi] ?? [0, 0, 0])) : asNum(pointValues[vi]) + asNum(attribute.data[fi] ?? 0);
        counts[vi]++;
      }
    } else {
      let corner = 0;
      for (const face of source.faces) for (const vi of face) {
        pointValues[vi] = itemSize === 3 ? vadd(asVec3(pointValues[vi]), asVec3(attribute.data[corner] ?? [0, 0, 0])) : asNum(pointValues[vi]) + asNum(attribute.data[corner] ?? 0);
        counts[vi]++; corner++;
      }
    }
    const data = new Float32Array(source.positions.length * itemSize);
    for (let i = 0; i < source.positions.length; i++) {
      const value = counts[i] > 1 ? (itemSize === 3 ? vscale(asVec3(pointValues[i]), 1 / counts[i]) : asNum(pointValues[i]) / counts[i]) : pointValues[i];
      if (itemSize === 3) {
        const vector = asVec3(value ?? [0, 0, 0]);
        data[i * 3] = vector[0]; data[i * 3 + 1] = vector[1]; data[i * 3 + 2] = vector[2];
      } else data[i] = asNum(value ?? 0);
    }
    attributes[name] = { itemSize, data };
  }
  return {
    positions,
    normals: normArr,
    indices,
    attributes,
    groups,
    stats: { verts: mesh.positions.length, faces: mesh.faces.length, tris: triCount },
  };
}
