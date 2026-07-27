// Geometry data structures for the GN-VM. Deliberately THREE-free so the whole
// engine runs under plain node/tsx for self-tests; the browser viewer converts
// the triangle soup to a BufferGeometry.

import { Vec3, Domain, Elem, asNum, asVec3, vadd, vscale, vsub, vlen } from "./core";

export interface Attribute {
  domain: Domain;
  data: Elem[];
}

// Attribute data arrays handed out by the structural-sharing clones below.
// Once an array lands in this set it may be referenced by several meshes, so
// it must never be mutated in place again — mutators go through
// ownAttributeData, which copies on first write. (The set is append-only: an
// array stays "shared" even after every other referent dies, costing at most
// one extra copy.)
const sharedAttributeData = new WeakSet<Elem[]>();

function shareAttributeData(data: Elem[]): Elem[] {
  sharedAttributeData.add(data);
  return data;
}

/**
 * Copy-on-write guard for attribute data. Mesh.clone/Geometry.clone share the
 * `data` array between source and clone; call this to get an array that is
 * safe to push/splice/index-write. Reads never need it. The returned array is
 * always `attribute.data` (possibly freshly copied and reassigned).
 */
export function ownAttributeData(attribute: Attribute): Elem[] {
  if (sharedAttributeData.has(attribute.data)) attribute.data = attribute.data.slice();
  return attribute.data;
}

/** Previous-material membership retained across a Set Material operation. */
export const MATERIAL_MATCH_ATTRIBUTE = "__gnvm_material_match";

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
    const face = this.faces[fi];
    if (!face.length) return [0, 0, 0];
    const f = Math.fround;
    if (face.length === 3 || face.length === 4) {
      // Blender special-cases triangles and quads with a left-associated float
      // sum followed by direct division. Marching Squares converts these
      // centers to points and exposes a one-ULP difference in every instance.
      // Plain loop (same per-axis operation order) — this is the FACE-domain
      // position accessor and runs once per face per field evaluation.
      const center: Vec3 = [0, 0, 0];
      for (let axis = 0; axis < 3; axis++) {
        let sum = f(this.positions[face[0]][axis]);
        for (let corner = 1; corner < face.length; corner++)
          sum = f(sum + f(this.positions[face[corner]][axis]));
        center[axis] = f(sum / f(face.length));
      }
      return center;
    }
    const weight = f(1 / f(face.length));
    const center: Vec3 = [0, 0, 0];
    for (const vertex of face) for (let axis = 0; axis < 3; axis++)
      center[axis] = f(center[axis] + f(f(this.positions[vertex][axis]) * weight));
    return center;
  }

  faceNormal(fi: number): Vec3 {
    const f = this.faces[fi];
    if (f.length < 3) return [0, 0, 1];
    return faceNormalBlenderFloat(this, f);
  }

  /** Blender's standalone `bke::mesh::face_normal_calc`, used by Edge Angle. */
  faceNormalCalc(fi: number): Vec3 {
    const face = this.faces[fi];
    if (!face || face.length < 3) return [0, 0, 1];
    return faceNormalCalcBlenderFloat(this, face);
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
    // Structural sharing: Vec3 positions, edge pairs, and face rows are never
    // mutated element-in-place after they are attached to a mesh (see the
    // mutation-safety audit below) — mutations replace the element or the
    // whole array. Copying only the outer arrays turns node-boundary clones
    // of 100k-vertex meshes from ~400k small-array allocations into four
    // pointer copies; attribute Elem[] data already shared Vec3 elements the
    // same way. Attribute data arrays are shared too (fresh wrapper, same
    // array) and marked in sharedAttributeData; every in-place mutator
    // (mergeMeshInto, FlipFaces corner reorder, the heal/clip duplicators)
    // goes through ownAttributeData to copy on first write.
    m.positions = this.positions.slice();
    m.edges = this.edges.slice();
    m.faces = this.faces.slice();
    m.faceMaterial = this.faceMaterial.slice();
    m.materialSlots = this.materialSlots.slice();
    for (const [k, a] of this.attributes) m.attributes.set(k, { domain: a.domain, data: shareAttributeData(a.data) });
    carryDerivedCaches(this, m);
    return m;
  }
}

