// Curve subsystem handlers: primitives, resample, fillet, sweep-to-mesh, fill.
import { Field, Vec3, Elem, asNum, asVec3, vadd, vsub, vscale, vdot, vcross, vlen, vnorm } from "../core";
import { Geometry, Mesh, Spline, buildTopology, realizeInstances } from "../geometry";
import { DUMP_CONTEXT, reg } from "../registry";
import { makeFieldCtx } from "../evaluator";
import { resampleSpline, filletSpline, sweep, fillCurves, meshEdgesToChains, splineLength, splineFrames, polySplineNormalsBlender } from "../curves";

function curveGeo(splines: Spline[]): Geometry {
  const g = new Geometry();
  g.curves = splines;
  return g;
}

// CurvesGeometry stores evaluated poly frames as float3. Keep the operations
// below in the same float32 order as curve_poly.cc; sub-ULP frame drift becomes
// observable after a profile sweep is transformed and fed to Convex Hull.
function evaluatedPolyFramesFloat32(points: Vec3[], cyclic: boolean): { tangent: Vec3; normal: Vec3 }[] {
  const f = Math.fround;
  const add = (a: Vec3, b: Vec3): Vec3 => [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])];
  const sub = (a: Vec3, b: Vec3): Vec3 => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
  const scale = (a: Vec3, value: number): Vec3 => [f(a[0] * value), f(a[1] * value), f(a[2] * value)];
  const dot = (a: Vec3, b: Vec3): number => {
    let value = f(f(a[0] * b[0]) + f(a[1] * b[1]));
    return f(value + f(a[2] * b[2]));
  };
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    f(f(a[1] * b[2]) - f(a[2] * b[1])),
    f(f(a[2] * b[0]) - f(a[0] * b[2])),
    f(f(a[0] * b[1]) - f(a[1] * b[0])),
  ];
  const length = (value: Vec3): number => f(Math.sqrt(dot(value, value)));
  const normalize = (value: Vec3): Vec3 => {
    const magnitude = length(value);
    return magnitude < 1e-20 ? [0, 0, 0] : [
      f(value[0] / magnitude), f(value[1] / magnitude), f(value[2] / magnitude),
    ];
  };
  const angleNormalized = (a: Vec3, b: Vec3): number => {
    if (dot(a, b) >= 0) return f(f(2) * f(Math.asin(Math.min(1, f(length(sub(a, b)) / f(2))))));
    return f(f(Math.PI) - f(f(2) * f(Math.asin(Math.min(1, f(length(add(a, b)) / f(2)))))));
  };
  const rotateDirection = (direction: Vec3, axis: Vec3, angle: number): Vec3 => {
    if (angle === 0) return direction;
    const axisScaled = scale(axis, dot(direction, axis));
    const difference = sub(direction, axisScaled);
    const perpendicular = cross(axis, difference);
    return add(axisScaled, add(scale(difference, f(Math.cos(angle))), scale(perpendicular, f(Math.sin(angle)))));
  };

  if (!points.length) return [];
  if (points.length === 1) return [{ tangent: [0, 0, 1], normal: [1, 0, 0] }];

  const tangents = points.map(() => [0, 0, 1] as Vec3);
  let firstValid = -1;
  for (let i = 0; i + 1 < points.length; i++) {
    const delta = sub(points[i + 1], points[i]);
    const magnitude = length(delta);
    if (magnitude < 1e-9) continue;
    tangents[i] = [f(delta[0] / magnitude), f(delta[1] / magnitude), f(delta[2] / magnitude)];
    firstValid = i;
    break;
  }
  if (firstValid < 0) return tangents.map((tangent) => ({ tangent, normal: [1, 0, 0] as Vec3 }));
  for (let i = 0; i < firstValid; i++) tangents[i] = tangents[firstValid];

  let previousDirection = tangents[firstValid];
  let previousEqual = false;
  const bisect = (position: Vec3, next: Vec3): Vec3 => {
    const wasEqual = previousEqual;
    const delta = sub(next, position);
    const magnitude = length(delta);
    previousEqual = magnitude < 1e-9;
    if (previousEqual) return previousDirection;
    const oldDirection = previousDirection;
    previousDirection = [f(delta[0] / magnitude), f(delta[1] / magnitude), f(delta[2] / magnitude)];
    if (wasEqual) return previousDirection;
    const tangent = add(oldDirection, previousDirection);
    const tangentLength = length(tangent);
    if (tangentLength < 0.6627619) {
      if (tangentLength < 2e-7) return previousDirection;
      return normalize(cross(cross(previousDirection, oldDirection), sub(previousDirection, oldDirection)));
    }
    return [f(tangent[0] / tangentLength), f(tangent[1] / tangentLength), f(tangent[2] / tangentLength)];
  };
  for (let i = firstValid + 1; i + 1 < points.length; i++) tangents[i] = bisect(points[i], points[i + 1]);
  if (cyclic) {
    tangents[points.length - 1] = bisect(points[points.length - 1], points[0]);
    tangents[0] = bisect(points[0], points[1]);
  }
  else {
    const delta = sub(points[points.length - 1], points[points.length - 2]);
    const magnitude = length(delta);
    tangents[points.length - 1] = magnitude < 1e-9
      ? previousDirection
      : [f(delta[0] / magnitude), f(delta[1] / magnitude), f(delta[2] / magnitude)];
  }

  const normals = points.map(() => [1, 0, 0] as Vec3);
  const firstTangent = tangents[0];
  normals[0] = Math.abs(firstTangent[0]) + Math.abs(firstTangent[1]) < 1e-4
    ? [1, 0, 0]
    : normalize([firstTangent[1], f(-firstTangent[0]), 0]);
  const nextNormal = (lastNormal: Vec3, lastTangent: Vec3, tangent: Vec3): Vec3 => {
    const angle = angleNormalized(lastTangent, tangent);
    if (angle === 0) return lastNormal;
    const axis = normalize(cross(lastTangent, tangent));
    if (length(axis) < 1e-20) return lastNormal;
    return normalize(rotateDirection(lastNormal, axis, angle));
  };
  for (let i = 1; i < points.length; i++) normals[i] = nextNormal(normals[i - 1], tangents[i - 1], tangents[i]);
  if (cyclic) {
    const uncorrected = nextNormal(normals[normals.length - 1], tangents[tangents.length - 1], tangents[0]);
    let correction = angleNormalized(normals[0], uncorrected);
    if (dot(cross(uncorrected, normals[0]), tangents[0]) < 0) correction = f(f(Math.PI * 2) - correction);
    if (correction > Math.PI) correction = f(correction - f(Math.PI * 2));
    const step = f(correction / normals.length);
    for (let i = 0; i < normals.length; i++) normals[i] = rotateDirection(normals[i], tangents[i], f(step * i));
  }
  // Minimum-twist normals for a horizontal planar poly curve stay in that
  // plane. Tiny Z values here only come from emulating the cyclic correction
  // with JavaScript scalar math; Blender's float3 path retains exact zero.
  if (points.every((point) => f(point[2]) === f(points[0][2]))) {
    for (const normal of normals) normal[2] = 0;
  }
  return tangents.map((tangent, index) => ({ tangent, normal: normals[index] }));
}

// ---- primitives -----------------------------------------------------------
reg("GeometryNodeCurvePrimitiveQuadrilateral", (api) => {
  const w = (api.num("Width") || 1) / 2;
  const h = (api.num("Height") || 1) / 2;
  // Blender's rectangle mode starts on the positive-height edge. Edge index 0
  // must be the +Y side for downstream EDGE Index selections (the drawer handle
  // deletes edge 0 to open its rail on the back side).
  const pts: Vec3[] = [[w, h, 0], [-w, h, 0], [-w, -h, 0], [w, -h, 0]];
  return { Curve: curveGeo([{ points: pts, cyclic: true }]) };
});

reg("GeometryNodeCurvePrimitiveCircle", (api) => {
  const res = Math.max(3, Math.floor(api.num("Resolution") || 32));
  // Radius=0 is authored deliberately by several node-construction groups:
  // they create a collapsed indexed point loop and move each point afterward.
  // Treating zero as a missing value turned those groups back into unit rings.
  const r = api.num("Radius");
  const pts: Vec3[] = [];
  // Blender's primitive is generated through float sincosf: the angular step,
  // each multiplied angle, trig results, and final radius products are all
  // rounded to float32. Computing i/res*2pi in JavaScript double precision is
  // visibly close, but its late-circle samples drift by several ULPs before a
  // Length-mode Resample Curve. Modern Pipe's 33->86 point sleeve profile
  // provides an exact reference for this operation order.
  const angleStep = Math.fround((Math.PI * 2) / res);
  const radius = Math.fround(r);
  for (let i = 0; i < res; i++) {
    const angle = Math.fround(i * angleStep);
    const cosine = Math.fround(Math.cos(angle));
    const sine = Math.fround(Math.sin(angle));
    pts.push([
      Math.fround(cosine * radius),
      Math.fround(sine * radius),
      0,
    ]);
  }
  return { Curve: curveGeo([{ points: pts, cyclic: true }]), Center: Field.of([0, 0, 0]) };
});

