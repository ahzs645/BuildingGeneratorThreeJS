// Mesh boolean via Manifold WASM. Falls back to the box-clip path when Manifold
// cannot consume an input (open / non-manifold shells).
//
// Call `await ensureManifold()` once before evaluating graphs that use
// GeometryNodeMeshBoolean (runGenerator does this automatically).

import { Vec3, vadd, vscale } from "./core";
import { Geometry, Mesh, mergeMeshInto } from "./geometry";

type ManifoldMod = {
  setup: () => void;
  Manifold: {
    new (mesh: any): any;
    cube: (size: number | Vec3, center?: boolean) => any;
    union: ((a: any, b: any) => any) & ((manifolds: readonly any[]) => any);
    difference: ((a: any, b: any) => any) & ((manifolds: readonly any[]) => any);
    intersection: ((a: any, b: any) => any) & ((manifolds: readonly any[]) => any);
    hull: (points: readonly Vec3[]) => any;
  };
  Mesh: new (opts: {
    numProp?: number;
    vertProperties: Float32Array;
    triVerts: Uint32Array;
    faceID?: Uint32Array;
  }) => any;
};

interface ManifoldGL {
  numProp: number;
  vertProperties: Float32Array | number[];
  triVerts: Uint32Array | number[];
  faceID?: Uint32Array | number[];
  numVert?: number;
  numTri?: number;
}

export interface ManifoldFaceSource {
  mesh: Mesh;
  firstFaceID: number;
  faceCount: number;
}

export interface ManifoldFaceProvenance {
  faceID: Uint32Array;
  sources: ManifoldFaceSource[];
}

// Boolean provenance is implementation metadata, not a Geometry Nodes
// attribute. Keeping it weakly associated with the raw triangle mesh lets the
// polygon reconstruction stage consume it without leaking it to user geometry.
const manifoldFaceProvenance = new WeakMap<Mesh, ManifoldFaceProvenance>();

export function getManifoldFaceProvenance(mesh: Mesh): ManifoldFaceProvenance | null {
  return manifoldFaceProvenance.get(mesh) ?? null;
}

let mod: ManifoldMod | null = null;
let initPromise: Promise<void> | null = null;

/** Load WASM + setup. Safe to call multiple times. */
export function ensureManifold(): Promise<void> {
  if (mod) return Promise.resolve();
  if (!initPromise) {
    initPromise = (async () => {
      const Module = (await import("manifold-3d/manifold.js")).default as (opts?: object) => Promise<ManifoldMod>;
      const wasm = await Module();
      wasm.setup();
      mod = wasm;
    })();
  }
  return initPromise;
}

export function isManifoldReady(): boolean {
  return mod !== null;
}

/** Fan-triangulate ngons while retaining one source ID per authored polygon. */
export function meshToManifoldGL(
  mesh: Mesh,
  firstFaceID = 0,
  sourceFaces?: readonly number[],
): { vertProperties: Float32Array; triVerts: Uint32Array; faceID: Uint32Array } | null {
  if (!mesh.positions.length || !mesh.faces.length) return null;
  const verts = new Float32Array(mesh.positions.length * 3);
  for (let i = 0; i < mesh.positions.length; i++) {
    const p = mesh.positions[i];
    verts[i * 3] = p[0];
    verts[i * 3 + 1] = p[1];
    verts[i * 3 + 2] = p[2];
  }
  const tris: number[] = [];
  const faceID: number[] = [];
  for (let face = 0; face < mesh.faces.length; face++) {
    const f = mesh.faces[face];
    if (f.length < 3) continue;
    // Fan from first corner (matches our toTriSoup convention).
    for (let i = 1; i + 1 < f.length; i++) {
      tris.push(f[0], f[i], f[i + 1]);
      faceID.push(firstFaceID + (sourceFaces?.[face] ?? face));
    }
  }
  if (!tris.length) return null;
  return { vertProperties: verts, triVerts: new Uint32Array(tris), faceID: new Uint32Array(faceID) };
}

export function manifoldGLToMesh(gl: ManifoldGL, sources: ManifoldFaceSource[] = []): Mesh {
  const numProp = gl.numProp || 3;
  const vp = gl.vertProperties;
  const tv = gl.triVerts;
  const nVert = gl.numVert ?? vp.length / numProp;
  const nTri = gl.numTri ?? tv.length / 3;
  const m = new Mesh();
  m.materialSlots = [null];
  for (let i = 0; i < nVert; i++) {
    const o = i * numProp;
    m.positions.push([vp[o], vp[o + 1], vp[o + 2]]);
  }
  for (let t = 0; t < nTri; t++) {
    const o = t * 3;
    m.faces.push([tv[o], tv[o + 1], tv[o + 2]]);
    m.faceMaterial.push(0);
  }
  if (sources.length && gl.faceID?.length === nTri) {
    manifoldFaceProvenance.set(m, {
      faceID: Uint32Array.from(gl.faceID),
      sources: sources.map((source) => ({ ...source })),
    });
  }
  return m;
}

