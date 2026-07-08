// Field-producing input nodes (resolved lazily against the consuming geometry's domain).
import { Field } from "../core";
import { reg } from "../registry";

reg("GeometryNodeInputPosition", () => ({
  Position: Field.perElem((i, ctx) => (ctx.position ? ctx.position(i) : [0, 0, 0])),
}));

reg("GeometryNodeInputIndex", () => ({
  Index: Field.perElem((i) => i),
}));

reg("GeometryNodeInputNormal", () => ({
  Normal: Field.perElem((i, ctx) => (ctx.normal ? ctx.normal(i) : [0, 0, 1])),
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

reg("GeometryNodeInputSceneTime", () => ({ Seconds: Field.of(0), Frame: Field.of(0) }));