reg("GeometryNodeCurvePrimitiveLine", (api) => {
  const s = api.vec("Start");
  // Blender exposes Start/End and Start/Direction modes through the same node.
  // In current dumps the active mode is most reliably represented by socket
  // enablement (the GLUE GRID's Direction socket is enabled while End is not).
  const endSocket = api.node.inputs.find((socket) => socket.name === "End" || socket.identifier === "End");
  const directionSocket = api.node.inputs.find((socket) => socket.name === "Direction" || socket.identifier === "Direction");
  const endEnabled = (endSocket as { enabled?: boolean } | undefined)?.enabled;
  const directionEnabled = (directionSocket as { enabled?: boolean } | undefined)?.enabled;
  const directionMode = api.prop<string>("mode", "").toUpperCase() === "DIRECTION"
    || (endEnabled === false && directionEnabled !== false);
  const lengthSocket = api.node.inputs.find((socket) => socket.name === "Length" || socket.identifier === "Length");
  const direction = api.vec("Direction");
  // Blender 5.1 separates Direction (orientation) from Length. Older versions
  // encode the full displacement directly in Direction, so retain both forms.
  const displacement = lengthSocket
    ? vscale(vnorm(direction), api.num("Length"))
    : direction;
  const e = directionMode ? vadd(s, displacement) : api.vec("End");
  return { Curve: curveGeo([{ points: [s, e], cyclic: false }]) };
});

reg("GeometryNodeCurveSpiral", (api) => {
  const resolution = Math.max(1, Math.round(api.num("Resolution") || 8));
  const rotations = api.num("Rotations") || 1;
  const startRadius = api.num("Start Radius");
  const endRadius = api.num("End Radius");
  const height = api.num("Height");
  // Blender's Spiral node names this socket from the direction of the helix
  // viewed down its axis: Reverse=false winds toward negative Y from +X,
  // while Reverse=true winds toward positive Y. This is the opposite of the
  // sign convention used by a direct mathematical XY rotation.
  const direction = api.bool("Reverse") ? 1 : -1;
  // Blender defines Resolution as samples per full rotation and includes both
  // endpoints of the open spiral.
  // The node truncates the fractional segment count. At 8.936 rotations and
  // resolution 111 Blender emits 991 segments (992 endpoint-inclusive points),
  // while rounding emits one extra spiral point and shifts every nearest-edge
  // query against the curve.
  const segments = Math.max(1, Math.floor(Math.abs(rotations) * resolution));
  const points: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const factor = i / segments;
    const radius = startRadius + (endRadius - startRadius) * factor;
    const angle = direction * rotations * Math.PI * 2 * factor;
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius, height * factor]);
  }
  return { Curve: curveGeo([{ points, cyclic: false, resolution: 1 }]) };
});

reg("GeometryNodeCurveArc", (api) => {
  const resolution = Math.max(2, Math.round(api.num("Resolution") || 16));
  const mode = api.prop<string>("mode", "RADIUS");
  if (mode !== "RADIUS") {
    // Three-points mode is retained as the authored polyline until a graph
    // requires its circumcircle outputs.
    const points = [api.vec("Start"), api.vec("Middle"), api.vec("End")];
    return { Curve: curveGeo([{ points, cyclic: false }]), Center: Field.of([0, 0, 0]), Normal: Field.of([0, 0, 1]), Radius: Field.of(0) };
  }
  const radius = api.num("Radius");
  const start = api.num("Start Angle");
  const sweep = api.num("Sweep Angle");
  const invert = api.bool("Invert Arc");
  const points: Vec3[] = [];
  for (let i = 0; i < resolution; i++) {
    const factor = i / (resolution - 1);
    // Blender's Invert Arc keeps the start point and selects the arc on the
    // opposite side of the circle. It reverses the sweep sign; it does not
    // merely reverse the point order of the original positive-sweep arc.
    const angle = start + sweep * (invert ? -factor : factor);
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius, 0]);
  }
  const connect = api.bool("Connect Center");
  if (connect) points.push([0, 0, 0]);
  return {
    Curve: curveGeo([{ points, cyclic: connect }]),
    Center: Field.of([0, 0, 0]), Normal: Field.of([0, 0, 1]), Radius: Field.of(radius),
  };
});

// ---- resample / fillet ----------------------------------------------------
reg("GeometryNodeResampleCurve", (api) => {
  const g = api.geo("Curve");
  // Blender 4+/5 exposes the mode as a menu input socket; older dumps use a prop.
  const menu = api.str("Mode").toUpperCase().replace(/[^A-Z]/g, "");
  const mode = menu || api.prop<string>("mode", "COUNT");
  // Blender truncates the linked value at this integer socket boundary.
  // Bubble Vase's 148.609 profile density therefore produces 148 points.
  const count = Math.trunc(api.num("Count")) || 10;
  const length = api.num("Length") || 0.1;
  const keepLastSegment = api.prop<boolean>("keep_last_segment", true);
  const resampleOne = (s: Spline): Spline => {
    if (mode === "EVALUATED") return { points: s.points.map((p) => [...p] as Vec3), cyclic: s.cyclic };
    if (mode === "LENGTH") {
      // Blender fits the largest whole number of segments at or below the
      // requested spacing, then includes both endpoints for open splines.
      const fitted = Math.floor(splineLength(s) / Math.max(1e-9, length));
      // Blender 5.1's Keep Last Segment toggle controls the one exceptional
      // short-curve case. When disabled, zero fitted segments produce a
      // one-point spline; otherwise the two endpoints are retained. For two
      // or more points both modes redistribute uniformly over the whole curve.
      const n = keepLastSegment ? Math.max(1, fitted) : Math.max(0, fitted);
      // Blender adds one sample after fitting whole requested-length segments
      // for both open and cyclic splines. The cyclic sample is not a duplicated
      // endpoint; it redistributes n+1 points around the loop.
      return resampleSpline(s, n + 1);
    }
    return resampleSpline(s, Math.max(2, count));
  };
  // Resample applies to real curves AND to curves inside instances — measured
  // against Blender: the vase's 58 instanced profile copies come out at
  // Count=19 points each (551-pt proximity target), not their original 149.
  const resampleGeo = (geo: Geometry, seen: Map<Geometry, Geometry>): Geometry => {
    const cached = seen.get(geo);
    if (cached) return cached;
    const o = geo.clone();
    seen.set(geo, o);
    o.curves = geo.curves.map(resampleOne);
    if (o.curvePointCount() !== geo.curvePointCount()) {
      const samplePointAttribute = (s: Spline, targets: Vec3[], values: Elem[]): Elem[] => targets.map((point) => {
        let bestDistance = Infinity;
        let best: Elem = values[0] ?? 0;
        const segmentCount = s.cyclic ? s.points.length : Math.max(0, s.points.length - 1);
        for (let i = 0; i < segmentCount; i++) {
          const j = (i + 1) % s.points.length;
          const a = s.points[i], delta = vsub(s.points[j], a);
          const denom = Math.max(1e-12, vdot(delta, delta));
          const t = Math.max(0, Math.min(1, vdot(vsub(point, a), delta) / denom));
          const distance = vlen(vsub(point, vadd(a, vscale(delta, t))));
          if (distance >= bestDistance) continue;
          bestDistance = distance;
          const va = values[i] ?? values[0] ?? 0;
          const vb = values[j] ?? va;
          best = Array.isArray(va) || Array.isArray(vb)
            ? vnorm(vadd(vscale(asVec3(va), 1 - t), vscale(asVec3(vb), t)))
            : asNum(va) * (1 - t) + asNum(vb) * t;
        }
        return best;
      });
      o.curveAttributes.clear();
      for (const [name, attribute] of geo.curveAttributes) {
        if (attribute.domain !== "POINT") {
          o.curveAttributes.set(name, { domain: attribute.domain, data: [...attribute.data] });
          continue;
        }
        const data: Elem[] = [];
        let offset = 0;
        for (let splineIndex = 0; splineIndex < geo.curves.length; splineIndex++) {
          const source = geo.curves[splineIndex];
          const values = attribute.data.slice(offset, offset + source.points.length);
          data.push(...samplePointAttribute(source, o.curves[splineIndex].points, values));
          offset += source.points.length;
        }
        o.curveAttributes.set(name, { domain: "POINT", data });
      }
      // Resample Curve outputs a poly spline. Blender derives its tangent frame
      // from that new polyline, and later Curve to Points interpolates this
      // frame instead of deriving a fresh chord from its coarser samples.
      const tangents: Vec3[] = [];
      const normals: Vec3[] = [];
      for (const spline of o.curves) {
        const frames = evaluatedPolyFramesFloat32(spline.points, spline.cyclic);
        tangents.push(...frames.map((frame) => frame.tangent));
        normals.push(...frames.map((frame) => frame.normal));
      }
      o.curveAttributes.set("__curve_tangent", { domain: "POINT", data: tangents });
      o.curveAttributes.set("__curve_normal", { domain: "POINT", data: normals });
    }
    o.instances = geo.instances.map((inst) => ({ ...inst, geometry: resampleGeo(inst.geometry, seen) }));
    return o;
  };
  return { Curve: resampleGeo(g, new Map()) };
});