/** Stamp Blender's inverse per-polygon smooth-shading built-in. */
export function setUniformFaceSharpness(mesh: Mesh, sharp: boolean): void {
  if (!mesh.faces.length) {
    mesh.attributes.delete("sharp_face");
    return;
  }
  mesh.attributes.set("sharp_face", {
    domain: "FACE",
    data: mesh.faces.map(() => sharp ? 1 : 0),
  });
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
    // Point arrays copy only their outer array; the Vec3 elements are shared
    // under the same immutability invariant as mesh positions (see the
    // mutation-safety audit above Mesh's cache section).
    g.curves = this.curves.map((s) => ({
      cyclic: s.cyclic,
      resolution: s.resolution,
      splineType: s.splineType,
      points: s.points.slice(),
      controlPoints: s.controlPoints?.slice(),
      bezierLeft: s.bezierLeft?.slice(),
      bezierRight: s.bezierRight?.slice(),
    }));
    g.instances = this.instances.map((i) => ({
      ...i,
      position: [...i.position] as Vec3, rotation: [...i.rotation] as Vec3, scale: [...i.scale] as Vec3,
      transformMatrix: i.transformMatrix?.map((row) => [...row]),
      attributes: i.attributes ? new Map(i.attributes) : undefined,
    }));
    for (const [k, a] of this.curveAttributes) g.curveAttributes.set(k, { domain: a.domain, data: shareAttributeData(a.data) });
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

// Mutation-safety audit, 2026-07-08 (extended 2026-07-27 for structural
// sharing):
// src/gnvm construction paths mutate fresh Mesh instances before any derived
// query. The current query-then-mutate handlers are SetPosition (positions
// assignment), DeleteGeometry EDGE (edges assignment), FlipFaces (face-row
// replacement), and mergeMeshInto's EDGE-attribute reconciliation (canonical
// keys before append). Cache validation records array identities/counts plus
// face and counts, so assignments and appends invalidate without turning hot
// mesh arrays into accessor/proxy arrays. The audited face reversals call
// invalidateMeshCaches explicitly.
// STRUCTURAL-SHARING INVARIANT (Mesh.clone copies only the outer arrays):
// once a Vec3 position, [a,b] edge pair, or face row is attached to a mesh,
// its CONTENTS are immutable — mutate by replacing the element
// (positions[i] = fresh) or the whole array, never p[0] = x or row.splice.
// The 2026-07 audit found one pre-attachment coordinate write
// (dump-object-geometry hook deform, runs on a freshly built mesh) and
// converted the two in-place face-row mutations (orientClosedSurface,
// reconstructSplitFastenerHeal) to row replacement. Attribute Elem[] data
// arrays are shared by clones as well (wave 2): every in-place mutator
// (push/splice/index write) must obtain the array through ownAttributeData,
// which copies on first write while the array is marked shared. Their Vec3
// element objects follow the same replace-don't-mutate invariant.
interface TopologyCacheMeta {
  // No positions-array identity here: topology depends on faces/edges rows
  // and the vertex COUNT only, so replacing the positions array (Set
  // Position) must keep the cache. Vertex normals keep their own stricter
  // meta below.
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

// Corner maps (corner -> vertex/face, face -> first corner slot). Derived
// from the face rows only; validated by faces-array identity + count, carried
// across clones, cleared by invalidateMeshCaches — same discipline as the
// topology cache. Previously rebuilt inside every makeFieldCtx call.
export interface CornerMaps { vert: number[]; face: number[]; faceStart: number[] }
interface CornerMapsCacheMeta { faces: number[][]; faceCount: number }
const cornerMapsCache = new WeakMap<Mesh, CornerMaps>();
const cornerMapsCacheMeta = new WeakMap<Mesh, CornerMapsCacheMeta>();

export function cornerMapsOf(mesh: Mesh): CornerMaps {
  const cached = cornerMapsCache.get(mesh);
  const meta = cornerMapsCacheMeta.get(mesh);
  if (cached && meta && meta.faces === mesh.faces && meta.faceCount === mesh.faces.length) return cached;
  const vert: number[] = [], face: number[] = [], faceStart: number[] = [];
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    faceStart.push(vert.length);
    for (const vi of mesh.faces[fi]) { vert.push(vi); face.push(fi); }
  }
  const maps: CornerMaps = { vert, face, faceStart };
  cornerMapsCache.set(mesh, maps);
  cornerMapsCacheMeta.set(mesh, { faces: mesh.faces, faceCount: mesh.faces.length });
  return maps;
}

// Corners attached to each vertex; needs the corner maps plus the vertex
// count (isolated verts still get an empty list).
interface VertexCornersCacheMeta extends CornerMapsCacheMeta { positionCount: number }
const vertexCornersCache = new WeakMap<Mesh, number[][]>();
const vertexCornersCacheMeta = new WeakMap<Mesh, VertexCornersCacheMeta>();

export function vertexCornersOf(mesh: Mesh): number[][] {
  const cached = vertexCornersCache.get(mesh);
  const meta = vertexCornersCacheMeta.get(mesh);
  if (
    cached && meta
    && meta.faces === mesh.faces
    && meta.faceCount === mesh.faces.length
    && meta.positionCount === mesh.positions.length
  ) return cached;
  const c = cornerMapsOf(mesh);
  const list: number[][] = mesh.positions.map(() => []);
  for (let i = 0; i < c.vert.length; i++) list[c.vert[i]]?.push(i);
  vertexCornersCache.set(mesh, list);
  vertexCornersCacheMeta.set(mesh, {
    faces: mesh.faces,
    faceCount: mesh.faces.length,
    positionCount: mesh.positions.length,
  });
  return list;
}

// Canonical-edge incidence per vertex, keyed on the Topology object itself:
// a fresh topology gives a fresh cache entry, and a carried topology carries
// this list with it for free. No explicit invalidation needed.
const vertexEdgesCache = new WeakMap<Topology, { positionCount: number; list: number[][] }>();

export function vertexEdgesOf(mesh: Mesh): number[][] {
  const topo = topologyOf(mesh);
  const cached = vertexEdgesCache.get(topo);
  if (cached && cached.positionCount === mesh.positions.length) return cached.list;
  const list: number[][] = mesh.positions.map(() => []);
  const es = topo.edges;
  for (let ei = 0; ei < es.length; ei++) for (const vi of es[ei].verts) list[vi]?.push(ei);
  vertexEdgesCache.set(topo, { positionCount: mesh.positions.length, list });
  return list;
}

// Canonical edge key -> canonical edge index, keyed on the Topology object.
const edgeIndexCache = new WeakMap<Topology, Map<number | string, number>>();

export function edgeIndexOf(mesh: Mesh): Map<number | string, number> {
  const topo = topologyOf(mesh);
  let index = edgeIndexCache.get(topo);
  if (!index) {
    index = new Map();
    for (let i = 0; i < topo.edges.length; i++) index.set(canonicalEdgeKey(topo.edges[i].verts[0], topo.edges[i].verts[1]), i);
    edgeIndexCache.set(topo, index);
  }
  return index;
}

export function invalidateMeshCaches(mesh: Mesh): void {
  topologyCache.delete(mesh);
  topologyCacheMeta.delete(mesh);
  vertexNormalsCache.delete(mesh);
  vertexNormalsCacheMeta.delete(mesh);
  cornerMapsCache.delete(mesh);
  cornerMapsCacheMeta.delete(mesh);
  vertexCornersCache.delete(mesh);
  vertexCornersCacheMeta.delete(mesh);
  normalsDeltaHints.delete(mesh);
}

// ---- incremental vertex normals -------------------------------------------
// A "delta hint" records that this mesh's state derives from a base state
// whose vertex normals are known: positions 0..baseVertCount-1 hold the same
// coordinate values as the base except the vertices listed in `dirty`, and
// faces 0..baseFaceCount-1 are the base's face rows unchanged (appends only).
// vertexNormalsOf can then recompute only the affected vertices — a vertex's
// corner-angle-weighted normal depends solely on its incident faces' corner
// geometry, and the full pass's Float64Array accumulator is f32-rounded after
// every addition while a vertex's slot is only ever touched by that vertex's
// own corners in ascending global corner order. Re-accumulating one vertex's
// corners in ascending corner order (vertexCornersOf's order) therefore
// reproduces the full pass bit-exactly.
//
// Soundness follows the same discipline as the derived caches above: hints
// are keyed to the exact outer-array identities AND lengths at install time,
// so wholesale array replacement or in-place growth invalidates them, and
// every audited in-place element mutation calls invalidateMeshCaches (which
// also deletes the hint). Hints are only installed at sites that guarantee
// the pure-append/pure-move contract (extrude EDGES/VERTICES, Set Position).
interface NormalsDeltaHint {
  baseNormals: Vec3[];
  baseVertCount: number;
  baseFaceCount: number;
  dirty: ReadonlySet<number>; // indices < baseVertCount whose positions moved
  positions: Vec3[];
  faces: number[][];
  positionCount: number;
  faceCount: number;
}
const normalsDeltaHints = new WeakMap<Mesh, NormalsDeltaHint>();
const EMPTY_DIRTY: ReadonlySet<number> = new Set<number>();

function validNormalsHint(mesh: Mesh): NormalsDeltaHint | null {
  const hint = normalsDeltaHints.get(mesh);
  return hint
    && hint.positions === mesh.positions
    && hint.faces === mesh.faces
    && hint.positionCount === mesh.positions.length
    && hint.faceCount === mesh.faces.length
    ? hint
    : null;
}

/**
 * The known-normals base state a mesh can serve as: either its own cached
 * (fully valid) vertex normals, or the base carried by its own valid hint.
 */
function normalsBaseStateOf(mesh: Mesh): {
  baseNormals: Vec3[];
  baseVertCount: number;
  baseFaceCount: number;
  dirty: ReadonlySet<number>;
} | null {
  const cached = vertexNormalsCache.get(mesh);
  const meta = vertexNormalsCacheMeta.get(mesh);
  if (
    cached && meta
    && meta.positions === mesh.positions
    && meta.faces === mesh.faces
    && meta.positionCount === mesh.positions.length
    && meta.faceCount === mesh.faces.length
  ) {
    return {
      baseNormals: cached,
      baseVertCount: mesh.positions.length,
      baseFaceCount: mesh.faces.length,
      dirty: EMPTY_DIRTY,
    };
  }
  const hint = validNormalsHint(mesh);
  if (hint) {
    return {
      baseNormals: hint.baseNormals,
      baseVertCount: hint.baseVertCount,
      baseFaceCount: hint.baseFaceCount,
      dirty: hint.dirty,
    };
  }
  return null;
}

/**
 * Declare that `target` extends `source` by pure append: target's first
 * source-count positions are the same elements, its first source-count face
 * rows are the same rows, and everything beyond is newly added. Callers
 * (extrude EDGES/VERTICES) must guarantee that contract. No-op when the
 * source has no usable normals base.
 */
export function carryNormalsDeltaOnAppend(source: Mesh, target: Mesh): void {
  const base = normalsBaseStateOf(source);
  if (!base) {
    normalsDeltaHints.delete(target);
    return;
  }
  normalsDeltaHints.set(target, {
    ...base,
    positions: target.positions,
    faces: target.faces,
    positionCount: target.positions.length,
    faceCount: target.faces.length,
  });
}

/**
 * Declare that `mesh.positions` was just replaced wholesale by a same-length
 * array (Set Position). Diffs against `oldPositions` to extend/install the
 * delta hint. Call AFTER the assignment; no-op (hint cleared) when there is
 * no usable base or the length changed.
 */
export function notePositionsReplaced(mesh: Mesh, oldPositions: Vec3[]): void {
  const next = mesh.positions;
  if (next === oldPositions || next.length !== oldPositions.length) {
    normalsDeltaHints.delete(mesh);
    return;
  }
  // The base must be valid for the PRE-replacement state: either cached
  // normals keyed to oldPositions, or a hint keyed to oldPositions.
  let base: ReturnType<typeof normalsBaseStateOf> = null;
  const cached = vertexNormalsCache.get(mesh);
  const meta = vertexNormalsCacheMeta.get(mesh);
  if (
    cached && meta
    && meta.positions === oldPositions
    && meta.faces === mesh.faces
    && meta.positionCount === oldPositions.length
    && meta.faceCount === mesh.faces.length
  ) {
    base = {
      baseNormals: cached,
      baseVertCount: oldPositions.length,
      baseFaceCount: mesh.faces.length,
      dirty: EMPTY_DIRTY,
    };
  } else {
    const hint = normalsDeltaHints.get(mesh);
    if (
      hint
      && hint.positions === oldPositions
      && hint.faces === mesh.faces
      && hint.positionCount === oldPositions.length
      && hint.faceCount === mesh.faces.length
    ) {
      base = hint;
    }
  }
  if (!base) {
    normalsDeltaHints.delete(mesh);
    return;
  }
  const dirty = new Set<number>(base.dirty);
  for (let i = 0; i < next.length; i++) {
    const before = oldPositions[i], after = next[i];
    if (before === after) continue;
    // Object.is: exact coordinate comparison including -0/NaN, so a "moved"
    // vertex whose coordinates are bit-identical stays clean.
    if (Object.is(before[0], after[0]) && Object.is(before[1], after[1]) && Object.is(before[2], after[2])) continue;
    if (i < base.baseVertCount) dirty.add(i);
  }
  normalsDeltaHints.set(mesh, {
    baseNormals: base.baseNormals,
    baseVertCount: base.baseVertCount,
    baseFaceCount: base.baseFaceCount,
    dirty,
    positions: next,
    faces: mesh.faces,
    positionCount: next.length,
    faceCount: mesh.faces.length,
  });
}

/**
 * Recompute only the vertices whose normals can differ from the hint's base:
 * appended vertices, vertices of appended faces, and vertices sharing a face
 * with a moved vertex. Returns null when the affected set is large enough
 * that the full pass is the better call. Bit-exact vs computeVertexNormals
 * (see the hint contract comment above).
 */
function incrementalVertexNormals(mesh: Mesh, hint: NormalsDeltaHint): Vec3[] | null {
  const vertCount = mesh.positions.length;
  const faces = mesh.faces;
  if (hint.baseNormals.length < hint.baseVertCount) return null;
  const affected = new Uint8Array(vertCount);
  let affectedCount = 0;
  for (let vi = hint.baseVertCount; vi < vertCount; vi++) {
    affected[vi] = 1;
    affectedCount++;
  }
  for (let fi = hint.baseFaceCount; fi < faces.length; fi++) {
    for (const vi of faces[fi]) {
      if (!affected[vi]) { affected[vi] = 1; affectedCount++; }
    }
  }
  const corners = vertexCornersOf(mesh);
  const cm = cornerMapsOf(mesh);
  for (const vi of hint.dirty) {
    if (vi >= vertCount) return null; // contract breach — bail to full pass
    if (!affected[vi]) { affected[vi] = 1; affectedCount++; }
    for (const c of corners[vi]) {
      for (const u of faces[cm.face[c]]) {
        if (!affected[u]) { affected[u] = 1; affectedCount++; }
      }
    }
  }
  if (affectedCount * 3 > vertCount) return null;

  const out: Vec3[] = new Array(vertCount);
  const baseNormals = hint.baseNormals;
  for (let vi = 0; vi < hint.baseVertCount; vi++) out[vi] = baseNormals[vi];
  // Face normals are pure per-face; compute each affected face once (the full
  // pass computes every face once — identical values for the ones we touch).
  const faceNormalMemo = new Map<number, Vec3>();
  const faceNormalOf = (fi: number): Vec3 => {
    let n = faceNormalMemo.get(fi);
    if (!n) {
      n = faceNormalBlenderFloat(mesh, faces[fi]);
      faceNormalMemo.set(fi, n);
    }
    return n;
  };
  for (let vi = 0; vi < vertCount; vi++) {
    if (!affected[vi]) continue;
    const cs = corners[vi];
    if (!cs.length) {
      out[vi] = normalizeBlenderFloat(mesh.positions[vi]);
      continue;
    }
    // Same inlined float32 arithmetic and per-vertex accumulation order as
    // computeVertexNormals: ascending corner order, f32 rounding after every
    // addition.
    let accX = 0, accY = 0, accZ = 0;
    for (const c of cs) {
      const fi = cm.face[c];
      const face = faces[fi];
      const k = c - cm.faceStart[fi];
      const n = faceNormalOf(fi);
      const p = mesh.positions[face[k]];
      const prev = mesh.positions[face[(k - 1 + face.length) % face.length]];
      const next = mesh.positions[face[(k + 1) % face.length]];
      let ax = f32(prev[0] - p[0]);
      let ay = f32(prev[1] - p[1]);
      let az = f32(prev[2] - p[2]);
      const alen = f32(Math.sqrt(f32(f32(f32(ax * ax) + f32(ay * ay)) + f32(az * az))));
      if (alen > 0) {
        ax = f32(ax / alen); ay = f32(ay / alen); az = f32(az / alen);
      } else {
        ax = 0; ay = 0; az = 0;
      }
      let bx = f32(next[0] - p[0]);
      let by = f32(next[1] - p[1]);
      let bz = f32(next[2] - p[2]);
      const blen = f32(Math.sqrt(f32(f32(f32(bx * bx) + f32(by * by)) + f32(bz * bz))));
      if (blen > 0) {
        bx = f32(bx / blen); by = f32(by / blen); bz = f32(bz / blen);
      } else {
        bx = 0; by = 0; bz = 0;
      }
      const dot = f32(f32(f32(ax * bx) + f32(ay * by)) + f32(az * bz));
      const angle = safeAcosApproxBlenderFloat(dot);
      accX = f32(accX + f32(n[0] * angle));
      accY = f32(accY + f32(n[1] * angle));
      accZ = f32(accZ + f32(n[2] * angle));
    }
    out[vi] = normalizeBlenderFloat([accX, accY, accZ]);
  }
  return out;
}

/**
 * Install a source mesh's still-valid derived caches on its clone. The clone
 * shares position/edge/face rows with the source, so topology and vertex
 * normals computed for the source are bit-identical for the clone. Re-keying
 * the meta to the clone's own outer arrays keeps the usual invalidation rules
 * (wholesale array replacement, count change, explicit invalidate) working
 * independently on each mesh afterwards.
 */
function carryDerivedCaches(source: Mesh, target: Mesh): void {
  const topo = topologyCache.get(source);
  const topoMeta = topologyCacheMeta.get(source);
  if (
    topo && topoMeta
    && topoMeta.faces === source.faces
    && topoMeta.edges === source.edges
    && topoMeta.positionCount === source.positions.length
    && topoMeta.faceCount === source.faces.length
    && topoMeta.edgeCount === source.edges.length
  ) {
    topologyCache.set(target, topo);
    topologyCacheMeta.set(target, {
      faces: target.faces,
      edges: target.edges,
      positionCount: target.positions.length,
      faceCount: target.faces.length,
      edgeCount: target.edges.length,
    });
  }
  const normals = vertexNormalsCache.get(source);
  const normalsMeta = vertexNormalsCacheMeta.get(source);
  if (
    normals && normalsMeta
    && normalsMeta.positions === source.positions
    && normalsMeta.faces === source.faces
    && normalsMeta.positionCount === source.positions.length
    && normalsMeta.faceCount === source.faces.length
  ) {
    vertexNormalsCache.set(target, normals);
    vertexNormalsCacheMeta.set(target, {
      positions: target.positions,
      faces: target.faces,
      positionCount: target.positions.length,
      faceCount: target.faces.length,
    });
  }
  const corners = cornerMapsCache.get(source);
  const cornersMeta = cornerMapsCacheMeta.get(source);
  if (
    corners && cornersMeta
    && cornersMeta.faces === source.faces
    && cornersMeta.faceCount === source.faces.length
  ) {
    cornerMapsCache.set(target, corners);
    cornerMapsCacheMeta.set(target, { faces: target.faces, faceCount: target.faces.length });
  }
  const hint = validNormalsHint(source);
  if (hint) {
    // The clone shares the same position elements and face rows, so the
    // hint's base relationship holds for it verbatim; re-key to the clone's
    // outer arrays (identical contents and lengths by construction).
    normalsDeltaHints.set(target, {
      ...hint,
      positions: target.positions,
      faces: target.faces,
      positionCount: target.positions.length,
      faceCount: target.faces.length,
    });
  }
  const vertCorners = vertexCornersCache.get(source);
  const vertCornersMeta = vertexCornersCacheMeta.get(source);
  if (
    vertCorners && vertCornersMeta
    && vertCornersMeta.faces === source.faces
    && vertCornersMeta.faceCount === source.faces.length
    && vertCornersMeta.positionCount === source.positions.length
  ) {
    vertexCornersCache.set(target, vertCorners);
    vertexCornersCacheMeta.set(target, {
      faces: target.faces,
      faceCount: target.faces.length,
      positionCount: target.positions.length,
    });
  }
}

const f32 = Math.fround;

/** Legacy C mesh normalization used while building true face normals. */
function normalizeBlenderFloatLegacy(vector: Vec3): Vec3 {
  const x = f32(vector[0]);
  const y = f32(vector[1]);
  const z = f32(vector[2]);
  const lengthSquared = f32(f32(f32(x * x) + f32(y * y)) + f32(z * z));
  const length = f32(Math.sqrt(lengthSquared));
  if (!(length > 0)) return [0, 0, 0];
  const inverse = f32(1 / length);
  return [f32(x * inverse), f32(y * inverse), f32(z * inverse)];
}

/** Blender's C++ `math::normalize(float3)`, which divides each component. */
function normalizeBlenderFloat(vector: Vec3): Vec3 {
  const x = f32(vector[0]);
  const y = f32(vector[1]);
  const z = f32(vector[2]);
  const lengthSquared = f32(f32(f32(x * x) + f32(y * y)) + f32(z * z));
  const length = f32(Math.sqrt(lengthSquared));
  if (!(length > 0)) return [0, 0, 0];
  // Do not replace these divisions with a shared reciprocal. Although the two
  // forms are algebraically equivalent, Blender's C++ mesh-normal path rounds
  // each float division directly and Chrome Crayon exposes the one-ULP gap.
  return [f32(x / length), f32(y / length), f32(z / length)];
}

function faceNormalBlenderFloat(mesh: Mesh, face: number[]): Vec3 {
  let nx = 0, ny = 0, nz = 0;
  // The cyclic starting edge is observable in float precision. Blender starts
  // with last -> first and then walks the face in corner order.
  let prev = mesh.positions[face[face.length - 1]];
  for (let i = 0; i < face.length; i++) {
    const cur = mesh.positions[face[i]];
    nx = f32(nx + f32(f32(prev[1] - cur[1]) * f32(prev[2] + cur[2])));
    ny = f32(ny + f32(f32(prev[2] - cur[2]) * f32(prev[0] + cur[0])));
    nz = f32(nz + f32(f32(prev[0] - cur[0]) * f32(prev[1] + cur[1])));
    prev = cur;
  }
  const normalized = normalizeBlenderFloatLegacy([nx, ny, nz]);
  return normalized[0] === 0 && normalized[1] === 0 && normalized[2] === 0
    ? [0, 0, 1]
    : normalized;
}

function faceNormalCalcBlenderFloat(mesh: Mesh, face: number[]): Vec3 {
  const sub = (a: Vec3, b: Vec3): Vec3 => [
    f32(a[0] - b[0]), f32(a[1] - b[1]), f32(a[2] - b[2]),
  ];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    f32(f32(a[1] * b[2]) - f32(a[2] * b[1])),
    f32(f32(a[2] * b[0]) - f32(a[0] * b[2])),
    f32(f32(a[0] * b[1]) - f32(a[1] * b[0])),
  ];
  let normal: Vec3;
  if (face.length === 3) {
    // `cross_tri(v1, v2, v3)`: cross(v1 - v2, v2 - v3).
    normal = normalizeBlenderFloatLegacy(cross(
      sub(mesh.positions[face[0]], mesh.positions[face[1]]),
      sub(mesh.positions[face[1]], mesh.positions[face[2]]),
    ));
  } else if (face.length === 4) {
    // `normal_quad_v3`: cross the two polygon diagonals.
    normal = normalizeBlenderFloatLegacy(cross(
      sub(mesh.positions[face[0]], mesh.positions[face[2]]),
      sub(mesh.positions[face[1]], mesh.positions[face[3]]),
    ));
  } else {
    normal = faceNormalBlenderFloat(mesh, face);
  }
  return normal[0] === 0 && normal[1] === 0 && normal[2] === 0
    ? [0, 0, 1]
    : normal;
}

