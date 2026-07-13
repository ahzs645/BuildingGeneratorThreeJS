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
    // A straight control point has no corner to round. Blender retains it once;
    // expanding it into Count+1 coincident points massively over-tessellates
    // rectilinear font outlines after their decimation pass.
    if (lenBA > 1e-9 && lenBC > 1e-9 && cosT < -0.9) {
      out.push([...B] as Vec3);
      continue;
    }
    const half = Math.acos(cosT) / 2;
    const tanHalf = Math.tan(half);
    // distance from corner to tangent points
    let d = tanHalf > 1e-6 ? radius / tanHalf : 0;
    d = Math.min(d, lenBA * 0.999, lenBC * 0.999); // safety: don't overshoot the neighbor vertex
    if (limitRadius) d = Math.min(d, lenBA * 0.5, lenBC * 0.5); // Blender Limit Radius: stop at midpoints
    if (d < 1e-6) {
      // Blender preserves the requested poly-fillet control-point count even
      // for a collapsed corner. The star-noodle fallback intentionally feeds
      // a zero-radius star through Fillet Curve and relies on those duplicate
      // points to determine the subsequent Curve to Mesh topology.
      for (let k = 0; k <= count; k++) out.push([...B] as Vec3);
      continue;
    }
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
export function splineFrames(pts: Vec3[], cyclic: boolean, tangentOverrides?: Vec3[]): { tangent: Vec3; normal: Vec3; binormal: Vec3 }[] {
  const n = pts.length;
  if (n === 0) return [];
  if (n === 1) {
    const tangent = tangentOverrides?.[0] && vlen(tangentOverrides[0]) > 1e-9
      ? vnorm(tangentOverrides[0])
      : [0, 0, 1] as Vec3;
    const normal: Vec3 = Math.abs(tangent[0]) < 0.9
      ? vnorm(vsub([1, 0, 0], vscale(tangent, tangent[0])))
      : vnorm(vsub([0, 1, 0], vscale(tangent, tangent[1])));
    return [{ tangent, normal, binormal: vnorm(vcross(tangent, normal)) }];
  }
  const tangents: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    if (tangentOverrides?.[i] && vlen(tangentOverrides[i]) > 1e-9) { tangents.push(vnorm(tangentOverrides[i])); continue; }
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    let t: Vec3;
    if (!cyclic && i === 0) t = vsub(pts[1], pts[0]);
    else if (!cyclic && i === n - 1) t = vsub(pts[n - 1], pts[n - 2]);
    else t = vsub(next, prev);
    const normalized = vnorm(t);
    tangents.push(vlen(normalized) < 1e-9 ? [0, 0, 1] : normalized);
  }
  // initial normal: any vector perpendicular to tangent[0]
  let normal: Vec3;
  if (tangentOverrides?.length) {
    normal = vcross(tangents[0], [0, 0, 1]);
    if (vlen(normal) < 1e-9) normal = [1, 0, 0];
    normal = vnorm(normal);
  } else {
    const ref: Vec3 = Math.abs(tangents[0][0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    normal = vnorm(vsub(ref, vscale(tangents[0], vdot(ref, tangents[0]))));
  }
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

// Sweep a profile spline along a rail spline -> mesh. `scales` (optional) is a
// per-rail-point profile scale (Blender's Curve to Mesh "Scale" / curve radius).
export function sweep(rail: Spline, profile: Spline, fillCaps: boolean, scales?: number[], tangentOverrides?: Vec3[]): Mesh {
  const mesh = new Mesh();
  const rp = rail.points;
  const pp = profile.points;
  if (rp.length < 2 || pp.length < 2) return mesh;
  const frames = splineFrames(rp, rail.cyclic, tangentOverrides);
  const nr = rp.length;
  const np = pp.length;
  // place profile at each rail point (profile local: x->binormal, y->normal)
  for (let i = 0; i < nr; i++) {
    const { normal, binormal } = frames[i];
    const s = scales?.[i] ?? 1;
    for (let j = 0; j < np; j++) {
      const px = pp[j][0] * s, py = pp[j][1] * s;
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

// Fill cyclic splines in their shared local plane. Blender's N-gons mode keeps
// each cyclic spline as an independent polygon, including nested font outlines;
// Triangles mode applies even-odd containment so inner loops become holes.
export function fillCurves(curves: Spline[], mode: "NGONS" | "TRIANGLES"): Mesh {
  const mesh = new Mesh();
  const plane = fillPlane(curves);
  if (!plane) {
    // Blender retains one point for a collapsed cyclic fill instead of
    // returning a completely empty mesh. The star-noodle fallback uses this
    // degenerate center alongside its swept outline.
    const collapsed = curves.find((s) => s.cyclic && s.points.length);
    if (collapsed) mesh.positions.push([...collapsed.points[0]] as Vec3);
    mesh.materialSlots = [null];
    return mesh;
  }
  const loops = fillLoops(curves, plane);
  if (mode === "NGONS") {
    for (const loop of loops) emitSimpleFill(mesh, loop.points, "NGONS");
    mesh.materialSlots = [null];
    return mesh;
  }
  classifyFillLoops(loops);
  for (let li = 0; li < loops.length; li++) {
    const loop = loops[li];
    if (loop.depth % 2 !== 0) continue;
    const holes = loops.filter((h) => h.parent === li && h.depth === loop.depth + 1);
    if (!holes.length) emitSimpleFill(mesh, loop.points, mode);
    else emitHoledFill(mesh, loop, holes);
  }
  mesh.materialSlots = [null];
  return mesh;
}

type Vec2 = [number, number];

type FillPlane = {
  origin: Vec3;
  normal: Vec3;
  u: Vec3;
  v: Vec3;
};

type FillLoop = {
  points: Vec3[];
  points2: Vec2[];
  area: number;
  absArea: number;
  depth: number;
  parent: number;
};

type PolyRef = {
  p: Vec2;
  vi: number;
};

const FILL_EPS = 1e-9;

function emitSimpleFill(mesh: Mesh, points: Vec3[], mode: "NGONS" | "TRIANGLES") {
  const base = mesh.positions.length;
  for (const p of points) mesh.positions.push([...p] as Vec3);
  const n = points.length;
  if (mode === "TRIANGLES") {
    // Blender triangulates using the existing loop vertices (n-2 faces), not
    // a newly inserted centroid. Ear clipping preserves concave star outlines.
    let refs: PolyRef[] = points.map((p, i) => ({ p: [p[0], p[1]], vi: base + i }));
    if (signedArea2(refs.map((ref) => ref.p)) < 0) refs = [...refs].reverse();
    for (const face of earClip(refs)) { mesh.faces.push(face); mesh.faceMaterial.push(0); }
  } else {
    mesh.faces.push(Array.from({ length: n }, (_, i) => base + i));
    mesh.faceMaterial.push(0);
  }
}

function fillPlane(curves: Spline[]): FillPlane | null {
  let origin: Vec3 | null = null;
  let firstNormal: Vec3 | null = null;
  let normalSum: Vec3 = [0, 0, 0];
  for (const s of curves) {
    if (!s.cyclic || s.points.length < 3) continue;
    const n = newellNormal(s.points);
    if (vlen(n) <= FILL_EPS) continue;
    if (!origin) origin = averagePoint(s.points);
    if (!firstNormal) firstNormal = n;
    const aligned = vdot(n, firstNormal) < 0 ? vscale(n, -1) : n;
    normalSum = vadd(normalSum, aligned);
  }
  if (!origin || !firstNormal) return null;
  const normal = vlen(normalSum) > FILL_EPS ? vnorm(normalSum) : vnorm(firstNormal);
  const ref: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = vnorm(vsub(ref, vscale(normal, vdot(ref, normal))));
  const v = vnorm(vcross(normal, u));
  return { origin, normal, u, v };
}

function fillLoops(curves: Spline[], plane: FillPlane): FillLoop[] {
  const loops: FillLoop[] = [];
  for (const s of curves) {
    if (!s.cyclic || s.points.length < 3) continue;
    const points2 = s.points.map((p) => projectFillPoint(p, plane));
    const area = signedArea2(points2);
    const absArea = Math.abs(area);
    if (absArea <= FILL_EPS) continue;
    loops.push({
      points: s.points,
      points2,
      area,
      absArea,
      depth: 0,
      parent: -1,
    });
  }
  return loops;
}

function classifyFillLoops(loops: FillLoop[]) {
  for (let i = 0; i < loops.length; i++) {
    let depth = 0;
    let parent = -1;
    let parentArea = Infinity;
    for (let j = 0; j < loops.length; j++) {
      if (i === j || loops[j].absArea <= loops[i].absArea + FILL_EPS) continue;
      if (!loopContainsLoop(loops[j], loops[i])) continue;
      depth++;
      if (loops[j].absArea < parentArea) {
        parentArea = loops[j].absArea;
        parent = j;
      }
    }
    loops[i].depth = depth;
    loops[i].parent = parent;
  }
}

function emitHoledFill(mesh: Mesh, outer: FillLoop, holes: FillLoop[]) {
  const baseByLoop = new Map<FillLoop, number>();
  const addLoop = (loop: FillLoop) => {
    const base = mesh.positions.length;
    baseByLoop.set(loop, base);
    for (const p of loop.points) mesh.positions.push([...p] as Vec3);
  };
  addLoop(outer);
  for (const h of holes) addLoop(h);

  let ring = orientedRefs(outer, baseByLoop.get(outer)!, true);
  const holeRefs = holes
    .map((h) => orientedRefs(h, baseByLoop.get(h)!, false))
    .sort((a, b) => rightmostX(b) - rightmostX(a));
  for (const hole of holeRefs) ring = bridgeHole(ring, hole, holeRefs);
  const tris = earClip(ring);
  for (const f of tris) {
    mesh.faces.push(f);
    mesh.faceMaterial.push(0);
  }
}

function orientedRefs(loop: FillLoop, base: number, ccw: boolean): PolyRef[] {
  const reverse = ccw ? loop.area < 0 : loop.area > 0;
  const refs: PolyRef[] = [];
  for (let k = 0; k < loop.points.length; k++) {
    const i = reverse ? loop.points.length - 1 - k : k;
    refs.push({ p: loop.points2[i], vi: base + i });
  }
  return refs;
}

function bridgeHole(ring: PolyRef[], hole: PolyRef[], allHoles: PolyRef[][]): PolyRef[] {
  const bridge = findBridge(ring, hole, allHoles);
  if (!bridge) return ring;
  const out: PolyRef[] = [];
  for (let i = 0; i <= bridge.ring; i++) out.push(ring[i]);
  for (let k = 0; k <= hole.length; k++) out.push(hole[(bridge.hole + k) % hole.length]);
  out.push(ring[bridge.ring]);
  for (let i = bridge.ring + 1; i < ring.length; i++) out.push(ring[i]);
  return out;
}

function findBridge(ring: PolyRef[], hole: PolyRef[], allHoles: PolyRef[][]): { ring: number; hole: number } | null {
  const holeOrder = hole.map((_, i) => i).sort((a, b) => {
    const dx = hole[b].p[0] - hole[a].p[0];
    return Math.abs(dx) > FILL_EPS ? dx : hole[a].p[1] - hole[b].p[1];
  });
  let best: { ring: number; hole: number; d2: number } | null = null;
  for (const hi of holeOrder) {
    for (let ri = 0; ri < ring.length; ri++) {
      if (!visibleBridge(ring[ri], hole[hi], ring, allHoles, hole)) continue;
      const d2 = dist2(ring[ri].p, hole[hi].p);
      if (!best || d2 < best.d2) best = { ring: ri, hole: hi, d2 };
    }
    if (best) break;
  }
  return best ? { ring: best.ring, hole: best.hole } : null;
}

function visibleBridge(a: PolyRef, b: PolyRef, ring: PolyRef[], allHoles: PolyRef[][], activeHole: PolyRef[]): boolean {
  if (same2(a.p, b.p)) return false;
  if (segmentHitsRing(a.p, b.p, ring, a.p)) return false;
  for (const h of allHoles) {
    const allowed = h === activeHole ? b.p : null;
    if (segmentHitsRing(a.p, b.p, h, allowed)) return false;
  }
  return true;
}

function segmentHitsRing(a: Vec2, b: Vec2, ring: PolyRef[], allowed: Vec2 | null): boolean {
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i].p;
    const d = ring[(i + 1) % ring.length].p;
    if (allowed && (same2(c, allowed) || same2(d, allowed))) continue;
    if (segmentsIntersect(a, b, c, d)) return true;
  }
  return false;
}

function earClip(poly: PolyRef[]): number[][] {
  const faces: number[][] = [];
  let verts = cleanPoly(poly);
  if (verts.length < 3) return faces;
  if (signedAreaRefs(verts) < 0) verts = [...verts].reverse();
  let guard = verts.length * verts.length;
  while (verts.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < verts.length; i++) {
      const pi = (i - 1 + verts.length) % verts.length;
      const ni = (i + 1) % verts.length;
      const a = verts[pi], b = verts[i], c = verts[ni];
      if (cross2(a.p, b.p, c.p) <= FILL_EPS) continue;
      if (diagonalBlocked(a.p, c.p, verts, pi, i, ni)) continue;
      if (earContainsPoint(a.p, b.p, c.p, verts, pi, i, ni)) continue;
      if (new Set([a.vi, b.vi, c.vi]).size === 3) faces.push([a.vi, b.vi, c.vi]);
      verts.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped && !dropDegenerateVertex(verts)) break;
  }
  if (verts.length === 3 && cross2(verts[0].p, verts[1].p, verts[2].p) > FILL_EPS && new Set(verts.map((v) => v.vi)).size === 3) {
    faces.push([verts[0].vi, verts[1].vi, verts[2].vi]);
  }
  return faces;
}

function cleanPoly(poly: PolyRef[]): PolyRef[] {
  const out: PolyRef[] = [];
  for (const p of poly) {
    if (!out.length || !same2(out[out.length - 1].p, p.p)) out.push(p);
  }
  if (out.length > 1 && same2(out[0].p, out[out.length - 1].p)) out.pop();
  return out;
}

function dropDegenerateVertex(verts: PolyRef[]): boolean {
  for (let i = 0; i < verts.length; i++) {
    const a = verts[(i - 1 + verts.length) % verts.length].p;
    const b = verts[i].p;
    const c = verts[(i + 1) % verts.length].p;
    if (same2(a, b) || same2(b, c) || Math.abs(cross2(a, b, c)) <= FILL_EPS) {
      verts.splice(i, 1);
      return true;
    }
  }
  return false;
}

function diagonalBlocked(a: Vec2, b: Vec2, verts: PolyRef[], pi: number, i: number, ni: number): boolean {
  for (let j = 0; j < verts.length; j++) {
    const j2 = (j + 1) % verts.length;
    if (j === pi || j === i || j2 === i || j2 === ni) continue;
    const c = verts[j].p;
    const d = verts[j2].p;
    if (same2(c, a) || same2(c, b) || same2(d, a) || same2(d, b)) continue;
    if (segmentsIntersect(a, b, c, d)) return true;
  }
  return false;
}

function earContainsPoint(a: Vec2, b: Vec2, c: Vec2, verts: PolyRef[], ai: number, bi: number, ci: number): boolean {
  for (let i = 0; i < verts.length; i++) {
    if (i === ai || i === bi || i === ci) continue;
    const p = verts[i].p;
    if (same2(p, a) || same2(p, b) || same2(p, c)) continue;
    if (pointInTriStrict(p, a, b, c)) return true;
  }
  return false;
}

function loopContainsLoop(outer: FillLoop, inner: FillLoop): boolean {
  for (const p of inner.points2) {
    const r = pointInPolygon(p, outer.points2);
    if (r > 0) return true;
    if (r < 0) return false;
  }
  return pointInPolygon(avg2(inner.points2), outer.points2) > 0;
}

function pointInPolygon(p: Vec2, poly: Vec2[]): number {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    if (pointOnSegment(p, a, b)) return 0;
    const crosses = (a[1] > p[1]) !== (b[1] > p[1]);
    if (!crosses) continue;
    const x = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
    if (p[0] < x - FILL_EPS) inside = !inside;
    else if (Math.abs(p[0] - x) <= FILL_EPS) return 0;
  }
  return inside ? 1 : -1;
}

function pointInTriStrict(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  return cross2(a, b, p) > FILL_EPS && cross2(b, c, p) > FILL_EPS && cross2(c, a, p) > FILL_EPS;
}

function pointOnSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  return Math.abs(cross2(a, b, p)) <= FILL_EPS &&
    p[0] >= Math.min(a[0], b[0]) - FILL_EPS && p[0] <= Math.max(a[0], b[0]) + FILL_EPS &&
    p[1] >= Math.min(a[1], b[1]) - FILL_EPS && p[1] <= Math.max(a[1], b[1]) + FILL_EPS;
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = cross2(a, b, c);
  const o2 = cross2(a, b, d);
  const o3 = cross2(c, d, a);
  const o4 = cross2(c, d, b);
  if (Math.abs(o1) <= FILL_EPS && pointOnSegment(c, a, b)) return true;
  if (Math.abs(o2) <= FILL_EPS && pointOnSegment(d, a, b)) return true;
  if (Math.abs(o3) <= FILL_EPS && pointOnSegment(a, c, d)) return true;
  if (Math.abs(o4) <= FILL_EPS && pointOnSegment(b, c, d)) return true;
  return (o1 > FILL_EPS) !== (o2 > FILL_EPS) && (o3 > FILL_EPS) !== (o4 > FILL_EPS);
}

