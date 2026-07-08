// Mesh-topology operations: the nodes that turn flat panels into real 3-D bins.
// Faithful-enough Blender semantics (region + individual extrude, domain-aware
// delete/separate, weld, flip).
import { Field, Vec3, Elem, asVec3, asNum, vadd, vscale, vnorm } from "../core";
import { Geometry, Mesh } from "../geometry";
import { reg } from "../registry";
import { makeFieldCtx } from "../evaluator";

const ekey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);

// Drop vertices not referenced by any face/edge and remap indices.
function compact(mesh: Mesh): Mesh {
  const used = new Set<number>();
  for (const f of mesh.faces) for (const v of f) used.add(v);
  for (const e of mesh.edges) { used.add(e[0]); used.add(e[1]); }
  if (used.size === mesh.positions.length) return mesh;
  const remap = new Map<number, number>();
  const pos: Vec3[] = [];
  for (let i = 0; i < mesh.positions.length; i++) {
    if (used.has(i)) { remap.set(i, pos.length); pos.push(mesh.positions[i]); }
  }
  const out = new Mesh();
  out.positions = pos;
  out.faces = mesh.faces.map((f) => f.map((v) => remap.get(v)!));
  out.faceMaterial = [...mesh.faceMaterial];
  out.edges = mesh.edges.map((e) => [remap.get(e[0])!, remap.get(e[1])!] as [number, number]);
  out.materialSlots = [...mesh.materialSlots];
  // remap POINT attributes
  for (const [k, a] of mesh.attributes) {
    if (a.domain === "POINT") {
      const data: Elem[] = [];
      for (let i = 0; i < mesh.positions.length; i++) if (used.has(i)) data.push(a.data[i]);
      out.attributes.set(k, { domain: "POINT", data });
    } else out.attributes.set(k, { domain: a.domain, data: [...a.data] });
  }
  return out;
}

// Keep only faces where keep[fi] is true; optionally compact points.
function keepFaces(mesh: Mesh, keep: (fi: number) => boolean, doCompact = true): Mesh {
  const out = mesh.clone();
  const faces: number[][] = [];
  const fmat: number[] = [];
  const faceAttrs = new Map<string, Elem[]>();
  for (const [k, a] of mesh.attributes) if (a.domain === "FACE") faceAttrs.set(k, []);
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    if (!keep(fi)) continue;
    faces.push(mesh.faces[fi]);
    fmat.push(mesh.faceMaterial[fi] ?? 0);
    for (const [k, a] of mesh.attributes) if (a.domain === "FACE") faceAttrs.get(k)!.push(a.data[fi]);
  }
  out.faces = faces;
  out.faceMaterial = fmat;
  for (const [k, data] of faceAttrs) out.attributes.set(k, { domain: "FACE", data });
  return doCompact ? compact(out) : out;
}

// ---- Delete Geometry ------------------------------------------------------
reg("GeometryNodeDeleteGeometry", (api) => {
  const g = api.geo("Geometry").clone();
  if (!g.mesh) return { Geometry: g };
  const domain = api.prop<string>("domain", "POINT");
  if (domain === "FACE") {
    const ctx = makeFieldCtx(g, "FACE");
    const sel = api.field("Selection").array(ctx);
    g.mesh = keepFaces(g.mesh, (fi) => !asNum(sel[fi] ?? 0));
  } else {
    // POINT/EDGE/CURVE: drop points where selected, plus faces using them.
    const ctx = makeFieldCtx(g, "POINT");
    const sel = api.field("Selection").array(ctx);
    const dead = new Set<number>();
    for (let i = 0; i < g.mesh.positions.length; i++) if (asNum(sel[i] ?? 0)) dead.add(i);
    g.mesh = keepFaces(g.mesh, (fi) => !g.mesh!.faces[fi].some((v) => dead.has(v)));
  }
  return { Geometry: g };
});

// ---- Separate Geometry ----------------------------------------------------
reg("GeometryNodeSeparateGeometry", (api) => {
  const g = api.geo("Geometry");
  if (!g.mesh) return { Selection: new Geometry(), Inverted: new Geometry() };
  const domain = api.prop<string>("domain", "POINT");
  const sel = api.field("Selection");
  const selG = new Geometry();
  const invG = new Geometry();
  if (domain === "FACE") {
    const ctx = makeFieldCtx(g, "FACE");
    const s = sel.array(ctx);
    selG.mesh = keepFaces(g.mesh, (fi) => !!asNum(s[fi] ?? 0));
    invG.mesh = keepFaces(g.mesh, (fi) => !asNum(s[fi] ?? 0));
  } else {
    const ctx = makeFieldCtx(g, "POINT");
    const s = ctx.size ? sel.array(ctx) : [];
    const keepSel = new Set<number>();
    for (let i = 0; i < g.mesh.positions.length; i++) if (asNum(s[i] ?? 0)) keepSel.add(i);
    selG.mesh = keepFaces(g.mesh, (fi) => g.mesh!.faces[fi].every((v) => keepSel.has(v)));
    invG.mesh = keepFaces(g.mesh, (fi) => g.mesh!.faces[fi].some((v) => !keepSel.has(v)));
  }
  return { Selection: selG, Inverted: invG };
});

