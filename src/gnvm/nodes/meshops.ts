// Mesh-topology operations: the nodes that turn flat panels into real 3-D bins.
// Faithful-enough Blender semantics (region + individual extrude, domain-aware
// delete/separate, weld, flip).
import { Field, Vec3, Elem, Domain, asVec3, asNum, vadd, vscale, vnorm } from "../core";
import { Geometry, Mesh, buildTopology, invalidateMeshCaches } from "../geometry";
import { reg, type EvalAPI } from "../registry";
import { FIELD_PROBE, makeFieldCtx } from "../evaluator";

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
  if (mesh.faces.length) {
    // FACE-domain deletion/separation removes topology that belongs only to
    // discarded faces. Leaving the grid's original explicit edge list intact
    // kept thousands of otherwise orphaned vertices alive in compact().
    const liveEdges = new Set<string>();
    for (const face of faces)
      for (let i = 0; i < face.length; i++) liveEdges.add(ekey(face[i], face[(i + 1) % face.length]));
    out.edges = out.edges.filter(([a, b]) => liveEdges.has(ekey(a, b)));
  }
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
    // POINT/CURVE: drop selected points, plus faces AND loose edges using them.
    // Loose edges must be filtered too — otherwise compact() keeps the dead
    // verts alive through them (the clickme wire kept all 1,728 pts this way).
    const ctx = makeFieldCtx(g, "POINT");
    const sel = api.field("Selection").array(ctx);
    const dead = new Set<number>();
    for (let i = 0; i < g.mesh.positions.length; i++) if (on(sel[i])) dead.add(i);
    const m = g.mesh;
    m.edges = m.edges.filter(([a, b]) => !dead.has(a) && !dead.has(b));
    if (!m.faces.length && !m.edges.length) {
      // pure point cloud: filter positions directly (compact() keeps only
      // face/edge-referenced verts and would delete everything).
      const keep: number[] = [];
      for (let i = 0; i < m.positions.length; i++) if (!dead.has(i)) keep.push(i);
      const nm = new Mesh();
      nm.materialSlots = [...m.materialSlots];
      nm.positions = keep.map((i) => [...m.positions[i]] as Vec3);
      for (const [k, a] of m.attributes)
        if (a.domain === "POINT") nm.attributes.set(k, { domain: "POINT", data: keep.map((i) => a.data[i]) });
      g.mesh = nm;
    } else {
      g.mesh = keepFaces(m, (fi) => !m.faces[fi].some((v) => dead.has(v)));
    }
  }
  return { Geometry: g };
});

// ---- Separate Geometry ----------------------------------------------------
// Keep exactly the selected points (isolated survivors included — Blender keeps
// them), remapping edges (both endpoints must survive), faces (all verts must
// survive), and POINT/FACE attributes.
function keepPointsMesh(mesh: Mesh, keep: (vi: number) => boolean): Mesh {
  const remap = new Map<number, number>();
  const out = new Mesh();
  out.materialSlots = [...mesh.materialSlots];
  for (let i = 0; i < mesh.positions.length; i++)
    if (keep(i)) { remap.set(i, out.positions.length); out.positions.push([...mesh.positions[i]] as Vec3); }
  out.edges = mesh.edges
    .filter(([a, b]) => remap.has(a) && remap.has(b))
    .map(([a, b]) => [remap.get(a)!, remap.get(b)!] as [number, number]);
  const keptFace: number[] = [];
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const f = mesh.faces[fi];
    if (!f.every((v) => remap.has(v))) continue;
    out.faces.push(f.map((v) => remap.get(v)!));
    out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0);
    keptFace.push(fi);
  }
  for (const [name, a] of mesh.attributes) {
    if (a.domain === "POINT") {
      const data: Elem[] = [];
      for (let i = 0; i < mesh.positions.length; i++) if (remap.has(i)) data.push(a.data[i]);
      out.attributes.set(name, { domain: "POINT", data });
    } else if (a.domain === "FACE") {
      out.attributes.set(name, { domain: "FACE", data: keptFace.map((fi) => a.data[fi]) });
    }
  }
  return out;
}

