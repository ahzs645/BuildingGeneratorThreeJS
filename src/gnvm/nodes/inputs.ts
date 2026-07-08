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
    Exists: Field.of(1),
  };
});

reg("GeometryNodeInputSceneTime", () => ({ Seconds: Field.of(0), Frame: Field.of(0) }));
