import type { Program } from "./evaluator";
import {
  findBakeInstanceState,
  hasCompleteBakeSnapshot,
  hasCompleteBakeStateSnapshotCoverage,
  type BakeInstanceState,
} from "./bake-snapshot";
import { hasEmbeddedStlPayload } from "./import-stl-payload";
import { REGISTRY, type Handler, type RawNode } from "./registry";

/**
 * Node types implemented directly by Evaluator rather than through REGISTRY.
 *
 * Keep this list limited to dispatch behavior: unsupported editor-only nodes
 * must remain visible in capability reports instead of being silently treated
 * as portable.
 */
export const EVALUATOR_NATIVE_NODE_TYPES = new Set([
  "NodeReroute",
  "NodeFrame",
  "NodeGroupInput",
  "NodeGroupOutput",
  "GeometryNodeGroup",
  "GeometryNodeRepeatInput",
  "GeometryNodeRepeatOutput",
  "GeometryNodeForeachGeometryElementInput",
  "GeometryNodeForeachGeometryElementOutput",
  "NodeClosureInput",
  "NodeClosureOutput",
]);

/**
 * Editor sinks do not contribute to a Geometry Nodes group output, so they do
 * not need a runtime handler. Listing them separately avoids both a false
 * unsupported warning and the misleading claim that Evaluator dispatches them.
 */
export const EDITOR_ONLY_NODE_TYPES = new Set([
  "GeometryNodeViewer",
  "GeometryNodeGizmoTransform",
  "GeometryNodeGizmoLinear",
  "GeometryNodeGizmoDial",
]);

export const BOUNDED_APPROXIMATION_NODE_TYPES = new Set([
  "GeometryNodeBake",
  "GeometryNodeGridToMesh",
  "GeometryNodeMeshToSDFGrid",
  "GeometryNodePointsToSDFGrid",
  "GeometryNodeVolumeCube",
  "GeometryNodeVolumeToMesh",
  "GeometryNodeUVPackIslands",
  "GeometryNodeUVUnwrap",
]);

/**
 * Handlers whose runtime can prove an exact narrow contract from evaluated
 * geometry and socket values. Static analysis cannot see those values, so it
 * must distinguish "runtime-conditional" from an unconditional approximation.
 */
export const RUNTIME_CONDITIONAL_NODE_TYPES = new Set([
  "GeometryNodeUVPackIslands",
  "GeometryNodeUVUnwrap",
  "GeometryNodeVolumeCube",
  "GeometryNodeVolumeToMesh",
]);

export type NodeSupport =
  | "native"
  | "handler"
  | "runtime-conditional"
  | "bounded-approximation"
  | "editor-only"
  | "muted-passthrough"
  | "unsupported";

export interface NodeCapabilityCount {
  type: string;
  count: number;
  support: NodeSupport;
}

export interface MissingGroupReference {
  group: string;
  referencedByGroup: string | null;
  referencedByNode: string | null;
}

export interface ProgramCapabilityReport {
  rootGroup: string;
  reachableGroups: string[];
  missingGroups: MissingGroupReference[];
  nodeTypes: NodeCapabilityCount[];
  unsupportedNodeTypes: { type: string; count: number }[];
  runtimeConditionalNodeTypes: { type: string; count: number }[];
  approximatedNodeTypes: { type: string; count: number }[];
  portable: boolean;
  exact: boolean;
}

type HandlerRegistry = ReadonlyMap<string, Handler>;

export interface ProgramCapabilityContext {
  /**
   * Modifier-instance Bake states. An explicit empty array means extraction
   * checked this modifier but could not associate a Bake with portable state.
   */
  bakeStates?: readonly BakeInstanceState[];
}