// ---- Flip Faces -----------------------------------------------------------
reg("GeometryNodeFlipFaces", (api) => {
  const g = api.geo("Mesh").clone();
  if (g.mesh) {
    const ctx = makeFieldCtx(g, "FACE");
    const sel = api.field("Selection").array(ctx);
    for (let fi = 0; fi < g.mesh.faces.length; fi++) if (asNum(sel[fi] ?? 1)) g.mesh.faces[fi].reverse();
  }
  return { Mesh: g };
});

// ---- Merge by Distance ----------------------------------------------------
reg("GeometryNodeMergeByDistance", (api) => {
  const g = api.geo("Geometry").clone();
  if (!g.mesh) return { Geometry: g };
  const dist = Math.max(1e-6, api.num("Distance") || 0.001);
  const inv = 1 / dist;
  const cell = (p: Vec3) => `${Math.round(p[0] * inv)}_${Math.round(p[1] * inv)}_${Math.round(p[2] * inv)}`;
  const rep = new Map<string, number>();
  const remap: number[] = [];
  const pos: Vec3[] = [];
  for (let i = 0; i < g.mesh.positions.length; i++) {
    const k = cell(g.mesh.positions[i]);
    if (rep.has(k)) remap[i] = rep.get(k)!;
    else { const ni = pos.length; rep.set(k, ni); remap[i] = ni; pos.push(g.mesh.positions[i]); }
  }
  const m = new Mesh();
  m.positions = pos;
  m.materialSlots = [...g.mesh.materialSlots];
  for (let fi = 0; fi < g.mesh.faces.length; fi++) {
    // remap + drop consecutive dupes
    const nf: number[] = [];
    for (const v of g.mesh.faces[fi]) { const r = remap[v]; if (!nf.length || nf[nf.length - 1] !== r) nf.push(r); }
    if (nf.length >= 2 && nf[0] === nf[nf.length - 1]) nf.pop();
    if (nf.length >= 3) { m.faces.push(nf); m.faceMaterial.push(g.mesh.faceMaterial[fi] ?? 0); }
  }
  g.mesh = m;
  return { Geometry: g };
});

