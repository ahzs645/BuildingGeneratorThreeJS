import { Vec3 } from "./core";
import { Spline } from "./geometry";

export const BEZIER_SAMPLES_PER_SEGMENT = 12;

function clonePoint(point: Vec3): Vec3 {
  return [...point] as Vec3;
}

function defaultHandles(points: Vec3[], cyclic: boolean): { left: Vec3[]; right: Vec3[] } {
  const left = points.map(clonePoint);
  const right = points.map(clonePoint);
  if (!cyclic && points.length === 2) {
    // Blender converts a two-point Poly spline to Bézier with endpoint handles
    // one third of the chord apart. Nodes Node then offsets both sides; using
    // zero-length handles produced the same topology but a visibly different
    // S-curve and 0.33-unit bounds error.
    const chordThird = scale(sub(points[1], points[0]), Math.fround(1 / 3));
    left[0] = sub(points[0], chordThird);
    right[0] = add(points[0], chordThird);
    left[1] = sub(points[1], chordThird);
    right[1] = add(points[1], chordThird);
  }
  return { left, right };
}

function fadd(a: number, b: number): number {
  return Math.fround(Math.fround(a) + Math.fround(b));
}

function fsub(a: number, b: number): number {
  return Math.fround(Math.fround(a) - Math.fround(b));
}

function fmul(a: number, b: number): number {
  return Math.fround(Math.fround(a) * Math.fround(b));
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [fadd(a[0], b[0]), fadd(a[1], b[1]), fadd(a[2], b[2])];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [fsub(a[0], b[0]), fsub(a[1], b[1]), fsub(a[2], b[2])];
}

function scale(a: Vec3, factor: number): Vec3 {
  return [fmul(a[0], factor), fmul(a[1], factor), fmul(a[2], factor)];
}

// Blender evaluates Bezier segments with float32 forward differences rather
// than independently evaluating the cubic polynomial at every parameter. The
// accumulated rounding is observable after arc-length resampling and changes
// a handful of Chrome Crayon marching intersections.
function evaluateSegmentForward(a: Vec3, b: Vec3, c: Vec3, d: Vec3, sampleCount: number): Vec3[] {
  const inverse = Math.fround(1 / sampleCount);
  const inverseSquared = fmul(inverse, inverse);
  const inverseCubed = fmul(inverseSquared, inverse);
  const rt1 = scale(scale(sub(b, a), 3), inverse);
  const rt2 = scale(scale(add(sub(a, scale(b, 2)), c), 3), inverseSquared);
  const rt3 = scale(add(sub(d, a), scale(sub(b, c), 3)), inverseCubed);
  let q0 = clonePoint(a).map(Math.fround) as Vec3;
  let q1 = add(add(rt1, rt2), rt3);
  let q2 = add(scale(rt2, 2), scale(rt3, 6));
  const q3 = scale(rt3, 6);
  const result: Vec3[] = [];
  for (let sample = 0; sample < sampleCount; sample++) {
    result.push(clonePoint(q0));
    q0 = add(q0, q1);
    q1 = add(q1, q2);
    q2 = add(q2, q3);
  }
  return result;
}

export function evaluateBezierSpline(
  controlPoints: Vec3[],
  cyclic: boolean,
  leftHandles: Vec3[],
  rightHandles: Vec3[],
  samplesPerSegment = BEZIER_SAMPLES_PER_SEGMENT,
): Vec3[] {
  if (controlPoints.length < 2) return controlPoints.map(clonePoint);
  samplesPerSegment = Math.max(1, Math.floor(samplesPerSegment));
  const evaluated: Vec3[] = [];
  const segmentCount = cyclic ? controlPoints.length : controlPoints.length - 1;
  for (let segment = 0; segment < segmentCount; segment++) {
    const next = (segment + 1) % controlPoints.length;
    evaluated.push(...evaluateSegmentForward(
      controlPoints[segment],
      rightHandles[segment] ?? controlPoints[segment],
      leftHandles[next] ?? controlPoints[next],
      controlPoints[next],
      samplesPerSegment,
    ));
  }
  if (!cyclic) evaluated.push(clonePoint(controlPoints[controlPoints.length - 1]).map(Math.fround) as Vec3);
  return evaluated;
}

export function asBezierSpline(source: Spline): Spline {
  const controlPoints = (source.controlPoints?.length ? source.controlPoints : source.points).map(clonePoint);
  const hadBezierHandles = source.bezierLeft?.length === controlPoints.length
    && source.bezierRight?.length === controlPoints.length;
  const defaults = defaultHandles(controlPoints, source.cyclic);
  const bezierLeft = source.bezierLeft?.length === controlPoints.length
    ? source.bezierLeft.map(clonePoint)
    : defaults.left;
  const bezierRight = source.bezierRight?.length === controlPoints.length
    ? source.bezierRight.map(clonePoint)
    : defaults.right;
  return {
    cyclic: source.cyclic,
    resolution: source.resolution ?? BEZIER_SAMPLES_PER_SEGMENT,
    controlPoints,
    bezierLeft,
    bezierRight,
    // Set Spline Type converts a poly spline to Bézier control points without
    // immediately multiplying its evaluated topology. Blender retains those
    // points until a later handle edit/resolution node creates curved samples.
    // Existing authored Bézier handles still need their evaluated curve here.
    points: hadBezierHandles
      ? evaluateBezierSpline(controlPoints, source.cyclic, bezierLeft, bezierRight, source.resolution ?? BEZIER_SAMPLES_PER_SEGMENT)
      : controlPoints.map(clonePoint),
  };
}