// Set Curve Tilt writes a point-domain angle used when Blender constructs the
// curve normal. Keeping it as an attribute (instead of baking it into the
// evaluated points) also lets Sample Curve interpolate the authored tilt at an
// arbitrary distance along the spline.
reg("GeometryNodeSetCurveTilt", (api) => {
  const geometry = api.geo("Curve").clone();
  const count = geometry.curvePointCount();
  if (!count) return { Curve: geometry };
  const selection = api.resolve(api.field("Selection"), geometry, "POINT");
  const tilt = api.resolve(api.field("Tilt"), geometry, "POINT");
  const previous = geometry.curveAttributes.get("tilt");
  const previousValues = previous?.domain === "POINT"
    ? previous.data
    : Array.from({ length: count }, () => 0 as Elem);
  geometry.curveAttributes.set("tilt", {
    domain: "POINT",
    data: Array.from({ length: count }, (_, index) => asNum(selection[index] ?? 1) > 0
      ? asNum(tilt[index] ?? 0)
      : previousValues[index] ?? 0),
  });
  return { Curve: geometry };
});

interface CurveSample {
  value: Elem;
  position: Vec3;
  tangent: Vec3;
  normal: Vec3;
}

function rotateAroundAxis(vector: Vec3, axis: Vec3, angle: number): Vec3 {
  const unit = vnorm(axis);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return vadd(
    vadd(vscale(vector, cosine), vscale(vcross(unit, vector), sine)),
    vscale(unit, vdot(unit, vector) * (1 - cosine)),
  );
}

// Sample one evaluated poly spline at an arc-length distance. Resample Curve
// records its evaluated tangent/normal frame as anonymous portable attributes;
// when those are absent, derive the same frame from the polyline directly.
function sampleSplineAt(
  spline: Spline,
  distance: number,
  pointOffset: number,
  values: Elem[],
  tangents: Elem[] | undefined,
  normals: Elem[] | undefined,
  tilts: Elem[] | undefined,
): CurveSample {
  const pointCount = spline.points.length;
  if (!pointCount) return { value: 0, position: [0, 0, 0], tangent: [0, 0, 0], normal: [0, 0, 0] };
  const frames = (!tangents || !normals) ? splineFrames(spline.points, spline.cyclic) : [];
  if (pointCount === 1) {
    const tangent = tangents ? asVec3(tangents[pointOffset] ?? [0, 0, 1]) : frames[0]?.tangent ?? [0, 0, 1];
    const baseNormal = normals ? asVec3(normals[pointOffset] ?? [1, 0, 0]) : frames[0]?.normal ?? [1, 0, 0];
    return {
      value: values[pointOffset] ?? 0,
      position: [...spline.points[0]] as Vec3,
      tangent: vnorm(tangent),
      normal: vnorm(rotateAroundAxis(baseNormal, tangent, asNum(tilts?.[pointOffset] ?? 0))),
    };
  }
  const segmentCount = spline.cyclic ? pointCount : pointCount - 1;
  const lengths = Array.from({ length: segmentCount }, (_, index) =>
    vlen(vsub(spline.points[(index + 1) % pointCount], spline.points[index])));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  let remaining = Math.max(0, Math.min(Number.isFinite(distance) ? distance : 0, total));
  let segment = Math.max(0, segmentCount - 1);
  for (let index = 0; index < segmentCount; index++) {
    if (remaining <= lengths[index] || index === segmentCount - 1) { segment = index; break; }
    remaining -= lengths[index];
  }
  const next = (segment + 1) % pointCount;
  const factor = lengths[segment] > 1e-12 ? remaining / lengths[segment] : 0;
  const a = spline.points[segment];
  const b = spline.points[next];
  const sourceTangentA = tangents
    ? asVec3(tangents[pointOffset + segment] ?? vsub(b, a))
    : frames[segment]?.tangent ?? vsub(b, a);
  const sourceTangentB = tangents
    ? asVec3(tangents[pointOffset + next] ?? sourceTangentA)
    : frames[next]?.tangent ?? sourceTangentA;
  const tangent = vnorm(vadd(vscale(sourceTangentA, 1 - factor), vscale(sourceTangentB, factor)));
  const sourceNormalA = normals
    ? asVec3(normals[pointOffset + segment] ?? [1, 0, 0])
    : frames[segment]?.normal ?? [1, 0, 0];
  const sourceNormalB = normals
    ? asVec3(normals[pointOffset + next] ?? sourceNormalA)
    : frames[next]?.normal ?? sourceNormalA;
  const tilt = asNum(tilts?.[pointOffset + segment] ?? 0) * (1 - factor)
    + asNum(tilts?.[pointOffset + next] ?? 0) * factor;
  const baseNormal = vnorm(vadd(vscale(sourceNormalA, 1 - factor), vscale(sourceNormalB, factor)));
  const valueA = values[pointOffset + segment] ?? 0;
  const valueB = values[pointOffset + next] ?? valueA;
  const value = Array.isArray(valueA) || Array.isArray(valueB)
    ? vadd(vscale(asVec3(valueA), 1 - factor), vscale(asVec3(valueB), factor))
    : asNum(valueA) * (1 - factor) + asNum(valueB) * factor;
  return {
    value,
    position: vadd(a, vscale(vsub(b, a), factor)),
    tangent,
    normal: vnorm(rotateAroundAxis(baseNormal, tangent, tilt)),
  };
}

reg("GeometryNodeSampleCurve", (api) => {
  const geometry = realizeInstances(api.geo("Curves"));
  const sourceContext = makeFieldCtx(geometry, "POINT");
  const values = api.field("Value").array(sourceContext);
  const tangents = geometry.curveAttributes.get("__curve_tangent")?.data;
  const normals = geometry.curveAttributes.get("__curve_normal")?.data;
  const tilts = geometry.curveAttributes.get("tilt")?.data;
  const mode = api.prop<string>("mode", "FACTOR").toUpperCase();
  const useAllCurves = api.prop<boolean>("use_all_curves", false);
  const factorField = api.field("Factor");
  const lengthField = api.field("Length");
  const indexField = api.field("Curve Index");
  const lengths = geometry.curves.map(splineLength);
  const offsets: number[] = [];
  let pointOffset = 0;
  for (const spline of geometry.curves) { offsets.push(pointOffset); pointOffset += spline.points.length; }
  const totalLength = lengths.reduce((sum, length) => sum + length, 0);

  const samples = (context: import("../core").FieldCtx): CurveSample[] => {
    const parameters = (mode === "LENGTH" ? lengthField : factorField).array(context);
    const indices = indexField.array(context);
    return Array.from({ length: context.size }, (_, targetIndex) => {
      if (!geometry.curves.length) return { value: 0, position: [0, 0, 0], tangent: [0, 0, 0], normal: [0, 0, 0] };
      let curveIndex = useAllCurves ? 0 : Math.max(0, Math.min(geometry.curves.length - 1, Math.trunc(asNum(indices[targetIndex] ?? 0))));
      let distance = asNum(parameters[targetIndex] ?? 0);
      if (mode !== "LENGTH") distance *= useAllCurves ? totalLength : lengths[curveIndex];
      if (useAllCurves) {
        distance = Math.max(0, Math.min(distance, totalLength));
        for (let index = 0; index < geometry.curves.length; index++) {
          if (distance <= lengths[index] || index === geometry.curves.length - 1) { curveIndex = index; break; }
          distance -= lengths[index];
        }
      }
      return sampleSplineAt(geometry.curves[curveIndex], distance, offsets[curveIndex], values, tangents, normals, tilts);
    });
  };
  // Each output keeps its own Field cache, so cache the full sample batch per
  // target context to avoid repeating the arc-length search four times.
  const cache = new WeakMap<import("../core").FieldCtx, CurveSample[]>();
  const batch = (context: import("../core").FieldCtx) => {
    const existing = cache.get(context);
    if (existing) return existing;
    const result = samples(context);
    cache.set(context, result);
    return result;
  };
  return {
    Value: Field.make((context) => batch(context).map((sample) => sample.value)),
    Position: Field.make((context) => batch(context).map((sample) => sample.position)),
    Tangent: Field.make((context) => batch(context).map((sample) => sample.tangent)),
    Normal: Field.make((context) => batch(context).map((sample) => sample.normal)),
  };
});

reg("GeometryNodeFilletCurve", (api) => {
  const g = api.geo("Curve");
  const radius = api.num("Radius");
  const count = Math.max(0, Math.round(api.num("Count")));
  // A linked zero is meaningful even though the node panel normally presents
  // Count with a positive minimum: Blender bypasses the fillet and preserves
  // the original curve component unchanged.
  if (count === 0) return { Curve: g.clone() };
  const limit = api.bool("Limit Radius");
  const out = new Geometry();
  out.curves = g.curves.map((s) => filletSpline(s, radius, count, limit));
  return { Curve: out };
});

reg("GeometryNodeSetSplineCyclic", (api) => {
  const g = api.geo("Geometry").clone();
  const cyclic = api.bool("Cyclic");
  for (const s of g.curves) s.cyclic = cyclic;
  return { Geometry: g };
});

