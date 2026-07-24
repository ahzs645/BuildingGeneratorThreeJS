import { Elem, Field, FieldCtx, Vec3, asNum, asVec3, fieldMap, vadd, vdot, vscale, vsub } from "../core";
import { realizeInstances } from "../geometry";
import { makeFieldCtx } from "../evaluator";
import { reg } from "../registry";

function interpolate(a: Elem, b: Elem, c: Elem, weights: Vec3): Elem {
  if (Array.isArray(a) || Array.isArray(b) || Array.isArray(c)) {
    const av = asVec3(a), bv = asVec3(b), cv = asVec3(c);
    return [
      av[0] * weights[0] + bv[0] * weights[1] + cv[0] * weights[2],
      av[1] * weights[0] + bv[1] * weights[1] + cv[1] * weights[2],
      av[2] * weights[0] + bv[2] * weights[1] + cv[2] * weights[2],
    ];
  }
  return asNum(a) * weights[0] + asNum(b) * weights[1] + asNum(c) * weights[2];
}

// Closest point from Real-Time Collision Detection, with barycentric weights.
function closestTriangle(point: Vec3, a: Vec3, b: Vec3, c: Vec3): { point: Vec3; weights: Vec3 } {
  const ab = vsub(b, a), ac = vsub(c, a), ap = vsub(point, a);
  const d1 = vdot(ab, ap), d2 = vdot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { point: a, weights: [1, 0, 0] };

  const bp = vsub(point, b), d3 = vdot(ab, bp), d4 = vdot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { point: b, weights: [0, 1, 0] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return { point: vadd(a, vscale(ab, v)), weights: [1 - v, v, 0] };
  }

  const cp = vsub(point, c), d5 = vdot(ab, cp), d6 = vdot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { point: c, weights: [0, 0, 1] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { point: vadd(a, vscale(ac, w)), weights: [1 - w, 0, w] };
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const edge = vsub(c, b);
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return { point: vadd(b, vscale(edge, w)), weights: [0, 1 - w, w] };
  }

  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator, w = vc * denominator;
  return { point: vadd(a, vadd(vscale(ab, v), vscale(ac, w))), weights: [1 - v - w, v, w] };
}

reg("GeometryNodeSampleNearestSurface", (api) => {
  const target = realizeInstances(api.geo("Mesh"));
  const mesh = target.mesh;
  const value = api.field("Value");
  const sourceValues = mesh ? value.array(makeFieldCtx(target, "POINT")) : [];
  const triangles: [number, number, number][] = [];
  for (const face of mesh?.faces ?? [])
    for (let index = 1; index + 1 < face.length; index++) triangles.push([face[0], face[index], face[index + 1]]);
  const samplePosition = api.field("Sample Position");
  const positionLinked = api.node.inputs.find((socket) => socket.identifier === "Sample Position")?.linked ?? false;
  const cache = new WeakMap<FieldCtx, { values: Elem[]; valid: Elem[] }>();
  const sample = (ctx: FieldCtx) => {
    const cached = cache.get(ctx);
    if (cached) return cached;
    const requested = positionLinked
      ? samplePosition.array(ctx).map(asVec3)
      : Array.from({ length: ctx.size }, (_, index) => ctx.position?.(index) ?? [0, 0, 0] as Vec3);
    const values: Elem[] = new Array(ctx.size).fill(0);
    const valid: Elem[] = new Array(ctx.size).fill(0);
    if (mesh && triangles.length) for (let index = 0; index < requested.length; index++) {
      let bestDistance = Infinity;
      let best: { triangle: [number, number, number]; weights: Vec3 } | undefined;
      for (const triangle of triangles) {
        const closest = closestTriangle(requested[index], mesh.positions[triangle[0]], mesh.positions[triangle[1]], mesh.positions[triangle[2]]);
        const delta = vsub(requested[index], closest.point);
        const distance = vdot(delta, delta);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { triangle, weights: closest.weights };
        }
      }
      if (best) {
        values[index] = interpolate(
          sourceValues[best.triangle[0]] ?? 0,
          sourceValues[best.triangle[1]] ?? 0,
          sourceValues[best.triangle[2]] ?? 0,
          best.weights,
        );
        valid[index] = 1;
      }
    }
    const result = { values, valid };
    cache.set(ctx, result);
    return result;
  };
  return {
    Value: Field.make((ctx) => sample(ctx).values),
    "Is Valid": Field.make((ctx) => sample(ctx).valid),
  };
});