/** Blender's float-only `safe_acos_approx`, used for mesh corner weights. */
function safeAcosApproxBlenderFloat(value: number): number {
  const x = f32(value);
  const absolute = f32(Math.abs(x));
  // The nested subtraction is intentional: Blender uses it to clamp values
  // outside [-1, 1] and crush denormals using float arithmetic.
  const magnitude = absolute < 1 ? f32(1 - f32(1 - absolute)) : 1;
  let polynomial = f32(-0.02164095);
  // Each source constant is a C++ float literal. Round the constant before the
  // addition as well as rounding the multiplication and result.
  polynomial = f32(f32(0.077980478) + f32(magnitude * polynomial));
  polynomial = f32(f32(-0.213300989) + f32(magnitude * polynomial));
  polynomial = f32(f32(1.5707963267) + f32(magnitude * polynomial));
  const angle = f32(f32(Math.sqrt(f32(1 - magnitude))) * polynomial);
  return x < 0 ? f32(f32(Math.PI) - angle) : angle;
}

function computeVertexNormals(mesh: Mesh): Vec3[] {
  const faceNormals = mesh.faces.map((face) => faceNormalBlenderFloat(mesh, face));
  const hasIncident = new Uint8Array(mesh.positions.length);
  // Blender's mesh point normals are corner-angle weighted. Equal face
  // weighting badly tilts a rounded n-gon rim toward its two wall quads: the
  // n-gon's almost-pi corner must contribute about twice each quad's pi/2
  // corner. The Dojo bin's normal-based thickness offset exposes this directly.
  //
  // This is the hottest per-corner loop in the evaluator; the vector helpers
  // are inlined into scalar float32 arithmetic (identical operation order, so
  // bit-identical results) to avoid five short-lived arrays per corner.
  const acc = new Float64Array(mesh.positions.length * 3);
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const f = mesh.faces[fi];
    const n = faceNormals[fi];
    for (let k = 0; k < f.length; k++) {
      const vi = f[k];
      hasIncident[vi] = 1;
      const p = mesh.positions[vi];
      const prev = mesh.positions[f[(k - 1 + f.length) % f.length]];
      const next = mesh.positions[f[(k + 1) % f.length]];
      // normalizeBlenderFloat(prev - p), inlined
      let ax = f32(prev[0] - p[0]);
      let ay = f32(prev[1] - p[1]);
      let az = f32(prev[2] - p[2]);
      const alen = f32(Math.sqrt(f32(f32(f32(ax * ax) + f32(ay * ay)) + f32(az * az))));
      if (alen > 0) {
        ax = f32(ax / alen); ay = f32(ay / alen); az = f32(az / alen);
      } else {
        ax = 0; ay = 0; az = 0;
      }
      // normalizeBlenderFloat(next - p), inlined
      let bx = f32(next[0] - p[0]);
      let by = f32(next[1] - p[1]);
      let bz = f32(next[2] - p[2]);
      const blen = f32(Math.sqrt(f32(f32(f32(bx * bx) + f32(by * by)) + f32(bz * bz))));
      if (blen > 0) {
        bx = f32(bx / blen); by = f32(by / blen); bz = f32(bz / blen);
      } else {
        bx = 0; by = 0; bz = 0;
      }
      const dot = f32(f32(f32(ax * bx) + f32(ay * by)) + f32(az * bz));
      const angle = safeAcosApproxBlenderFloat(dot);
      const at = vi * 3;
      acc[at] = f32(acc[at] + f32(n[0] * angle));
      acc[at + 1] = f32(acc[at + 1] + f32(n[1] * angle));
      acc[at + 2] = f32(acc[at + 2] + f32(n[2] * angle));
    }
  }

  const out: Vec3[] = new Array(mesh.positions.length);
  for (let vi = 0; vi < mesh.positions.length; vi++) {
    if (!hasIncident[vi]) {
      out[vi] = normalizeBlenderFloat(mesh.positions[vi]);
      continue;
    }
    // Blender does not select one of several opposing normal fans on a
    // non-manifold point. It corner-angle-weights every incident face and
    // normalizes the resulting sum. This is observable on the Bolt Generator's
    // tap thread: choosing one fan moves nine seam points by about 0.5 units and
    // prevents the authored Heal Mesh weld from closing the surface.
    out[vi] = normalizeBlenderFloat([acc[vi * 3], acc[vi * 3 + 1], acc[vi * 3 + 2]]);
  }
  return out;
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
  const hint = validNormalsHint(mesh);
  let normals = hint ? incrementalVertexNormals(mesh, hint) : null;
  const diag = (globalThis as any).__VN_DIAG;
  if (diag) diag.push({ v: mesh.positions.length, f: mesh.faces.length, mode: normals ? "incremental" : hint ? "hint-bailed" : "full" });
  if (normals && (globalThis as any).__VN_VERIFY) {
    const full = computeVertexNormals(mesh);
    let bad = 0;
    for (let i = 0; i < full.length; i++) {
      if (!Object.is(full[i][0], normals[i][0]) || !Object.is(full[i][1], normals[i][1]) || !Object.is(full[i][2], normals[i][2])) bad++;
    }
    ((globalThis as any).__VN_VERIFY_RESULTS ??= []).push({ v: mesh.positions.length, bad });
  }
  if (!normals) normals = computeVertexNormals(mesh);
  normalsDeltaHints.delete(mesh); // superseded by the full cache below
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