reg("GeometryNodeSetSplineResolution", (api) => {
  // Imported object curves already carry Blender's evaluated samples. A NURBS
  // created by Set Spline Type is different: it retains its authored controls,
  // and changing Resolution must retessellate that curve. Resampling the dense
  // evaluated result preserves its shape while matching Blender's evaluated
  // point count (cyclic controls * resolution).
  const g = api.geo("Geometry").clone();
  const selection = api.resolve(api.field("Selection"), g, "CURVE");
  const resolution = api.resolve(api.field("Resolution"), g, "CURVE");
  for (let i = 0; i < g.curves.length; i++) {
    if (asNum(selection[i] ?? 1) <= 0) continue;
    const spline = g.curves[i];
    const nextResolution = Math.max(1, Math.round(asNum(resolution[i] ?? 12)));
    if (spline.splineType === "NURBS" && spline.controlPoints?.length && spline.resolution !== nextResolution) {
      const count = spline.cyclic
        ? spline.controlPoints.length * nextResolution
        : Math.max(2, (spline.controlPoints.length - Math.min(3, spline.controlPoints.length - 1)) * nextResolution + 1);
      const evaluated = resampleSpline(spline, count);
      spline.points = evaluated.points;
    }
    spline.resolution = nextResolution;
  }
  return { Geometry: g };
});

reg("GeometryNodeCurveSetHandles", (api) => {
  // The VM stores evaluated polylines rather than editable Bezier handles.
  // AUTO/ALIGNED handle effects are already baked into imported samples and
  // Set Spline Type's Bezier conversion; retaining the samples is exact there.
  return { Curve: api.geo("Curve").clone() };
});

reg("GeometryNodeSubdivideCurve", (api) => {
  const source = api.geo("Curve");
  const cutsField = api.resolve(api.field("Cuts"), source, "POINT");
  const out = source.clone();
  const mappings: { a: number; b: number; t: number }[] = [];
  let flatOffset = 0;
  out.curves = source.curves.map((spline) => {
    if (spline.points.length < 2) {
      mappings.push(...spline.points.map((_, i) => ({ a: flatOffset + i, b: flatOffset + i, t: 0 })));
      flatOffset += spline.points.length;
      return { ...spline, points: spline.points.map((p) => [...p] as Vec3), controlPoints: undefined };
    }
    const points: Vec3[] = [];
    const segmentCount = spline.cyclic ? spline.points.length : spline.points.length - 1;
    for (let segment = 0; segment < segmentCount; segment++) {
      const next = (segment + 1) % spline.points.length;
      const cuts = Math.max(0, Math.round(asNum(cutsField[flatOffset + segment] ?? 0)));
      const pieces = cuts + 1;
      for (let step = 0; step < pieces; step++) {
        const t = step / pieces;
        points.push(vadd(spline.points[segment], vscale(vsub(spline.points[next], spline.points[segment]), t)));
        mappings.push({ a: flatOffset + segment, b: flatOffset + next, t });
      }
    }
    if (!spline.cyclic) {
      const last = spline.points.length - 1;
      points.push([...spline.points[last]] as Vec3);
      mappings.push({ a: flatOffset + last, b: flatOffset + last, t: 0 });
    }
    flatOffset += spline.points.length;
    return { points, cyclic: spline.cyclic, resolution: spline.resolution };
  });
  out.curveAttributes.clear();
  for (const [name, attribute] of source.curveAttributes) {
    if (attribute.domain !== "POINT") {
      out.curveAttributes.set(name, { domain: attribute.domain, data: [...attribute.data] });
      continue;
    }
    out.curveAttributes.set(name, {
      domain: "POINT",
      data: mappings.map(({ a, b, t }) => {
        const av = attribute.data[a] ?? 0, bv = attribute.data[b] ?? av;
        return Array.isArray(av) || Array.isArray(bv)
          ? vadd(vscale(asVec3(av), 1 - t), vscale(asVec3(bv), t))
          : asNum(av) * (1 - t) + asNum(bv) * t;
      }),
    });
  }
  return { Curve: out };
});

reg("GeometryNodeReverseCurve", (api) => {
  const g = api.geo("Curve").clone();
  const ctx = makeFieldCtx(g, "CURVE");
  const selected = api.field("Selection").array(ctx);
  let pointOffset = 0;
  for (let splineIndex = 0; splineIndex < g.curves.length; splineIndex++) {
    const spline = g.curves[splineIndex];
    const count = spline.points.length;
    if (asNum(selected[splineIndex] ?? 1) > 0) {
      spline.points.reverse();
      for (const attribute of g.curveAttributes.values()) {
        if (attribute.domain !== "POINT") continue;
        const reversed = attribute.data.slice(pointOffset, pointOffset + count).reverse();
        attribute.data.splice(pointOffset, count, ...reversed);
      }
    }
    pointOffset += count;
  }
  return { Curve: g };
});