// ---- Extrude Mesh ---------------------------------------------------------
reg("GeometryNodeExtrudeMesh", (api) => {
  const g = api.geo("Mesh").clone();
  if (!g.mesh) return { Mesh: g, Top: Field.of(0), Side: Field.of(0) };
  const mode = api.prop<string>("mode", "FACES");
  const scale = api.num("Offset Scale");
  const offsetLinked = api.node.inputs.find((s) => s.identifier === "Offset")?.linked ?? false;
  const individual = api.bool("Individual");
  const mesh = g.mesh;

  if (mode !== "FACES") {
    // VERTICES/EDGES extrude: not needed for the bin; leave geometry unchanged.
    return { Mesh: g, Top: Field.of(0), Side: Field.of(0) };
  }

  const fctx = makeFieldCtx(g, "FACE");
  const selArr = api.field("Selection").array(fctx);
  const selMask = mesh.faces.map((_, fi) => !!asNum(selArr[fi] ?? 1));
  const pctx = makeFieldCtx(g, "POINT");
  const offArr = offsetLinked ? api.field("Offset").array(pctx) : null;

  const selFaces: number[] = [];
  for (let fi = 0; fi < mesh.faces.length; fi++) if (selMask[fi]) selFaces.push(fi);
  if (!selFaces.length) return { Mesh: g, Top: Field.of(0), Side: Field.of(0) };

  const out = new Mesh();
  out.positions = mesh.positions.map((p) => [...p] as Vec3);
  out.materialSlots = [...mesh.materialSlots];
  // keep unselected faces
  for (let fi = 0; fi < mesh.faces.length; fi++) if (!selMask[fi]) { out.faces.push([...mesh.faces[fi]]); out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0); }
  const topFaceIdx: number[] = [];

  const deltaFor = (v: number, avgNormal: Vec3): Vec3 =>
    offArr ? vscale(asVec3(offArr[v] ?? [0, 0, 0]), scale) : vscale(vnorm(avgNormal), scale);

  if (individual) {
    for (const fi of selFaces) {
      const f = mesh.faces[fi];
      const n = mesh.faceNormal(fi);
      const nv = f.map((v) => {
        const idx = out.positions.length;
        out.positions.push(vadd(mesh.positions[v], deltaFor(v, n)));
        return idx;
      });
      // side walls on every edge (individual)
      for (let i = 0; i < f.length; i++) {
        const a = i, b = (i + 1) % f.length;
        out.faces.push([f[a], f[b], nv[b], nv[a]]);
        out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0);
      }
      topFaceIdx.push(out.faces.length);
      out.faces.push(nv);
      out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0);
    }
  } else {
    // Region extrude: shared new verts, walls only on boundary edges.
    const vertSet = new Set<number>();
    const normAcc = new Map<number, Vec3>();
    const edgeCount = new Map<string, { a: number; b: number; n: number }>();
    for (const fi of selFaces) {
      const f = mesh.faces[fi];
      const n = mesh.faceNormal(fi);
      for (let i = 0; i < f.length; i++) {
        const v = f[i];
        vertSet.add(v);
        normAcc.set(v, vadd(normAcc.get(v) ?? [0, 0, 0], n));
        const a = f[i], b = f[(i + 1) % f.length];
        const k = ekey(a, b);
        const e = edgeCount.get(k) ?? { a, b, n: 0 };
        e.n++;
        edgeCount.set(k, e);
      }
    }
    const newIdx = new Map<number, number>();
    for (const v of vertSet) {
      const idx = out.positions.length;
      out.positions.push(vadd(mesh.positions[v], deltaFor(v, normAcc.get(v)!)));
      newIdx.set(v, idx);
    }
    for (const fi of selFaces) {
      const f = mesh.faces[fi];
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        if (edgeCount.get(ekey(a, b))!.n === 1) {
          out.faces.push([a, b, newIdx.get(b)!, newIdx.get(a)!]);
          out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0);
        }
      }
      topFaceIdx.push(out.faces.length);
      out.faces.push(f.map((v) => newIdx.get(v)!));
      out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0);
    }
  }

  g.mesh = out;
  const topSet = new Set(topFaceIdx);
  return {
    Mesh: g,
    Top: Field.perElem((i) => (topSet.has(i) ? 1 : 0)),
    Side: Field.perElem((i) => (i < out.faces.length && !topSet.has(i) ? 1 : 0)),
  };
});

// ---- Split Edges / Subdivide (light) --------------------------------------
reg("GeometryNodeSplitEdges", (api) => ({ Mesh: api.geo("Mesh") }));

reg("GeometryNodeSubdivideMesh", (api) => {
  const g = api.geo("Mesh").clone();
  const level = Math.max(0, Math.min(3, Math.round(api.num("Level"))));
  if (!g.mesh || level === 0) return { Mesh: g };
  // one level: split every quad/tri into a center-fan of quads (Catmull-like topology, linear positions)
  let mesh = g.mesh;
  for (let l = 0; l < level; l++) mesh = subdivideOnce(mesh);
  g.mesh = mesh;
  return { Mesh: g };
});

function subdivideOnce(mesh: Mesh): Mesh {
  const out = new Mesh();
  out.positions = mesh.positions.map((p) => [...p] as Vec3);
  out.materialSlots = [...mesh.materialSlots];
  const edgePoint = new Map<string, number>();
  const getEdge = (a: number, b: number) => {
    const k = ekey(a, b);
    let idx = edgePoint.get(k);
    if (idx === undefined) { idx = out.positions.length; out.positions.push(vscale(vadd(mesh.positions[a], mesh.positions[b]), 0.5)); edgePoint.set(k, idx); }
    return idx;
  };
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const f = mesh.faces[fi];
    const c = out.positions.length;
    out.positions.push(mesh.faceCenter(fi));
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length], prev = f[(i - 1 + f.length) % f.length];
      out.faces.push([a, getEdge(a, b), c, getEdge(prev, a)]);
      out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0);
    }
  }
  return out;
}

// ---- Mesh -> Points / Separate Components ---------------------------------
reg("GeometryNodeMeshToPoints", (api) => {
  const g = api.geo("Mesh");
  const out = new Geometry();
  if (g.mesh) { const m = new Mesh(); m.positions = g.mesh.positions.map((p) => [...p] as Vec3); out.mesh = m; }
  return { Points: out };
});

reg("GeometryNodeSeparateComponents", (api) => {
  const g = api.geo("Geometry");
  const meshOnly = new Geometry();
  if (g.mesh) meshOnly.mesh = g.mesh;
  const inst = new Geometry();
  inst.instances = g.instances;
  return { Mesh: meshOnly, "Point Cloud": new Geometry(), Curve: new Geometry(), Instances: inst, Volume: new Geometry() };
});