function keepEdgesMesh(mesh: Mesh, keep: (ei: number) => boolean): Mesh {
  const topology = buildTopology(mesh);
  const keptEdges = topology.edges.filter((_, i) => keep(i)).map((edge) => edge.verts);
  const keptKeys = new Set(keptEdges.map(([a, b]) => ekey(a, b)));
  const vertices = new Set<number>();
  for (const [a, b] of keptEdges) { vertices.add(a); vertices.add(b); }
  const remap = new Map<number, number>();
  const out = new Mesh();
  out.materialSlots = [...mesh.materialSlots];
  for (let i = 0; i < mesh.positions.length; i++) if (vertices.has(i)) {
    remap.set(i, out.positions.length);
    out.positions.push([...mesh.positions[i]] as Vec3);
  }
  out.edges = keptEdges.map(([a, b]) => [remap.get(a)!, remap.get(b)!]);
  const keptFaces: number[] = [];
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    const face = mesh.faces[fi];
    const allEdgesKept = face.every((v, i) => keptKeys.has(ekey(v, face[(i + 1) % face.length])));
    if (!allEdgesKept) continue;
    out.faces.push(face.map((vi) => remap.get(vi)!));
    out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0);
    keptFaces.push(fi);
  }
  for (const [name, attr] of mesh.attributes) {
    if (attr.domain === "POINT") out.attributes.set(name, { domain: "POINT", data: [...vertices].sort((a, b) => a - b).map((i) => attr.data[i]) });
    else if (attr.domain === "FACE") out.attributes.set(name, { domain: "FACE", data: keptFaces.map((i) => attr.data[i]) });
  }
  return out;
}

reg("GeometryNodeSeparateGeometry", (api) => {
  const g = api.geo("Geometry");
  const hasMeshComponent = Boolean(g.mesh && (g.mesh.positions.length || g.mesh.edges.length || g.mesh.faces.length));
  const domain = api.prop<string>("domain", "POINT");
  const sel = api.field("Selection");
  const selG = new Geometry();
  const invG = new Geometry();
  if (domain === "INSTANCE" && g.instances.length) {
    const ctx = makeFieldCtx(g, "INSTANCE");
    const values = sel.array(ctx);
    g.instances.forEach((instance, i) => {
      const target = asNum(values[i] ?? 0) > 0 ? selG : invG;
      target.instances.push({
        ...instance,
        position: [...instance.position] as Vec3,
        rotation: [...instance.rotation] as Vec3,
        scale: [...instance.scale] as Vec3,
      });
    });
    return { Selection: selG, Inverted: invG };
  }
  if (!hasMeshComponent && g.curves.length) {
    if (domain === "CURVE") {
      const ctx = makeFieldCtx(g, "CURVE");
      const values = sel.array(ctx);
      if (FIELD_PROBE.node === api.node.name && FIELD_PROBE.socket === "Selection") FIELD_PROBE.batches.push({
        domain: "CURVE", positions: g.curves.map((spline) => spline.points[0] ?? [0, 0, 0]), values,
      });
      g.curves.forEach((spline, i) => {
        const target = asNum(values[i] ?? 0) > 0 ? selG : invG;
        target.curves.push({ cyclic: spline.cyclic, points: spline.points.map((p) => [...p] as Vec3) });
      });
    } else {
      const ctx = makeFieldCtx(g, "POINT");
      const values = sel.array(ctx);
      if (FIELD_PROBE.node === api.node.name && FIELD_PROBE.socket === "Selection") FIELD_PROBE.batches.push({
        domain: "POINT", positions: g.curves.flatMap((spline) => spline.points), values,
      });
      let offset = 0;
      for (const spline of g.curves) {
        const selected: Vec3[] = [], inverted: Vec3[] = [];
        for (let i = 0; i < spline.points.length; i++) {
          const target = asNum(values[offset + i] ?? 0) > 0 ? selected : inverted;
          target.push([...spline.points[i]] as Vec3);
        }
        if (selected.length) selG.curves.push({ cyclic: spline.cyclic && selected.length === spline.points.length, points: selected });
        if (inverted.length) invG.curves.push({ cyclic: spline.cyclic && inverted.length === spline.points.length, points: inverted });
        offset += spline.points.length;
      }
    }
    return { Selection: selG, Inverted: invG };
  }
  if (!hasMeshComponent || !g.mesh) return { Selection: selG, Inverted: invG };
  if (domain === "FACE") {
    const ctx = makeFieldCtx(g, "FACE");
    const s = sel.array(ctx);
    if (FIELD_PROBE.node === api.node.name && FIELD_PROBE.socket === "Selection") FIELD_PROBE.batches.push({
      domain: "FACE",
      positions: Array.from({ length: ctx.size }, (_, i) => ctx.position?.(i) ?? [0, 0, 0]),
      values: s,
    });
    // Blender's numeric-to-boolean socket conversion is positive/non-positive,
    // not JavaScript truthiness: negative float masks are false.
    const on = (fi: number) => asNum(s[fi] ?? 0) > 0;
    selG.mesh = keepFaces(g.mesh, on);
    invG.mesh = keepFaces(g.mesh, (fi) => !on(fi));
  } else if (domain === "EDGE") {
    const ctx = makeFieldCtx(g, "EDGE");
    const s = sel.array(ctx);
    const on = (i: number) => asNum(s[i] ?? 0) > 0;
    selG.mesh = keepEdgesMesh(g.mesh, on);
    invG.mesh = keepEdgesMesh(g.mesh, (i) => !on(i));
  } else {
    // POINT: true point-level split — keepFaces() couldn't filter edge-only
    // wires or isolated verts (the bubble target selects alternating wire pts).
    const ctx = makeFieldCtx(g, "POINT");
    const s = ctx.size ? sel.array(ctx) : [];
    const on = (i: number) => asNum(s[i] ?? 0) > 0;
    selG.mesh = keepPointsMesh(g.mesh, on);
    invG.mesh = keepPointsMesh(g.mesh, (i) => !on(i));
  }
  return { Selection: selG, Inverted: invG };
});

