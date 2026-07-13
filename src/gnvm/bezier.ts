import { Vec3 } from "./core";
import { Spline } from "./geometry";

export const BEZIER_SAMPLES_PER_SEGMENT = 12;

function clonePoint(point: Vec3): Vec3 {
  return [...point] as Vec3;
}

function defaultHandles(points: Vec3[], cyclic: boolean): { left: Vec3[]; right: Vec3[] } {
  void cyclic;
  // Set Spline Type creates zero-length free handles. Subsequent Set Handle
  // Positions offsets therefore start at each knot, which is observable in
  // the Nodes Node noodle groups where every left/right handle is displaced.
  return { left: points.map(clonePoint), right: points.map(clonePoint) };
}

function cubicBezier(a: Vec3, b: Vec3, c: Vec3, d: Vec3, t: number): Vec3 {
  const u = 1 - t;
  const u2 = u * u;
  const t2 = t * t;
  return [
    u2 * u * a[0] + 3 * u2 * t * b[0] + 3 * u * t2 * c[0] + t2 * t * d[0],
    u2 * u * a[1] + 3 * u2 * t * b[1] + 3 * u * t2 * c[1] + t2 * t * d[1],
    u2 * u * a[2] + 3 * u2 * t * b[2] + 3 * u * t2 * c[2] + t2 * t * d[2],
  ];
}

export function evaluateBezierSpline(
  controlPoints: Vec3[],
  cyclic: boolean,
  leftHandles: Vec3[],
  rightHandles: Vec3[],
  samplesPerSegment = BEZIER_SAMPLES_PER_SEGMENT,
): Vec3[] {
  if (controlPoints.length < 2) return controlPoints.map(clonePoint);
  const evaluated: Vec3[] = [];
  const segmentCount = cyclic ? controlPoints.length : controlPoints.length - 1;
  for (let segment = 0; segment < segmentCount; segment++) {
    const next = (segment + 1) % controlPoints.length;
    const startSample = segment === 0 ? 0 : 1;
    const endSample = cyclic ? samplesPerSegment - 1 : samplesPerSegment;
    for (let sample = startSample; sample <= endSample; sample++) {
      evaluated.push(cubicBezier(
        controlPoints[segment],
        rightHandles[segment] ?? controlPoints[segment],
        leftHandles[next] ?? controlPoints[next],
        controlPoints[next],
        sample / samplesPerSegment,
      ));
    }
  }
  return evaluated;
}

export function asBezierSpline(source: Spline): Spline {
  const controlPoints = (source.controlPoints?.length ? source.controlPoints : source.points).map(clonePoint);
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
    points: evaluateBezierSpline(controlPoints, source.cyclic, bezierLeft, bezierRight, source.resolution ?? BEZIER_SAMPLES_PER_SEGMENT),
  };
}
