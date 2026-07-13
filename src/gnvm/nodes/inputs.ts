// Field-producing input nodes (resolved lazily against the consuming geometry's domain).
import { Field, Vec3 } from "../core";
import { DUMP_CONTEXT, reg } from "../registry";

reg("GeometryNodeInputPosition", () => ({
  Position: Field.perElem((i, ctx) => (ctx.position ? ctx.position(i) : [0, 0, 0])),
}));

reg("GeometryNodeInputCurveTilt", () => ({
  Tilt: Field.perElem((i, ctx) => ctx.attr?.("tilt", i) ?? 0),
}));

// Curve Radius is 1.0 when no authored per-point radius attribute exists.
// It is also available on point clouds, where downstream Instance on Points
// commonly uses it as a uniform scale field.
reg("GeometryNodeInputRadius", () => ({
  Radius: Field.perElem((i, ctx) => ctx.attr?.("radius", i) ?? 1),
}));

reg("GeometryNodeInputSplineResolution", () => ({
  Resolution: Field.perElem((i, ctx) => ctx.splineResolution?.(i) ?? 1),
}));

// Browser evaluation is the viewport path. A future offline renderer can expose
// an explicit render-mode override without changing portable graph semantics.
reg("GeometryNodeIsViewport", () => ({ "Is Viewport": Field.of(1) }));

reg("GeometryNodeImageInfo", (api) => {
  const image = DUMP_CONTEXT.images.find((candidate) => candidate.name === api.ref("Image")?.name);
  return {
    Width: Field.of(image?.size?.[0] ?? 0), Height: Field.of(image?.size?.[1] ?? 0),
    "Has Alpha": Field.of((image?.channels ?? 4) >= 4 ? 1 : 0),
    "Frame Count": Field.of(1), FPS: Field.of(0),
  };
});

function imageBytes(image: (typeof DUMP_CONTEXT.images)[number] | undefined): Uint8Array | undefined {
  if (!image?.pixels_rgba8) return undefined;
  if (!image.decoded) {
    const binary = globalThis.atob(image.pixels_rgba8);
    image.decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return image.decoded;
}

reg("GeometryNodeImageTexture", (api) => {
  const image = DUMP_CONTEXT.images.find((candidate) => candidate.name === api.ref("Image")?.name);
  const bytes = imageBytes(image);
  const width = image?.size?.[0] ?? 0, height = image?.size?.[1] ?? 0;
  const vector = api.field("Vector");
  const extension = api.prop<string>("extension", "REPEAT");
  const sample = (element: import("../core").Elem): { color: Vec3; alpha: number } => {
    if (!bytes || !width || !height) return { color: [0, 0, 0], alpha: 0 };
    const coordinate = Array.isArray(element) ? element : [0, 0, 0];
    let u = coordinate[0], v = coordinate[1];
    if (extension === "CLIP") {
      if (u < 0 || u > 1 || v < 0 || v > 1) return { color: [0, 0, 0], alpha: 0 };
      u = Math.max(0, Math.min(1, u)); v = Math.max(0, Math.min(1, v));
    } else {
      u = ((u % 1) + 1) % 1; v = ((v % 1) + 1) % 1;
    }
    const x = Math.min(width - 1, Math.max(0, Math.round(u * (width - 1))));
    const y = Math.min(height - 1, Math.max(0, Math.round(v * (height - 1))));
    const offset = (y * width + x) * 4;
    return { color: [bytes[offset] / 255, bytes[offset + 1] / 255, bytes[offset + 2] / 255], alpha: bytes[offset + 3] / 255 };
  };
  return {
    Color: Field.make((ctx) => vector.array(ctx).map((value) => sample(value).color)),
    Alpha: Field.make((ctx) => vector.array(ctx).map((value) => sample(value).alpha)),
  };
});

reg("GeometryNodeInputIndex", () => ({
  Index: Field.perElem((i) => i),
}));

reg("GeometryNodeInputNormal", () => ({
  Normal: Field.perElem((i, ctx) => (ctx.normal ? ctx.normal(i) : [0, 0, 1])),
}));

// Curve Tangent is defined only on a curve component. Blender returns zero
// when the same field is evaluated on a mesh/point-cloud component.
reg("GeometryNodeInputTangent", () => ({
  Tangent: Field.perElem((i, ctx) => {
    if (ctx.component !== "CURVE") return [0, 0, 0] as Vec3;
    const p = ctx.position ? ctx.position(i) : ([0, 0, 0] as Vec3);
    const neighbors = ctx.neighbors?.(i) ?? [];
    let prev = p, next = p;
    if (ctx.position && neighbors.length >= 2) {
      prev = ctx.position(neighbors[0]);
      next = ctx.position(neighbors[1]);
    } else if (ctx.position && neighbors.length === 1) {
      const neighbor = ctx.position(neighbors[0]);
      if (neighbors[0] > i) next = neighbor;
      else prev = neighbor;
    }
    const dx = next[0] - prev[0], dy = next[1] - prev[1], dz = next[2] - prev[2];
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-12) return [dx / len, dy / len, dz / len] as Vec3;
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
