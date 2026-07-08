// Mesh-topology operations: the nodes that turn flat panels into real 3-D bins.
// Faithful-enough Blender semantics (region + individual extrude, domain-aware
// delete/separate, weld, flip).
import { Field, Vec3, Elem, asVec3, asNum, vadd, vscale, vnorm } from "../core";
import { Geometry, Mesh, buildTopology } from "../geometry";
import { reg } from "../registry";
import { makeFieldCtx } from "../evaluator";

const ekey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);

function avgElem(vals: Elem[]): Elem {
  if (!vals.length) return 0;
  if (Array.isArray(vals[0])) {
    const acc: Vec3 = [0, 0, 0];
    for (const v of vals) { const u = asVec3(v); acc[0] += u[0]; acc[1] += u[1]; acc[2] += u[2]; }
    return [acc[0] / vals.length, acc[1] / vals.length, acc[2] / vals.length];
  }
  let s = 0;
  for (const v of vals) s += asNum(v);
  return s / vals.length;
}

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
  // Blender's float->bool conversion is `> 0` (e.g. Map Range feeding a Selection
  // uses -0.02 as its false sentinel; plain truthiness would treat it as selected).
  const on = (v: Elem | undefined) => asNum(v ?? 0) > 0;
  if (domain === "FACE") {
    const ctx = makeFieldCtx(g, "FACE");
    const sel = api.field("Selection").array(ctx);
    g.mesh = keepFaces(g.mesh, (fi) => !on(sel[fi]));
  } else if (domain === "EDGE") {
    // drop selected edges, plus faces using them (selection resolved per-edge)
    const ctx = makeFieldCtx(g, "EDGE");
    const sel = api.field("Selection").array(ctx);
    const edges = buildTopology(g.mesh).edges;
    const dead = new Set<string>();
    for (let ei = 0; ei < edges.length; ei++) if (on(sel[ei])) dead.add(ekey(edges[ei].verts[0], edges[ei].verts[1]));
    const faceDead = (f: number[]) => {
      for (let i = 0; i < f.length; i++) if (dead.has(ekey(f[i], f[(i + 1) % f.length]))) return true;
      return false;
    };
    const m = g.mesh;
    m.edges = m.edges.filter(([a, b]) => !dead.has(ekey(a, b)));
    g.mesh = keepFaces(m, (fi) => !faceDead(m.faces[fi]));
  } else {
    // POINT/CURVE: drop points where selected, plus faces using them.
    const ctx = makeFieldCtx(g, "POINT");
    const sel = api.field("Selection").array(ctx);
    const dead = new Set<number>();
    for (let i = 0; i < g.mesh.positions.length; i++) if (on(sel[i])) dead.add(i);
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
  const mesh = g.mesh;
  const mode = api.str("Mode").toUpperCase().replace(/[^A-Z]/g, "");
  if (mode === "CONNECTED") {
    // TODO: Connected mode should limit candidates to connected vertices; fall through to All for now.
  }
  const hasDistance = api.node.inputs.some((s) => s.identifier === "Distance" || s.name === "Distance");
  const rawDist = hasDistance ? api.num("Distance") : 0.001;
  const dist = Number.isFinite(rawDist) ? Math.max(0, rawDist) : 0.001;
  const distSq = dist * dist;
  const cellSize = dist || 1e-12;
  const cellCoord = (p: Vec3): [number, number, number] => [
    Math.floor(p[0] / cellSize),
    Math.floor(p[1] / cellSize),
    Math.floor(p[2] / cellSize),
  ];
  const cellKey = (x: number, y: number, z: number) => `${x}_${y}_${z}`;
  const selectedCtx = makeFieldCtx(g, "POINT");
  const selected = api.field("Selection").array(selectedCtx);
  const reps = new Map<string, number[]>();
  const remap: number[] = [];
  const srcVert: number[] = [];
  const pos: Vec3[] = [];
  for (let i = 0; i < mesh.positions.length; i++) {
    const p = mesh.positions[i];
    let found = -1;
    if (asNum(selected[i] ?? 1)) {
      const [cx, cy, cz] = cellCoord(p);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const bucket = reps.get(cellKey(cx + dx, cy + dy, cz + dz));
        if (!bucket) continue;
        for (const ri of bucket) {
          const q = pos[ri];
          const d2 = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
          if (d2 <= distSq && (found < 0 || ri < found)) found = ri;
        }
      }
      if (found >= 0) {
        remap[i] = found;
        continue;
      }
      const ni = pos.length;
      remap[i] = ni;
      srcVert[ni] = i;
      pos.push([...p] as Vec3);
      const bucketKey = cellKey(cx, cy, cz);
      const bucket = reps.get(bucketKey);
      if (bucket) bucket.push(ni);
      else reps.set(bucketKey, [ni]);
    } else {
      const ni = pos.length;
      remap[i] = ni;
      srcVert[ni] = i;
      pos.push([...p] as Vec3);
    }
  }
  const m = new Mesh();
  m.positions = pos;
  m.materialSlots = [...mesh.materialSlots];
  const seenEdges = new Set<string>();
  for (const [a, b] of mesh.edges) {
    const ra = remap[a], rb = remap[b];
    if (ra === rb) continue;
    const k = ekey(ra, rb);
    if (seenEdges.has(k)) continue;
    seenEdges.add(k);
    m.edges.push([ra, rb]);
  }
  const keptFace: number[] = [];
  const cornerStart: number[] = [];
  let cornerCursor = 0;
  for (const f of mesh.faces) { cornerStart.push(cornerCursor); cornerCursor += f.length; }
  const keptCorners: number[][] = [];
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const nf: number[] = [];
    const nc: number[] = [];
    const f = mesh.faces[fi];
    for (let ci = 0; ci < f.length; ci++) {
      const r = remap[f[ci]];
      if (!nf.length || nf[nf.length - 1] !== r) {
        nf.push(r);
        nc.push(cornerStart[fi] + ci);
      }
    }
    if (nf.length >= 2 && nf[0] === nf[nf.length - 1]) {
      nf.pop();
      nc.pop();
    }
    if (new Set(nf).size >= 3) {
      m.faces.push(nf);
      m.faceMaterial.push(mesh.faceMaterial[fi] ?? 0);
      keptFace.push(fi);
      keptCorners.push(nc);
    }
  }
  for (const [name, a] of mesh.attributes) {
    if (a.domain === "POINT") m.attributes.set(name, { domain: "POINT", data: srcVert.map((vi) => a.data[vi]) });
    else if (a.domain === "FACE") m.attributes.set(name, { domain: "FACE", data: keptFace.map((fi) => a.data[fi]) });
    else if (a.domain === "CORNER") {
      const data: Elem[] = [];
      for (const corners of keptCorners) for (const ci of corners) data.push(a.data[ci]);
      m.attributes.set(name, { domain: "CORNER", data });
    }
  }
  g.mesh = m;
  return { Geometry: g };
});

