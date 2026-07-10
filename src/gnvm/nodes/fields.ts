// Field-plumbing nodes: sample-at-index, evaluate-on-domain, align-euler.
import { Field, Vec3, Elem, Domain, asNum, asVec3, vnorm, vcross, vdot, vlen } from "../core";
import { reg } from "../registry";

const DOMAINS = new Set<Domain>(["POINT", "EDGE", "FACE", "CORNER", "CURVE", "INSTANCE"]);

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
  // AttributeDomainSize returns counts; we don't track them precisely -> 0s.
  if (api.node.type === "GeometryNodeAttributeDomainSize") {
    return { "Point Count": Field.of(0), "Edge Count": Field.of(0), "Face Count": Field.of(0), "Face Corner Count": Field.of(0) };
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
