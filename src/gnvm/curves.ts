// Curve/spline helpers: arc-length resample, poly fillet, rotation-minimizing
// frames, and profile sweep (the geometry behind CurveToMesh).
import { Vec3, vadd, vsub, vscale, vlen, vnorm, vcross, vdot } from "./core";
import { Spline, Mesh, Geometry } from "./geometry";

export function splineSegments(s: Spline): [number, number][] {
  const segs: [number, number][] = [];
  for (let i = 0; i + 1 < s.points.length; i++) segs.push([i, i + 1]);
  if (s.cyclic && s.points.length > 2) segs.push([s.points.length - 1, 0]);
  return segs;
}

export function splineLength(s: Spline): number {
  let L = 0;
  for (const [a, b] of splineSegments(s)) L += vlen(vsub(s.points[b], s.points[a]));
  return L;
}

// Resample a spline to `count` evenly-spaced points along arc length.
export function resampleSpline(s: Spline, count: number): Spline {
  count = Math.max(2, Math.floor(count));
  const pts = s.points;
  if (pts.length < 2) return { points: pts.map((p) => [...p] as Vec3), cyclic: s.cyclic };
  const segs = splineSegments(s);
  const segLen = segs.map(([a, b]) => vlen(vsub(pts[b], pts[a])));
  const total = segLen.reduce((n, l) => n + l, 0);
  if (total < 1e-9) return { points: [pts[0], pts[0]].map((p) => [...p] as Vec3), cyclic: s.cyclic };
  const out: Vec3[] = [];
  const n = s.cyclic ? count : count - 1;
  for (let i = 0; i <= n; i++) {
    if (!s.cyclic && i === n) { out.push([...pts[pts.length - 1]] as Vec3); break; }
    if (s.cyclic && i === n) break; // don't duplicate the closing point
    let d = (i / n) * total;
    let si = 0;
    while (si < segs.length - 1 && d > segLen[si]) { d -= segLen[si]; si++; }
    const [a, b] = segs[si];
    const t = segLen[si] > 1e-9 ? d / segLen[si] : 0;
    out.push(vadd(pts[a], vscale(vsub(pts[b], pts[a]), t)));
  }
  return { points: out, cyclic: s.cyclic };
}

// Round the corners of a poly spline: each interior corner becomes an arc of
// `count` segments at `radius`. When limitRadius is set, the arc is clamped so it
// can't overshoot the adjacent edge midpoints (matches Blender's Limit Radius).
export function filletSpline(s: Spline, radius: number, count: number, limitRadius = false): Spline {
  const pts = s.points;
  const n = pts.length;
  if (n < 3 || radius <= 0) return { points: pts.map((p) => [...p] as Vec3), cyclic: s.cyclic };
  count = Math.max(1, Math.floor(count));
  const out: Vec3[] = [];
  const first = s.cyclic ? 0 : 1;
  const last = s.cyclic ? n - 1 : n - 2;
  if (!s.cyclic) out.push([...pts[0]] as Vec3);
  for (let i = first; i <= last; i++) {
    const B = pts[i];
    const A = pts[(i - 1 + n) % n];
    const C = pts[(i + 1) % n];
    const dirBA = vnorm(vsub(A, B));
    const dirBC = vnorm(vsub(C, B));
    const lenBA = vlen(vsub(A, B));
    const lenBC = vlen(vsub(C, B));
    const cosT = Math.max(-1, Math.min(1, vdot(dirBA, dirBC)));
    const half = Math.acos(cosT) / 2;
    const tanHalf = Math.tan(half);
    // distance from corner to tangent points
    let d = tanHalf > 1e-6 ? radius / tanHalf : 0;
    d = Math.min(d, lenBA * 0.999, lenBC * 0.999); // safety: don't overshoot the neighbor vertex
    if (limitRadius) d = Math.min(d, lenBA * 0.5, lenBC * 0.5); // Blender Limit Radius: stop at midpoints
    if (d < 1e-6) { out.push([...B] as Vec3); continue; }
    const p0 = vadd(B, vscale(dirBA, d)); // tangent point on BA
    const p1 = vadd(B, vscale(dirBC, d)); // tangent point on BC
    // arc center: along the internal bisector
    const bis = vnorm(vadd(dirBA, dirBC));
    const r = d * tanHalf;
    const centerDist = r / Math.sin(half);
    const center = vadd(B, vscale(bis, centerDist));
    // sweep from p0 to p1 around center
    const v0 = vsub(p0, center);
    const v1 = vsub(p1, center);
    const axis = vnorm(vcross(v0, v1));
    const ang = Math.acos(Math.max(-1, Math.min(1, vdot(vnorm(v0), vnorm(v1)))));
    for (let k = 0; k <= count; k++) {
      const a = (ang * k) / count;
      out.push(vadd(center, rotateAboutAxis(v0, axis, a)));
    }
  }
  if (!s.cyclic) out.push([...pts[n - 1]] as Vec3);
  return { points: out, cyclic: s.cyclic };
}

