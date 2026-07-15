// Field-plumbing nodes: sample-at-index, evaluate-on-domain, align-euler.
import { Field, fieldMap, Vec3, Elem, Domain, asNum, asVec3, vnorm, vcross, vdot, vlen } from "../core";
import { reg } from "../registry";
import { buildTopology } from "../geometry";

const DOMAINS = new Set<Domain>(["POINT", "EDGE", "FACE", "CORNER", "CURVE", "INSTANCE"]);

reg("GeometryNodeInputMeshFaceArea", () => ({
  Area: Field.perElem((i, ctx) => ctx.faceArea?.(i) ?? 0).tagged("FACE"),
}));

// Value sampled at another element's index. The index is evaluated on the
// consumer context; the value is evaluated on the node's declared source domain.
reg("GeometryNodeFieldAtIndex", (api) => {
  const domainProp = api.prop<string>("domain", "POINT");
  const domain: Domain = DOMAINS.has(domainProp as Domain) ? (domainProp as Domain) : "POINT";
  const idx = api.field("Index");
  const val = api.field("Value");
  return {
    Value: Field.make((ctx) => {
      const iArr = idx.array(ctx);
      const srcCtx = ctx.domain === domain ? ctx : ctx.fork?.(domain) ?? ctx;
      const vArr = val.array(srcCtx);
      const out: Elem[] = new Array(ctx.size);
      for (let i = 0; i < ctx.size; i++) {
        const j = Math.round(asNum(iArr[i] ?? 0));
        out[i] = j >= 0 && j < vArr.length ? vArr[j] ?? 0 : 0;
      }
      return out;
    }),
  };
});

// Offset Point in Curve returns a flattened point index, but offsets within the
// source spline only.  An unconnected Point Index socket is Blender's implicit
// current-index field (the dumped socket value is misleadingly zero).  Open
// splines report invalid beyond either endpoint; cyclic splines wrap.
reg("GeometryNodeOffsetPointInCurve", (api) => {
  const pointSocket = api.node.inputs.find((socket) =>
    socket.name === "Point Index" || socket.identifier === "Point Index");
  const pointIndex = api.field("Point Index");
  const offset = api.field("Offset");

  const resolve = (ctx: Parameters<Field["array"]>[0]) => {
    const points = pointSocket?.linked ? pointIndex.array(ctx) : null;
    const offsets = offset.array(ctx);
    const indices: Elem[] = new Array(ctx.size);
    const valid: Elem[] = new Array(ctx.size);

    for (let i = 0; i < ctx.size; i++) {
      const source = Math.trunc(asNum(points?.[i] ?? i));
      const local = ctx.splineIndex?.(source) ?? source;
      const count = ctx.splinePointCount?.(source) ?? ctx.size;
      const start = source - local;
      const delta = Math.trunc(asNum(offsets[i] ?? 0));
      let target = local + delta;
      const cyclic = ctx.splineCyclic?.(source) ?? false;

      if (count > 0 && cyclic) {
        target = ((target % count) + count) % count;
        indices[i] = start + target;
        valid[i] = 1;
      } else if (count > 0 && target >= 0 && target < count) {
        indices[i] = start + target;
        valid[i] = 1;
      } else {
        indices[i] = 0;
        valid[i] = 0;
      }
    }
    return { indices, valid };
  };

  return {
    "Point Index": Field.make((ctx) => resolve(ctx).indices).tagged("POINT"),
    "Is Valid Offset": Field.make((ctx) => resolve(ctx).valid).tagged("POINT"),
  };
});