function newellNormal(points: Vec3[]): Vec3 {
  let n: Vec3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    n = [
      n[0] + (a[1] - b[1]) * (a[2] + b[2]),
      n[1] + (a[2] - b[2]) * (a[0] + b[0]),
      n[2] + (a[0] - b[0]) * (a[1] + b[1]),
    ];
  }
  return n;
}

function averagePoint(points: Vec3[]): Vec3 {
  let c: Vec3 = [0, 0, 0];
  for (const p of points) c = vadd(c, p);
  return vscale(c, 1 / points.length);
}

function projectFillPoint(p: Vec3, plane: FillPlane): Vec2 {
  const d = vsub(p, plane.origin);
  return [vdot(d, plane.u), vdot(d, plane.v)];
}

function signedArea2(points: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

function signedAreaRefs(points: PolyRef[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i].p;
    const q = points[(i + 1) % points.length].p;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

function avg2(points: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of points) { x += p[0]; y += p[1]; }
  return [x / points.length, y / points.length];
}

function cross2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function same2(a: Vec2, b: Vec2): boolean {
  return Math.abs(a[0] - b[0]) <= FILL_EPS && Math.abs(a[1] - b[1]) <= FILL_EPS;
}

function dist2(a: Vec2, b: Vec2): number {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

function rightmostX(points: PolyRef[]): number {
  return Math.max(...points.map((p) => p.p[0]));
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
  // Mesh to Curve follows stored edge order. This can differ from face winding:
  // Grid starts BL->TL while Mesh Circle starts +X->+Y. Fall back to polygon
  // loops only for meshes that do not carry explicit edges.
  for (const [a, b] of mesh.edges) addE(a, b);
  for (const f of mesh.faces) for (let i = 0; i < f.length; i++) addE(f[i], f[(i + 1) % f.length]);
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
