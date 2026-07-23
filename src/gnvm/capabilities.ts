import type { Program } from "./evaluator";
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
]);

/**
 * Editor sinks do not contribute to a Geometry Nodes group output, so they do
 * not need a runtime handler. Listing them separately avoids both a false
 * unsupported warning and the misleading claim that Evaluator dispatches them.
 */
export const EDITOR_ONLY_NODE_TYPES = new Set([
  "GeometryNodeViewer",
  "GeometryNodeGizmoTransform",
]);

export type NodeSupport = "native" | "handler" | "editor-only" | "muted-passthrough" | "unsupported";

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
  portable: boolean;
}

type HandlerRegistry = ReadonlyMap<string, Handler>;

function supportOf(node: RawNode, registry: HandlerRegistry): NodeSupport {
  if (node.ui?.mute) return "muted-passthrough";
  if (EVALUATOR_NATIVE_NODE_TYPES.has(node.type)) return "native";
  if (EDITOR_ONLY_NODE_TYPES.has(node.type)) return "editor-only";
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
): ProgramCapabilityReport {
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
      const support = supportOf(node, registry);
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

  return {
    rootGroup,
    reachableGroups,
    missingGroups,
    nodeTypes,
    unsupportedNodeTypes,
    portable: missingGroups.length === 0 && unsupportedNodeTypes.length === 0,
  };
}
