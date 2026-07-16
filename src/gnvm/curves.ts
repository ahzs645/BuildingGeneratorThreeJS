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
  // `points` is Blender's evaluated curve domain. Authored Bezier controls are
  // retained separately for nodes that explicitly operate on handles; curve
  // resampling must consume the already-evaluated (and possibly transformed)
  // points instead of re-evaluating stale controls.
  const pts = s.points;
  if (pts.length < 2) return { points: pts.map((p) => [...p] as Vec3), cyclic: s.cyclic };
  const segs = splineSegments({ ...s, points: pts });
  const segLen = segs.map(([a, b]) => {
    const dx = Math.fround(Math.fround(pts[b][0]) - Math.fround(pts[a][0]));
    const dy = Math.fround(Math.fround(pts[b][1]) - Math.fround(pts[a][1]));
    const dz = Math.fround(Math.fround(pts[b][2]) - Math.fround(pts[a][2]));
    let squared = Math.fround(Math.fround(dx * dx) + Math.fround(dy * dy));
    squared = Math.fround(squared + Math.fround(dz * dz));
    return Math.fround(Math.sqrt(squared));
  });
  const cumulative: number[] = [];
  let total = 0;
  for (const length of segLen) {
    total = Math.fround(total + length);
    cumulative.push(total);
  }
  if (total < 1e-9) return { points: [pts[0], pts[0]].map((p) => [...p] as Vec3), cyclic: s.cyclic };
  const out: Vec3[] = [];
  const n = s.cyclic ? count : count - 1;
  const step = Math.fround(total / n);
  // Blender's `sample_uniform` evaluates ranges of 512 samples with a shared
  // `SampleSegmentHint`. The hint fast-path runs before the explicit
  // end-of-curve case, so the last open sample can retain a factor one ULP
  // below 1 instead of being replaced with the raw endpoint.
  let hintSegment = -1;
  let hintStart = 0;
  let hintInverseLength = 0;
  for (let i = 0; i < count; i++) {
    if (i % 512 === 0) hintSegment = -1;
    const distance = Math.min(total, Math.fround(i * step));
    let si: number;
    let t: number;
    const hintedFactor = hintSegment >= 0
      ? Math.fround(Math.fround(distance - hintStart) * hintInverseLength)
      : -1;
    if (hintedFactor >= 0 && hintedFactor < 1) {
      si = hintSegment;
      t = hintedFactor;
    } else if (distance >= total) {
      si = segs.length - 1;
      t = 1;
    } else {
      // Blender uses upper_bound, so a sample exactly on a boundary belongs
      // to the following segment with factor zero.
      si = 0;
      while (si < segs.length - 1 && distance >= cumulative[si]) si++;
      const previous = si === 0 ? 0 : cumulative[si - 1];
      const segmentLength = Math.fround(cumulative[si] - previous);
      const inverseLength = segmentLength > 1e-9 ? Math.fround(1 / segmentLength) : 0;
      t = Math.fround(Math.fround(distance - previous) * inverseLength);
      hintSegment = si;
      hintStart = previous;
      hintInverseLength = inverseLength;
    }
    const [a, b] = segs[si];
    const inverse = Math.fround(1 - t);
    out.push([
      Math.fround(Math.fround(Math.fround(pts[a][0]) * inverse) + Math.fround(Math.fround(pts[b][0]) * t)),
      Math.fround(Math.fround(Math.fround(pts[a][1]) * inverse) + Math.fround(Math.fround(pts[b][1]) * t)),
      Math.fround(Math.fround(Math.fround(pts[a][2]) * inverse) + Math.fround(Math.fround(pts[b][2]) * t)),
    ]);
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
    else {
      // Blender bisects the normalized incident segment directions. Using a
      // raw next-minus-previous chord weights the tangent toward the longer
      // evaluated segment and can move a polygonal Curve-to-Mesh boundary.
      const incoming = vnorm(vsub(pts[i], prev));
      const outgoing = vnorm(vsub(next, pts[i]));
      const bisector = vadd(incoming, outgoing);
      t = vlen(bisector) > 1e-9 ? bisector : vsub(next, prev);
    }
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
export function sweep(
  rail: Spline,
  profile: Spline,
  fillCaps: boolean,
  scales?: number[],
  tangentOverrides?: Vec3[],
  normalOverrides?: Vec3[],
  planarFromMesh = false,
): Mesh {
  const mesh = new Mesh();
  const rp = rail.points;
  const pp = profile.points;
  if (rp.length < 2 || pp.length < 2) return mesh;
  const frames = splineFrames(rp, rail.cyclic, tangentOverrides);
  const nr = rp.length;
  const np = pp.length;
  // Blender treats the rail tangent as profile-local +Z. An open +X rail maps
  // profile (2,3) to world (0,-2,-3), while a closed planar loop establishes a
  // stable in-plane normal. Cyclic curves point profile +X toward their
  // interior. A trimmed planar arc retains its source curve's outward normal;
  // the Clevis retaining clip depends on that distinction.
  // Blender treats any coplanar cyclic rail as a planar curve, not only one
  // lying in world XY. Derive a stable, winding-independent plane normal so a
  // slightly tilted board outline keeps a constant profile-up direction.
  const horizontalPlanar = rail.cyclic && rp.length > 2
    && rp.every((point) => Math.abs(point[2] - rp[0][2]) < 1e-8)
    // A fully collapsed cyclic rail has no in-plane tangent. Blender falls
    // back to its generic +Z frame and retains both profile axes.
    && rp.some((point, index) => {
      const next = rp[(index + 1) % rp.length];
      return Math.hypot(next[0] - point[0], next[1] - point[1]) > 1e-9;
    });
  let tiltedPlanarNormal: Vec3 | null = null;
  if (planarFromMesh && !horizontalPlanar && rail.cyclic && rp.length > 2) {
    for (let index = 1; index + 1 < rp.length; index++) {
      const candidate = vcross(vsub(rp[index], rp[0]), vsub(rp[index + 1], rp[0]));
      if (vlen(candidate) > 1e-9) { tiltedPlanarNormal = vnorm(candidate); break; }
    }
    if (tiltedPlanarNormal) {
      const dominant = [0, 1, 2].reduce((best, axis) => Math.abs(tiltedPlanarNormal![axis]) > Math.abs(tiltedPlanarNormal![best]) ? axis : best, 0);
      if (tiltedPlanarNormal[dominant] < 0) tiltedPlanarNormal = vscale(tiltedPlanarNormal, -1);
      const span = Math.max(1, ...rp.flatMap((point) => point.map(Math.abs)));
      if (!rp.every((point) => Math.abs(vdot(vsub(point, rp[0]), tiltedPlanarNormal!)) <= 1e-7 * span)) tiltedPlanarNormal = null;
    }
  }
  let planarOrientation = 1;
  if (horizontalPlanar) {
    let area2 = 0;
    for (let i = 0; i < rp.length; i++) {
      const a = rp[i], b = rp[(i + 1) % rp.length];
      area2 += a[0] * b[1] - b[0] * a[1];
    }
    planarOrientation = area2 >= 0 ? 1 : -1;
  } else if (tiltedPlanarNormal) {
    let areaVector: Vec3 = [0, 0, 0];
    for (let i = 0; i < rp.length; i++) {
      const a = rp[i], b = rp[(i + 1) % rp.length];
      areaVector = vadd(areaVector, vcross(a, b));
    }
    planarOrientation = vdot(areaVector, tiltedPlanarNormal) >= 0 ? 1 : -1;
  }
  const planarOpen = !rail.cyclic && rp.length > 2
    && rp.every((point) => Math.abs(point[2] - rp[0][2]) < 1e-8);
  let planarTurn = 0;
  if (planarOpen) {
    for (let i = 1; i + 1 < rp.length; i++) {
      const a = vnorm(vsub(rp[i], rp[i - 1]));
      const b = vnorm(vsub(rp[i + 1], rp[i]));
      planarTurn += a[0] * b[1] - a[1] * b[0];
    }
  }
  for (let i = 0; i < nr; i++) {
    const frame = frames[i];
    // Resample Curve carries Blender's evaluated tangent frame forward. Its
    // initial normal is already constructed with cross(tangent, +Z), so the
    // generic open-curve half-turn below must not be applied a second time.
    // Modern Pipe exposes this on its three straight, resampled sleeve rails:
    // the extra half-turn changes which slightly asymmetric resampled-circle
    // point reaches each extremum and moves the generated joint boundary.
    const evaluatedFrameSign = tangentOverrides?.length ? 1 : -1;
    // Evaluated curve normals carry Blender's minimum-twist transport and its
    // small float32 cyclic correction. Rebuilding them only from the tangent
    // loses that roll and changes coordinate-sensitive hull membership.
    const evaluatedNormal = normalOverrides?.[i] && vlen(normalOverrides[i]) > 1e-9
      ? normalOverrides[i]
      : null;
    const normal = evaluatedNormal
      ? evaluatedNormal
      : horizontalPlanar
        ? vnorm([frame.tangent[1] * planarOrientation, -frame.tangent[0] * planarOrientation, 0])
      : tiltedPlanarNormal
        ? vscale(vnorm(vcross(tiltedPlanarNormal, frame.tangent)), planarOrientation)
      : planarOpen && Math.abs(planarTurn) > 1e-6
        ? frame.normal
        : vscale(frame.normal, evaluatedFrameSign);
    const binormal = evaluatedNormal
      ? vnorm(vcross(frame.tangent, evaluatedNormal))
      : horizontalPlanar
      ? vnorm(vcross(frame.tangent, normal))
      : tiltedPlanarNormal ? tiltedPlanarNormal : vscale(frame.binormal, evaluatedFrameSign);
    const f = Math.fround;
    const s = f(scales?.[i] ?? 1);
    for (let j = 0; j < np; j++) {
      const px = f(f(pp[j][0]) * s), py = f(f(pp[j][1]) * s);
      mesh.positions.push([0, 1, 2].map((axis) => {
        const normalOffset = f(f(normal[axis]) * px);
        const binormalOffset = f(f(binormal[axis]) * py);
        return f(f(f(rp[i][axis]) + normalOffset) + binormalOffset);
      }) as Vec3);
    }
  }
  const ringCount = rail.cyclic ? nr : nr - 1;
  const profSeg = profile.cyclic ? np : np - 1;
  for (let i = 0; i < ringCount; i++) {
    const a = i * np;
    const b = ((i + 1) % nr) * np;
    for (let j = 0; j < profSeg; j++) {
      const j2 = (j + 1) % np;
      // Blender advances around the profile first, then the rail. The reverse
      // winding flips the generated surface normals and makes downstream
      // Solidify groups offset inward (the Clevis head lost 0.763 units).
      mesh.faces.push([a + j, a + j2, b + j2, b + j]);
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

// Fill cyclic splines in their shared local plane. Both modes apply even-odd
// containment. Triangles emits a triangulated annulus; N-gons partitions the
// annulus with two boundary bridges per hole so it can retain Blender's one-face
// per authored outline count without filling glyph counters such as O, P, or B.
export function fillCurves(curves: Spline[], mode: "NGONS" | "TRIANGLES"): Mesh {
  const mesh = new Mesh();
  // Limit Radius can make neighboring fillets meet at the exact same tangent
  // point. Blender's Fill Curve welds those adjacent duplicates before it
  // creates the polygon (the N03D print-preview square has one at every edge).
  const fillInput = curves.map((spline) => {
    if (!spline.cyclic || spline.points.length < 2) return spline;
    const points: Vec3[] = [];
    for (const point of spline.points) {
      const previous = points[points.length - 1];
      if (!previous || vlen(vsub(point, previous)) > 1e-7) points.push(point);
    }
    if (points.length > 1 && vlen(vsub(points[0], points[points.length - 1])) <= 1e-7) points.pop();
    return { ...spline, points };
  });
  const plane = fillPlane(fillInput);
  if (!plane) {
    // Blender retains one point for a collapsed cyclic fill instead of
    // returning a completely empty mesh. The star-noodle fallback uses this
    // degenerate center alongside its swept outline.
    const collapsed = fillInput.find((s) => s.cyclic && s.points.length);
    if (collapsed) mesh.positions.push([...collapsed.points[0]] as Vec3);
    mesh.materialSlots = [null];
    return mesh;
  }
  const loops = fillLoops(fillInput, plane);
  // Blender resolves crossings between cyclic outlines before triangulating.
  // This matters for same-winding overlaps such as Stackable Bin's 13x13
  // groove cells crossing its rounded clip outline. Preserve the inexpensive
  // legacy path when there are no proper intersections (the common case).
  if (mode === "TRIANGLES" && emitIntersectingFill(mesh, loops, plane)) {
    weldTouchingFillLoops(mesh);
    mesh.materialSlots = [null];
    return mesh;
  }
  if (mode === "NGONS" && emitOverlappingNgonFill(mesh, loops)) {
    weldTouchingFillLoops(mesh);
    mesh.materialSlots = [null];
    return mesh;
  }
  classifyFillLoops(loops);
  for (let li = 0; li < loops.length; li++) {
    const loop = loops[li];
    if (loop.depth % 2 !== 0) continue;
    const holes = loops.filter((h) => h.parent === li && h.depth === loop.depth + 1);
    if (!holes.length) {
      if (mode !== "NGONS" || !emitSelfTouchingNgonFill(mesh, loop)) emitSimpleFill(mesh, loop.points, mode);
    }
    else if (mode === "NGONS") emitHoledNgonFill(mesh, loop, holes);
    else emitHoledFill(mesh, loop, holes);
  }
  weldTouchingFillLoops(mesh);
  mesh.materialSlots = [null];
  return mesh;
}

// Fill Curve keeps separate faces for contours that only touch, but their
// coincident corners share one mesh vertex. Pixel fonts rely on this: several
// square glyph cells meet at a corner without becoming one polygon. Welding
// only the emitted vertices preserves the face partition and even-odd loop
// classification while matching Blender's final topology.
function weldTouchingFillLoops(mesh: Mesh): void {
  if (mesh.positions.length < 2) return;
  const tolerance = 1e-7;
  const buckets = new Map<string, number[]>();
  const positions: Vec3[] = [];
  const remap: number[] = new Array(mesh.positions.length);
  for (let index = 0; index < mesh.positions.length; index++) {
    const point = mesh.positions[index];
    const qx = Math.round(point[0] / tolerance);
    const qy = Math.round(point[1] / tolerance);
    const qz = Math.round(point[2] / tolerance);
    let representative = -1;
    for (let x = qx - 1; x <= qx + 1 && representative < 0; x++)
      for (let y = qy - 1; y <= qy + 1 && representative < 0; y++)
        for (let z = qz - 1; z <= qz + 1 && representative < 0; z++)
          for (const candidate of buckets.get(`${x}:${y}:${z}`) ?? [])
            if (vlen(vsub(point, positions[candidate])) <= tolerance) { representative = candidate; break; }
    if (representative < 0) {
      representative = positions.length;
      positions.push(point);
      const key = `${qx}:${qy}:${qz}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(representative);
      else buckets.set(key, [representative]);
    }
    remap[index] = representative;
  }
  if (positions.length === mesh.positions.length) return;
  mesh.positions = positions;
  mesh.faces = mesh.faces.map((face) => {
    const mapped: number[] = [];
    for (const vertex of face) if (mapped[mapped.length - 1] !== remap[vertex]) mapped.push(remap[vertex]);
    if (mapped.length > 1 && mapped[0] === mapped[mapped.length - 1]) mapped.pop();
    return mapped;
  });
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

const FILL_EPS = 1e-12;

function loopHasSelfTouch(loop: FillLoop): boolean {
  for (let i = 0; i < loop.points2.length; i++) for (let j = i + 1; j < loop.points2.length; j++) {
    if (same2(loop.points2[i], loop.points2[j])) return true;
  }
  return false;
}

// Blender's N-gon CDT globally nodes collinear constraints. In the pixel-font
// spacing sweep, a simple contour partially overlaps a self-touching contour;
// Blender keeps the non-zero arrangement cells but leaves the simple-only strip
// loose. This helper is deliberately gated on that uncommon pattern so normal
// nested-loop N-gon fills retain the exact bridge topology below.
function emitOverlappingNgonFill(mesh: Mesh, loops: FillLoop[]): boolean {
  const selfTouching = new Set<number>();
  for (let i = 0; i < loops.length; i++) if (loopHasSelfTouch(loops[i])) selfTouching.add(i);
  if (!selfTouching.size) return false;

  const suppressedSimple = new Set<number>();
  for (let simple = 0; simple < loops.length; simple++) {
    if (selfTouching.has(simple)) continue;
    for (const complex of selfTouching) {
      const relation = loops[simple].points2.map((point) => pointInPolygon(point, loops[complex].points2));
      // A boundary-only touch must not suppress the neighboring simple cell.
      // Require a point strictly inside the self-touching walk as well as one
      // outside it; the pixel-font fixture also has several harmless corner
      // contacts that Blender's CDT keeps filled.
      if (relation.some((value) => value > 0) && relation.some((value) => value < 0)) {
        suppressedSimple.add(simple);
        break;
      }
    }
  }
  if (!suppressedSimple.size) return false;

  const tolerance = 1e-7;
  const points2: Vec2[] = [];
  const points3: Vec3[] = [];
  const loopVertices: number[][] = [];
  for (const loop of loops) {
    const indices: number[] = [];
    for (let i = 0; i < loop.points2.length; i++) {
      const point = loop.points2[i];
      let index = points2.findIndex((candidate) => Math.hypot(point[0] - candidate[0], point[1] - candidate[1]) <= tolerance);
      if (index < 0) {
        index = points2.length;
        points2.push(point);
        points3.push([...loop.points[i]] as Vec3);
      }
      indices.push(index);
    }
    loopVertices.push(indices);
  }

  // Split every authored segment at every authored point lying on it. XOR the
  // resulting undirected constraints so coincident overlap boundaries cancel.
  const edgeMultiplicity = new Map<string, number>();
  for (const indices of loopVertices) for (let segment = 0; segment < indices.length; segment++) {
    const ia = indices[segment], ib = indices[(segment + 1) % indices.length];
    const a = points2[ia], b = points2[ib];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const length2 = dx * dx + dy * dy;
    if (length2 <= FILL_EPS) continue;
    const cuts: { t: number; vertex: number }[] = [];
    for (let vertex = 0; vertex < points2.length; vertex++) {
      const point = points2[vertex];
      const t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2;
      const cross = Math.abs((point[0] - a[0]) * dy - (point[1] - a[1]) * dx);
      if (t >= -1e-9 && t <= 1 + 1e-9 && cross <= tolerance * Math.sqrt(length2)) {
        cuts.push({ t: Math.max(0, Math.min(1, t)), vertex });
      }
    }
    cuts.sort((left, right) => left.t - right.t);
    for (let cut = 0; cut + 1 < cuts.length; cut++) {
      const u = cuts[cut].vertex, v = cuts[cut + 1].vertex;
      if (u === v) continue;
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      edgeMultiplicity.set(key, (edgeMultiplicity.get(key) ?? 0) + 1);
    }
  }
  const edges: [number, number][] = [];
  for (const [key, multiplicity] of edgeMultiplicity) if (multiplicity % 2) {
    const [a, b] = key.split(":").map(Number);
    edges.push([a, b]);
  }

  const adjacency = points2.map(() => [] as number[]);
  for (const [a, b] of edges) { adjacency[a].push(b); adjacency[b].push(a); }
  for (let vertex = 0; vertex < adjacency.length; vertex++) adjacency[vertex].sort((a, b) =>
    Math.atan2(points2[a][1] - points2[vertex][1], points2[a][0] - points2[vertex][0])
    - Math.atan2(points2[b][1] - points2[vertex][1], points2[b][0] - points2[vertex][0]));

  const windingAt = (point: Vec2) => {
    let winding = 0;
    for (const loop of loops) for (let i = 0; i < loop.points2.length; i++) {
      const a = loop.points2[i], b = loop.points2[(i + 1) % loop.points2.length];
      if (a[1] <= point[1]) {
        if (b[1] > point[1] && cross2(a, b, point) > 0) winding++;
      } else if (b[1] <= point[1] && cross2(a, b, point) < 0) winding--;
    }
    return winding;
  };
  const containingLoops = (point: Vec2) => loops
    .map((loop, index) => pointInPolygon(point, loop.points2) > 0 ? index : -1)
    .filter((index) => index >= 0);

  const visited = new Set<string>();
  const faces: number[][] = [];
  for (let start = 0; start < adjacency.length; start++) for (const first of adjacency[start]) {
    if (visited.has(`${start}:${first}`)) continue;
    const face: number[] = [];
    let previous = start, current = first;
    while (!visited.has(`${previous}:${current}`) && face.length <= edges.length + 1) {
      visited.add(`${previous}:${current}`);
      face.push(previous);
      const around = adjacency[current];
      const reverse = around.indexOf(previous);
      if (reverse < 0 || !around.length) break;
      const next = around[(reverse - 1 + around.length) % around.length];
      previous = current;
      current = next;
      if (previous === start && current === first) break;
    }
    if (previous !== start || current !== first || face.length < 3) continue;
    const refs = face.map((vertex) => ({ p: points2[vertex], vi: vertex }));
    if (signedAreaRefs(refs) <= FILL_EPS) continue;
    const triangles = earClip(refs);
    const firstTriangle = triangles[0];
    if (!firstTriangle) continue;
    const sample = avg2(firstTriangle.map((vertex) => points2[vertex]));
    if (windingAt(sample) === 0) continue;
    const containers = containingLoops(sample);
    if (containers.length === 1 && suppressedSimple.has(containers[0])) continue;
    faces.push(face);
  }
  if (!faces.length) return false;

  const base = mesh.positions.length;
  mesh.positions.push(...points3);
  for (const face of faces) {
    mesh.faces.push(face.map((vertex) => base + vertex));
    mesh.faceMaterial.push(0);
  }
  return true;
}

// A pixel-font outline can walk through the same bridge vertex more than once.
// Blender's N-gon fill treats that walk as a planar graph and emits each odd-
// winding bounded cell separately. A single polygon with repeated corners
// instead left two 20-gons where Blender creates a 16-gon plus a 4-gon.
function emitSelfTouchingNgonFill(mesh: Mesh, loop: FillLoop): boolean {
  const tolerance = 1e-7;
  const unique: Vec2[] = [];
  const sourceToUnique: number[] = [];
  let repeated = false;
  for (const point of loop.points2) {
    let index = unique.findIndex((candidate) => Math.hypot(point[0] - candidate[0], point[1] - candidate[1]) <= tolerance);
    if (index < 0) {
      index = unique.length;
      unique.push(point);
    } else repeated = true;
    sourceToUnique.push(index);
  }
  if (!repeated || unique.length < 3) return false;

  const edges: [number, number][] = [];
  const edgeKeys = new Set<string>();
  for (let i = 0; i < sourceToUnique.length; i++) {
    const a = sourceToUnique[i], b = sourceToUnique[(i + 1) % sourceToUnique.length];
    if (a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (!edgeKeys.has(key)) { edgeKeys.add(key); edges.push([a, b]); }
  }
  const adjacency = unique.map(() => [] as number[]);
  for (const [a, b] of edges) { adjacency[a].push(b); adjacency[b].push(a); }
  for (let vertex = 0; vertex < adjacency.length; vertex++) adjacency[vertex].sort((a, b) =>
    Math.atan2(unique[a][1] - unique[vertex][1], unique[a][0] - unique[vertex][0])
    - Math.atan2(unique[b][1] - unique[vertex][1], unique[b][0] - unique[vertex][0]));

  const windingAt = (point: Vec2) => {
    let winding = 0;
    for (let i = 0; i < loop.points2.length; i++) {
      const a = loop.points2[i], b = loop.points2[(i + 1) % loop.points2.length];
      if (a[1] <= point[1]) {
        if (b[1] > point[1] && cross2(a, b, point) > 0) winding++;
      } else if (b[1] <= point[1] && cross2(a, b, point) < 0) winding--;
    }
    return winding;
  };

  const visited = new Set<string>();
  const candidates: number[][] = [];
  for (let start = 0; start < adjacency.length; start++) for (const first of adjacency[start]) {
    const initial = `${start}:${first}`;
    if (visited.has(initial)) continue;
    const face: number[] = [];
    let previous = start, current = first;
    while (!visited.has(`${previous}:${current}`) && face.length <= edges.length + 1) {
      visited.add(`${previous}:${current}`);
      face.push(previous);
      const around = adjacency[current];
      const reverse = around.indexOf(previous);
      if (reverse < 0 || !around.length) break;
      const next = around[(reverse - 1 + around.length) % around.length];
      previous = current;
      current = next;
      if (previous === start && current === first) break;
    }
    if (previous !== start || current !== first || face.length < 3) continue;
    const refs = face.map((vi) => ({ p: unique[vi], vi }));
    if (signedAreaRefs(refs) <= FILL_EPS) continue;
    if (Math.abs(windingAt(avg2(refs.map((ref) => ref.p)))) % 2 === 0) continue;
    candidates.push(face);
  }
  if (candidates.length <= 1) return false;

  const base = mesh.positions.length;
  for (let i = 0; i < unique.length; i++) {
    const source = sourceToUnique.indexOf(i);
    mesh.positions.push([...loop.points[source]] as Vec3);
  }
  for (const face of candidates) {
    mesh.faces.push(face.map((vertex) => base + vertex));
    mesh.faceMaterial.push(0);
  }
  return true;
}

function emitIntersectingFill(mesh: Mesh, loops: FillLoop[], plane: FillPlane): boolean {
  if (loops.length < 2) return false;
  type Split = { t: number; vi: number };
  const bases: number[] = [];
  for (const loop of loops) {
    bases.push(mesh.positions.length);
    for (const point of loop.points) mesh.positions.push([...point] as Vec3);
  }
  const splits = loops.map((loop) => loop.points.map(() => [] as Split[]));
  const bounds = loops.map((loop) => ({
    minX: Math.min(...loop.points2.map((point) => point[0])),
    minY: Math.min(...loop.points2.map((point) => point[1])),
    maxX: Math.max(...loop.points2.map((point) => point[0])),
    maxY: Math.max(...loop.points2.map((point) => point[1])),
  }));
  const intersectionByKey = new Map<string, number>();
  let intersectionCount = 0;
  const properIntersection = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): { ta: number; tb: number } | null => {
    const abx = b[0] - a[0], aby = b[1] - a[1];
    const cdx = d[0] - c[0], cdy = d[1] - c[1];
    const denominator = abx * cdy - aby * cdx;
    if (Math.abs(denominator) <= FILL_EPS) return null;
    const acx = c[0] - a[0], acy = c[1] - a[1];
    const ta = (acx * cdy - acy * cdx) / denominator;
    const tb = (acx * aby - acy * abx) / denominator;
    const endpointEpsilon = 1e-8;
    return ta > endpointEpsilon && ta < 1 - endpointEpsilon && tb > endpointEpsilon && tb < 1 - endpointEpsilon
      ? { ta, tb }
      : null;
  };
  for (let ai = 0; ai < loops.length; ai++) for (let bi = ai + 1; bi < loops.length; bi++) {
    const ab = bounds[ai], bb = bounds[bi];
    if (ab.maxX < bb.minX || bb.maxX < ab.minX || ab.maxY < bb.minY || bb.maxY < ab.minY) continue;
    const a = loops[ai], b = loops[bi];
    for (let ase = 0; ase < a.points2.length; ase++) {
      const a0 = a.points2[ase], a1 = a.points2[(ase + 1) % a.points2.length];
      const aminX = Math.min(a0[0], a1[0]), amaxX = Math.max(a0[0], a1[0]);
      const aminY = Math.min(a0[1], a1[1]), amaxY = Math.max(a0[1], a1[1]);
      for (let bse = 0; bse < b.points2.length; bse++) {
        const b0 = b.points2[bse], b1 = b.points2[(bse + 1) % b.points2.length];
        if (amaxX < Math.min(b0[0], b1[0]) || Math.max(b0[0], b1[0]) < aminX
          || amaxY < Math.min(b0[1], b1[1]) || Math.max(b0[1], b1[1]) < aminY) continue;
        const hit = properIntersection(a0, a1, b0, b1);
        if (!hit) continue;
        const point2: Vec2 = [a0[0] + (a1[0] - a0[0]) * hit.ta, a0[1] + (a1[1] - a0[1]) * hit.ta];
        const key = `${Math.round(point2[0] * 1e10)}:${Math.round(point2[1] * 1e10)}`;
        let vi = intersectionByKey.get(key);
        if (vi === undefined) {
          vi = mesh.positions.length;
          mesh.positions.push(vadd(a.points[ase], vscale(vsub(a.points[(ase + 1) % a.points.length], a.points[ase]), hit.ta)));
          intersectionByKey.set(key, vi);
          intersectionCount++;
        }
        splits[ai][ase].push({ t: hit.ta, vi });
        splits[bi][bse].push({ t: hit.tb, vi });
      }
    }
  }
  if (!intersectionCount) {
    mesh.positions.length = bases[0] ?? 0;
    return false;
  }

  const positions2: Vec2[] = mesh.positions.map((point) => projectFillPoint(point, plane));
  const edges: [number, number][] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (a: number, b: number) => {
    if (a === b) return;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push([a, b]);
  };
  for (let li = 0; li < loops.length; li++) {
    const loop = loops[li];
    for (let segment = 0; segment < loop.points.length; segment++) {
      const start = bases[li] + segment;
      const end = bases[li] + (segment + 1) % loop.points.length;
      const chain = [start, ...splits[li][segment].sort((a, b) => a.t - b.t).map((split) => split.vi), end];
      for (let i = 0; i + 1 < chain.length; i++) addEdge(chain[i], chain[i + 1]);
    }
  }
  const adjacency = new Map<number, number[]>();
  for (const [a, b] of edges) {
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  }
  for (const [vertex, neighbors] of adjacency) neighbors.sort((a, b) =>
    Math.atan2(positions2[a][1] - positions2[vertex][1], positions2[a][0] - positions2[vertex][0])
    - Math.atan2(positions2[b][1] - positions2[vertex][1], positions2[b][0] - positions2[vertex][0]));
  const visited = new Set<string>();
  const directedKey = (a: number, b: number) => `${a}:${b}`;
  const windingAt = (point: Vec2): number => {
    let winding = 0;
    for (const loop of loops) {
      for (let i = 0; i < loop.points2.length; i++) {
        const a = loop.points2[i], b = loop.points2[(i + 1) % loop.points2.length];
        if (a[1] <= point[1]) {
          if (b[1] > point[1] && cross2(a, b, point) > 0) winding++;
        } else if (b[1] <= point[1] && cross2(a, b, point) < 0) winding--;
      }
    }
    return winding;
  };
  for (const [start, neighbors] of adjacency) for (const first of neighbors) {
    if (visited.has(directedKey(start, first))) continue;
    const face: number[] = [];
    let previous = start, current = first;
    while (!visited.has(directedKey(previous, current)) && face.length <= edges.length + 1) {
      visited.add(directedKey(previous, current));
      face.push(previous);
      const around = adjacency.get(current) ?? [];
      const reverse = around.indexOf(previous);
      if (reverse < 0 || !around.length) break;
      const next = around[(reverse - 1 + around.length) % around.length];
      previous = current;
      current = next;
      if (previous === start && current === first) break;
    }
    if (previous !== start || current !== first || face.length < 3) continue;
    const refs = face.map((vi) => ({ p: positions2[vi], vi }));
    if (signedAreaRefs(refs) <= FILL_EPS) continue;
    const center = avg2(refs.map((ref) => ref.p));
    // Fill Curve's Triangles mode uses the even-odd rule: overlap regions with
    // winding two are holes, while each singly covered side remains filled.
    if (Math.abs(windingAt(center)) % 2 === 0) continue;
    for (const triangle of earClip(refs)) {
      mesh.faces.push(triangle);
      mesh.faceMaterial.push(0);
    }
  }
  return true;
}

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
    // Fill Curve emits a +Z-facing polygon in its local XY plane regardless
    // of the cyclic spline's authored direction. Blender canonicalizes the
    // cyclic start at the lowest Y corner (observable when Extrude Mesh emits
    // duplicate vertices in face-corner order), while retaining the original
    // cyclic direction.
    const start = points.reduce((best, point, index) =>
      point[1] < points[best][1] || (point[1] === points[best][1] && point[0] < points[best][0]) ? index : best, 0);
    const face = Array.from({ length: n }, (_, i) => base + (start + i) % n);
    if (signedArea2(points.map((point) => [point[0], point[1]])) < 0) face.reverse();
    mesh.faces.push(face);
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

// Blender's N-gon fill keeps the number of faces equal to the number of input
// loops, but it does not fill nested loops independently. It connects a hole to
// its containing polygon with two non-crossing bridges, splitting that polygon
// into two simple N-gons. Each additional hole repeats the split and adds one
// face, preserving the authored-loop face count while leaving the hole open.
function emitHoledNgonFill(mesh: Mesh, outer: FillLoop, holes: FillLoop[]) {
  const baseByLoop = new Map<FillLoop, number>();
  const addLoop = (loop: FillLoop) => {
    const base = mesh.positions.length;
    baseByLoop.set(loop, base);
    for (const p of loop.points) mesh.positions.push([...p] as Vec3);
  };
  addLoop(outer);
  for (const hole of holes) addLoop(hole);

  let polygons: PolyRef[][] = [orientedRefs(outer, baseByLoop.get(outer)!, true)];
  const pending = holes
    .map((hole) => orientedRefs(hole, baseByLoop.get(hole)!, false))
    .sort((a, b) => rightmostX(b) - rightmostX(a));
  for (let hi = 0; hi < pending.length; hi++) {
    const hole = pending[hi];
    const center = avg2(hole.map((ref) => ref.p));
    let polygonIndex = polygons.findIndex((polygon) => pointInPolygon(center, polygon.map((ref) => ref.p)) >= 0);
    if (polygonIndex < 0) polygonIndex = 0;
    const split = splitPolygonAroundHole(polygons[polygonIndex], hole, pending.slice(hi));
    if (split) polygons.splice(polygonIndex, 1, ...split);
    else polygons.push(hole);
  }
  for (let face of polygons) {
    face = cleanPoly(face);
    if (face.length < 3) continue;
    if (signedAreaRefs(face) < 0) face.reverse();
    mesh.faces.push(face.map((ref) => ref.vi));
    mesh.faceMaterial.push(0);
  }
}

function splitPolygonAroundHole(ring: PolyRef[], hole: PolyRef[], allHoles: PolyRef[][]): [PolyRef[], PolyRef[]] | null {
  type Candidate = { ring: number; hole: number; d2: number };
  const candidates: Candidate[] = [];
  const ringPoints = ring.map((ref) => ref.p);
  const holePoints = hole.map((ref) => ref.p);
  for (let ri = 0; ri < ring.length; ri++) for (let hi = 0; hi < hole.length; hi++) {
    if (!visibleBridge(ring[ri], hole[hi], ring, allHoles, hole)) continue;
    const midpoint: Vec2 = [(ring[ri].p[0] + hole[hi].p[0]) * 0.5, (ring[ri].p[1] + hole[hi].p[1]) * 0.5];
    if (pointInPolygon(midpoint, ringPoints) < 0 || pointInPolygon(midpoint, holePoints) > 0) continue;
    candidates.push({ ring: ri, hole: hi, d2: dist2(ring[ri].p, hole[hi].p) });
  }
  candidates.sort((a, b) => a.d2 - b.d2);
  for (let ai = 0; ai < candidates.length; ai++) {
    const a = candidates[ai];
    for (let bi = ai + 1; bi < candidates.length; bi++) {
      const b = candidates[bi];
      if (a.ring === b.ring || a.hole === b.hole) continue;
      if (segmentsIntersect(ring[a.ring].p, hole[a.hole].p, ring[b.ring].p, hole[b.hole].p)) continue;
      const ringAB = cyclicArc(ring, a.ring, b.ring);
      const ringBA = cyclicArc(ring, b.ring, a.ring);
      const holeBA = cyclicArc(hole, b.hole, a.hole);
      const holeAB = cyclicArc(hole, a.hole, b.hole);
      return [[...ringAB, ...holeBA], [...ringBA, ...holeAB]];
    }
  }
  return null;
}

function cyclicArc<T>(items: T[], start: number, end: number): T[] {
  const out: T[] = [];
  for (let i = start; ; i = (i + 1) % items.length) {
    out.push(items[i]);
    if (i === end) return out;
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
  } else if (verts.length === 3 && new Set(verts.map((v) => v.vi)).size === 3) {
    // A valid polygon can finish on three collinear boundary points after all
    // non-degenerate ears have been removed. Blender preserves the middle
    // authored point by splitting the neighboring triangle that spans the two
    // endpoints. Stackable Bin's groove cells expose one such point after the
    // optional rounded-outline crossing is resolved.
    const middle = verts.findIndex((candidate, i) => {
      const a = verts[(i + 1) % 3].p, b = candidate.p, c = verts[(i + 2) % 3].p;
      return Math.abs(cross2(a, b, c)) <= FILL_EPS
        && (b[0] - a[0]) * (b[0] - c[0]) + (b[1] - a[1]) * (b[1] - c[1]) <= FILL_EPS;
    });
    if (middle >= 0) {
      const point = verts[middle].vi;
      const endpointA = verts[(middle + 1) % 3].vi;
      const endpointB = verts[(middle + 2) % 3].vi;
      const faceIndex = faces.findIndex((face) => face.some((vertex, corner) => {
        const next = face[(corner + 1) % face.length];
        return (vertex === endpointA && next === endpointB) || (vertex === endpointB && next === endpointA);
      }));
      if (faceIndex >= 0) {
        const face = faces[faceIndex];
        for (let corner = 0; corner < face.length; corner++) {
          const a = face[corner], b = face[(corner + 1) % face.length];
          if (!((a === endpointA && b === endpointB) || (a === endpointB && b === endpointA))) continue;
          const opposite = face[(corner + 2) % face.length];
          faces[faceIndex] = [a, point, opposite];
          faces.push([point, b, opposite]);
          break;
        }
      }
    }
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
  let strictlyInside = false;
  for (const p of inner.points2) {
    const r = pointInPolygon(p, outer.points2);
    // Partial overlap is not containment. The old first-inside-point shortcut
    // classified every groove crossing Stackable Bin's rounded boundary as a
    // hole, dropping the whole 68-point loop instead of letting Fill Curve
    // resolve its boundary intersections.
    if (r < 0) return false;
    if (r > 0) strictlyInside = true;
  }
  return strictlyInside || pointInPolygon(avg2(inner.points2), outer.points2) > 0;
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
  if (!mesh.attributes.has("__gnvm_explicit_edges_only"))
    for (const f of mesh.faces) for (let i = 0; i < f.length; i++) addE(f[i], f[(i + 1) % f.length]);
  const out: { spline: Spline; verts: number[] }[] = [];
  const visitedEdge = new Set<string>();
  const ek = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  // Blender Mesh to Curve semantics: splines break at "poles" (valence != 2).
  // Walk pole-to-pole open chains first, then what remains are pure cycles.
  const isPole = (v: number) => (adj.get(v)?.size ?? 0) !== 2;
  const walk = (start: number, next: number, repeatStartOnClosure = false): number[] => {
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
      if (cur === start) {
        // A cycle attached to a branch pole is not a cyclic spline in
        // Blender. It is an open pole-to-same-pole spline, so the pole occurs
        // at both ends. Omitting this repeated endpoint silently drops the
        // closing edge when Curve to Mesh consumes the result.
        if (repeatStartOnClosure) chain.push(cur);
        break;
      }
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
      emit(walk(start, nb, true), false);
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