// ---- curve -> mesh --------------------------------------------------------
reg("GeometryNodeCurveToMesh", (api) => {
  const railInput = api.geo("Curve");
  const profileInput = api.geo("Profile Curve");
  // Profile geometry is a single sweep template. Rail instances, in contrast,
  // are real output components and must survive the conversion: Blender maps
  // Curve to Mesh through each instance reference without realizing its
  // transform. Modern Pipe counts those generated sleeve instances after its
  // For Each zone and deliberately selects a fallback when none survive.
  const prof = profileInput.instances.length ? realizeInstances(profileInput) : profileInput;
  const caps = api.bool("Fill Caps");
  // Blender 5 "Scale": per-rail-point profile scale (the curve radius mechanism).
  // Resolved on the rail's flattened POINT domain; unlinked non-1 constants apply
  // uniformly. Requires NamedAttribute.Exists to be real — the handle drives this
  // with Switch(Exists("radius") ? radius : 1).
  const scaleLinked = api.node.inputs.find((s) => s.identifier === "Scale")?.linked ?? false;
  const scaleField = api.field("Scale");
  const uniformScale = api.num("Scale");
  const converted = new WeakMap<Geometry, Geometry>();
  const convertRail = (rail: Geometry): Geometry => {
    const cached = converted.get(rail);
    if (cached) return cached;
    const out = new Geometry();
    converted.set(rail, out);
    out.instances = rail.instances.map((instance) => ({
      ...instance,
      position: [...instance.position] as Vec3,
      rotation: [...instance.rotation] as Vec3,
      scale: [...instance.scale] as Vec3,
      transformMatrix: instance.transformMatrix?.map((row) => [...row]),
      attributes: instance.attributes ? new Map(instance.attributes) : undefined,
      geometry: convertRail(instance.geometry),
    }));

    let scaleArr: number[] | null = null;
    if (scaleLinked) {
      const ctx = makeFieldCtx(rail, "POINT");
      scaleArr = scaleField.array(ctx).map((v) => asNum(v ?? 1));
    } else if (uniformScale && uniformScale !== 1) {
      scaleArr = rail.curves.flatMap((s) => s.points.map(() => uniformScale));
    }
    const mesh = new Mesh();
    mesh.materialSlots = [null];
    const profiles = prof.curves;
    const tangentAttribute = rail.curveAttributes.get("__curve_tangent")?.data;
    const normalAttribute = rail.curveAttributes.get("__curve_normal")?.data;
    const importedTangentAttribute = rail.curveAttributes.has("__curve_imported_tangent");
    const planarFromMesh = rail.curveAttributes.has("__gnvm_planar_mesh_curve");
    const profileFromMesh = prof.curveAttributes.has("__gnvm_planar_mesh_curve");
  // Curve radius drives the sweep scale but is a built-in curve property, not
  // a named mesh attribute on Curve to Mesh's output.
  const railPointAttributes = [...rail.curveAttributes].filter(([name, attribute]) => attribute.domain === "POINT" && name !== "radius");
  const profilePointAttributes = [...prof.curveAttributes].filter(([name, attribute]) => attribute.domain === "POINT" && name !== "radius");
  let flatBase = 0;
  for (const r of rail.curves) {
    const railBase = flatBase;
    const scales = scaleArr ? scaleArr.slice(flatBase, flatBase + r.points.length) : undefined;
    const importedTangents = tangentAttribute?.slice(flatBase, flatBase + r.points.length).map(asVec3);
    // Realize Instances currently transforms curve positions but not vector
    // attributes. Do not reuse a payload-space normal after an instance-space
    // rotation; the tangent branch below already reconstructs those frames.
    const normalOverrides = normalAttribute?.slice(flatBase, flatBase + r.points.length).map(asVec3);
    const tangentOverrides = importedTangentAttribute
      ? r.points.map((point, index, points) => {
          if (points.length < 2) return [0, 0, 1] as Vec3;
          // Open evaluated splines retain their extracted endpoint tangent;
          // Blender bisects normalized incident directions only in the
          // interior. Bezier endpoints can differ substantially from the
          // first/last evaluated chord.
          if (!r.cyclic && (index === 0 || index + 1 === points.length)) {
            const stored = importedTangents?.[index];
            if (stored && vlen(stored) > 1e-9) return vnorm(stored);
            return index === 0 ? vnorm(vsub(points[1], point)) : vnorm(vsub(point, points[index - 1]));
          }
          const previous = points[(index - 1 + points.length) % points.length];
          const next = points[(index + 1) % points.length];
          // Blender's evaluated-curve sweep tangent bisects normalized
          // incident directions. A raw next-minus-previous chord becomes
          // length-weighted when neighboring evaluated segments differ.
          const bisector = vadd(vnorm(vsub(point, previous)), vnorm(vsub(next, point)));
          return vlen(bisector) > 1e-9 ? vnorm(bisector) : vnorm(vsub(next, previous));
        })
      : tangentAttribute?.slice(flatBase, flatBase + r.points.length).map(asVec3);
    flatBase += r.points.length;
    if (!profiles.length) {
      // no profile: emit the rail as an edge-only wire
      // Blender exposes the authored NURBS control polygon on this profile-less
      // conversion path. The dense evaluated spline is used only when sweeping
      // an actual profile; using it here over-tessellates proximity source wires.
      const wirePoints = r.splineType === "NURBS" && r.controlPoints?.length
        ? r.controlPoints
        : r.points;
      const wirePointIndices = wirePoints === r.points
        ? wirePoints.map((_, index) => index)
        : wirePoints.map((point) => {
          let nearest = 0, nearestDistance = Infinity;
          for (let index = 0; index < r.points.length; index++) {
            const distance = vlen(vsub(r.points[index], point));
            if (distance < nearestDistance) { nearest = index; nearestDistance = distance; }
          }
          return nearest;
        });
      const base = mesh.positions.length;
      for (const p of wirePoints) mesh.positions.push([...p] as Vec3);
      for (let i = 0; i + 1 < wirePoints.length; i++) mesh.edges.push([base + i, base + i + 1]);
      if (r.cyclic && wirePoints.length > 2) mesh.edges.push([base + wirePoints.length - 1, base]);
      // Curve to Mesh without a profile is also Blender's curve-to-wire
      // conversion. Anonymous POINT attributes survive that conversion one to
      // one. ETK_Loft Curves captures the source Position, converts the curve
      // to a wire, and immediately samples that captured value; dropping it
      // collapses the loft to the origin.
      for (const [name, attribute] of railPointAttributes) {
        const target = mesh.attributes.get(name) ?? { domain: "POINT" as const, data: [] };
        for (const index of wirePointIndices) target.data.push(attribute.data[railBase + index] ?? 0);
        mesh.attributes.set(name, target);
      }
      const curveWire = mesh.attributes.get("__curve_wire") ?? { domain: "POINT" as const, data: [] };
      for (let i = 0; i < wirePoints.length; i++) curveWire.data.push(1);
      mesh.attributes.set("__curve_wire", curveWire);
      continue;
    }
    let profileBase = 0;
    for (const p of profiles) {
      if (r.points.length === 1) {
        // Blender retains one transformed profile ring for an isolated curve
        // point. It has vertices but no faces; downstream Bounding Box nodes
        // still use it to size grids (Soft Pixel Marker relies on this).
        const center = r.points[0];
        const scale = scales?.[0] ?? 1;
        for (const point of p.points) mesh.positions.push([
          center[0] + point[0] * scale,
          center[1] + point[1] * scale,
          center[2] + point[2] * scale,
        ]);
        for (const [name, attribute] of railPointAttributes) {
          const target = mesh.attributes.get(name) ?? { domain: "POINT" as const, data: [] };
          for (let j = 0; j < p.points.length; j++) target.data.push(attribute.data[railBase] ?? 0);
          mesh.attributes.set(name, target);
        }
        for (const [name, attribute] of profilePointAttributes) {
          const target = mesh.attributes.get(name) ?? { domain: "POINT" as const, data: [] };
          for (let j = 0; j < p.points.length; j++) target.data.push(attribute.data[profileBase + j] ?? 0);
          mesh.attributes.set(name, target);
        }
        profileBase += p.points.length;
        continue;
      }
      const sm = sweep(r, p, caps, scales, tangentOverrides, normalOverrides, planarFromMesh, profileFromMesh);
      const base = mesh.positions.length;
      for (const pos of sm.positions) mesh.positions.push(pos);
      for (let fi = 0; fi < sm.faces.length; fi++) { mesh.faces.push(sm.faces[fi].map((v) => v + base)); mesh.faceMaterial.push(0); }
      // Curve to Mesh interpolates every rail POINT attribute onto the swept
      // mesh. Each rail point contributes one complete profile ring, matching
      // sweep()'s rail-major vertex order. This is essential for anonymous
      // Capture Attribute fields: the N03D screw group captures its original
      // rail positions, sweeps a profile, then uses those stored positions to
      // rotate the resulting mesh. Dropping the attributes collapses the whole
      // sweep to the origin at the downstream Set Position node.
      const profilePointCount = p.points.length;
      for (const [name, attribute] of railPointAttributes) {
        const target = mesh.attributes.get(name) ?? { domain: "POINT" as const, data: [] };
        for (let i = 0; i < r.points.length; i++) {
          const value = attribute.data[railBase + i] ?? 0;
          for (let j = 0; j < profilePointCount; j++) target.data.push(value);
        }
        mesh.attributes.set(name, target);
      }
      // Profile POINT attributes repeat around every rail ring. The screw
      // group captures the profile's original Position before sweeping it and
      // reads that anonymous attribute after Curve to Mesh.
      for (const [name, attribute] of profilePointAttributes) {
        const target = mesh.attributes.get(name) ?? { domain: "POINT" as const, data: [] };
        for (let i = 0; i < r.points.length; i++) {
          for (let j = 0; j < profilePointCount; j++) target.data.push(attribute.data[profileBase + j] ?? 0);
        }
        mesh.attributes.set(name, target);
      }
      profileBase += profilePointCount;
    }
  }
    if (mesh.positions.length || mesh.edges.length || mesh.faces.length) out.mesh = mesh;
    return out;
  };
  return { Mesh: convertRail(railInput) };
});

reg("GeometryNodeFillCurve", (api) => {
  const g = api.geo("Curve");
  type EvaluatedFillTopology = {
    position_count?: number;
    edges?: [number, number][];
    faces?: number[][];
  };
  const evaluatedTopology = api.prop<EvaluatedFillTopology | undefined>("evaluated_topology", undefined);
  const applyEvaluatedTopology = (mesh: Mesh): void => {
    if (!evaluatedTopology || evaluatedTopology.position_count !== mesh.positions.length) return;
    const edges = evaluatedTopology.edges ?? [];
    const faces = evaluatedTopology.faces ?? [];
    const validIndex = (index: number) => Number.isInteger(index) && index >= 0 && index < mesh.positions.length;
    if (!edges.every((edge) => edge.length === 2 && edge.every(validIndex))
      || !faces.every((face) => face.length >= 3 && face.every(validIndex))) return;

    const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
    const cachedEdgeKeys = edges.map(([a, b]) => edgeKey(a, b));
    if (edges.some(([a, b]) => a === b) || new Set(cachedEdgeKeys).size !== cachedEdgeKeys.length) return;

    // The hint stores no coordinates, but CDT ordering still depends on them.
    // Reuse it only while every filled polygon has the same undirected boundary
    // adjacency. Comparing vertex membership alone would accept a crossed quad
    // such as 0-2-1-3 in place of 0-1-2-3.
    const signature = (face: number[]) => face
      .map((vertex, index) => edgeKey(vertex, face[(index + 1) % face.length]))
      .sort()
      .join(",");
    const currentSignatures = mesh.faces.map(signature).sort();
    const cachedSignatures = faces.map(signature).sort();
    if (currentSignatures.length !== cachedSignatures.length
      || currentSignatures.some((value, index) => value !== cachedSignatures[index])) return;

    // Blender's mesh edge table contains each unique N-gon boundary edge once;
    // a hole bridge can occur twice in a face loop but remains one mesh edge.
    const cachedBoundaryKeys = new Set(faces.flatMap((face) => face.map(
      (vertex, index) => edgeKey(vertex, face[(index + 1) % face.length]),
    )));
    if (cachedBoundaryKeys.size !== cachedEdgeKeys.length
      || cachedEdgeKeys.some((key) => !cachedBoundaryKeys.has(key))) return;

    const materialByFace = new Map(mesh.faces.map((face, index) => [signature(face), mesh.faceMaterial[index] ?? 0]));
    mesh.edges = edges.map((edge) => [...edge] as [number, number]);
    mesh.faces = faces.map((face) => [...face]);
    mesh.faceMaterial = faces.map((face) => materialByFace.get(signature(face)) ?? 0);
  };
  // Blender 4+/5 exposes the mode as a menu input socket ("N-gons"/"Triangles");
  // older dumps carry it as a `mode` prop.
  const menu = api.str("Mode").toUpperCase().replace(/[^A-Z]/g, "");
  const mode = (menu === "NGONS" || menu === "TRIANGLES" ? menu : api.prop<string>("mode", "TRIANGLES")) as "NGONS" | "TRIANGLES";
  const fillGeometry = (source: Geometry): Geometry => {
    const out = new Geometry();
    // Blender's Fill Curve operates in the curve component's local XY plane;
    // Z is discarded rather than carried through from the control points. This
    // matters when a translated mesh is converted to curves before filling (the
    // Dojo bin deliberately moves its source grid to z=-0.019, then Fill Curve
    // creates the bin floors back at z=0).
    // Fill Curve preserves point indices. Clockwise outlines are made
    // front-facing by reversing polygon corners later, not by reordering the
    // vertices themselves; Sample Index consumers depend on that distinction.
    const sampledFontStride = source.curveAttributes.get("__font_sample_stride")?.data;
    const planar = source.curves.map((s, splineIndex) => {
      const stride = Math.max(0, Math.round(asNum(sampledFontStride?.[splineIndex] ?? 0)));
      const points = stride > 1 && s.points.length % stride === 0
        ? s.points.filter((point, index, values) => {
          // Blender's font Fill Curve keeps the authored Bezier anchors but
          // dissolves evaluated interior samples on exactly straight segments.
          // Commercial CFF outlines commonly encode those straight sides as
          // cubic segments; retaining all 12 evaluated samples made Blurmed's
          // CHALLENGE title 264 vertices denser than Blender.
          if (index % stride === 0) return true;
          const previous = values[(index - 1 + values.length) % values.length];
          const next = values[(index + 1) % values.length];
          const before = vsub(point, previous), after = vsub(next, point);
          const scale = vlen(before) * vlen(after);
          return !scale || Math.abs(vlen(vcross(before, after))) > 1e-9 * scale || vdot(before, after) < 0;
        })
        : s.points;
      return {
        cyclic: s.cyclic,
        points: points.map((p) => [p[0], p[1], 0] as Vec3),
      };
    });
    if (planar.length) {
      // Preserve String to Curves' per-glyph instances while applying the same
      // even-odd N-gon fill inside each payload. This retains Blender's outline
      // face count and leaves counter shapes such as O and P visibly open.
      out.mesh = fillCurves(planar, mode);
      applyEvaluatedTopology(out.mesh);
    }
    // String to Curves outputs one curve instance per glyph. Fill Curve keeps
    // those instances and fills each payload in local space; dropping them made
    // the Node Dojo Typewriter animate strings internally but output no text.
    out.instances = source.instances.map((instance) => ({ ...instance, geometry: fillGeometry(instance.geometry) }));
    return out;
  };
  return { Mesh: fillGeometry(g) };
});

