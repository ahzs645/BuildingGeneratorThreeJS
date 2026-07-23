import {
  Field,
  type Elem,
  type Vec3,
  asNum,
  asVec3,
  fieldMap,
  vnormBlenderFloat,
} from "./core";
import { Geometry, Mesh, mergeMeshInto } from "./geometry";
import type { RawNode, SockVal } from "./registry";

export interface GroupDefinition {
  interface?: {
    item_type?: string;
    in_out?: string;
    identifier?: string;
    socket_type?: string;
  }[];
}

export interface GroupOverrideContext {
  node: RawNode;
  definition: GroupDefinition | undefined;
  pull(identifier: string): SockVal;
}

interface SocketContract {
  identifier: string;
  socketType: string;
  optionalWithoutDefinition?: boolean;
}

interface GroupOverride {
  names: readonly string[];
  inputs: readonly SocketContract[];
  outputs: readonly SocketContract[];
  evaluate(context: GroupOverrideContext): Record<string, SockVal>;
}

function groupMatchesContract(
  definition: GroupDefinition | undefined,
  node: RawNode,
  inputs: readonly SocketContract[],
  outputs: readonly SocketContract[],
): boolean {
  if (definition?.interface) {
    const sockets = definition.interface.filter((item) => item.item_type === "SOCKET");
    const hasSocket = (direction: "INPUT" | "OUTPUT", expected: SocketContract) =>
      sockets.some((socket) =>
        socket.in_out === direction
        && socket.identifier === expected.identifier
        && socket.socket_type === expected.socketType);
    return inputs.every((socket) => hasSocket("INPUT", socket))
      && outputs.every((socket) => hasSocket("OUTPUT", socket));
  }

  // Focused handler harnesses and old partial dumps may omit the referenced
  // group definition. Preserve that compatibility only when the call node
  // itself still exposes the minimum known contract.
  return inputs
    .filter((socket) => !socket.optionalWithoutDefinition)
    .every((expected) => node.inputs.some((socket) =>
      socket.identifier === expected.identifier && socket.type === expected.socketType))
    && outputs.every((expected) => node.outputs.some((socket) =>
      socket.identifier === expected.identifier && socket.type === expected.socketType));
}

function inputField(context: GroupOverrideContext, identifier: string, fallback: Elem): Field {
  const input = context.pull(identifier);
  return input instanceof Field ? input : Field.of(fallback);
}

function selectorNumber(value: SockVal): number {
  if (!(value instanceof Field)) return 0;
  if (value.isConst) return asNum(value.value);
  // Legacy material/geometry switch groups expose an integer selector as a
  // field even when their authored graph is spatially uniform. Material
  // sockets themselves cannot vary per element, so resolve that uniform field
  // once instead of treating every non-folded expression as selector zero.
  try {
    return asNum(value.array({ size: 1, domain: "POINT" })[0] ?? 0);
  } catch {
    return 0;
  }
}

function wrappedSelector(value: SockVal, maximum: SockVal): number {
  const raw = Math.round(selectorNumber(value));
  const max = Math.round(selectorNumber(maximum));
  if (max <= 0) return Math.max(0, raw);
  // The legacy switch groups subtract one, wrap that zero-based value, then
  // feed a one-based boolean ladder.
  return (((raw - 1) % max) + max) % max + 1;
}