// ---- Extrude Mesh ---------------------------------------------------------
// Top/Side are FACE-domain booleans in Blender. Returning raw face-index fields
// breaks every cross-domain consumer (Set Position selections, Switch factors),
// so we stamp them as hidden FACE attributes and read them through the ctx's
// domain interpolation (FACE->POINT = any adjacent face, like Blender).
let extrudeSeq = 0;
function faceMaskField(name: string): Field {
  return Field.perElem((i, ctx) => (asNum((ctx.attr?.(name, i) ?? 0) as Elem) > 0 ? 1 : 0));
}
reg("GeometryNodeExtrudeMesh", (api) => {
  const g = api.geo("Mesh").clone();
  if (!g.mesh) return { Mesh: g, Top: Field.of(0), Side: Field.of(0) };
  const mode = api.prop<string>("mode", "FACES");
  const scale = api.num("Offset Scale");
  const offsetLinked = api.node.inputs.find((s) => s.identifier === "Offset")?.linked ?? false;
  const individual = api.bool("Individual");
  const mesh = g.mesh;

  if (mode === "EDGES") {
    // Edge extrude: duplicate the selected edges' vertices (shared within the
    // selection, like Blender), offset them (vertex normals when Offset is
    // unlinked), and stitch a side quad per edge. Top = the duplicated edges
    // (EDGE mask), Side = the new quads (FACE mask). The bin's tray walls come
    // from extruding the filled floor n-gons' boundary loops this way.
    const ectx = makeFieldCtx(g, "EDGE");
    const selE = api.field("Selection").array(ectx);
    const inEdges = buildTopology(mesh).edges;
    const selEdges: number[] = [];
    for (let ei = 0; ei < inEdges.length; ei++) if (asNum(selE[ei] ?? 1)) selEdges.push(ei);
    if (!selEdges.length) return { Mesh: g, Top: Field.of(0), Side: Field.of(0) };
    const pctx = makeFieldCtx(g, "POINT");
    const offArr = offsetLinked ? api.field("Offset").array(pctx) : null;
    const vnorms = mesh.vertexNormals();
    const out = mesh.clone();
    const srcVert: number[] = mesh.positions.map((_, i) => i);
    const dup = new Map<number, number>();
    const dupOf = (v: number): number => {
      let nv = dup.get(v);
      if (nv === undefined) {
        nv = out.positions.length;
        const delta = offArr ? vscale(asVec3(offArr[v] ?? [0, 0, 0]), scale) : vscale(vnorms[v] ?? [0, 0, 1], scale);
        out.positions.push(vadd(mesh.positions[v], delta));
        srcVert.push(v);
        dup.set(v, nv);
      }
      return nv;
    };
    // Orient each side quad by the adjacent face's traversal direction (like
    // Blender) — canonical sorted order gives inconsistent winding, which
    // half-cancels the smoothed vertex normals downstream.
    const orient = new Map<string, [number, number]>();
    for (const f of mesh.faces)
      for (let k = 0; k < f.length; k++) {
        const u = f[k], v = f[(k + 1) % f.length];
        const key = ekey(u, v);
        if (!orient.has(key)) orient.set(key, [u, v]);
      }
    const sideFaceIdx: number[] = [];
    const newEdgePairs: [number, number][] = []; // duplicated (top) edges
    for (const ei of selEdges) {
      const [ca, cb] = inEdges[ei].verts;
      const [a, b] = orient.get(ekey(ca, cb)) ?? [ca, cb];
      const na = dupOf(a), nb = dupOf(b);
      sideFaceIdx.push(out.faces.length);
      out.faces.push([a, b, nb, na]);
      out.faceMaterial.push(inEdges[ei].faces.length ? out.faceMaterial[inEdges[ei].faces[0]] ?? 0 : 0);
      newEdgePairs.push([na, nb]);
    }
    // carry POINT attributes onto the duplicated verts
    for (const [name, a] of mesh.attributes) {
      if (a.domain === "POINT") out.attributes.set(name, { domain: "POINT", data: out.positions.map((_, i) => a.data[srcVert[i]]) });
      else if (a.domain === "FACE") {
        const data = [...a.data];
        for (const ei of selEdges) data.push(inEdges[ei].faces.length ? a.data[inEdges[ei].faces[0]] : 0);
        out.attributes.set(name, { domain: "FACE", data });
      } else if (a.domain === "EDGE") {
        // output canonical edges: original mesh edges keep their order (faces
        // unchanged), then each new quad appends its vertical + top edges
        const outEdges = buildTopology(out).edges;
        const inIdx = new Map<string, number>();
        inEdges.forEach((e, i) => inIdx.set(ekey(e.verts[0], e.verts[1]), i));
        const data = outEdges.map((e) => {
          const sa = srcVert[e.verts[0]], sb = srcVert[e.verts[1]];
          if (sa === sb) return 0;
          const si = inIdx.get(ekey(sa, sb));
          return si !== undefined ? a.data[si] : 0;
        });
        out.attributes.set(name, { domain: "EDGE", data });
      }
    }
    g.mesh = out;
    const topPairs = new Set(newEdgePairs.map(([x, y]) => ekey(x, y)));
    const outEdges = buildTopology(out).edges;
    const topName = `__extrude_top_${extrudeSeq}`;
    const sideName = `__extrude_side_${extrudeSeq}`;
    extrudeSeq++;
    out.attributes.set(topName, { domain: "EDGE", data: outEdges.map((e) => (topPairs.has(ekey(e.verts[0], e.verts[1])) ? 1 : 0)) });
    const sideSet = new Set(sideFaceIdx);
    out.attributes.set(sideName, { domain: "FACE", data: out.faces.map((_, i) => (sideSet.has(i) ? 1 : 0)) });
    return {
      Mesh: g,
      Top: Field.perElem((i, ctx) => (asNum((ctx.attr?.(topName, i) ?? 0) as Elem) > 0 ? 1 : 0)),
      Side: faceMaskField(sideName),
    };
  }
  if (mode !== "FACES") {
    // VERTICES extrude: not needed for the bin; leave geometry unchanged.
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
  // Attribute provenance: source vertex per out-vertex, source face per out-face.
  // Lets Captured/Stored attributes survive the extrude — the inset-floor trick
  // captures the face center as a FACE attribute, then reads it back on the
  // extruded top faces to pull each corner inward. Dropping it collapsed the cells.
  const srcVert: number[] = mesh.positions.map((_, i) => i);
  const srcFace: number[] = [];
  // keep unselected faces
  for (let fi = 0; fi < mesh.faces.length; fi++) if (!selMask[fi]) { out.faces.push([...mesh.faces[fi]]); out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0); srcFace.push(fi); }
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
        srcVert.push(v);
        return idx;
      });
      // side walls on every edge (individual)
      for (let i = 0; i < f.length; i++) {
        const a = i, b = (i + 1) % f.length;
        out.faces.push([f[a], f[b], nv[b], nv[a]]);
        out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0);
        srcFace.push(fi);
      }
      topFaceIdx.push(out.faces.length);
      out.faces.push(nv);
      out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0);
      srcFace.push(fi);
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
      srcVert.push(v);
      newIdx.set(v, idx);
    }
    for (const fi of selFaces) {
      const f = mesh.faces[fi];
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        if (edgeCount.get(ekey(a, b))!.n === 1) {
          out.faces.push([a, b, newIdx.get(b)!, newIdx.get(a)!]);
          out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0);
          srcFace.push(fi);
        }
      }
      topFaceIdx.push(out.faces.length);
      out.faces.push(f.map((v) => newIdx.get(v)!));
      out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0);
      srcFace.push(fi);
    }
  }

  // Carry POINT/FACE/CORNER attributes through the extrude via the provenance
  // maps. CORNER values follow each output corner's source vertex when it lies
  // on the source face (exact for tops/kept faces), else the face average —
  // dropping them zeroed the solidify offset in "thiccen walls".
  const faceCornerAvg = (a: { data: Elem[] }, cornerStart: number[], fi: number): Elem => {
    const f = mesh.faces[fi];
    const vals: Elem[] = [];
    for (let k = 0; k < f.length; k++) vals.push(a.data[cornerStart[fi] + k]);
    return avgElem(vals);
  };
  for (const [name, a] of mesh.attributes) {
    if (a.domain === "POINT") out.attributes.set(name, { domain: "POINT", data: out.positions.map((_, i) => a.data[srcVert[i]]) });
    else if (a.domain === "FACE") out.attributes.set(name, { domain: "FACE", data: srcFace.map((fi) => a.data[fi]) });
    else if (a.domain === "CORNER") {
      const cornerStart: number[] = [];
      let acc = 0;
      for (const f of mesh.faces) { cornerStart.push(acc); acc += f.length; }
      const data: Elem[] = [];
      for (let fo = 0; fo < out.faces.length; fo++) {
        const fs = srcFace[fo];
        const srcF = mesh.faces[fs];
        for (const v of out.faces[fo]) {
          const sv = srcVert[v];
          const slot = srcF.indexOf(sv);
          data.push(slot >= 0 ? a.data[cornerStart[fs] + slot] : faceCornerAvg(a, cornerStart, fs));
        }
      }
      out.attributes.set(name, { domain: "CORNER", data });
    }
  }
  // EDGE attributes: an output edge inherits the input edge between its corners'
  // source vertices (Blender's duplicate-element propagation); edges with no
  // source (e.g. the vertical side edges) default to 0. Data is aligned to
  // buildTopology's canonical edge enumeration on both sides.
  const edgeAttrs = [...mesh.attributes].filter(([, a]) => a.domain === "EDGE");
  if (edgeAttrs.length) {
    const inEdges = buildTopology(mesh).edges;
    const inIdx = new Map<string, number>();
    inEdges.forEach((e, i) => inIdx.set(ekey(e.verts[0], e.verts[1]), i));
    const outEdges = buildTopology(out).edges;
    const srcEdge = outEdges.map((e) => {
      const a = srcVert[e.verts[0]], b = srcVert[e.verts[1]];
      if (a === b) return -1; // vertical edge between an original vert and its copy
      return inIdx.get(ekey(a, b)) ?? -1;
    });
    for (const [name, a] of edgeAttrs)
      out.attributes.set(name, { domain: "EDGE", data: srcEdge.map((i) => (i >= 0 ? a.data[i] : 0)) });
  }
  g.mesh = out;
  const topSet = new Set(topFaceIdx);
  const keptCount = mesh.faces.length - selFaces.length; // unselected faces come first
  const topName = `__extrude_top_${extrudeSeq}`;
  const sideName = `__extrude_side_${extrudeSeq}`;
  extrudeSeq++;
  out.attributes.set(topName, { domain: "FACE", data: out.faces.map((_, i) => (topSet.has(i) ? 1 : 0)) });
  out.attributes.set(sideName, { domain: "FACE", data: out.faces.map((_, i) => (i >= keptCount && !topSet.has(i) ? 1 : 0)) });
  return {
    Mesh: g,
    Top: faceMaskField(topName),
    Side: faceMaskField(sideName),
  };
});