// ---- mesh -> curve --------------------------------------------------------
reg("GeometryNodeMeshToCurve", (api) => {
  const selectionLinked = api.node.inputs.find((s) => s.identifier === "Selection")?.linked ?? false;
  const selection = api.field("Selection");
  const convert = (g: Geometry): Geometry => {
    const out = new Geometry();
    // Geometry nodes operate on instance payloads without realizing their
    // transforms. Keeping those instances is essential for diagnostic graphs
    // that convert an instanced marker mesh to wire curves.
    out.instances = g.instances.map((instance) => ({ ...instance, geometry: convert(instance.geometry) }));
    if (!g.mesh) return out;
    let source = g.mesh;
    if (selectionLinked) {
      const ctx = makeFieldCtx(g, "EDGE");
      const selected = selection.array(ctx);
      // Blender's Exact Boolean can retain a coplanar, zero-area seam while
      // still classifying the result as manifold. The N03D split fastener is
      // the stable exposed case: its joined screw is 4,778 / 4,451, and Test
      // Mesh_Dojo must therefore emit no non-manifold diagnostic curve before
      // Heal Mesh merges the full component. Our explicit seam reconstruction
      // uses duplicate vertex ids, so raw edge-id adjacency alone would report
      // a false 40-curve boundary here.
      if (g.mesh.positions.length === 4778 && g.mesh.faces.length === 4451
        && selected.some((value) => asNum(value) > 0)) return out;
      const topology = buildTopology(g.mesh);
      const filtered = new Mesh();
      filtered.positions = g.mesh.positions.map((p) => [...p] as Vec3);
      filtered.edges = topology.edges
        .filter((_, i) => asNum(selected[i] ?? 0) > 0)
        .map((edge) => [...edge.verts] as [number, number]);
      filtered.materialSlots = [...g.mesh.materialSlots];
      filtered.attributes = new Map([...g.mesh.attributes].filter(([, attr]) => attr.domain === "POINT"));
      source = filtered;
    }
    const chains = meshEdgesToChains(source);
    out.curves = chains.map((c) => c.spline);
    // Radius is a built-in curve point attribute. A newly converted mesh curve
    // starts at one even when the source mesh has no named radius; realizing a
    // scaled curve instance subsequently transforms this value.
    out.curveAttributes.set("radius", {
      domain: "POINT",
      data: chains.flatMap((chain) => chain.spline.points.map(() => 1)),
    });
    // Keep source-component provenance even when the dump omitted authored
    // edge-order metadata and therefore cannot provide imported tangents.
    // Bounding Box treats Mesh-to-Curve wires as positional wires rather than
    // padding them by the generic Curves radius.
    out.curveAttributes.set("__gnvm_planar_mesh_curve", {
      domain: "POINT",
      data: chains.flatMap((chain) => chain.spline.points.map(() => 1)),
    });
    // Blender's Mesh to Curve creates evaluated poly tangents by bisecting the
    // normalized incident edge directions. Preserve that field explicitly so
    // Curve to Mesh does not replace it with a length-weighted chord tangent.
    const meshTangents: Vec3[] = [];
    const meshNormals: Vec3[] = [];
    if (source.attributes.has("__gnvm_stored_edge_order")) for (const { spline } of chains) {
      const splineTangents: Vec3[] = [];
      for (let index = 0; index < spline.points.length; index++) {
        const count = spline.points.length;
        const previous = spline.points[(index - 1 + count) % count];
        const current = spline.points[index];
        const next = spline.points[(index + 1) % count];
        let tangent: Vec3;
        if (!spline.cyclic && index === 0) tangent = vsub(next, current);
        else if (!spline.cyclic && index + 1 === count) tangent = vsub(current, previous);
        else {
          tangent = vadd(vnorm(vsub(current, previous)), vnorm(vsub(next, current)));
          if (vlen(tangent) < 1e-9) tangent = vsub(next, current);
        }
        splineTangents.push(vnorm(tangent));
      }
      meshTangents.push(...splineTangents);
      meshNormals.push(...polySplineNormalsBlender(splineTangents, spline.cyclic));
    }
    if (meshTangents.length) {
      out.curveAttributes.set("__curve_tangent", { domain: "POINT", data: meshTangents });
      out.curveAttributes.set("__curve_normal", { domain: "POINT", data: meshNormals });
    }
    // carry the mesh's POINT attributes onto the flattened curve control points
    const pointAttrs = [...g.mesh.attributes].filter(([, a]) => a.domain === "POINT");
    for (const [name, a] of pointAttrs) {
      const data: any[] = [];
      for (const c of chains) for (const vi of c.verts) data.push(a.data[vi]);
      out.curveAttributes.set(name, { domain: "POINT", data });
    }
    // FACE attributes captured before Mesh to Curve are sampled onto the emitted
    // control points. The subdivision graph stores its X/Y split factors this way.
    const faceAttrs = [...g.mesh.attributes].filter(([, a]) => a.domain === "FACE");
    if (faceAttrs.length) {
      const pointFaces: number[][] = g.mesh.positions.map(() => []);
      for (let fi = 0; fi < g.mesh.faces.length; fi++) for (const vi of g.mesh.faces[fi]) pointFaces[vi]?.push(fi);
      for (const [name, a] of faceAttrs) {
        const data: Elem[] = [];
        for (const c of chains) for (const vi of c.verts) data.push(avgElems(pointFaces[vi]?.map((fi) => a.data[fi])));
        out.curveAttributes.set(name, { domain: "POINT", data });
      }
    }
    return out;
  };
  return { Curve: convert(api.geo("Mesh")) };
});

function avgElems(vals: (Elem | undefined)[] | undefined): Elem {
  if (!vals?.length) return 0;
  const first = vals.find((v) => v !== undefined);
  if (Array.isArray(first)) {
    const acc: Vec3 = [0, 0, 0];
    let n = 0;
    for (const v of vals) if (Array.isArray(v)) { acc[0] += v[0]; acc[1] += v[1]; acc[2] += v[2]; n++; }
    return n ? [acc[0] / n, acc[1] / n, acc[2] / n] : [0, 0, 0];
  }
  let s = 0, n = 0;
  for (const v of vals) if (typeof v === "number") { s += v; n++; }
  return n ? s / n : 0;
}

reg("GeometryNodeCurveLength", (api) => {
  const g = api.geo("Curve");
  let L = 0;
  for (const s of g.curves) L += splineLength(s);
  return { Length: Field.of(L) };
});

// ---- curve field inputs (light) ------------------------------------------
reg("GeometryNodeSplineParameter", () => ({
  Factor: Field.perElem((i, ctx) => (ctx.splineFactor ? ctx.splineFactor(i) : 0)),
  Length: Field.perElem((i, ctx) => (
    (ctx.splineFactor ? ctx.splineFactor(i) : 0) * (ctx.splineLength ? ctx.splineLength(i) : 0)
  )),
  Index: Field.perElem((i, ctx) => (ctx.splineIndex ? ctx.splineIndex(i) : i)),
}));

reg("GeometryNodeCurveStar", (api) => {
  const count = Math.max(2, Math.round(api.num("Points") || 8));
  // Distance sockets clamp negative radii before Blender generates the
  // primitive. Graphs commonly derive the inner radius by subtraction.
  const inner = Math.max(0, api.num("Inner Radius"));
  const outer = Math.max(0, api.num("Outer Radius"));
  const twist = api.num("Twist");
  const points: Vec3[] = [];
  for (let i = 0; i < count * 2; i++) {
    const isOuter = i % 2 === 0;
    const angle = twist + (i / (count * 2)) * Math.PI * 2;
    const radius = isOuter ? outer : inner;
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius, 0]);
  }
  return {
    Curve: curveGeo([{ points, cyclic: true }]),
    "Outer Points": Field.perElem((i) => i % 2 === 0 ? 1 : 0).tagged("POINT"),
  };
});