function rotateAboutAxis(v: Vec3, axis: Vec3, ang: number): Vec3 {
  const c = Math.cos(ang), s = Math.sin(ang);
  // Rodrigues
  return vadd(vadd(vscale(v, c), vscale(vcross(axis, v), s)), vscale(axis, vdot(axis, v) * (1 - c)));
}

// Rotation-minimizing frames along a spline (double reflection method).
export function splineFrames(pts: Vec3[], cyclic: boolean): { tangent: Vec3; normal: Vec3; binormal: Vec3 }[] {
  const n = pts.length;
  const tangents: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    let t: Vec3;
    if (!cyclic && i === 0) t = vsub(pts[1], pts[0]);
    else if (!cyclic && i === n - 1) t = vsub(pts[n - 1], pts[n - 2]);
    else t = vsub(next, prev);
    tangents.push(vnorm(t));
  }
  // initial normal: any vector perpendicular to tangent[0]
  let ref: Vec3 = Math.abs(tangents[0][0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let normal = vnorm(vsub(ref, vscale(tangents[0], vdot(ref, tangents[0]))));
  const frames = [] as { tangent: Vec3; normal: Vec3; binormal: Vec3 }[];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // parallel transport normal from i-1 to i
      const t0 = tangents[i - 1], t1 = tangents[i];
      const axis = vcross(t0, t1);
      const sinA = vlen(axis);
      if (sinA > 1e-6) {
        const a = Math.atan2(sinA, vdot(t0, t1));
        normal = rotateAboutAxis(normal, vnorm(axis), a);
      }
      // re-orthogonalize
      normal = vnorm(vsub(normal, vscale(tangents[i], vdot(normal, tangents[i]))));
    }
    const binormal = vnorm(vcross(tangents[i], normal));
    frames.push({ tangent: tangents[i], normal, binormal });
  }
  // Closed-rail seam correction: distribute residual twist so the last frame's
  // normal meets the first (prevents a pinch/seam on cyclic sweeps, e.g. a torus).
  if (cyclic && n > 2) {
    const first = frames[0].normal;
    const lastN = frames[n - 1].normal;
    const t0 = tangents[0];
    // signed angle from lastN to first about the (shared) tangent at the seam
    let ang = Math.atan2(vdot(vcross(lastN, first), t0), vdot(lastN, first));
    for (let i = 0; i < n; i++) {
      const a = (ang * i) / n;
      const nn = rotateAboutAxis(frames[i].normal, tangents[i], a);
      frames[i] = { tangent: tangents[i], normal: nn, binormal: vnorm(vcross(tangents[i], nn)) };
    }
  }
  return frames;
}

// Sweep a profile spline along a rail spline -> mesh.
export function sweep(rail: Spline, profile: Spline, fillCaps: boolean): Mesh {
  const mesh = new Mesh();
  const rp = rail.points;
  const pp = profile.points;
  if (rp.length < 2 || pp.length < 2) return mesh;
  const frames = splineFrames(rp, rail.cyclic);
  const nr = rp.length;
  const np = pp.length;
  // place profile at each rail point (profile local: x->binormal, y->normal)
  for (let i = 0; i < nr; i++) {
    const { normal, binormal } = frames[i];
    for (let j = 0; j < np; j++) {
      const px = pp[j][0], py = pp[j][1];
      mesh.positions.push(vadd(rp[i], vadd(vscale(binormal, px), vscale(normal, py))));
    }
  }
  const ringCount = rail.cyclic ? nr : nr - 1;
  const profSeg = profile.cyclic ? np : np - 1;
  for (let i = 0; i < ringCount; i++) {
    const a = i * np;
    const b = ((i + 1) % nr) * np;
    for (let j = 0; j < profSeg; j++) {
      const j2 = (j + 1) % np;
      mesh.faces.push([a + j, b + j, b + j2, a + j2]);
      mesh.faceMaterial.push(0);
    }
  }
  if (fillCaps && profile.cyclic && !rail.cyclic) {
    const startFace: number[] = [];
    const endFace: number[] = [];
    for (let j = 0; j < np; j++) { startFace.push(j); endFace.push((nr - 1) * np + (np - 1 - j)); }
    mesh.faces.push(startFace); mesh.faceMaterial.push(0);
    mesh.faces.push(endFace); mesh.faceMaterial.push(0);
  }
  mesh.materialSlots = [null];
  return mesh;
}