// ---- Split Edges ----------------------------------------------------------
// Split all selected edges. The bin subdivision uses Selection=all, which fully
// unwelds every face (each face gets its own copy of its vertices).
reg("GeometryNodeSplitEdges", (api) => {
  const g = api.geo("Mesh").clone();
  if (!g.mesh) return { Mesh: g };
  const m = g.mesh;
  const ctx = makeFieldCtx(g, "EDGE");
  const selArr = api.field("Selection").array(ctx);
  const allSelected = selArr.length === 0 || selArr.every((s) => asNum(s ?? 1));
  if (!allSelected) return { Mesh: g }; // partial edge splits: leave as-is (rare)
  const nm = new Mesh();
  nm.materialSlots = [...m.materialSlots];
  // carry POINT attributes by duplicating the source vertex's value
  const pointAttrNames = [...m.attributes].filter(([, a]) => a.domain === "POINT").map(([k]) => k);
  const newPointAttrs = new Map<string, Elem[]>();
  for (const name of pointAttrNames) newPointAttrs.set(name, []);
  for (let fi = 0; fi < m.faces.length; fi++) {
    const f = m.faces[fi];
    const base = nm.positions.length;
    for (const vi of f) {
      nm.positions.push([...m.positions[vi]] as Vec3);
      for (const name of pointAttrNames) newPointAttrs.get(name)!.push(m.attributes.get(name)!.data[vi]);
    }
    nm.faces.push(f.map((_, k) => base + k));
    nm.faceMaterial.push(m.faceMaterial[fi] ?? 0);
  }
  for (const [name, data] of newPointAttrs) nm.attributes.set(name, { domain: "POINT", data });
  // carry FACE attributes unchanged (same face count/order)
  for (const [name, a] of m.attributes) if (a.domain === "FACE") nm.attributes.set(name, { domain: "FACE", data: [...a.data] });
  g.mesh = nm;
  return { Mesh: g };
});

reg("GeometryNodeSubdivideMesh", (api) => {
  const g = api.geo("Mesh").clone();
  // Cap is a runaway guard; the bin's print-layer slicer legitimately uses 4.
  const level = Math.max(0, Math.min(5, Math.round(api.num("Level"))));
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