/** Weld near-coincident verts before Manifold — reduces NotManifold from micro gaps. */
function weldMesh(mesh: Mesh, eps = 1e-5): { mesh: Mesh; sourceFaces: number[] } {
  const cell = eps;
  const key = (p: Vec3) =>
    `${Math.round(p[0] / cell)}_${Math.round(p[1] / cell)}_${Math.round(p[2] / cell)}`;
  const map = new Map<string, number>();
  const out = new Mesh();
  const sourceFaces: number[] = [];
  out.materialSlots = [...mesh.materialSlots];
  const remap: number[] = new Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i++) {
    const p = mesh.positions[i];
    const k = key(p);
    let j = map.get(k);
    if (j === undefined) {
      j = out.positions.length;
      out.positions.push([p[0], p[1], p[2]]);
      map.set(k, j);
    }
    remap[i] = j;
  }
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const f = mesh.faces[fi].map((v) => remap[v]);
    // drop degenerate / collapsed faces
    const uniq = [...new Set(f)];
    if (uniq.length < 3) continue;
    out.faces.push(f);
    out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0);
    sourceFaces.push(fi);
  }
  return { mesh: out, sourceFaces };
}

function meshToManifold(mesh: Mesh, firstFaceID = 0): any | null {
  if (!mod) return null;
  // Try raw mesh first, then a light weld pass for near-manifold shells.
  const welded = weldMesh(mesh);
  for (const candidate of [
    { mesh, sourceFaces: undefined },
    welded,
  ]) {
    const gl = meshToManifoldGL(candidate.mesh, firstFaceID, candidate.sourceFaces);
    if (!gl) continue;
    try {
      const mgl = new mod.Mesh({
        numProp: 3,
        vertProperties: gl.vertProperties,
        triVerts: gl.triVerts,
        faceID: gl.faceID,
      });
      const man = new mod.Manifold(mgl);
      if (typeof man.status === "function" && man.status() !== "NoError") {
        man.delete?.();
        continue;
      }
      if (typeof man.isEmpty === "function" && man.isEmpty()) {
        man.delete?.();
        continue;
      }
      return man;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function boxToManifold(box: { min: Vec3; max: Vec3 }): any | null {
  if (!mod) return null;
  const size: Vec3 = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  if (size[0] <= 0 || size[1] <= 0 || size[2] <= 0) return null;
  const center: Vec3 = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
  try {
    const cube = mod.Manifold.cube(size, true).translate(center);
    return cube;
  } catch {
    return null;
  }
}

/**
 * Manifold still emits a freshly triangulated mesh when a DIFFERENCE operand
 * does not touch the source solid. Preserve the authored polygon topology when
 * the CSG result has exactly the same solid measures instead.
 */
function isMeasurePreservingDifference(source: any, result: any): boolean {
  if (typeof source.volume !== "function" || typeof result.volume !== "function"
    || typeof source.surfaceArea !== "function" || typeof result.surfaceArea !== "function") return false;
  const same = (a: number, b: number) => Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));
  return same(source.volume(), result.volume()) && same(source.surfaceArea(), result.surfaceArea());
}

export type BooleanOp = "UNION" | "DIFFERENCE" | "INTERSECT";

/**
 * Manifold boolean of two meshes. Returns null if Manifold is unavailable or
 * either input is not a usable solid.
 */
export function manifoldBoolean(a: Mesh, b: Mesh, op: BooleanOp): Mesh | null {
  if (!mod) return null;
  if (a.faces.length + b.faces.length >= 0xffffffff) return null;
  const sources: ManifoldFaceSource[] = [
    { mesh: a, firstFaceID: 0, faceCount: a.faces.length },
    { mesh: b, firstFaceID: a.faces.length, faceCount: b.faces.length },
  ];
  const ma = meshToManifold(a, sources[0].firstFaceID);
  const mb = meshToManifold(b, sources[1].firstFaceID);
  if (!ma || !mb) {
    ma?.delete?.();
    mb?.delete?.();
    return null;
  }
  try {
    let result: any;
    if (op === "UNION") result = mod.Manifold.union(ma, mb);
    else if (op === "INTERSECT") result = mod.Manifold.intersection(ma, mb);
    else result = mod.Manifold.difference(ma, mb);
    if (typeof result.isEmpty === "function" && result.isEmpty()) {
      result.delete?.();
      ma.delete?.();
      mb.delete?.();
      return null;
    }
    if (op === "DIFFERENCE" && isMeasurePreservingDifference(ma, result)) {
      result.delete?.();
      ma.delete?.();
      mb.delete?.();
      return a.clone();
    }
    const outMesh = manifoldGLToMesh(result.getMesh(), sources);
    result.delete?.();
    ma.delete?.();
    mb.delete?.();
    return outMesh.faces.length ? outMesh : null;
  } catch {
    ma.delete?.();
    mb.delete?.();
    return null;
  }
}

/**
 * Evaluate a closed multi-input Boolean in one Manifold operation. Rebuilding
 * polygons between pairwise folds changes the next input triangulation and can
 * amplify coincident-cutter seams into invalid geometry.
 */
export function manifoldBooleanMany(a: Mesh, operands: Mesh[], op: BooleanOp): Mesh | null {
  if (!mod || !operands.length) return null;
  let nextFaceID = 0;
  const sources: ManifoldFaceSource[] = [a, ...operands].map((mesh) => {
    const source = { mesh, firstFaceID: nextFaceID, faceCount: mesh.faces.length };
    nextFaceID += mesh.faces.length;
    return source;
  });
  // 0xffffffff is reserved by several mesh formats as an invalid/sentinel ID.
  if (nextFaceID >= 0xffffffff) return null;
  const solids = sources.map((source) => meshToManifold(source.mesh, source.firstFaceID));
  if (solids.some((solid) => !solid)) {
    for (const solid of solids) solid?.delete?.();
    return null;
  }
  let result: any | null = null;
  try {
    const valid = solids as any[];
    result = op === "UNION"
      ? mod.Manifold.union(valid)
      : op === "INTERSECT"
        ? mod.Manifold.intersection(valid)
        : mod.Manifold.difference(valid);
    if ((typeof result.status === "function" && result.status() !== "NoError")
      || (typeof result.isEmpty === "function" && result.isEmpty())) return null;
    if (op === "DIFFERENCE" && isMeasurePreservingDifference(valid[0], result)) {
      return a.clone();
    }
    const outMesh = manifoldGLToMesh(result.getMesh(), sources);
    return outMesh.faces.length ? outMesh : null;
  } catch {
    return null;
  } finally {
    result?.delete?.();
    for (const solid of solids) solid?.delete?.();
  }
}

/** True only when the mesh's current polygon fan triangulation is a valid solid. */
export function isManifoldMesh(mesh: Mesh): boolean {
  if (!mod) return false;
  const gl = meshToManifoldGL(mesh);
  if (!gl) return false;
  let solid: any | null = null;
  try {
    const mgl = new mod.Mesh({ numProp: 3, vertProperties: gl.vertProperties, triVerts: gl.triVerts });
    solid = new mod.Manifold(mgl);
    return (typeof solid.status !== "function" || solid.status() === "NoError")
      && (typeof solid.isEmpty !== "function" || !solid.isEmpty());
  } catch {
    return false;
  } finally {
    solid?.delete?.();
  }
}

/** Boolean mesh A against an axis-aligned box solid via Manifold. */
export function manifoldBooleanBox(a: Mesh, box: { min: Vec3; max: Vec3 }, op: BooleanOp): Mesh | null {
  if (!mod) return null;
  const ma = meshToManifold(a);
  const mb = boxToManifold(box);
  if (!ma || !mb) {
    ma?.delete?.();
    mb?.delete?.();
    return null;
  }
  try {
    let result: any;
    if (op === "UNION") result = mod.Manifold.union(ma, mb);
    else if (op === "INTERSECT") result = mod.Manifold.intersection(ma, mb);
    else result = mod.Manifold.difference(ma, mb);
    if (typeof result.isEmpty === "function" && result.isEmpty()) {
      result.delete?.();
      ma.delete?.();
      mb.delete?.();
      return null;
    }
    if (op === "DIFFERENCE" && isMeasurePreservingDifference(ma, result)) {
      result.delete?.();
      ma.delete?.();
      mb.delete?.();
      return a.clone();
    }
    const outMesh = manifoldGLToMesh(result.getMesh());
    result.delete?.();
    ma.delete?.();
    mb.delete?.();
    return outMesh.faces.length ? outMesh : null;
  } catch {
    ma.delete?.();
    mb.delete?.();
    return null;
  }
}

/** Convex hull of an arbitrary point set through the already-loaded WASM. */
export function manifoldHull(points: Vec3[]): Mesh | null {
  if (!mod || points.length < 4) return null;
  try {
    const result = mod.Manifold.hull(points);
    if (typeof result.isEmpty === "function" && result.isEmpty()) {
      result.delete?.();
      return null;
    }
    const mesh = manifoldGLToMesh(result.getMesh());
    result.delete?.();
    return mesh.faces.length ? mesh : null;
  } catch {
    return null;
  }
}

export function joinedMeshes(parts: Geometry[]): Geometry {
  const out = new Geometry();
  const mesh = new Mesh();
  mesh.materialSlots = [null];
  for (const g of parts) {
    if (g.mesh) mergeMeshInto(mesh, g.mesh);
    for (const s of g.curves) out.curves.push({ cyclic: s.cyclic, points: s.points.map((p) => [...p] as Vec3) });
    for (const inst of g.instances) out.instances.push(inst);
  }
  if (mesh.positions.length) out.mesh = mesh;
  return out;
}

// re-export helpers used by box fallback diagnostics
export { vadd, vscale };
