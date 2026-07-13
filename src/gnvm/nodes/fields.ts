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
// Matrix aligning unit axis `a` onto target `t` (Rodrigues), then euler XYZ
// extracted for M = Rz*Ry*Rx (the convention rotateEulerXYZ uses).
function axisAngleMatrix(axis: Vec3, angle: number): number[][] {
  const [x, y, z] = vnorm(axis);
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}
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
function quatFromTo(from0: Vec3, to0: Vec3, axisSel: string): Quat {
  const from = vnorm(from0), to = vnorm(to0);
  const dot = Math.max(-1, Math.min(1, vdot(from, to)));
  if (dot > 1 - 1e-10) return [0, 0, 0, 1];
  if (dot < -1 + 1e-10) {
    // AUTO keeps the named axis' conventional roll reference stable. Project
    // that reference onto the perpendicular plane so Y -> -Y rotates around Z,
    // matching Blender's outward-facing cyclic-curve instances.
    const reference: Vec3 = axisSel === "Y" ? [0, 0, 1] : axisSel === "Z" ? [1, 0, 0] : [0, 1, 0];
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
  const a: Vec3 = axisSel === "Y" ? [0, 1, 0] : axisSel === "Z" ? [0, 0, 1] : [1, 0, 0];
  const vecF = api.field("Vector");
  const facF = api.field("Factor");
  return {
    Rotation: Field.make((ctx) => {
      const vArr = vecF.array(ctx);
      const fArr = facF.array(ctx);
      const out: Elem[] = new Array(ctx.size);
      for (let i = 0; i < ctx.size; i++) {
        const t = vnorm(asVec3(vArr[i] ?? [0, 0, 1]));
        const f = asNum(fArr[i] ?? 1);
        const d = Math.max(-1, Math.min(1, vdot(a, t)));
        let ang = Math.acos(d) * f;
        let axis = vcross(a, t);
        if (vlen(axis) <= 1e-12) {
          // Antiparallel vectors have infinitely many valid rotation axes.
          // Blender's AUTO pivot keeps Z stable when aligning Y (the radial
          // array's -Y point); choosing X reflects the instanced curve in Z.
          axis = axisSel === "Y" ? [0, 0, 1] : axisSel === "Z" ? [1, 0, 0] : [0, 1, 0];
        }
        out[i] = matrixToEulerXYZ(axisAngleMatrix(axis, ang));
      }
      return out;
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
      const base = quatFromEulerXYZ(asVec3(r));
      const currentAxis = quatRotate(base, localAxis);
      const delta = quatSlerpIdentity(quatFromTo(currentAxis, asVec3(v), axisSel), asNum(f));
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