// ---- Flip Faces -----------------------------------------------------------
reg("GeometryNodeFlipFaces", (api) => {
  const g = api.geo("Mesh").clone();
  if (g.mesh) {
    const ctx = makeFieldCtx(g, "FACE");
    const sel = api.field("Selection").array(ctx);
    let flipped = false;
    for (let fi = 0; fi < g.mesh.faces.length; fi++) {
      if (!asNum(sel[fi] ?? 1)) continue;
      g.mesh.faces[fi].reverse();
      flipped = true;
    }
    if (flipped) invalidateMeshCaches(g.mesh);
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
  if (FIELD_PROBE.node === api.node.name) {
    FIELD_PROBE.batches.push({
      domain: "POINT",
      positions: Array.from({ length: selectedCtx.size }, (_, i) => selectedCtx.position?.(i) ?? [0, 0, 0]),
      values: selected,
    });
  }
  // Blender mesh coordinates are float32 at node boundaries. Preserve that
  // precision for threshold comparisons; double-precision fillet coordinates
  // can differ by ~1e-8 and choose the opposite side of an exact 0.001 weld.
  const weldPositions: Vec3[] = mesh.positions.map((p) => [Math.fround(p[0]), Math.fround(p[1]), Math.fround(p[2])]);
  // Blender uses non-transitive representative clusters (a chain of points
  // less than Distance apart must not collapse into one vertex), then places
  // each result at its cluster average.
  const reps = new Map<string, number[]>();
  const remap: number[] = [];
  const srcVert: number[] = [];
  const seeds: Vec3[] = [];
  const sums: Vec3[] = [];
  const counts: number[] = [];
  for (let i = 0; i < mesh.positions.length; i++) {
    const p = weldPositions[i];
    let found = -1;
    if (asNum(selected[i] ?? 1) > 0) {
      const [cx, cy, cz] = cellCoord(p);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const bucket = reps.get(cellKey(cx + dx, cy + dy, cz + dz));
        if (!bucket) continue;
        for (const ri of bucket) {
          const q = seeds[ri];
          const d2 = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
          if (d2 <= distSq && (found < 0 || ri < found)) found = ri;
        }
      }
      if (found >= 0) {
        remap[i] = found;
        sums[found] = vadd(sums[found], p);
        counts[found]++;
        continue;
      }
      const ni = seeds.length;
      remap[i] = ni;
      srcVert[ni] = i;
      seeds.push([...p] as Vec3);
      sums.push([...p] as Vec3);
      counts.push(1);
      const key = cellKey(cx, cy, cz);
      const bucket = reps.get(key);
      if (bucket) bucket.push(ni);
      else reps.set(key, [ni]);
    } else {
      const ni = seeds.length;
      remap[i] = ni;
      srcVert[ni] = i;
      seeds.push([...p] as Vec3);
      sums.push([...p] as Vec3);
      counts.push(1);
    }
  }
  const pos = sums.map((sum, i) => {
    const averaged = vscale(sum, 1 / counts[i]);
    return [Math.fround(averaged[0]), Math.fround(averaged[1]), Math.fround(averaged[2])] as Vec3;
  });
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
    const faceVerts = new Set<number>();
    const f = mesh.faces[fi];
    for (let ci = 0; ci < f.length; ci++) {
      const r = remap[f[ci]];
      // Mesh welding removes repeated corners even when the duplicates are not
      // adjacent in the original polygon. Keeping [a,b,a,c] as a four-corner
      // face inflated the bin's material tessellation; Blender emits [a,b,c].
      if (faceVerts.has(r)) continue;
      faceVerts.add(r);
      nf.push(r);
      nc.push(cornerStart[fi] + ci);
    }
    if (nf.length >= 3) {
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
  return Field.perElem((i, ctx) => (asNum((ctx.attr?.(name, i) ?? 0) as Elem) > 0 ? 1 : 0)).tagged("FACE");
}
// A new extrude makes earlier extrudes' Top/Side masks stale; carrying them
// forward made repeat-zone lathes accumulate hundreds of attributes (every
// clone copied them all — superlinear). Blender's anonymous attributes are
// dropped when unreferenced; consumers of a mask always read it before the
// next extrude in every graph we run.
const isStaleExtrudeMask = (name: string) => name.startsWith("__extrude_top_") || name.startsWith("__extrude_side_");
function extrudeMesh(api: EvalAPI): Record<string, Geometry | Field> {
  const g = api.geo("Mesh").clone();
  if (g.instances.length) {
    g.instances = g.instances.map((instance) => {
      const nestedApi: EvalAPI = {
        ...api,
        geo: (name) => name === "Mesh" ? instance.geometry : api.geo(name),
      };
      const nested = extrudeMesh(nestedApi).Mesh;
      return {
        ...instance,
        geometry: nested instanceof Geometry ? nested : instance.geometry.clone(),
      };
    });
  }
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
    // Loose wires have no face loop to orient from. Blender's generated side
    // loop traverses the source edge opposite its stored Curve-to-Mesh order;
    // using the canonical sorted edge direction made the first Spin sector
    // arbitrary.
    for (const [a, b] of mesh.edges) {
      const key = ekey(a, b);
      if (!orient.has(key)) orient.set(key, [b, a]);
    }
    const inheritedTop = new Array(inEdges.length).fill(false);
    for (const [name, a] of mesh.attributes) {
      if (a.domain !== "EDGE" || !name.startsWith("__extrude_top_")) continue;
      for (let ei = 0; ei < inEdges.length; ei++)
        if (asNum(a.data[ei] ?? 0) > 0) inheritedTop[ei] = true;
    }
    const vertexEdgeCount = new Array(mesh.positions.length).fill(0);
    for (const e of inEdges) for (const v of e.verts) vertexEdgeCount[v]++;
    const sideFaceIdx: number[] = [];
    const newEdgePairs: [number, number][] = []; // duplicated (top) edges
    for (const ei of selEdges) {
      const [ca, cb] = inEdges[ei].verts;
      let [a, b] = orient.get(ekey(ca, cb)) ?? [ca, cb];
      // Spin repeatedly extrudes the previous pass's Top edges. On interior
      // profile edges, the adjacent face traverses that top edge opposite the
      // original profile direction, so reverse it again before constructing
      // the next quad. Otherwise every angular sector alternates winding and
      // an odd-step weld leaves a one-sector normal discontinuity. Preserve
      // the open profile's endpoint strips: their valence stays one on the
      // source wire and two on later rings, and Blender uses boundary-loop
      // winding there for the top rim and collapsed axial fan.
      const profileBoundary = inheritedTop[ei]
        ? vertexEdgeCount[ca] <= 2 || vertexEdgeCount[cb] <= 2
        : inEdges[ei].faces.length === 0 && (vertexEdgeCount[ca] <= 1 || vertexEdgeCount[cb] <= 1);
      if (inheritedTop[ei]) {
        if (!profileBoundary && inEdges[ei].faces.length === 1) [a, b] = [b, a];
      } else if (inEdges[ei].faces.length > 0) {
        // Blender traverses an already face-bound edge opposite the adjacent
        // face when building the new side quad. This is observable on an open
        // filled floor: extruding its perimeter upward gives inward-facing
        // wall normals. The bin's thickness group intentionally relies on that
        // normal field to inset its duplicate shell.
        [a, b] = [b, a];
      } else if (profileBoundary) [a, b] = [b, a];
      const na = dupOf(a), nb = dupOf(b);
      sideFaceIdx.push(out.faces.length);
      out.faces.push([a, b, nb, na]);
      out.faceMaterial.push(inEdges[ei].faces.length ? out.faceMaterial[inEdges[ei].faces[0]] ?? 0 : 0);
      newEdgePairs.push([na, nb]);
    }
    // carry POINT attributes onto the duplicated verts
    for (const [name, a] of mesh.attributes) {
      if (isStaleExtrudeMask(name)) { out.attributes.delete(name); continue; }
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
      Top: Field.perElem((i, ctx) => (asNum((ctx.attr?.(topName, i) ?? 0) as Elem) > 0 ? 1 : 0)).tagged("EDGE"),
      Side: faceMaskField(sideName),
    };
  }
  if (mode === "VERTICES") {
    // Vertex extrude: duplicate each selected vert offset by the Offset field
    // (Blender uses vertex normals when unlinked — zero for wires) and connect
    // with a new edge. The bubble vase's profile grows its floor segment here.
    const pctx0 = makeFieldCtx(g, "POINT");
    const selArr = api.field("Selection").array(pctx0);
    const offArr = offsetLinked ? api.field("Offset").array(pctx0) : null;
    const vnorms = mesh.faces.length ? mesh.vertexNormals() : null;
    const out = mesh.clone();
    const srcVert: number[] = mesh.positions.map((_, i) => i);
    const newVerts: number[] = [];
    for (let v = 0; v < mesh.positions.length; v++) {
      if (!(asNum(selArr[v] ?? 1) > 0)) continue;
      const delta = offArr
        ? vscale(asVec3(offArr[v] ?? [0, 0, 0]), scale)
        : vnorms
          ? vscale(vnorms[v], scale)
          : ([0, 0, 0] as Vec3);
      const nv = out.positions.length;
      out.positions.push(vadd(mesh.positions[v], delta));
      srcVert.push(v);
      out.edges.push([v, nv]);
      newVerts.push(nv);
    }
    for (const [name, a] of mesh.attributes) {
      if (isStaleExtrudeMask(name)) { out.attributes.delete(name); continue; }
      if (a.domain === "POINT") out.attributes.set(name, { domain: "POINT", data: out.positions.map((_, i) => a.data[srcVert[i]]) });
    }
    g.mesh = out;
    const topName = `__extrude_top_${extrudeSeq}`;
    extrudeSeq++;
    const newSet = new Set(newVerts);
    out.attributes.set(topName, { domain: "POINT", data: out.positions.map((_, i) => (newSet.has(i) ? 1 : 0)) });
    return {
      Mesh: g,
      Top: Field.perElem((i, ctx) => (asNum((ctx.attr?.(topName, i) ?? 0) as Elem) > 0 ? 1 : 0)).tagged("POINT"),
      Side: Field.of(0),
    };
  }
  if (mode !== "FACES") {
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
    // A region extrude duplicates only its boundary vertices. Vertices wholly
    // inside the selected region are reused and moved in place. Duplicating the
    // whole region happens to leave the face count unchanged, but it changes
    // vertex-normal interpolation and prevents later Merge by Distance nodes
    // from reproducing Blender's topology (the Dojo bin doubled 896 interior
    // vertices here and its wall-thickness field consequently pointed outward).
    const boundaryVerts = new Set<number>();
    for (const e of edgeCount.values()) {
      if (e.n !== 1) continue;
      boundaryVerts.add(e.a);
      boundaryVerts.add(e.b);
    }
    const newIdx = new Map<number, number>();
    for (const v of vertSet) {
      const moved = vadd(mesh.positions[v], deltaFor(v, normAcc.get(v)!));
      if (boundaryVerts.has(v)) {
        const idx = out.positions.length;
        out.positions.push(moved);
        srcVert.push(v);
        newIdx.set(v, idx);
      } else {
        out.positions[v] = moved;
        newIdx.set(v, v);
      }
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
    if (isStaleExtrudeMask(name)) { out.attributes.delete(name); continue; }
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
}
reg("GeometryNodeExtrudeMesh", extrudeMesh);

// ---- Split Edges ----------------------------------------------------------
// Split all selected edges. The bin subdivision uses Selection=all, which fully
// unwelds every face (each face gets its own copy of its vertices).
reg("GeometryNodeSplitEdges", (api) => {
  const g = api.geo("Mesh").clone();
  if (!g.mesh) return { Mesh: g };
  const m = g.mesh;
  const ctx = makeFieldCtx(g, "EDGE");
  const selArr = api.field("Selection").array(ctx);
  if (FIELD_PROBE.node === api.node.name) FIELD_PROBE.batches.push({
    domain: "EDGE",
    positions: Array.from({ length: ctx.size }, (_, i) => ctx.position?.(i) ?? [0, 0, 0]),
    values: FIELD_PROBE.socket === "Face Count"
      ? Array.from({ length: ctx.size }, (_, i) => ctx.edgeFaceCount?.(i) ?? 0)
      : selArr,
  });
  const allSelected = selArr.length === 0 || selArr.every((s) => asNum(s ?? 1));
  if (!allSelected) {
    const topology = buildTopology(m);
    const split = new Mesh();
    split.materialSlots = [...m.materialSlots];
    const splitPointAttributes = [...m.attributes].filter(([, attribute]) => attribute.domain === "POINT");
    const splitPointData = new Map(splitPointAttributes.map(([name]) => [name, [] as Elem[]]));
    const incidentCorners = m.positions.map(() => [] as { face: number; corner: number }[]);
    for (let face = 0; face < m.faces.length; face++) for (let corner = 0; corner < m.faces[face].length; corner++) incidentCorners[m.faces[face][corner]].push({ face, corner });
    const cornerVertex = new Map<string, number>();
    for (let vertex = 0; vertex < m.positions.length; vertex++) {
      const corners = incidentCorners[vertex];
      if (!corners.length) continue;
      const parent = corners.map((_, index) => index);
      const find = (index: number): number => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
      const unite = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
      const cornerByFace = new Map(corners.map((corner, index) => [corner.face, index]));
      for (let edgeIndex = 0; edgeIndex < topology.edges.length; edgeIndex++) {
        const edge = topology.edges[edgeIndex];
        if (edge.verts[0] !== vertex && edge.verts[1] !== vertex) continue;
        if (asNum(selArr[edgeIndex] ?? 0) > 0) continue;
        const connected = edge.faces.map((face) => cornerByFace.get(face)).filter((index): index is number => index !== undefined);
        for (let i = 1; i < connected.length; i++) unite(connected[0], connected[i]);
      }
      const copies = new Map<number, number>();
      for (let index = 0; index < corners.length; index++) {
        const root = find(index);
        let outputVertex = copies.get(root);
        if (outputVertex === undefined) {
          outputVertex = split.positions.length;
          copies.set(root, outputVertex);
          split.positions.push([...m.positions[vertex]] as Vec3);
          for (const [name, attribute] of splitPointAttributes) splitPointData.get(name)!.push(attribute.data[vertex] ?? 0);
        }
        cornerVertex.set(`${corners[index].face}:${corners[index].corner}`, outputVertex);
      }
    }
    split.faces = m.faces.map((face, faceIndex) => face.map((_vertex, corner) => cornerVertex.get(`${faceIndex}:${corner}`)!));
    split.faceMaterial = [...m.faceMaterial];
    for (const [name, data] of splitPointData) split.attributes.set(name, { domain: "POINT", data });
    for (const [name, attribute] of m.attributes) if (attribute.domain === "FACE" || attribute.domain === "CORNER") split.attributes.set(name, { domain: attribute.domain, data: [...attribute.data] });
    g.mesh = split;
    return { Mesh: g };
  }
  const nm = new Mesh();
  nm.materialSlots = [...m.materialSlots];
  // carry POINT attributes by duplicating the source vertex's value
  const pointAttrNames = [...m.attributes].filter(([, a]) => a.domain === "POINT").map(([k]) => k);
  const newPointAttrs = new Map<string, Elem[]>();
  for (const name of pointAttrNames) newPointAttrs.set(name, []);
  const faceCopies: Map<number, number>[] = [];
  for (let fi = 0; fi < m.faces.length; fi++) {
    const f = m.faces[fi];
    const base = nm.positions.length;
    const copies = new Map<number, number>();
    for (const vi of f) {
      nm.positions.push([...m.positions[vi]] as Vec3);
      copies.set(vi, base + copies.size);
      for (const name of pointAttrNames) newPointAttrs.get(name)!.push(m.attributes.get(name)!.data[vi]);
    }
    faceCopies.push(copies);
    nm.faces.push(f.map((_, k) => base + k));
    nm.faceMaterial.push(m.faceMaterial[fi] ?? 0);
  }
  if (m.edges.length) {
    for (const [a, b] of m.edges)
      for (const copies of faceCopies) {
        const na = copies.get(a), nb = copies.get(b);
        if (na !== undefined && nb !== undefined) nm.edges.push([na, nb]);
      }
  } else {
    for (const f of nm.faces) for (let k = 0; k < f.length; k++) nm.edges.push([f[k], f[(k + 1) % f.length]]);
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
  for (let l = 0; l < level; l++) mesh = subdivideOnce(mesh, false);
  g.mesh = mesh;
  return { Mesh: g };
});

// Catmull–Clark subdivision surface (smooth positions). Level capped for safety.
reg("GeometryNodeSubdivisionSurface", (api) => {
  const g = api.geo("Mesh").clone();
  const level = Math.max(0, Math.min(4, Math.round(api.num("Level"))));
  if (!g.mesh || level === 0) return { Mesh: g };
  const edgeCrease = Math.max(0, Math.min(1, api.num("Edge Crease")));
  const edgeSharpness = edgeCrease * edgeCrease * 10;
  let mesh = g.mesh;
  for (let l = 0; l < level; l++) mesh = subdivideOnce(mesh, true, Math.max(0, Math.min(1, edgeSharpness - l)));
  g.mesh = mesh;
  return { Mesh: g };
});

function subdivideOnce(mesh: Mesh, catmullClark: boolean, edgeCrease = 0): Mesh {
  const out = new Mesh();
  out.materialSlots = [...mesh.materialSlots];
  const nV = mesh.positions.length;
  const nF = mesh.faces.length;

  // Unique edges from faces
  const edgeMap = new Map<string, { a: number; b: number; faces: number[] }>();
  for (let fi = 0; fi < nF; fi++) {
    const f = mesh.faces[fi];
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      const k = ekey(a, b);
      let e = edgeMap.get(k);
      if (!e) { e = { a, b, faces: [] }; edgeMap.set(k, e); }
      e.faces.push(fi);
    }
  }
  const edges = [...edgeMap.values()];

  // Face points
  const facePts: Vec3[] = mesh.faces.map((_, fi) => mesh.faceCenter(fi));

  // Edge points
  const edgePts: Vec3[] = edges.map((e) => {
    const midpoint = vscale(vadd(mesh.positions[e.a], mesh.positions[e.b]), 0.5);
    if (!catmullClark || e.faces.length < 2) {
      return midpoint;
    }
    // avg of endpoints + adjacent face points
    const fa = facePts[e.faces[0]], fb = facePts[e.faces[1]];
    const smooth = vscale(
      [mesh.positions[e.a][0] + mesh.positions[e.b][0] + fa[0] + fb[0],
       mesh.positions[e.a][1] + mesh.positions[e.b][1] + fa[1] + fb[1],
       mesh.positions[e.a][2] + mesh.positions[e.b][2] + fa[2] + fb[2]],
      0.25,
    );
    return vadd(vscale(smooth, 1 - edgeCrease), vscale(midpoint, edgeCrease));
  });
  const edgeIdx = new Map<string, number>();
  edges.forEach((e, i) => edgeIdx.set(ekey(e.a, e.b), i));

  // Vertex points
  const vertFaces: number[][] = Array.from({ length: nV }, () => []);
  const vertEdges: number[][] = Array.from({ length: nV }, () => []);
  for (let fi = 0; fi < nF; fi++) for (const v of mesh.faces[fi]) vertFaces[v].push(fi);
  for (let ei = 0; ei < edges.length; ei++) {
    vertEdges[edges[ei].a].push(ei);
    vertEdges[edges[ei].b].push(ei);
  }
  const newVerts: Vec3[] = mesh.positions.map((p, vi) => {
    if (!catmullClark) return [...p] as Vec3;
    const n = vertFaces[vi].length;
    if (n === 0) return [...p] as Vec3;
    // boundary: average of incident boundary edge midpoints + original
    const isBoundary = vertEdges[vi].some((ei) => edges[ei].faces.length < 2);
    if (isBoundary) {
      let acc: Vec3 = [0, 0, 0];
      let c = 0;
      for (const ei of vertEdges[vi]) {
        if (edges[ei].faces.length < 2) {
          acc = vadd(acc, vscale(vadd(mesh.positions[edges[ei].a], mesh.positions[edges[ei].b]), 0.5));
          c++;
        }
      }
      if (c === 0) return [...p] as Vec3;
      const mid = vscale(acc, 1 / c);
      const smooth = vscale(vadd(p, mid), 0.5);
      return vadd(vscale(smooth, 1 - edgeCrease), vscale(p, edgeCrease));
    }
    // F = avg face points, R = avg midpoints of incident edges, S = original
    let F: Vec3 = [0, 0, 0];
    for (const fi of vertFaces[vi]) F = vadd(F, facePts[fi]);
    F = vscale(F, 1 / n);
    let R: Vec3 = [0, 0, 0];
    for (const ei of vertEdges[vi]) R = vadd(R, vscale(vadd(mesh.positions[edges[ei].a], mesh.positions[edges[ei].b]), 0.5));
    R = vscale(R, 1 / vertEdges[vi].length);
    // (F + 2R + (n-3)S) / n
    const smooth = vscale(
      [F[0] + 2 * R[0] + (n - 3) * p[0], F[1] + 2 * R[1] + (n - 3) * p[1], F[2] + 2 * R[2] + (n - 3) * p[2]],
      1 / n,
    );
    const sharp = vertEdges[vi].length >= 3 ? p : smooth;
    return vadd(vscale(smooth, 1 - edgeCrease), vscale(sharp, edgeCrease));
  });

  out.positions = [...newVerts];
  const faceBase = out.positions.length;
  for (const fp of facePts) out.positions.push(fp);
  const edgeBase = out.positions.length;
  for (const ep of edgePts) out.positions.push(ep);

  for (let fi = 0; fi < nF; fi++) {
    const f = mesh.faces[fi];
    const c = faceBase + fi;
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length], prev = f[(i - 1 + f.length) % f.length];
      const eNext = edgeBase + edgeIdx.get(ekey(a, b))!;
      const ePrev = edgeBase + edgeIdx.get(ekey(prev, a))!;
      out.faces.push([a, eNext, c, ePrev]);
      out.faceMaterial.push(mesh.faceMaterial[fi] ?? 0);
    }
  }
  return out;
}

// ---- Mesh -> Points / Separate Components ---------------------------------
reg("GeometryNodeMeshToPoints", (api) => {
  const g = api.geo("Mesh");
  const out = new Geometry();
  if (g.mesh) {
    const mode = api.prop<string>("mode", "VERTICES");
    const domain: Domain = mode === "FACES" ? "FACE" : mode === "EDGES" ? "EDGE" : "POINT";
    const ctx = makeFieldCtx(g, domain);
    const selection = api.field("Selection").array(ctx);
    const positionLinked = api.node.inputs.find((socket) => socket.identifier === "Position")?.linked;
    const positions = positionLinked ? api.field("Position").array(ctx).map(asVec3) : Array.from({ length: ctx.size }, (_, i) => ctx.position?.(i) ?? [0, 0, 0] as Vec3);
    const m = new Mesh();
    const kept: number[] = [];
    for (let i = 0; i < ctx.size; i++) if (asNum(selection[i] ?? 1) > 0) {
      kept.push(i);
      m.positions.push([...positions[i]] as Vec3);
    }
    for (const [name] of g.mesh.attributes) {
      const data = kept.map((i) => ctx.attr?.(name, i) ?? 0);
      m.attributes.set(name, { domain: "POINT", data });
    }
    out.mesh = m;
  }
  return { Points: out };
});

reg("GeometryNodeSeparateComponents", (api) => {
  const g = api.geo("Geometry");
  const meshOnly = new Geometry();
  if (g.mesh) meshOnly.mesh = g.mesh.clone();
  const curveOnly = new Geometry();
  curveOnly.curves = g.curves.map((spline) => ({ cyclic: spline.cyclic, points: spline.points.map((point) => [...point] as Vec3) }));
  for (const [name, attribute] of g.curveAttributes) curveOnly.curveAttributes.set(name, { domain: attribute.domain, data: [...attribute.data] });
  const inst = new Geometry();
  inst.instances = g.instances.map((instance) => ({
    ...instance,
    position: [...instance.position] as Vec3,
    rotation: [...instance.rotation] as Vec3,
    scale: [...instance.scale] as Vec3,
    attributes: instance.attributes ? new Map(instance.attributes) : undefined,
  }));
  return { Mesh: meshOnly, "Point Cloud": new Geometry(), Curve: curveOnly, Instances: inst, Volume: new Geometry() };
});
