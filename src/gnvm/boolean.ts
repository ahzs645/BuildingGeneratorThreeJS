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
    union: (a: any, b: any) => any;
    difference: (a: any, b: any) => any;
    intersection: (a: any, b: any) => any;
    hull: (points: readonly Vec3[]) => any;
  };
  Mesh: new (opts: {
    numProp?: number;
    vertProperties: Float32Array;
    triVerts: Uint32Array;
  }) => any;
};

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

/** Fan-triangulate ngons into a Manifold MeshGL (positions only, numProp=3). */
export function meshToManifoldGL(mesh: Mesh): { vertProperties: Float32Array; triVerts: Uint32Array } | null {
  if (!mesh.positions.length || !mesh.faces.length) return null;
  const verts = new Float32Array(mesh.positions.length * 3);
  for (let i = 0; i < mesh.positions.length; i++) {
    const p = mesh.positions[i];
    verts[i * 3] = p[0];
    verts[i * 3 + 1] = p[1];
    verts[i * 3 + 2] = p[2];
  }
  const tris: number[] = [];
  for (const f of mesh.faces) {
    if (f.length < 3) continue;
    // Fan from first corner (matches our toTriSoup convention).
    for (let i = 1; i + 1 < f.length; i++) {
      tris.push(f[0], f[i], f[i + 1]);
    }
  }
  if (!tris.length) return null;
  return { vertProperties: verts, triVerts: new Uint32Array(tris) };
}

export function manifoldGLToMesh(gl: { numProp: number; vertProperties: Float32Array | number[]; triVerts: Uint32Array | number[]; numVert?: number; numTri?: number }): Mesh {
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
  return m;
}

/** Weld near-coincident verts before Manifold — reduces NotManifold from micro gaps. */
function weldMesh(mesh: Mesh, eps = 1e-5): Mesh {
  const cell = eps;
  const key = (p: Vec3) =>
    `${Math.round(p[0] / cell)}_${Math.round(p[1] / cell)}_${Math.round(p[2] / cell)}`;
  const map = new Map<string, number>();
  const out = new Mesh();
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
  }
  return out;
}

function meshToManifold(mesh: Mesh): any | null {
  if (!mod) return null;
  // Try raw mesh first, then a light weld pass for near-manifold shells.
  for (const candidate of [mesh, weldMesh(mesh)]) {
    const gl = meshToManifoldGL(candidate);
    if (!gl) continue;
    try {
      const mgl = new mod.Mesh({ numProp: 3, vertProperties: gl.vertProperties, triVerts: gl.triVerts });
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

export type BooleanOp = "UNION" | "DIFFERENCE" | "INTERSECT";

/**
 * Manifold boolean of two meshes. Returns null if Manifold is unavailable or
 * either input is not a usable solid.
 */
export function manifoldBoolean(a: Mesh, b: Mesh, op: BooleanOp): Mesh | null {
  if (!mod) return null;
  const ma = meshToManifold(a);
  const mb = meshToManifold(b);
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