// Fill each cyclic spline with an ngon (fan) face -> mesh.
export function fillCurves(curves: Spline[], mode: "NGONS" | "TRIANGLES"): Mesh {
  const mesh = new Mesh();
  for (const s of curves) {
    if (s.points.length < 3) continue;
    const base = mesh.positions.length;
    for (const p of s.points) mesh.positions.push([...p] as Vec3);
    const n = s.points.length;
    if (mode === "TRIANGLES") {
      // fan from centroid for robustness on concave-ish shapes
      let c: Vec3 = [0, 0, 0];
      for (const p of s.points) c = vadd(c, p);
      c = vscale(c, 1 / n);
      const ci = mesh.positions.length;
      mesh.positions.push(c);
      for (let i = 0; i < n; i++) { mesh.faces.push([ci, base + i, base + ((i + 1) % n)]); mesh.faceMaterial.push(0); }
    } else {
      mesh.faces.push(Array.from({ length: n }, (_, i) => base + i));
      mesh.faceMaterial.push(0);
    }
  }
  mesh.materialSlots = [null];
  return mesh;
}

// Chain a mesh's edges into poly splines, returning the source vertex index per
// control point so attributes can be carried onto the curve.
export function meshEdgesToChains(mesh: Mesh, selected?: (vi: number) => boolean): { spline: Spline; verts: number[] }[] {
  const raw = meshEdgesToCurvesInternal(mesh, selected);
  return raw;
}

// Chain a mesh's edges (from faces) into poly splines.
export function meshEdgesToCurves(mesh: Mesh, selected?: (vi: number) => boolean): Spline[] {
  return meshEdgesToCurvesInternal(mesh, selected).map((r) => r.spline);
}

function meshEdgesToCurvesInternal(mesh: Mesh, selected?: (vi: number) => boolean): { spline: Spline; verts: number[] }[] {
  // gather undirected edges from faces
  const adj = new Map<number, Set<number>>();
  const addE = (a: number, b: number) => {
    if (selected && (!selected(a) || !selected(b))) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b); adj.get(b)!.add(a);
  };
  for (const f of mesh.faces) for (let i = 0; i < f.length; i++) addE(f[i], f[(i + 1) % f.length]);
  for (const [a, b] of mesh.edges) addE(a, b);
  const out: { spline: Spline; verts: number[] }[] = [];
  const visitedEdge = new Set<string>();
  const ek = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  // Blender Mesh to Curve semantics: splines break at "poles" (valence != 2).
  // Walk pole-to-pole open chains first, then what remains are pure cycles.
  const isPole = (v: number) => (adj.get(v)?.size ?? 0) !== 2;
  const walk = (start: number, next: number): number[] => {
    const chain = [start];
    let prev = start, cur = next;
    visitedEdge.add(ek(prev, cur));
    chain.push(cur);
    while (cur !== start && !isPole(cur)) {
      const nbrs = [...(adj.get(cur) ?? [])].filter((x) => x !== prev && !visitedEdge.has(ek(cur, x)));
      if (!nbrs.length) break;
      const nxt = nbrs[0];
      visitedEdge.add(ek(cur, nxt));
      prev = cur; cur = nxt;
      if (cur === start) break;
      chain.push(cur);
    }
    return chain;
  };
  const emit = (chain: number[], cyclic: boolean) =>
    out.push({ spline: { points: chain.map((vi) => [...mesh.positions[vi]] as Vec3), cyclic }, verts: chain });
  for (const [start] of adj) {
    if (!isPole(start)) continue;
    for (const nb of adj.get(start)!) {
      if (visitedEdge.has(ek(start, nb))) continue;
      emit(walk(start, nb), false);
    }
  }
  // remaining unvisited edges belong to valence-2 cycles
  for (const [start] of adj) {
    for (const nb of adj.get(start)!) {
      if (visitedEdge.has(ek(start, nb))) continue;
      const chain = walk(start, nb);
      emit(chain, chain.length > 2);
    }
  }
  return out;
}

export function curveGeometry(splines: Spline[]): Geometry {
  const g = new Geometry();
  g.curves = splines;
  return g;
}