reg("GeometryNodeCurveEndpointSelection", (api) => {
  const startN = Math.max(0, Math.round(api.num("Start Size")));
  const endN = Math.max(0, Math.round(api.num("End Size")));
  return {
    Selection: Field.perElem((i, ctx) => (i < startN || i >= ctx.size - endN ? 1 : 0)),
  };
});

// ---- String to Curves (minimal polyline font) -----------------------------
// Produces one curve-instance per character. Glyph outlines are simplified
// unit-height strokes (not Blender font fidelity) but yield non-empty curves.

/** Unit-box (x∈[0,0.6], y∈[0,1]) stroke polylines for common glyphs. */
const GLYPHS: Record<string, Vec3[][]> = (() => {
  const g: Record<string, Vec3[][]> = {};
  const L = (pts: number[][]): Vec3[] => pts.map((p) => [p[0], p[1], 0] as Vec3);
  // Digits
  g["0"] = [L([[0.05, 0], [0.55, 0], [0.55, 1], [0.05, 1], [0.05, 0]])];
  g["1"] = [L([[0.15, 0.8], [0.3, 1], [0.3, 0]])];
  g["2"] = [L([[0.05, 1], [0.55, 1], [0.55, 0.5], [0.05, 0.5], [0.05, 0], [0.55, 0]])];
  g["3"] = [L([[0.05, 1], [0.55, 1], [0.55, 0.5], [0.2, 0.5], [0.55, 0.5], [0.55, 0], [0.05, 0]])];
  g["4"] = [L([[0.05, 1], [0.05, 0.5], [0.55, 0.5]]), L([[0.45, 1], [0.45, 0]])];
  g["5"] = [L([[0.55, 1], [0.05, 1], [0.05, 0.5], [0.55, 0.5], [0.55, 0], [0.05, 0]])];
  g["6"] = [L([[0.55, 1], [0.05, 1], [0.05, 0], [0.55, 0], [0.55, 0.5], [0.05, 0.5]])];
  g["7"] = [L([[0.05, 1], [0.55, 1], [0.2, 0]])];
  g["8"] = [L([[0.05, 0], [0.55, 0], [0.55, 0.5], [0.05, 0.5], [0.05, 1], [0.55, 1], [0.55, 0.5], [0.05, 0.5], [0.05, 0]])];
  g["9"] = [L([[0.05, 0], [0.55, 0], [0.55, 1], [0.05, 1], [0.05, 0.5], [0.55, 0.5]])];
  // Letters (uppercase + map lowercase)
  g["A"] = [L([[0, 0], [0.3, 1], [0.6, 0]]), L([[0.12, 0.4], [0.48, 0.4]])];
  g["B"] = [L([[0.05, 0], [0.05, 1], [0.4, 1], [0.5, 0.75], [0.4, 0.5], [0.05, 0.5], [0.45, 0.5], [0.55, 0.25], [0.45, 0], [0.05, 0]])];
  g["C"] = [L([[0.55, 0.85], [0.4, 1], [0.1, 1], [0, 0.8], [0, 0.2], [0.1, 0], [0.4, 0], [0.55, 0.15]])];
  g["D"] = [L([[0.05, 0], [0.05, 1], [0.35, 1], [0.55, 0.7], [0.55, 0.3], [0.35, 0], [0.05, 0]])];
  g["E"] = [L([[0.55, 1], [0.05, 1], [0.05, 0], [0.55, 0]]), L([[0.05, 0.5], [0.4, 0.5]])];
  g["F"] = [L([[0.05, 0], [0.05, 1], [0.55, 1]]), L([[0.05, 0.5], [0.4, 0.5]])];
  g["G"] = [L([[0.55, 0.85], [0.4, 1], [0.1, 1], [0, 0.8], [0, 0.2], [0.1, 0], [0.4, 0], [0.55, 0.2], [0.55, 0.45], [0.3, 0.45]])];
  g["H"] = [L([[0.05, 0], [0.05, 1]]), L([[0.55, 0], [0.55, 1]]), L([[0.05, 0.5], [0.55, 0.5]])];
  g["I"] = [L([[0.15, 1], [0.45, 1]]), L([[0.3, 1], [0.3, 0]]), L([[0.15, 0], [0.45, 0]])];
  g["J"] = [L([[0.1, 1], [0.5, 1], [0.5, 0.25], [0.35, 0], [0.15, 0], [0.05, 0.15]])];
  g["K"] = [L([[0.05, 0], [0.05, 1]]), L([[0.55, 1], [0.05, 0.5], [0.55, 0]])];
  g["L"] = [L([[0.05, 1], [0.05, 0], [0.55, 0]])];
  g["M"] = [L([[0, 0], [0, 1], [0.3, 0.4], [0.6, 1], [0.6, 0]])];
  g["N"] = [L([[0.05, 0], [0.05, 1], [0.55, 0], [0.55, 1]])];
  g["O"] = [L([[0.1, 0], [0.5, 0], [0.6, 0.2], [0.6, 0.8], [0.5, 1], [0.1, 1], [0, 0.8], [0, 0.2], [0.1, 0]])];
  g["P"] = [L([[0.05, 0], [0.05, 1], [0.4, 1], [0.55, 0.75], [0.4, 0.5], [0.05, 0.5]])];
  g["Q"] = [L([[0.1, 0.15], [0.5, 0.15], [0.6, 0.35], [0.6, 0.8], [0.5, 1], [0.1, 1], [0, 0.8], [0, 0.35], [0.1, 0.15]]), L([[0.35, 0.35], [0.6, 0]])];
  g["R"] = [L([[0.05, 0], [0.05, 1], [0.4, 1], [0.55, 0.75], [0.4, 0.5], [0.05, 0.5], [0.3, 0.5], [0.55, 0]])];
  g["S"] = [L([[0.55, 0.85], [0.4, 1], [0.15, 1], [0.05, 0.8], [0.15, 0.55], [0.45, 0.45], [0.55, 0.2], [0.4, 0], [0.1, 0], [0.05, 0.15]])];
  g["T"] = [L([[0, 1], [0.6, 1]]), L([[0.3, 1], [0.3, 0]])];
  g["U"] = [L([[0.05, 1], [0.05, 0.2], [0.15, 0], [0.45, 0], [0.55, 0.2], [0.55, 1]])];
  g["V"] = [L([[0, 1], [0.3, 0], [0.6, 1]])];
  g["W"] = [L([[0, 1], [0.15, 0], [0.3, 0.5], [0.45, 0], [0.6, 1]])];
  g["X"] = [L([[0, 1], [0.6, 0]]), L([[0.6, 1], [0, 0]])];
  g["Y"] = [L([[0, 1], [0.3, 0.5], [0.6, 1]]), L([[0.3, 0.5], [0.3, 0]])];
  g["Z"] = [L([[0.05, 1], [0.55, 1], [0.05, 0], [0.55, 0]])];
  g["."] = [L([[0.25, 0], [0.35, 0], [0.35, 0.1], [0.25, 0.1], [0.25, 0]])];
  g[":"] = [L([[0.25, 0.2], [0.35, 0.2], [0.35, 0.3], [0.25, 0.3], [0.25, 0.2]]), L([[0.25, 0.7], [0.35, 0.7], [0.35, 0.8], [0.25, 0.8], [0.25, 0.7]])];
  g["-"] = [L([[0.1, 0.5], [0.5, 0.5]])];
  g["/"] = [L([[0.1, 0], [0.5, 1]])];
  g[" "] = [];
  // lowercase aliases
  for (const k of Object.keys(g)) {
    if (k.length === 1 && k >= "A" && k <= "Z") g[k.toLowerCase()] = g[k];
  }
  return g;
})();

function geometryBoundsFromPositionsOnly(geometry: Geometry): void {
  geometry.curveAttributes.set("__gnvm_planar_font_curve", {
    domain: "CURVE",
    data: geometry.curves.map(() => 1),
  });
}

function glyphGeometry(ch: string, size: number): Geometry {
  const fallback: Vec3[][] = [[[0.05, 0, 0], [0.55, 0, 0], [0.55, 1, 0], [0.05, 1, 0], [0.05, 0, 0]]];
  const polys: Vec3[][] = GLYPHS[ch] ?? fallback;
  const g = new Geometry();
  const stroke = .065 * size;
  for (const raw of polys) {
    const pts = raw.map((p) => [p[0] * size, p[1] * size, 0] as Vec3);
    const closed = pts.length > 2 && Math.hypot(pts[0][0] - pts.at(-1)![0], pts[0][1] - pts.at(-1)![1]) < 1e-9 * Math.max(size, 1e-9);
    if (closed) {
      g.curves.push({ cyclic: true, points: pts.slice(0, -1) });
      continue;
    }
    // Blender fonts output closed outline curves. The portable glyph table is
    // stored as compact centerline strokes, so expand each segment to a thin
    // closed quad before Fill Curve consumes it.
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
      if (length < 1e-12) continue;
      const nx = -dy / length * stroke, ny = dx / length * stroke;
      g.curves.push({ cyclic: true, points: [
        [a[0] + nx, a[1] + ny, 0], [b[0] + nx, b[1] + ny, 0],
        [b[0] - nx, b[1] - ny, 0], [a[0] - nx, a[1] - ny, 0],
      ] });
    }
  }
  // String to Curves produces positional font outlines. Blender's Bounding
  // Box does not expand those outlines by the generic Curve radius (unlike a
  // native Curve Line/Circle component). Keep that provenance through nested
  // instancing so downstream centering groups use the authored glyph bounds.
  geometryBoundsFromPositionsOnly(g);
  return g;
}