// Evaluate on Domain (a.k.a. Interpolate Domain): resolve the value field on the
// node's declared domain, then interpolate onto the consumer's domain. The
// distinction matters: e.g. Normal on POINT (smooth vertex normals) vs CORNER
// (face-split) is how the solidify angle compensation is computed.
reg(["GeometryNodeFieldOnDomain", "GeometryNodeAttributeDomainSize"], (api) => {
  if (api.node.type === "GeometryNodeAttributeDomainSize") {
    const g = api.geo("Geometry");
    const m = g.mesh;
    return {
      "Point Count": Field.of(m ? m.positions.length : g.curvePointCount()),
      "Edge Count": Field.of(m ? buildTopology(m).edges.length : g.curves.reduce((n, s) => n + Math.max(0, s.points.length - (s.cyclic ? 0 : 1)), 0)),
      "Face Count": Field.of(m?.faces.length ?? 0),
      "Face Corner Count": Field.of(m?.faces.reduce((n, f) => n + f.length, 0) ?? 0),
      "Spline Count": Field.of(g.curves.length),
      "Instance Count": Field.of(g.instances.length),
      "Layer Count": Field.of(0),
    };
  }
  const domainProp = api.prop<string>("domain", "POINT");
  const target: Domain = DOMAINS.has(domainProp as Domain) ? (domainProp as Domain) : "POINT";
  const val = api.field("Value");
  return {
    Value: Field.make((ctx) => {
      if (ctx.domain === target || !ctx.fork || !ctx.toDomain) return val.array(ctx);
      const srcArr = val.array(ctx.fork(target));
      const out: Elem[] = new Array(ctx.size);
      for (let i = 0; i < ctx.size; i++) out[i] = ctx.toDomain(target, srcArr, i) ?? 0;
      return out;
    }),
  };
});

// ---- Align Euler to Vector ------------------------------------------------
function matrixToEulerXYZ(M: number[][]): Vec3 {
  const sy = -M[2][0];
  const ey = Math.asin(Math.max(-1, Math.min(1, sy)));
  const cy = Math.cos(ey);
  if (Math.abs(cy) > 1e-6) {
    return [Math.atan2(M[2][1], M[2][2]), ey, Math.atan2(M[1][0], M[0][0])];
  }
  return [Math.atan2(-M[1][2], M[1][1]), ey, 0]; // gimbal
}

type Quat = [number, number, number, number];
const ROTATION_QUATERNION = Symbol.for("gnvm.rotationQuaternion");
type TaggedRotation = Vec3 & { [ROTATION_QUATERNION]?: Quat };
const taggedQuaternion = (value: Elem): Quat | undefined =>
  Array.isArray(value) ? (value as TaggedRotation)[ROTATION_QUATERNION] : undefined;
