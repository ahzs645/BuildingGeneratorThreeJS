// Color-field nodes used by geometry graphs.
import { Elem, Field, Vec3, asNum, asVec3 } from "../core";
import { reg } from "../registry";

type RampElement = { position: number; color: number[] };
type RampProps = { interpolation?: string; elements?: RampElement[] };

function smoothstep(value: number): number { return value * value * (3 - 2 * value); }

reg("ShaderNodeValToRGB", (api) => {
  const factor = api.field("Fac");
  const ramp = api.prop<RampProps>("color_ramp", {});
  const elements = [...(ramp.elements ?? [
    { position: 0, color: [0, 0, 0, 1] },
    { position: 1, color: [1, 1, 1, 1] },
  ])].sort((a, b) => a.position - b.position);
  const sample = (raw: Elem): { color: Vec3; alpha: number } => {
    const value = asNum(raw);
    if (value <= elements[0].position) return { color: asVec3(elements[0].color.slice(0, 3) as Vec3), alpha: elements[0].color[3] ?? 1 };
    if (value >= elements[elements.length - 1].position) {
      const last = elements[elements.length - 1];
      return { color: asVec3(last.color.slice(0, 3) as Vec3), alpha: last.color[3] ?? 1 };
    }
    let right = 1;
    while (right < elements.length && value > elements[right].position) right++;
    const a = elements[right - 1], b = elements[right];
    let t = (value - a.position) / Math.max(1e-12, b.position - a.position);
    if (ramp.interpolation === "CONSTANT") t = 0;
    else if (ramp.interpolation === "EASE") t = smoothstep(t);
    const ca = a.color, cb = b.color;
    return {
      color: [0, 1, 2].map((channel) => (ca[channel] ?? 0) + ((cb[channel] ?? 0) - (ca[channel] ?? 0)) * t) as Vec3,
      alpha: (ca[3] ?? 1) + ((cb[3] ?? 1) - (ca[3] ?? 1)) * t,
    };
  };
  return {
    Color: Field.make((ctx) => factor.array(ctx).map((value) => sample(value).color)),
    Alpha: Field.make((ctx) => factor.array(ctx).map((value) => sample(value).alpha)),
  };
});