// Contract of Node Dojo's reusable "Gradient Direction" group. The authored
// graph evaluates one finite-difference direction for every triangle in the
// polygon's corner-order fan (0, 1, 2), (0, 2, 3), ... . The final two corner
// slots are zero, so CORNER -> FACE interpolation averages the n-2 fan values
// with those two zeros before normalizing.
export function gradientDirectionField(gradient: Field, solenoidal: boolean): Field {
  return Field.make((ctx) => {
    const faceCtx = ctx.domain === "FACE" ? ctx : ctx.fork?.("FACE");
    const cornerCtx = ctx.domain === "CORNER" ? ctx : ctx.fork?.("CORNER");
    if (!faceCtx || !cornerCtx || !faceCtx.faceVertCount || !cornerCtx.position)
      return Array.from({ length: ctx.size }, () => [0, 0, 0] as Vec3);
    const scalar = gradient.array(cornerCtx);
    const f = Math.fround;
    const addFloat = (a: Vec3, b: Vec3): Vec3 => [
      f(f(a[0]) + f(b[0])),
      f(f(a[1]) + f(b[1])),
      f(f(a[2]) + f(b[2])),
    ];
    const subFloat = (a: Vec3, b: Vec3): Vec3 => [
      f(f(a[0]) - f(b[0])),
      f(f(a[1]) - f(b[1])),
      f(f(a[2]) - f(b[2])),
    ];
    const scaleFloat = (a: Vec3, scale: number): Vec3 => [
      f(f(a[0]) * f(scale)),
      f(f(a[1]) * f(scale)),
      f(f(a[2]) * f(scale)),
    ];
    const crossFloat = (a: Vec3, b: Vec3): Vec3 => [
      f(f(a[1]) * f(b[2]) - f(a[2]) * f(b[1])),
      f(f(a[2]) * f(b[0]) - f(a[0]) * f(b[2])),
      f(f(a[0]) * f(b[1]) - f(a[1]) * f(b[0])),
    ];
    const faceDirections: Vec3[] = new Array(faceCtx.size);
    let cornerStart = 0;
    for (let face = 0; face < faceCtx.size; face++) {
      const count = faceCtx.faceVertCount(face);
      if (count < 3) {
        faceDirections[face] = [0, 0, 0];
        cornerStart += count;
        continue;
      }
      const p0 = cornerCtx.position(cornerStart);
      const s0 = asNum(scalar[cornerStart] ?? 0);
      let fanDirection: Vec3 = [0, 0, 0];
      for (let triangle = 0; triangle < count - 2; triangle++) {
        const p1 = cornerCtx.position(cornerStart + triangle + 1);
        const p2 = cornerCtx.position(cornerStart + triangle + 2);
        const s1 = asNum(scalar[cornerStart + triangle + 1] ?? 0);
        const s2 = asNum(scalar[cornerStart + triangle + 2] ?? 0);
        const raw = addFloat(
          scaleFloat(subFloat(p2, p1), f(s0 - s2)),
          scaleFloat(subFloat(p0, p2), f(s1 - s2)),
        );
        fanDirection = addFloat(fanDirection, vnormBlenderFloat(raw));
      }
      const cornerAverage = scaleFloat(fanDirection, f(1 / count));
      const gradientDirection = vnormBlenderFloat(cornerAverage);
      const direction = solenoidal
        ? gradientDirection
        : crossFloat(faceCtx.normal?.(face) ?? [0, 0, 0], gradientDirection);
      faceDirections[face] = direction;
      cornerStart += count;
    }
    if (ctx.domain === "FACE") return faceDirections.map(vnormBlenderFloat);
    if (!ctx.toDomain) return Array.from({ length: ctx.size }, () => [0, 0, 0] as Vec3);
    return Array.from(
      { length: ctx.size },
      (_, index) => vnormBlenderFloat(asVec3(ctx.toDomain!("FACE", faceDirections, index) ?? [0, 0, 0])),
    );
  });
}

function hueSaturationValueField(
  color: Field,
  hue: Field,
  saturation: Field,
  value: Field,
  factor: Field,
): Field {
  return fieldMap([color, hue, saturation, value, factor], (
    colorValue,
    hueValue,
    saturationValue,
    valueValue,
    factorValue,
  ) => {
    const rgb = asVec3(colorValue);
    const maximum = Math.max(rgb[0], rgb[1], rgb[2]);
    const minimum = Math.min(rgb[0], rgb[1], rgb[2]);
    const range = maximum - minimum;
    let sourceHue = 0;
    const sourceSaturation = maximum === 0 ? 0 : range / maximum;
    if (range !== 0) {
      if (rgb[2] === maximum && (rgb[2] === rgb[0] || rgb[2] === rgb[1])) sourceHue = 2 / 3;
      else if (rgb[1] === maximum && rgb[1] === rgb[0]) sourceHue = 1 / 3;
      else {
        if (maximum === rgb[0]) sourceHue = (rgb[1] - rgb[2]) / range;
        else if (maximum === rgb[1]) sourceHue = 2 + (rgb[2] - rgb[0]) / range;
        else sourceHue = 4 + (rgb[0] - rgb[1]) / range;
        sourceHue = ((sourceHue / 6) % 1 + 1) % 1;
      }
    }
    const adjustedHue = ((sourceHue + asNum(hueValue) - 0.5) % 1 + 1) % 1;
    const adjustedSaturation = Math.max(0, Math.min(1, sourceSaturation * asNum(saturationValue)));
    const adjustedValue = Math.max(0, Math.min(1, maximum * asNum(valueValue)));
    const sector = adjustedHue * 6;
    const index = Math.floor(sector);
    const fraction = sector - index;
    const p = adjustedValue * (1 - adjustedSaturation);
    const q = adjustedValue * (1 - adjustedSaturation * fraction);
    const t = adjustedValue * (1 - adjustedSaturation * (1 - fraction));
    const adjusted: Vec3 = ([
      [adjustedValue, t, p], [q, adjustedValue, p], [p, adjustedValue, t],
      [p, q, adjustedValue], [t, p, adjustedValue], [adjustedValue, p, q],
    ][index % 6] ?? [adjustedValue, p, q]) as Vec3;
    const mix = Math.max(0, Math.min(1, asNum(factorValue)));
    return [
      rgb[0] + (adjusted[0] - rgb[0]) * mix,
      rgb[1] + (adjusted[1] - rgb[1]) * mix,
      rgb[2] + (adjusted[2] - rgb[2]) * mix,
    ] as Vec3;
  });
}

