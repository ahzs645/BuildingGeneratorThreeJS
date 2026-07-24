import type { Dump, DumpInterfaceItem, DumpObject } from "../gnvm";
import {
  connectedGeometryInputsForBlendStudioTarget,
  modifierStackIssuesForBlendStudioTarget,
  type BlendStudioSeed,
  type BlendStudioTarget,
} from "./model";

export type BlendStudioPresetContractMode =
  | "authored"
  | "seed"
  | "target-aware-extraction"
  | "modifier-stack";

export type BlendStudioPresetContract = {
  mode: BlendStudioPresetContractMode;
  geometryInput?: string;
  output?: string;
  recommendedSeed?: BlendStudioSeed;
  unboundDatablockInputs: string[];
  reason: string;
};

const isSocket = (
  item: DumpInterfaceItem,
  direction: "INPUT" | "OUTPUT",
  socketType?: string,
): boolean => item.item_type === "SOCKET"
  && item.in_out === direction
  && (!socketType || item.socket_type === socketType);

function recommendedSeedFor(socket: DumpInterfaceItem): BlendStudioSeed {
  const contract = `${socket.name} ${socket.description ?? ""}`.toLowerCase();
  if (/\b(profile|cross[- ]?section)\b/.test(contract)) return { kind: "curve-circle" };
  if (/\b(curve|spline|path|rail)\b/.test(contract)) return { kind: "curve-line" };
  if (/\b(plane|sheet|surface)\b/.test(contract)) return { kind: "plane" };
  return { kind: "cube" };
}

function objectForTarget(dump: Dump, target: BlendStudioTarget): DumpObject | undefined {
  return target.kind === "object"
    ? dump.objects?.find((object) => object.name === target.objectName)
    : undefined;
}

function hasAuthoredGeometry(object: DumpObject | undefined): boolean {
  return Boolean(object?.mesh || object?.curves?.length);
}

function omittedMeshSize(object: DumpObject | undefined): number {
  const stats = object?.mesh_stats as { verts?: unknown } | undefined;
  const vertices = Number(stats?.verts ?? 0);
  return Number.isFinite(vertices) ? vertices : 0;
}

function unboundDatablockInputs(dump: Dump, target: BlendStudioTarget): string[] {
  const group = dump.node_groups[target.groupName];
  if (!group) return [];
  const pointerTypes = new Set([
    "NodeSocketObject",
    "NodeSocketCollection",
    "NodeSocketImage",
    "NodeSocketMaterial",
  ]);
  return group.interface.flatMap((item) => {
    if (!isSocket(item, "INPUT") || !pointerTypes.has(item.socket_type ?? "")) return [];
    const identifierSaved = Boolean(item.identifier)
      && Object.prototype.hasOwnProperty.call(target.savedInputs, item.identifier!);
    const nameSaved = Object.prototype.hasOwnProperty.call(target.savedInputs, item.name);
    const value = identifierSaved
      ? target.savedInputs[item.identifier!]
      : nameSaved ? target.savedInputs[item.name] : item.default;
    return value == null ? [item.name] : [];
  });
}

/**
 * Infer only contracts that follow from the extracted target/interface.
 *
 * This deliberately does not guess whether an unbound Object/Collection input
 * is required: null datablocks are sometimes authored as an intentional empty
 * branch. Callers can surface `unboundDatablockInputs` without inventing a
 * replacement object.
 */
export function presetContractForBlendStudioTarget(
  dump: Dump,
  target: BlendStudioTarget,
): BlendStudioPresetContract {
  const group = dump.node_groups[target.groupName];
  const outputs = group?.interface.filter((item) =>
    isSocket(item, "OUTPUT", "NodeSocketGeometry")) ?? [];
  const inputs = connectedGeometryInputsForBlendStudioTarget(dump, target);
  const geometryInput = inputs.length === 1 ? inputs[0].identifier : undefined;
  const output = outputs[0]?.name;
  const unbound = unboundDatablockInputs(dump, target);

  if (!inputs.length) {
    return {
      mode: "authored",
      output,
      unboundDatablockInputs: unbound,
      reason: "The target is a pure generator; its output does not consume interface geometry.",
    };
  }

  if (target.kind === "object") {
    const stackIssues = modifierStackIssuesForBlendStudioTarget(dump, target);
    if (stackIssues.length) {
      const first = stackIssues[0];
      return {
        mode: "target-aware-extraction",
        geometryInput,
        output,
        unboundDatablockInputs: unbound,
        reason: `The preceding ${first.modifierType} modifier is not portable (${first.reason}); use an evaluated target extraction.`,
      };
    }
    if (target.modifierIndex > 0) {
      return {
        mode: "modifier-stack",
        geometryInput,
        output,
        unboundDatablockInputs: unbound,
        reason: "The portable modifier stack supplies the geometry produced before this modifier.",
      };
    }
    const object = objectForTarget(dump, target);
    if (hasAuthoredGeometry(object)) {
      return {
        mode: "authored",
        geometryInput,
        output,
        unboundDatablockInputs: unbound,
        reason: "The object's extracted base geometry satisfies the connected Geometry input.",
      };
    }
    const omittedVertices = omittedMeshSize(object);
    if (omittedVertices > 0) {
      return {
        mode: "target-aware-extraction",
        geometryInput,
        output,
        unboundDatablockInputs: unbound,
        reason: `The object reports ${omittedVertices} base vertices, but its mesh payload was omitted from this dump.`,
      };
    }
  }

  if (inputs.length === 1) {
    const recommendedSeed = recommendedSeedFor(inputs[0]);
    return {
      mode: "seed",
      geometryInput,
      output,
      recommendedSeed,
      unboundDatablockInputs: unbound,
      reason: `The connected ${inputs[0].name} input requires a ${recommendedSeed.kind} preview seed.`,
    };
  }

  return {
    mode: "seed",
    output,
    unboundDatablockInputs: unbound,
    reason: "The target has multiple connected Geometry inputs; the user must choose an input and seed.",
  };
}