// Scratch tables for computeTopology's undirected-edge dedup, reused across
// calls (module is single-threaded and the dedup loop is non-reentrant). The
// slot table is re-cleared per call; key tables hold stale values that are
// only read after a slot match. Profiling the bubble-putty dump showed the
// per-corner Map<get/set> here as the single largest self-time consumer
// (~16 s of a 99 s run), most of it hashing + entry allocation churn.
let edgeDedupKeyLo = new Float64Array(0);
let edgeDedupKeyHi = new Float64Array(0);
let edgeDedupSlot = new Int32Array(0);

function computeTopology(mesh: Mesh): Topology {
  // Snapshot the rows and counts: the returned Topology can outlive this
  // mesh's array identities (clones carry it, and meshes can be appended to
  // in place by mergeMeshInto). Face rows are immutable once attached, so a
  // row-pointer snapshot keeps the lazily computed sections correct for every
  // mesh that shares them.
  const faces = mesh.faces.slice();
  const positionCount = mesh.positions.length;
  // Open-addressing dedup keyed on the (lo, hi) endpoint pair. Exact for any
  // numeric index (doubles compare exactly), so it fully replaces the old
  // 21-bit-packed / string-fallback Map keys. Insertion order — explicit
  // wires first, then face-derived first-seen — and the first stored edge's
  // endpoint order are preserved unchanged (Blender keeps the first stored
  // direction; sorting endpoints shifts Geometry Proximity EDGES by ULPs).
  let totalCorners = 0;
  for (const f of faces) totalCorners += f.length;
  const upper = mesh.edges.length + totalCorners + 1;
  let cap = 16;
  while (cap < upper * 2) cap <<= 1;
  if (edgeDedupSlot.length < cap) {
    edgeDedupKeyLo = new Float64Array(cap);
    edgeDedupKeyHi = new Float64Array(cap);
    edgeDedupSlot = new Int32Array(cap);
  }
  const keyLo = edgeDedupKeyLo, keyHi = edgeDedupKeyHi, slot = edgeDedupSlot;
  const mask = cap - 1;
  slot.fill(-1, 0, cap);
  const edges: { verts: [number, number]; faces: number[] }[] = [];
  const addFaceEdge = (a: number, b: number, fi: number) => {
    const lo = a < b ? a : b, hi = a < b ? b : a;
    let h = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca6b)) & mask;
    let e: { verts: [number, number]; faces: number[] };
    for (;;) {
      const s = slot[h];
      if (s === -1) {
        slot[h] = edges.length;
        keyLo[h] = lo;
        keyHi[h] = hi;
        e = { verts: [a, b], faces: [] };
        edges.push(e);
        break;
      }
      if (keyLo[h] === lo && keyHi[h] === hi) { e = edges[s]; break; }
      h = (h + 1) & mask;
    }
    if (fi >= 0) e.faces.push(fi);
  };
  // Blender's Edge Index follows the mesh's stored edge order. Generated
  // meshes often carry that order explicitly (notably Edge Extrude); seed the
  // topology map from it before adding any implicit polygon boundaries.
  for (const [a, b] of mesh.edges) addFaceEdge(a, b, -1);
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    for (let i = 0; i < f.length; i++) addFaceEdge(f[i], f[(i + 1) % f.length], fi);
  }

  return assembleTopology(faces, positionCount, edges);
}

