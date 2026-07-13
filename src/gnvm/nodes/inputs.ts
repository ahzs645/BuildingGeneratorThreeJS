// Field-producing input nodes (resolved lazily against the consuming geometry's domain).
import { Field, Vec3 } from "../core";
import { DUMP_CONTEXT, reg } from "../registry";

reg("GeometryNodeInputPosition", () => ({
  Position: Field.perElem((i, ctx) => (ctx.position ? ctx.position(i) : [0, 0, 0])),
}));

reg("GeometryNodeInputIndex", () => ({
  Index: Field.perElem((i) => i),
}));

reg("GeometryNodeInputNormal", () => ({
  Normal: Field.perElem((i, ctx) => (ctx.normal ? ctx.normal(i) : [0, 0, 1])),
}));

// Curve tangent (and a mesh-point finite-difference fallback). Prefer the
// context's spline frames via a small neighbor delta on curve POINT domain.
reg("GeometryNodeInputTangent", () => ({
  Tangent: Field.perElem((i, ctx) => {
    // Use position of neighbors on the same domain to form a tangent.
    // For curves, control points are sequential; for mesh edges this is approximate.
    const p = ctx.position ? ctx.position(i) : ([0, 0, 0] as Vec3);
    const prev = ctx.position && i > 0 ? ctx.position(i - 1) : p;
    const next = ctx.position && i + 1 < ctx.size ? ctx.position(i + 1) : p;
    const dx = next[0] - prev[0], dy = next[1] - prev[1], dz = next[2] - prev[2];
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-12) return [dx / len, dy / len, dz / len] as Vec3;
    // single-point / endpoint: try one-sided
    if (ctx.position && i + 1 < ctx.size) {
      const n = ctx.position(i + 1);
      const sx = n[0] - p[0], sy = n[1] - p[1], sz = n[2] - p[2];
      const sl = Math.hypot(sx, sy, sz);
      if (sl > 1e-12) return [sx / sl, sy / sl, sz / sl] as Vec3;
    }
    if (ctx.position && i > 0) {
      const n = ctx.position(i - 1);
      const sx = p[0] - n[0], sy = p[1] - n[1], sz = p[2] - n[2];
      const sl = Math.hypot(sx, sy, sz);
      if (sl > 1e-12) return [sx / sl, sy / sl, sz / sl] as Vec3;
    }
    return [0, 0, 1] as Vec3;
  }),
}));

reg("GeometryNodeInputNamedAttribute", (api) => {
  const name = api.str("Name");
  return {
    Attribute: Field.perElem((i, ctx) => (ctx.attr ? (ctx.attr(name, i) ?? 0) : 0)),
    // Exists must reflect real attribute presence: the handle's Curve-to-Mesh
    // Scale is Switch(Exists("radius") ? radius : 1) — a hardcoded true would
    // resolve the absent attribute to 0 and collapse the sweep.
    Exists: Field.perElem((i, ctx) => (ctx.attr && ctx.attr(name, i) !== undefined ? 1 : 0)),
  };
});

reg("GeometryNodeInputSceneTime", () => ({
  Seconds: Field.of(DUMP_CONTEXT.frame / Math.max(DUMP_CONTEXT.fps, 1e-9)),
  Frame: Field.of(DUMP_CONTEXT.frame),
}));