const OVERRIDES: readonly GroupOverride[] = [
  {
    names: ["Gradient Direction"],
    inputs: [
      { identifier: "Input_1", socketType: "NodeSocketFloat" },
      { identifier: "Input_2", socketType: "NodeSocketBool" },
    ],
    outputs: [{ identifier: "Output_0", socketType: "NodeSocketVector" }],
    evaluate: (context) => {
      const gradient = inputField(context, "Input_1", 0);
      const mode = context.pull("Input_2");
      const solenoidal = mode instanceof Field && mode.isConst ? asNum(mode.value) > 0 : false;
      return { Output_0: gradientDirectionField(gradient, solenoidal) };
    },
  },
  {
    names: ["Hue Saturation Value N++"],
    inputs: [
      { identifier: "Input_0", socketType: "NodeSocketColor" },
      { identifier: "Input_2", socketType: "NodeSocketFloat" },
      { identifier: "Input_3", socketType: "NodeSocketFloat" },
      { identifier: "Input_4", socketType: "NodeSocketFloat" },
      { identifier: "Input_5", socketType: "NodeSocketFloat" },
    ],
    outputs: [{ identifier: "Output_1", socketType: "NodeSocketColor" }],
    evaluate: (context) => ({
      Output_1: hueSaturationValueField(
        inputField(context, "Input_0", [0, 0, 0]),
        inputField(context, "Input_2", 0.5),
        inputField(context, "Input_3", 1),
        inputField(context, "Input_4", 1),
        inputField(context, "Input_5", 1),
      ),
    }),
  },
  {
    names: ["_SWITCH.GEOMETRY 25 slot", "_SWITCH.accumalative geo"],
    inputs: [
      { identifier: "Input_0", socketType: "NodeSocketInt" },
      { identifier: "Input_4", socketType: "NodeSocketInt", optionalWithoutDefinition: true },
      { identifier: "Input_1", socketType: "NodeSocketGeometry" },
    ],
    outputs: [{ identifier: "Output_19", socketType: "NodeSocketGeometry" }],
    evaluate: (context) => {
      const value = wrappedSelector(context.pull("Input_0"), context.pull("Input_4"));
      const geometryInputs = context.node.inputs.filter(
        (socket) => socket.type === "NodeSocketGeometry" && /^\d+$/.test(socket.name),
      );
      if (context.node.group === "_SWITCH.GEOMETRY 25 slot") {
        const socket = geometryInputs[value - 1];
        return { Output_19: socket ? context.pull(socket.identifier) : new Geometry() };
      }
      const joined = new Geometry();
      joined.mesh = new Mesh();
      for (const [rowIndex, socket] of geometryInputs.slice(0, value + 1).entries()) {
        const part = context.pull(socket.identifier);
        if (!(part instanceof Geometry)) continue;
        const shifted = part.clone();
        const z = rowIndex * -0.6299998760223389;
        const move = (point: Vec3): Vec3 => [point[0], point[1], point[2] + z];
        if (shifted.mesh) shifted.mesh.positions = shifted.mesh.positions.map(move);
        for (const spline of shifted.curves) {
          spline.points = spline.points.map(move);
          if (spline.controlPoints) spline.controlPoints = spline.controlPoints.map(move);
          if (spline.bezierLeft) spline.bezierLeft = spline.bezierLeft.map(move);
          if (spline.bezierRight) spline.bezierRight = spline.bezierRight.map(move);
        }
        for (const instance of shifted.instances) instance.position = move(instance.position);
        if (shifted.mesh) mergeMeshInto(joined.mesh, shifted.mesh);
        joined.curves.push(...shifted.curves);
        joined.instances.push(...shifted.instances);
      }
      if (!joined.mesh.positions.length && !joined.mesh.faces.length && !joined.mesh.edges.length)
        joined.mesh = undefined;
      return { Output_19: joined };
    },
  },
  {
    names: ["_SWITCH.Materials 15 slot"],
    inputs: [
      { identifier: "Input_0", socketType: "NodeSocketInt" },
      { identifier: "Input_4", socketType: "NodeSocketInt", optionalWithoutDefinition: true },
      { identifier: "Input_1", socketType: "NodeSocketMaterial" },
    ],
    outputs: [{ identifier: "Output_19", socketType: "NodeSocketMaterial" }],
    evaluate: (context) => {
      const value = wrappedSelector(context.pull("Input_0"), context.pull("Input_4"));
      const sockets = context.node.inputs.filter(
        (socket) => socket.type === "NodeSocketMaterial" && /^\d+$/.test(socket.name),
      );
      return { Output_19: sockets[value - 1] ? context.pull(sockets[value - 1].identifier) : null };
    },
  },
];

/**
 * Evaluate a known compatibility override, or return undefined so Evaluator
 * can run the referenced node group normally.
 *
 * Exact names alone are intentionally insufficient: imported files may contain
 * an unrelated user group with the same display name. Its interface must also
 * match the contract that the override implements.
 */
export function tryEvaluateGroupOverride(
  context: GroupOverrideContext,
): Record<string, SockVal> | undefined {
  const name = context.node.group;
  if (!name) return undefined;
  const override = OVERRIDES.find((candidate) => candidate.names.includes(name));
  if (!override || !groupMatchesContract(context.definition, context.node, override.inputs, override.outputs))
    return undefined;
  return override.evaluate(context);
}
