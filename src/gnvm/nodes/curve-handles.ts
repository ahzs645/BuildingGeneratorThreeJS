import { Elem, Vec3, asNum, asVec3, vadd } from "../core";
import { evaluateBezierSpline } from "../bezier";
import { Geometry, Spline } from "../geometry";
import { makeFieldCtx } from "../evaluator";
import { reg } from "../registry";

function authoredSpline(source: Spline): Spline {
  return {
    cyclic: source.cyclic,
    resolution: source.resolution,
    points: (source.controlPoints?.length ? source.controlPoints : source.points).map((point) => [...point] as Vec3),
  };
}

reg("GeometryNodeSetCurveHandlePositions", (api) => {
  const source = api.geo("Curve");
  const out = source.clone();
  if (!source.curves.length) return { Curve: out };

  // Blender resolves Selection, Position, and Offset on Bézier control points,
  // while the VM stores a denser evaluated polyline in `points` for meshing.
  const authored = new Geometry();
  authored.curves = source.curves.map(authoredSpline);
  for (const [name, attribute] of source.curveAttributes)
    authored.curveAttributes.set(name, { domain: attribute.domain, data: [...attribute.data] });
  const ctx = makeFieldCtx(authored, "POINT");
  const selection = api.field("Selection").array(ctx);
  const offset = api.field("Offset").array(ctx);
  const positionLinked = api.node.inputs.find((socket) => socket.identifier === "Position")?.linked ?? false;
  const position = positionLinked ? api.field("Position").array(ctx) : null;
  const side = api.prop<string>("mode", "LEFT");

  let pointOffset = 0;
  let frameChanged = false;
  out.curves = source.curves.map((spline) => {
    const controlPoints = (spline.controlPoints?.length ? spline.controlPoints : spline.points).map((point) => [...point] as Vec3);
    const left = (spline.bezierLeft ?? controlPoints).map((point) => [...point] as Vec3);
    const right = (spline.bezierRight ?? controlPoints).map((point) => [...point] as Vec3);
    const target = side === "RIGHT" ? right : left;
    for (let index = 0; index < controlPoints.length; index++) {
      const fieldIndex = pointOffset + index;
      if (!asNum(selection[fieldIndex] ?? 1)) continue;
      const base: Elem = position ? position[fieldIndex] ?? target[index] : target[index];
      const next = vadd(asVec3(base), asVec3(offset[fieldIndex] ?? [0, 0, 0]));
      frameChanged ||= next.some((value, axis) => value !== target[index][axis]);
      target[index] = next;
    }
    pointOffset += controlPoints.length;
    return {
      cyclic: spline.cyclic,
      resolution: spline.resolution,
      controlPoints,
      bezierLeft: left,
      bezierRight: right,
      points: evaluateBezierSpline(controlPoints, spline.cyclic, left, right, spline.resolution),
    };
  });
  if (frameChanged) {
    out.curveAttributes.delete("__curve_tangent");
    out.curveAttributes.delete("__curve_imported_tangent");
    out.curveAttributes.delete("__curve_normal");
  }
  return { Curve: out };
});