const quatNormalize = (q: Quat): Quat => {
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
};
const quatMultiply = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
function quatFromEulerXYZ(e: Vec3): Quat {
  const [sx, cx] = [Math.sin(e[0] / 2), Math.cos(e[0] / 2)];
  const [sy, cy] = [Math.sin(e[1] / 2), Math.cos(e[1] / 2)];
  const [sz, cz] = [Math.sin(e[2] / 2), Math.cos(e[2] / 2)];
  return quatNormalize([
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ]);
}
function quatToMatrix(q0: Quat): number[][] {
  const [x, y, z, w] = quatNormalize(q0);
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}
const quatToEulerXYZ = (q: Quat): Vec3 => matrixToEulerXYZ(quatToMatrix(q));
function quatRotate(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]];
  const s = q[3];
  const uv = vcross(u, v);
  const uuv = vcross(u, uv);
  return [v[0] + 2 * (s * uv[0] + uuv[0]), v[1] + 2 * (s * uv[1] + uuv[1]), v[2] + 2 * (s * uv[2] + uuv[2])];
}
function quatFromTo(from0: Vec3, to0: Vec3, axisSel: string, nativeRotation = false): Quat {
  const from = vnorm(from0), to = vnorm(to0);
  const dot = Math.max(-1, Math.min(1, vdot(from, to)));
  if (dot > 1 - 1e-10) return [0, 0, 0, 1];
  if (dot < -1 + 1e-10) {
    // AUTO keeps the named axis' conventional roll reference stable. Project
    // that reference onto the perpendicular plane so Y -> -Y rotates around Z,
    // matching Blender's outward-facing cyclic-curve instances.
    // Curve sockets carry a native quaternion. At the exact 180-degree
    // singularity Blender's AUTO pivot for native Z-axis rotations is Y. An
    // Euler socket reconstructed from the visually identical [pi, 0, 0]
    // contains a tiny quaternion W component and follows the X-pivot branch
    // instead. Preserve that distinction: Modern Pipe's cap rails depend on
    // the native curve rotation becoming a pi roll around Z, while an authored
    // Euler constant must continue collapsing to identity.
    const reference: Vec3 = axisSel === "Y"
      ? [0, 0, 1]
      : axisSel === "Z"
        ? nativeRotation ? [0, 1, 0] : [1, 0, 0]
        : [0, 1, 0];
    let pivot: Vec3 = [
      reference[0] - from[0] * vdot(reference, from),
      reference[1] - from[1] * vdot(reference, from),
      reference[2] - from[2] * vdot(reference, from),
    ];
    if (vlen(pivot) < 1e-10) pivot = vnorm(vcross(from, Math.abs(from[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    else pivot = vnorm(pivot);
    return [pivot[0], pivot[1], pivot[2], 0];
  }
  const cross = vcross(from, to);
  return quatNormalize([cross[0], cross[1], cross[2], 1 + dot]);
}
function quatSlerpIdentity(q0: Quat, factor: number): Quat {
  let q = quatNormalize(q0);
  if (q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
  const t = Math.max(0, Math.min(1, factor));
  const angle = Math.acos(Math.max(-1, Math.min(1, q[3])));
  if (angle < 1e-8) return [0, 0, 0, 1];
  const scale = Math.sin(angle * t) / Math.sin(angle);
  return quatNormalize([q[0] * scale, q[1] * scale, q[2] * scale, Math.cos(angle * t)]);
}

reg("FunctionNodeAlignEulerToVector", (api) => {
  const axisSel = api.prop<string>("axis", "X");
  const localAxis: Vec3 = axisSel === "Y" ? [0, 1, 0] : axisSel === "Z" ? [0, 0, 1] : [1, 0, 0];
  return {
    Rotation: fieldMap([api.field("Rotation"), api.field("Vector"), api.field("Factor")], (r, v, f) => {
      const base = quatFromEulerXYZ(asVec3(r));
      const currentAxis = quatRotate(base, localAxis);
      const delta = quatSlerpIdentity(quatFromTo(currentAxis, asVec3(v), axisSel), asNum(f));
      return quatToEulerXYZ(quatMultiply(delta, base));
    }),
  };
});

// Blender 4.2+ rotation-socket replacement for Align Euler to Vector. Align the
// chosen local axis of the incoming rotation while preserving its existing
// twist, then blend the corrective rotation by Factor.
reg("FunctionNodeAlignRotationToVector", (api) => {
  const axisSel = api.prop<string>("axis", "X");
  const localAxis: Vec3 = axisSel === "Y" ? [0, 1, 0] : axisSel === "Z" ? [0, 0, 1] : [1, 0, 0];
  const rotation = api.field("Rotation");
  const vector = api.field("Vector");
  const factor = api.field("Factor");
  return {
    Rotation: fieldMap([rotation, vector, factor], (r, v, f) => {
      const native = taggedQuaternion(r);
      const base = native ? quatNormalize(native) : quatFromEulerXYZ(asVec3(r));
      const currentAxis = quatRotate(base, localAxis);
      const delta = quatSlerpIdentity(quatFromTo(currentAxis, asVec3(v), axisSel, Boolean(native)), asNum(f));
      return quatToEulerXYZ(quatMultiply(delta, base));
    }),
  };
});

reg("FunctionNodeRotateRotation", (api) => {
  const global = api.prop<string>("rotation_space", "GLOBAL") === "GLOBAL";
  return {
    Rotation: fieldMap([api.field("Rotation"), api.field("Rotate By")], (r, by) => {
      const base = quatFromEulerXYZ(asVec3(r));
      const secondary = quatFromEulerXYZ(asVec3(by));
      return quatToEulerXYZ(global ? quatMultiply(secondary, base) : quatMultiply(base, secondary));
    }),
  };
});