reg("GeometryNodeSetCurveRadius", (api) => {
  const source = api.geo("Curve");
  const selectionField = api.field("Selection");
  const radiusField = api.field("Radius");
  const converted = new WeakMap<import("../geometry").Geometry, import("../geometry").Geometry>();
  const applyRadius = (input: import("../geometry").Geometry): import("../geometry").Geometry => {
    const cached = converted.get(input);
    if (cached) return cached;
    const geometry = input.clone();
    converted.set(input, geometry);
    geometry.instances = geometry.instances.map((instance, index) => ({
      ...instance,
      geometry: applyRadius(input.instances[index].geometry),
    }));
    if (!geometry.curves.length) return geometry;
    const ctx = makeFieldCtx(geometry, "POINT");
    const selection = selectionField.array(ctx);
    const radius = radiusField.array(ctx);
    const current = geometry.curveAttributes.get("radius")?.data ?? new Array(ctx.size).fill(1);
    // Curve radii are signed. A negative radius mirrors the sweep profile;
    // Blender node trees use that signed scale to taper strands toward zero.
    geometry.curveAttributes.set("radius", {
      domain: "POINT",
      data: Array.from({ length: ctx.size }, (_, index) => (
        asNum(selection[index] ?? 1) > 0 ? asNum(radius[index] ?? 0) : current[index] ?? 1
      )),
    });
    return geometry;
  };
  return { Curve: applyRadius(source) };
});

reg("GeometryNodeSetPointRadius", (api) => {
  const source = api.geo("Points");
  const selectionField = api.field("Selection");
  const radiusField = api.field("Radius");
  const converted = new WeakMap<import("../geometry").Geometry, import("../geometry").Geometry>();
  const applyRadius = (input: import("../geometry").Geometry): import("../geometry").Geometry => {
    const cached = converted.get(input);
    if (cached) return cached;
    const geometry = input.clone();
    converted.set(input, geometry);
    geometry.instances = geometry.instances.map((instance, index) => ({
      ...instance,
      geometry: applyRadius(input.instances[index].geometry),
    }));
    const mesh = geometry.mesh;
    if (!mesh?.attributes.has("__gnvm_point_cloud")) return geometry;
    const ctx = makeFieldCtx(geometry, "POINT");
    const selection = selectionField.array(ctx);
    const radius = radiusField.array(ctx);
    const current = mesh.attributes.get("radius")?.data ?? new Array(ctx.size).fill(0.05);
    mesh.attributes.set("radius", {
      domain: "POINT",
      data: Array.from({ length: ctx.size }, (_, index) => (
        asNum(selection[index] ?? 1) > 0 ? asNum(radius[index] ?? 0) : current[index] ?? 0.05
      )),
    });
    return geometry;
  };
  return { Points: applyRadius(source) };
});

type Quaternion = [number, number, number, number];
function quaternionFromEuler(euler: Vec3): Quaternion {
  const sx = Math.sin(euler[0] / 2), cx = Math.cos(euler[0] / 2);
  const sy = Math.sin(euler[1] / 2), cy = Math.cos(euler[1] / 2);
  const sz = Math.sin(euler[2] / 2), cz = Math.cos(euler[2] / 2);
  return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
}
function multiplyQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function eulerFromQuaternion(quaternion: Quaternion): Vec3 {
  const length = Math.hypot(...quaternion) || 1;
  const [x, y, z, w] = quaternion.map((value) => value / length) as Quaternion;
  const m20 = 2 * (x * z - y * w);
  const ey = Math.asin(Math.max(-1, Math.min(1, -m20)));
  const cy = Math.cos(ey);
  if (Math.abs(cy) > 1e-6) return [
    Math.atan2(2 * (y * z + x * w), 1 - 2 * (x * x + y * y)),
    ey,
    Math.atan2(2 * (x * y + z * w), 1 - 2 * (y * y + z * z)),
  ];
  return [Math.atan2(-2 * (x * y - z * w), 1 - 2 * (x * x + z * z)), ey, 0];
}

reg("FunctionNodeRotateEuler", (api) => {
  const local = api.prop<string>("space", "OBJECT") === "LOCAL";
  return {
    Rotation: fieldMap([api.field("Rotation"), api.field("Rotate By")], (rotation, rotateBy) => {
      const base = quaternionFromEuler(asVec3(rotation));
      const secondary = quaternionFromEuler(asVec3(rotateBy));
      return eulerFromQuaternion(local ? multiplyQuaternion(base, secondary) : multiplyQuaternion(secondary, base));
    }),
  };
});