function supportOf(
  node: RawNode,
  registry: HandlerRegistry,
  groupName: string,
  context: ProgramCapabilityContext,
): NodeSupport {
  if (node.ui?.mute) return "muted-passthrough";
  if (EVALUATOR_NATIVE_NODE_TYPES.has(node.type)) return "native";
  if (EDITOR_ONLY_NODE_TYPES.has(node.type)) return "editor-only";
  if (
    node.type === "ShaderNodeTexGabor"
    && !["2D", "3D"].includes(node.props?.gabor_type ?? "2D")
  ) return "unsupported";
  if (
    node.type === "GeometryNodeSetMeshNormal"
    && (node.props?.mode ?? "SHARPNESS") !== "SHARPNESS"
    && registry.has(node.type)
  ) return "bounded-approximation";
  // Bake state belongs to a modifier instance, not its shared node group.
  // Exactness therefore requires either a confirmed unbaked/live state or one
  // complete portable snapshot for this exact modifier/node tuple.
  if (node.type === "GeometryNodeBake" && registry.has(node.type)) {
    if (context.bakeStates !== undefined) {
      const state = findBakeInstanceState(context.bakeStates, groupName, node);
      if (state?.status === "unbaked") return "handler";
      if (state && hasCompleteBakeStateSnapshotCoverage(node, state)) return "handler";
      return "bounded-approximation";
    }
    // Reusable group assets have no modifier owner. Retain explicitly attached
    // legacy snapshots, but never infer that a missing cache means unbaked.
    return hasCompleteBakeSnapshot(node) ? "handler" : "bounded-approximation";
  }
  // Import STL is portable only when extraction embedded the exact authored
  // triangle payload. A registered handler must not turn a missing local file
  // into a false static support claim.
  if (node.type === "GeometryNodeImportSTL" && !hasEmbeddedStlPayload(node))
    return "unsupported";
  if (RUNTIME_CONDITIONAL_NODE_TYPES.has(node.type) && registry.has(node.type))
    return "runtime-conditional";
  if (BOUNDED_APPROXIMATION_NODE_TYPES.has(node.type) && registry.has(node.type))
    return "bounded-approximation";
  if (registry.has(node.type)) return "handler";
  return "unsupported";
}

/**
 * Statically inspect the node types reachable from a modifier's root group.
 *
 * Unlike runtime MISSING, this does not need to evaluate the graph, so it can
 * reject or explain a newly extracted Blender file before WASM initialization
 * or expensive geometry work begins.
 */
export function analyzeProgramCapabilities(
  program: Program,
  rootGroup: string,
  registry: HandlerRegistry = REGISTRY,
  context: ProgramCapabilityContext = {},
): ProgramCapabilityReport {
  const staticallyReachableGroups = new Set<string>();
  const groupStack = [rootGroup];
  while (groupStack.length) {
    const groupName = groupStack.pop()!;
    if (staticallyReachableGroups.has(groupName)) continue;
    staticallyReachableGroups.add(groupName);
    for (const node of program[groupName]?.nodes ?? [])
      if (node.type === "GeometryNodeGroup" && node.group)
        groupStack.push(node.group);
  }
  const reachableGroups: string[] = [];
  const visited = new Set<string>();
  const pending: { group: string; referencedByGroup: string | null; referencedByNode: string | null }[] = [
    { group: rootGroup, referencedByGroup: null, referencedByNode: null },
  ];
  const missingGroups: MissingGroupReference[] = [];
  const counts = new Map<string, Map<NodeSupport, number>>();

  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current.group)) continue;
    visited.add(current.group);
    const group = program[current.group];
    if (!group) {
      missingGroups.push(current);
      continue;
    }
    reachableGroups.push(current.group);

    for (const node of group.nodes ?? []) {
      const support = supportOf(node, registry, current.group, context);
      const bySupport = counts.get(node.type) ?? new Map<NodeSupport, number>();
      bySupport.set(support, (bySupport.get(support) ?? 0) + 1);
      counts.set(node.type, bySupport);

      if (node.type === "GeometryNodeGroup" && node.group) {
        pending.push({
          group: node.group,
          referencedByGroup: current.group,
          referencedByNode: node.name,
        });
      }
    }
  }

  reachableGroups.sort((a, b) => a.localeCompare(b));
  missingGroups.sort((a, b) =>
    a.group.localeCompare(b.group)
    || (a.referencedByGroup ?? "").localeCompare(b.referencedByGroup ?? "")
    || (a.referencedByNode ?? "").localeCompare(b.referencedByNode ?? ""));

  const nodeTypes = [...counts.entries()]
    .flatMap(([type, bySupport]) =>
      [...bySupport.entries()].map(([support, count]) => ({ type, count, support })))
    .sort((a, b) => a.type.localeCompare(b.type) || a.support.localeCompare(b.support));
  const unsupportedNodeTypes = nodeTypes
    .filter((entry) => entry.support === "unsupported")
    .map(({ type, count }) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const approximatedNodeTypes = nodeTypes
    .filter((entry) => entry.support === "bounded-approximation")
    .map(({ type, count }) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const runtimeConditionalNodeTypes = nodeTypes
    .filter((entry) => entry.support === "runtime-conditional")
    .map(({ type, count }) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  return {
    rootGroup,
    reachableGroups,
    missingGroups,
    nodeTypes,
    unsupportedNodeTypes,
    runtimeConditionalNodeTypes,
    approximatedNodeTypes,
    portable: missingGroups.length === 0 && unsupportedNodeTypes.length === 0,
    exact: missingGroups.length === 0
      && unsupportedNodeTypes.length === 0
      && runtimeConditionalNodeTypes.length === 0
      && approximatedNodeTypes.length === 0,
  };
}