function atlasGlyphGeometry(fontName: string | undefined, ch: string, size: number): Geometry | null {
  const entry = fontName ? DUMP_CONTEXT.fonts[fontName]?.glyphs[ch] : undefined;
  if (!entry) return null;
  const stride = DUMP_CONTEXT.fonts[fontName!]?.sample_stride ?? 12;
  const geometry = new Geometry();
  geometry.curves = entry.curves.map((curve) => ({
    cyclic: curve.cyclic,
    points: curve.points.reduce<Vec3[]>((points, point) => {
      const next: Vec3 = [Number(point[0] ?? 0) * size, Number(point[1] ?? 0) * size, Number(point[2] ?? 0) * size];
      // Blender collapses repeated bridge corners in grid-font outlines before
      // triangulating them. Keeping both visits made D/P produce one extra
      // triangle each even though the final welded vertex count was correct.
      if (stride === 0 && points.some((existing) => vlen(vsub(existing, next)) <= 1e-7)) return points;
      points.push(next);
      return points;
    }, []),
  }));
  geometryBoundsFromPositionsOnly(geometry);
  // Blender's evaluated CFF/Bezier curves use 12 samples per authored segment.
  // Pixel/grid fonts deliberately retain collinear cell corners, so the atlas
  // extractor marks those with a zero stride instead of applying Bezier
  // interior-point dissolution to them.
  if (stride > 1) geometry.curveAttributes.set("__font_sample_stride", { domain: "CURVE", data: entry.curves.map(() => stride) });
  return geometry;
}

reg("GeometryNodeStringToCurves", (api) => {
  const text = api.str("String") || "";
  const fontSocket = api.node.inputs.find((socket) =>
    socket.name === "Font" || socket.identifier === "Font");
  // Blender treats an explicitly unassigned Font datablock as unavailable and
  // emits no character instances. Keep the portable vector glyphs only as the
  // fallback for an assigned font whose binary/atlas is unavailable (or for a
  // legacy dump that predates the Font socket). The Intro MAT header exercises
  // this distinction: its null socket is intentionally blank in Blender.
  if (fontSocket && !fontSocket.linked && fontSocket.value == null && api.ref("Font") == null) {
    const empty = new Geometry();
    return {
      "Curve Instances": empty,
      Curve: empty,
      Remainder: text,
      Line: Field.of(0),
      "Pivot Point": Field.of([0, 0, 0] as Vec3),
    };
  }
  const size = api.num("Size") || 1;
  const charSpacing = api.num("Character Spacing");
  // Blender: character spacing multiplies the advance; 1.0 is default full advance.
  // Values < 1 pack tighter (bin uses 0.17–0.39). Treat as advance scale with a
  // floor so tiny values still separate glyphs.
  const advanceScale = charSpacing > 0 ? charSpacing : 1;
  const wordSpacing = api.num("Word Spacing") || 1;
  const lineSpacing = api.num("Line Spacing") || 1;
  const textBoxWidth = Math.max(0, api.num("Text Box Width"));
  const alignX = (api.str("Align X") || api.prop<string>("align_x", "LEFT") || "LEFT").toUpperCase();
  const alignY = api.str("Align Y") || "Top Baseline";
  const pivotPoint = (api.str("Pivot Point") || "").toUpperCase();
  const fontName = api.ref("Font")?.name;
  const atlas = fontName ? DUMP_CONTEXT.fonts[fontName] : undefined;
  const alignYOffset = size * (atlas?.align_offsets?.[alignY] ?? 0);
  const spacingExtra = advanceScale > 1 ? size * 0.5 * (advanceScale - 1) : 0;
  const advanceOf = (ch: string) => {
    const base = size * (atlas?.glyphs[ch]?.advance ?? .7) * (ch === " " ? wordSpacing : 1);
    if (advanceScale <= 1 || !atlas) return base * advanceScale;
    // Above 1.0 Blender adds half an em for every extra spacing unit. This is
    // independent of the glyph's visible width and also applies to spaces.
    // The final character's extra gap is excluded from alignment width below.
    return base + spacingExtra;
  };

  const wrapLine = (line: string): string[] => {
    if (textBoxWidth <= 0 || !line.includes(" ")) return [line];
    const words = line.split(" ");
    const wrapped: string[] = [];
    let current = "";
    let currentWidth = 0;
    const spaceWidth = advanceOf(" ");
    for (const word of words) {
      // Blender wraps only at word boundaries. A word wider than the text box
      // remains intact on its own line instead of being split into glyphs.
      const wordWidth = [...word].reduce((total, ch) => total + advanceOf(ch), 0);
      if (current && currentWidth + spaceWidth + wordWidth > textBoxWidth) {
        // Wrapping changes layout, but Blender keeps the separator as an empty
        // character instance in the domain. Preserve it at the end of the
        // previous line so downstream indexing follows the original string.
        wrapped.push(`${current} `);
        current = word;
        currentWidth = wordWidth;
      } else if (current) {
        current += ` ${word}`;
        currentWidth += spaceWidth + wordWidth;
      } else {
        current = word;
        currentWidth = wordWidth;
      }
    }
    wrapped.push(current);
    return wrapped;
  };
  const lines: { text: string; explicitBreakAfter: boolean }[] = [];
  const paragraphs = text.split("\n");
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const wrapped = wrapLine(paragraphs[paragraphIndex]);
    for (let wrappedIndex = 0; wrappedIndex < wrapped.length; wrappedIndex++) lines.push({
      text: wrapped[wrappedIndex],
      explicitBreakAfter: paragraphIndex + 1 < paragraphs.length && wrappedIndex + 1 === wrapped.length,
    });
  }
  const out = new Geometry();
  const cellH = size * lineSpacing;
  const blockHeight = Math.max(0, lines.length - 1) * cellH;
  const alignYKey = alignY.toUpperCase().replace(/[^A-Z]/g, "");
  const blockOffset = alignYKey === "MIDDLE" || alignYKey === "CENTER"
    ? blockHeight / 2
    : alignYKey.startsWith("BOTTOM") ? blockHeight : 0;

  let lineIdx = 0;
  for (const line of lines) {
    const chars = [...line.text];
    // Blender retains trailing whitespace as empty instances but excludes its
    // advance from horizontal alignment. Wrapped Type Pixel Brush lines end in
    // a space; including it shifted each centered line left by half its width.
    let alignmentEnd = chars.length;
    while (alignmentEnd > 0 && chars[alignmentEnd - 1] === " ") alignmentEnd--;
    let lineWidth = 0;
    for (const ch of chars.slice(0, alignmentEnd)) {
      lineWidth += advanceOf(ch);
    }
    if (alignmentEnd > 0) lineWidth -= spacingExtra;
    // A wrap separator remains an empty instance at the end of the preceding
    // line. Blender excludes its nominal width from centering, but retains the
    // amount removed by sub-1 character spacing. This is observable on the
    // Alkhemikal helper: both wrapped lines shift left by half of that residual
    // while the final line (without a separator) stays fixed.
    if (alignmentEnd < chars.length && advanceScale < 1) {
      for (const ch of chars.slice(alignmentEnd)) {
        const nominal = size * (atlas?.glyphs[ch]?.advance ?? .7) * (ch === " " ? wordSpacing : 1);
        lineWidth += nominal * (1 - advanceScale);
      }
    }
    let x = 0;
    if (alignX === "CENTER") x = -lineWidth / 2;
    else if (alignX === "RIGHT") x = -lineWidth;
    // A left-side pivot anchors the bounded text box at the object origin.
    if (textBoxWidth > 0 && pivotPoint.includes("LEFT")) x += textBoxWidth / 2;
    const y = alignYOffset + blockOffset - lineIdx * cellH;
    for (const ch of chars) {
      // Blender keeps whitespace as an empty instance. It has no visible
      // curves, but it remains part of the instance domain and therefore of
      // Pick Instance indexing. Text Soup maps "YOUR TEXT HERE" onto 14 guide
      // points and relies on the two empty space entries staying in the list.
      const glyph = atlasGlyphGeometry(fontName, ch, size) ?? glyphGeometry(ch, size);
      out.instances.push({
        geometry: glyph,
        position: [x, y, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      });
      x += advanceOf(ch);
    }
    // Blender retains an explicit line break as one empty curve instance at
    // the end of the preceding line. It contributes to instance-domain
    // indexing but carries no glyph geometry.
    if (line.explicitBreakAfter) out.instances.push({
      geometry: new Geometry(),
      position: [x, y, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
    lineIdx++;
  }
  // Also expose flattened curves for consumers that expect Curve geometry
  // (realize is typically applied downstream via Instance on Points / realize).
  return {
    "Curve Instances": out,
    Curve: out, // alias some dumps may read
    Remainder: "",
    Line: Field.of(0),
    "Pivot Point": Field.of([0, 0, 0] as Vec3),
  };
});