/**
 * Wrap a canonical edge list into a Topology with the standard lazily built
 * adjacency/island sections. `faces` must be a snapshot the topology may
 * outlive its mesh with (computeTopology slices; installTopology snapshots).
 */
function assembleTopology(
  faces: number[][],
  positionCount: number,
  edges: { verts: [number, number]; faces: number[] }[],
): Topology {
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
      const sets: Set<number>[] = faces.map(() => new Set<number>());
      for (const e of edges)
        for (const fa of e.faces)
          for (const fb of e.faces)
            if (fa !== fb) sets[fa].add(fb);
      faceNeighbors = sets.map((s) => s.size);
    }
    return faceNeighbors;
  };
  const getFaceIslands = () => (faceIslands ??= uf(faces.length, (join) => {
    for (const e of edges) for (let i = 1; i < e.faces.length; i++) join(e.faces[0], e.faces[i]);
  }));
  const getPointIslands = () => (pointIslands ??= uf(positionCount, (join) => {
    for (const e of edges) join(e.verts[0], e.verts[1]);
  }));
  const getPointFaces = () => {
    if (!pointFaces) {
      pointFaces = Array.from({ length: positionCount }, () => [] as number[]);
      for (let fi = 0; fi < faces.length; fi++)
        for (const v of faces[fi]) pointFaces[v]?.push(fi);
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

/**
 * Install a canonical topology that the caller has constructed incrementally
 * (see extrudeMesh's EDGES mode). The edge list MUST be exactly what a fresh
 * computeTopology(mesh) would produce — same enumeration order, same stored
 * endpoint directions, same per-edge face lists (faces pushed in ascending
 * face-walk order). The caller may share edge objects/arrays from an input
 * mesh's topology; Topology consumers are read-only.
 */
export function installTopology(
  mesh: Mesh,
  edges: { verts: [number, number]; faces: number[] }[],
): Topology {
  const topo = assembleTopology(mesh.faces.slice(), mesh.positions.length, edges);
  topologyCache.set(mesh, topo);
  topologyCacheMeta.set(mesh, {
    faces: mesh.faces,
    edges: mesh.edges,
    positionCount: mesh.positions.length,
    faceCount: mesh.faces.length,
    edgeCount: mesh.edges.length,
  });
  return topo;
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
// A numeric pair key (same 21-bit packing as computeTopology) avoids allocating
// a string per edge in instance-heavy realizes; identity is all consumers use,
// and Map insertion order — the contract note near computeTopology — is
// independent of the key representation.
const EDGE_KEY_BASE = 2 ** 21;
export const canonicalEdgeKey = (x: number, y: number): number | string => {
  const lo = x < y ? x : y, hi = x < y ? y : x;
  return hi < EDGE_KEY_BASE ? lo * EDGE_KEY_BASE + hi : `${lo}_${hi}`;
};
const ekeyG = canonicalEdgeKey;
function canonicalEdgeIndex(m: Mesh): Map<number | string, number> {
  // computeTopology inserts unique edges in the same order this function
  // needs; the map is cached per Topology object.
  return edgeIndexOf(m);
}

export function mergeMeshInto(a: Mesh, b: Mesh): void {
  // Canonical edge maps must be taken before mutation for the EDGE-attr reconcile.
  const hasEdgeAttr = (m: Mesh) => [...m.attributes.values()].some((x) => x.domain === "EDGE");
  const needEdge = hasEdgeAttr(a) || hasEdgeAttr(b);
  const aEdgeIdx = needEdge ? canonicalEdgeIndex(a) : null;
  const bEdgeIdx = needEdge ? canonicalEdgeIndex(b) : null;
  const baseV = a.positions.length;
  const baseF = a.faces.length;
  const baseC = a.domainSize("CORNER");
  const addedC = b.domainSize("CORNER");
  // Share the Vec3 elements (immutable once attached); only a's outer array
  // grows.
  for (const p of b.positions) a.positions.push(p);
  for (const e of b.edges) a.edges.push([e[0] + baseV, e[1] + baseV]);
  const slotMap = b.materialSlots.map((name) => a.ensureMaterialSlot(name));
  for (let fi = 0; fi < b.faces.length; fi++) {
    a.faces.push(b.faces[fi].map((vi) => vi + baseV));
    a.faceMaterial.push(slotMap[b.faceMaterial[fi] ?? 0] ?? 0);
  }
  invalidateMeshCaches(a);
  // Reconcile POINT + FACE + CORNER (+ EDGE when present) attributes across
  // the union of names. UV maps are CORNER-domain and must survive Join
  // Geometry/Realize Instances without averaging across seams.
  const reconcile = (domain: "POINT" | "FACE" | "CORNER" | "EDGE", baseCount: number, addCount: number) => {
    const names = new Set<string>();
    for (const [k, x] of a.attributes) if (x.domain === domain) names.add(k);
    for (const [k, x] of b.attributes) if (x.domain === domain) names.add(k);
    for (const name of names) {
      let aa = a.attributes.get(name);
      const ba = b.attributes.get(name);
      const dflt = zeroLike(aa?.data[0] ?? ba?.data[0]);
      if (!aa) { aa = { domain, data: [] }; a.attributes.set(name, aa); }
      const data = ownAttributeData(aa);
      while (data.length < baseCount) data.push(dflt);
      for (let i = 0; i < addCount; i++) data.push(ba ? ba.data[i] ?? dflt : dflt);
    }
  };
  reconcile("POINT", baseV, b.positions.length);
  reconcile("FACE", baseF, b.faces.length);
  reconcile("CORNER", baseC, addedC);
  // EDGE attrs can't just concatenate: buildTopology enumerates ALL face-derived
  // edges before ANY loose wires, so when A has loose edges the joined order
  // interleaves. Map each joined canonical edge back to its source explicitly.
  if (needEdge && aEdgeIdx && bEdgeIdx) {
    const joined = topologyOf(a).edges; // after mutation (caches invalidated above)
    // a joined edge belongs to B iff both endpoints are >= baseV
    const srcOf = joined.map((edge) => {
      const [u, v] = edge.verts;
      if (u >= baseV && v >= baseV) {
        const bi = bEdgeIdx.get(ekeyG(u - baseV, v - baseV));
        return bi === undefined ? null : { from: "b" as const, i: bi };
      }
      const ai = aEdgeIdx.get(ekeyG(u, v));
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

type InstanceMatrix = number[][];

function multiplyInstanceTransformMatrices(a: InstanceMatrix, b: InstanceMatrix): InstanceMatrix {
  const f = Math.fround;
  return [0, 1, 2, 3].map((row) => [0, 1, 2, 3].map((column) => {
    let value = f(f(a[row][0]) * f(b[0][column]));
    value = f(value + f(f(a[row][1]) * f(b[1][column])));
    value = f(value + f(f(a[row][2]) * f(b[2][column])));
    return f(value + f(f(a[row][3]) * f(b[3][column])));
  }));
}

function instanceMatrixRadiusScale(matrix: InstanceMatrix): number {
  const scales = [0, 1, 2].map((column) => Math.hypot(
    matrix[0]?.[column] ?? 0,
    matrix[1]?.[column] ?? 0,
    matrix[2]?.[column] ?? 0,
  ));
  return Math.cbrt(Math.max(0, scales[0] * scales[1] * scales[2]));
}

// Realize instances into the mesh (bakes transforms, merges geometry, propagates
// per-instance attributes onto the realized vertices — Blender's realize semantics).
//
// Blender composes nested instance transforms before applying the resulting
// matrix to a leaf component. Baking and rounding the child first, then baking
// and rounding its parent, changes quarter-turn coordinates by a few ULPs and
// can alter a following Convex Hull. Keep explicit instance matrices pending
// until a mesh/curve leaf is reached, then transform every point exactly once.
export function realizeInstances(
  g: Geometry,
  pendingMatrix?: InstanceMatrix,
  pendingRadiusScale = 1,
): Geometry {
  const out = new Geometry();
  const mesh = g.mesh ? g.mesh.clone() : new Mesh();
  if (g.mesh && pendingMatrix) {
    mesh.positions = mesh.positions.map((point) => transformPointMatrixFloat32(point, pendingMatrix));
  }
  // base curves pass through; instanced curves get appended transformed below
  out.curves = g.curves.map((s) => ({
    cyclic: s.cyclic,
    points: pendingMatrix
      ? s.points.map((p) => transformPointMatrixFloat32(p, pendingMatrix))
      : s.points.slice(),
    controlPoints: pendingMatrix
      ? s.controlPoints?.map((p) => transformPointMatrixFloat32(p, pendingMatrix))
      : s.controlPoints?.slice(),
    bezierLeft: pendingMatrix
      ? s.bezierLeft?.map((p) => transformPointMatrixFloat32(p, pendingMatrix))
      : s.bezierLeft?.slice(),
    bezierRight: pendingMatrix
      ? s.bezierRight?.map((p) => transformPointMatrixFloat32(p, pendingMatrix))
      : s.bezierRight?.slice(),
  }));
  for (const [k, a] of g.curveAttributes) out.curveAttributes.set(k, {
    domain: a.domain,
    data: k === "radius" && a.domain === "POINT" && pendingRadiusScale !== 1
      ? a.data.map((value) => asNum(value) * pendingRadiusScale)
      : [...a.data],
  });
  for (const inst of g.instances) {
    const explicitMatrix = inst.transformMatrix;
    const childMatrix = explicitMatrix
      ? pendingMatrix
        ? multiplyInstanceTransformMatrices(pendingMatrix, explicitMatrix)
        : explicitMatrix
      : undefined;
    const childRadiusScale = explicitMatrix
      ? pendingRadiusScale * instanceMatrixRadiusScale(explicitMatrix)
      : 1;
    const rg = realizeInstances(inst.geometry, childMatrix, childRadiusScale); // recursive
    const transformGenericPoint = (point: Vec3): Vec3 => {
      let transformed = transformPointFloat32(point, inst.position, inst.rotation, inst.scale);
      if (pendingMatrix) transformed = transformPointMatrixFloat32(transformed, pendingMatrix);
      return transformed;
    };
    if (rg.mesh) {
      const tm = rg.mesh.clone();
      // An explicit matrix was carried to the leaf and has already been
      // applied. Legacy Euler instances retain their established sequential
      // float32 path, followed by any explicit parent matrix.
      if (!explicitMatrix) tm.positions = tm.positions.map(transformGenericPoint);
      const baseV = mesh.positions.length;
      mergeMeshInto(mesh, tm); // carries the instance geometry's own attributes
      if (inst.attributes && inst.attributes.size) {
        for (const [name, val] of inst.attributes) {
          let a = mesh.attributes.get(name);
          if (!a) { a = { domain: "POINT", data: [] }; mesh.attributes.set(name, a); }
          const data = ownAttributeData(a);
          while (data.length < mesh.positions.length) data.push(zeroLike(val));
          for (let k = baseV; k < mesh.positions.length; k++) data[k] = val;
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
        points: explicitMatrix ? s.points.slice() : s.points.map(transformGenericPoint),
        controlPoints: explicitMatrix
          ? s.controlPoints?.slice()
          : s.controlPoints?.map(transformGenericPoint),
        bezierLeft: explicitMatrix
          ? s.bezierLeft?.slice()
          : s.bezierLeft?.map(transformGenericPoint),
        bezierRight: explicitMatrix
          ? s.bezierRight?.slice()
          : s.bezierRight?.map(transformGenericPoint),
      });
    if (addedCurves) {
      // Realizing a scaled curve instance transforms its built-in radius along
      // with its positions. Mesh to Curve creates radius=1; an Instance on
      // Points scale of .27 therefore makes a following Curve to Mesh profile
      // .27 times as wide. Preserve all curve attributes while flattening and
      // apply the transform's uniform scale to that radius field.
      const genericScales = inst.scale.map(Math.abs);
      const radiusScale = explicitMatrix
        ? 1
        : pendingRadiusScale * Math.cbrt(Math.max(0, genericScales[0] * genericScales[1] * genericScales[2]));
      const names = new Set([...out.curveAttributes.keys(), ...rg.curveAttributes.keys()]);
      // Extraction-only font sampling metadata is not a Blender geometry
      // attribute. Carrying it across Realize Instances makes a later Fill
      // Curve dissolve already-realized glyph points a second time.
      names.delete("__font_sample_stride");
      for (const name of names) {
        const source = rg.curveAttributes.get(name);
        const target = out.curveAttributes.get(name);
        const domain = source?.domain ?? target?.domain;
        if (!domain || (target && target.domain !== domain)) continue;
        const before = domain === "POINT" ? pointBase : curveBase;
        const count = domain === "POINT" ? addedPoints : addedCurves;
        const fallback = zeroLike(target?.data[0] ?? source?.data[0]);
        const data = target ? ownAttributeData(target) : [];
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
  /**
   * Blender split normals in emitted triangle-corner order. Present only when
   * a retained EDGE-domain sharp_edge attribute separates smooth fans.
   * Renderers can expand the indexed display mesh while keeping GN topology
   * and statistics unchanged.
   */
  cornerNormals?: Float32Array;
  /** Source face for every emitted triangle, in the same order as indices. */
  triangleFaces?: Uint32Array;
  /** Source mesh corner for every emitted triangle corner. */
  triangleCorners?: Uint32Array;
  attributes: Record<string, {
    itemSize: 1 | 3;
    data: Float32Array;
    domain?: "POINT" | "FACE" | "CORNER";
    /** Uninterpolated values retained in the original FACE/CORNER domain. */
    domainData?: Float32Array;
  }>;
  groups: { start: number; count: number; material: string | null }[]; // per material slot
  stats: { verts: number; faces: number; tris: number };
  /**
   * Optional curve-only display payload. These evaluated polyline segments are
   * deliberately separate from the indexed mesh arrays so a visible browser
   * wire never inflates Blender-compatible mesh vertex/face statistics.
   */
  lines?: {
    positions: Float32Array; // duplicated xyz endpoints, two per segment
    stats: { controlPoints: number; evaluatedPoints: number; segments: number; splines: number };
  };
  /** Loose point-cloud display payload, kept separate from mesh topology. */
  points?: {
    positions: Float32Array;
    radii: Float32Array;
    stats: { points: number };
  };
}

/**
 * Reconstruct Blender's smooth-normal fans separated by sharp mesh edges.
 *
 * Geometry Nodes retains `sharp_edge` as EDGE-domain data even though a WebGL
 * index can bind only one normal to each point. Keep the evaluated mesh
 * indexed for topology/export, and return a normal for each source face corner
 * so the display adapter can split only its render vertices.
 */
function sharpCornerNormals(mesh: Mesh): Vec3[] | undefined {
  const sharp = mesh.attributes.get("sharp_edge");
  const sharpFace = mesh.attributes.get("sharp_face");
  const hasSharpEdges = sharp?.domain === "EDGE" && sharp.data.some((value) => asNum(value) > 0);
  const hasSharpFaces = sharpFace?.domain === "FACE" && sharpFace.data.some((value) => asNum(value) > 0);
  if (!hasSharpEdges && !hasSharpFaces) return undefined;

  const faceNormals = mesh.faces.map((face) => faceNormalBlenderFloat(mesh, face));
  const contributions: Vec3[][] = mesh.faces.map((face, faceIndex) => {
    const normal = faceNormals[faceIndex];
    return face.map((vertex, corner) => {
      const point = mesh.positions[vertex];
      const previous = mesh.positions[face[(corner - 1 + face.length) % face.length]];
      const next = mesh.positions[face[(corner + 1) % face.length]];
      const a = normalizeBlenderFloat([
        f32(previous[0] - point[0]),
        f32(previous[1] - point[1]),
        f32(previous[2] - point[2]),
      ]);
      const b = normalizeBlenderFloat([
        f32(next[0] - point[0]),
        f32(next[1] - point[1]),
        f32(next[2] - point[2]),
      ]);
      const dot = f32(f32(f32(a[0] * b[0]) + f32(a[1] * b[1])) + f32(a[2] * b[2]));
      const angle = safeAcosApproxBlenderFloat(dot);
      return [
        f32(normal[0] * angle),
        f32(normal[1] * angle),
        f32(normal[2] * angle),
      ] as Vec3;
    });
  });

  const incident = mesh.positions.map(() => new Set<number>());
  for (let face = 0; face < mesh.faces.length; face++)
    for (const vertex of mesh.faces[face]) incident[vertex].add(face);

  // A separate disjoint-set per point follows the smooth face fan through
  // every incident non-sharp edge. Boundary edges simply have no second face.
  const parents = incident.map((faces) => new Map([...faces].map((face) => [face, face])));
  const find = (point: number, face: number): number => {
    const parent = parents[point];
    let root = face;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = face;
    while (parent.get(cursor) !== cursor) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (point: number, a: number, b: number): void => {
    const rootA = find(point, a);
    const rootB = find(point, b);
    if (rootA !== rootB) parents[point].set(rootB, rootA);
  };

  const topology = topologyOf(mesh);
  for (let edge = 0; edge < topology.edges.length; edge++) {
    const item = topology.edges[edge];
    if (asNum(sharp?.data[edge] ?? 0) > 0 || item.faces.length < 2) continue;
    if (item.faces.some((face) => asNum(sharpFace?.data[face] ?? 0) > 0)) continue;
    for (const point of item.verts)
      for (let index = 1; index < item.faces.length; index++)
        union(point, item.faces[0], item.faces[index]);
  }

  const sums = mesh.positions.map(() => new Map<number, Vec3>());
  for (let face = 0; face < mesh.faces.length; face++) {
    for (let corner = 0; corner < mesh.faces[face].length; corner++) {
      const point = mesh.faces[face][corner];
      const root = find(point, face);
      const current = sums[point].get(root) ?? [0, 0, 0];
      const contribution = contributions[face][corner];
      sums[point].set(root, [
        f32(current[0] + contribution[0]),
        f32(current[1] + contribution[1]),
        f32(current[2] + contribution[2]),
      ]);
    }
  }

  const result: Vec3[] = [];
  for (let face = 0; face < mesh.faces.length; face++) {
    for (const point of mesh.faces[face]) {
      const normal = normalizeBlenderFloat(sums[point].get(find(point, face)) ?? faceNormals[face]);
      result.push(normal[0] || normal[1] || normal[2] ? normal : faceNormals[face]);
    }
  }
  return result;
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
  // Replace rows instead of reversing in place: face rows may be shared with
  // clones of this mesh (structural-sharing invariant).
  for (const fi of flips) mesh.faces[fi] = [...mesh.faces[fi]].reverse();
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
  // Fresh rows: the existing ones may be shared with clones of this mesh.
  mesh.faces = mesh.faces.map((f) => [...f].reverse());
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
  let points: TriSoup["points"];
  let source = realizedMesh;
  if (marker?.domain === "POINT") {
    const referenced = new Set<number>();
    for (const face of realizedMesh.faces) for (const vertex of face) referenced.add(vertex);
    for (const edge of realizedMesh.edges) { referenced.add(edge[0]); referenced.add(edge[1]); }
    const pointIndices = realizedMesh.positions.flatMap((_, vertex) =>
      !referenced.has(vertex) && asNum(marker.data[vertex] ?? 0) > 0 ? [vertex] : []);
    if (pointIndices.length) {
      const radius = realizedMesh.attributes.get("radius");
      const pointPositions = new Float32Array(pointIndices.length * 3);
      const pointRadii = new Float32Array(pointIndices.length);
      for (let point = 0; point < pointIndices.length; point++) {
        const vertex = pointIndices[point];
        const position = realizedMesh.positions[vertex];
        pointPositions.set(position, point * 3);
        pointRadii[point] = radius?.domain === "POINT"
          ? Math.max(0, asNum(radius.data[vertex] ?? 0.05))
          : 0.05;
      }
      points = {
        positions: pointPositions,
        radii: pointRadii,
        stats: { points: pointIndices.length },
      };
    }
    const retained = realizedMesh.positions.map((_, vertex) => referenced.has(vertex) || asNum(marker.data[vertex] ?? 0) <= 0);
    if (retained.some((value) => !value)) {
      const filtered = new Mesh();
      filtered.materialSlots = [...realizedMesh.materialSlots];
      const remap = new Map<number, number>();
      for (let vertex = 0; vertex < realizedMesh.positions.length; vertex++) if (retained[vertex]) {
        remap.set(vertex, filtered.positions.length);
        filtered.positions.push(realizedMesh.positions[vertex]);
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
    // Rows are shared (never mutated in place) — this mesh only normalizes
    // faceMaterial for the grouping pass below.
    mesh.faces.push(source.faces[fi]);
    mesh.faceMaterial.push(source.faceMaterial[fi] ?? 0);
  }
  // Export the evaluated face loops verbatim. Winding is observable Geometry
  // Nodes data: Blender's Geometry/Backfacing shader output, front-face
  // culling, signed-volume tools, and G-code preparation all depend on it.
  // Generic display-time "repair" used to reverse intentionally inward
  // OpenVDB shells (including Math Clay TPMS variants) and made the browser
  // select the opposite material branch from Blender. Nodes that genuinely
  // repair topology must do so before this serialization boundary.
  // Normals come from `source`: identical positions and face content, and
  // source may already carry a valid vertex-normal cache from its clone
  // lineage.
  const normals = source.vertexNormals();
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
  const perSlotFaces: number[][] = Array.from({ length: slotCount }, () => []);
  const perSlotCorners: number[][] = Array.from({ length: slotCount }, () => []);
  const faceCornerStarts: number[] = [];
  let sourceCorner = 0;
  for (const face of mesh.faces) {
    faceCornerStarts.push(sourceCorner);
    sourceCorner += face.length;
  }
  let triCount = 0;
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const f = mesh.faces[fi];
    const slot = mesh.faceMaterial[fi] ?? 0;
    for (const triangle of triangulateFaceIndices(mesh, f)) {
      perSlot[slot].push(...triangle);
      perSlotFaces[slot].push(fi);
      for (const vertex of triangle) {
        // Degenerate polygons can repeat a vertex index. Blender's material UV
        // meshes in this pack do not, and choosing the first matching loop is
        // the stable fallback for such a degenerate triangle.
        perSlotCorners[slot].push(faceCornerStarts[fi] + Math.max(0, f.indexOf(vertex)));
      }
      triCount++;
    }
  }
  const indices = new Uint32Array(triCount * 3);
  const triangleFaces = new Uint32Array(triCount);
  const triangleCorners = new Uint32Array(triCount * 3);
  const sourceCornerNormals = sharpCornerNormals(source);
  const cornerNormals = sourceCornerNormals ? new Float32Array(triCount * 9) : undefined;
  const groups: TriSoup["groups"] = [];
  let cursor = 0;
  let triangleCursor = 0;
  for (let s = 0; s < slotCount; s++) {
    const tri = perSlot[s];
    if (!tri.length) continue;
    groups.push({ start: cursor, count: tri.length, material: mesh.materialSlots[s] ?? null });
    indices.set(tri, cursor);
    triangleCorners.set(perSlotCorners[s], cursor);
    triangleFaces.set(perSlotFaces[s], triangleCursor);
    if (cornerNormals) {
      for (let corner = 0; corner < perSlotCorners[s].length; corner++) {
        const normal = sourceCornerNormals![perSlotCorners[s][corner]] ?? [0, 0, 1];
        const target = (cursor + corner) * 3;
        cornerNormals[target] = normal[0];
        cornerNormals[target + 1] = normal[1];
        cornerNormals[target + 2] = normal[2];
      }
    }
    cursor += tri.length;
    triangleCursor += perSlotFaces[s].length;
  }
  const attributes: TriSoup["attributes"] = {};
  for (const [name, attribute] of source.attributes) {
    // Curve radius is a built-in evaluation property, not a generic mesh
    // attribute after Blender converts the curve component.
    if (name === "radius") continue;
    if ((name.startsWith("__") && name !== MATERIAL_MATCH_ATTRIBUTE)
      || !["POINT", "FACE", "CORNER"].includes(attribute.domain)) continue;
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
    let domainData: Float32Array | undefined;
    if (attribute.domain === "FACE" || attribute.domain === "CORNER") {
      const domainSize = attribute.domain === "FACE"
        ? source.faces.length
        : source.faces.reduce((count, face) => count + face.length, 0);
      domainData = new Float32Array(domainSize * itemSize);
      for (let element = 0; element < domainSize; element++) {
        const value = attribute.data[element] ?? (itemSize === 3 ? [0, 0, 0] : 0);
        if (itemSize === 3) {
          const vector = asVec3(value);
          domainData[element * 3] = vector[0];
          domainData[element * 3 + 1] = vector[1];
          domainData[element * 3 + 2] = vector[2];
        } else domainData[element] = asNum(value);
      }
    }
    attributes[name] = { itemSize, data, domain: attribute.domain as "POINT" | "FACE" | "CORNER", domainData };
  }
  const linePositions: number[] = [];
  let controlPoints = 0;
  let evaluatedPoints = 0;
  let lineSplines = 0;
  for (const spline of realized.curves) {
    controlPoints += spline.controlPoints?.length ?? spline.points.length;
    evaluatedPoints += spline.points.length;
    if (spline.points.length < 2) continue;
    lineSplines++;
    const segmentCount = spline.points.length - 1 + (spline.cyclic ? 1 : 0);
    for (let segment = 0; segment < segmentCount; segment++) {
      const a = spline.points[segment];
      const b = spline.points[(segment + 1) % spline.points.length];
      linePositions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
  }
  const lines: TriSoup["lines"] = linePositions.length ? {
    positions: new Float32Array(linePositions),
    stats: {
      controlPoints,
      evaluatedPoints,
      segments: linePositions.length / 6,
      splines: lineSplines,
    },
  } : undefined;
  return {
    positions,
    normals: normArr,
    indices,
    cornerNormals,
    triangleFaces,
    triangleCorners,
    attributes,
    groups,
    stats: { verts: mesh.positions.length, faces: mesh.faces.length, tris: triCount },
    lines,
    points,
  };
}
