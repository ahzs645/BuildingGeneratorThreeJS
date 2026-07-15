import type { Dump } from "../gnvm";

export type GraphSocketDirection = "input" | "output";
export type GraphNodeKind = "node" | "frame" | "reroute";

export interface DumpSocket {
  name: string;
  identifier: string;
  type?: string;
  idx?: number;
  linked?: boolean;
  enabled?: boolean;
  hide?: boolean;
  hide_value?: boolean;
  display_shape?: string;
  value?: unknown;
  default?: unknown;
}

export interface DumpNode {
  name: string;
  type: string;
  label?: string | null;
  group?: string;
  ui?: {
    location?: number[];
    location_absolute?: number[];
    width?: number;
    height?: number;
    dimensions?: number[];
    hide?: boolean;
    mute?: boolean;
    parent?: string | null;
    use_custom_color?: boolean;
    color?: number[];
  };
  inputs?: DumpSocket[];
  outputs?: DumpSocket[];
  props?: Record<string, unknown>;
}

export interface GraphSocket {
  /** Stable editor handle ID. The extracted Blender identifier remains separate. */
  id: string;
  identifier: string;
  name: string;
  type: string;
  direction: GraphSocketDirection;
  index: number;
  linked: boolean;
  visible: boolean;
  hideValue: boolean;
  displayShape: string;
  value: unknown;
}

export interface GraphNode {
  id: string;
  sourceName: string;
  sourceType: string;
  label: string;
  kind: GraphNodeKind;
  position: { x: number; y: number };
  absolutePosition: { x: number; y: number };
  width: number;
  height: number;
  parentId?: string;
  muted: boolean;
  hidden: boolean;
  color?: string;
  inputs: GraphSocket[];
  outputs: GraphSocket[];
  nestedGroup?: string;
  properties: Record<string, unknown>;
}

export interface GraphLink {
  id: string;
  sourceIndex: number;
  source: string;
  sourceHandle: string;
  sourceSocketIdentifier: string;
  target: string;
  targetHandle: string;
  targetSocketIdentifier: string;
  socketType: string;
  muted: boolean;
  multiInputSortId?: number;
}

export interface EditorGraph {
  groupName: string;
  nodes: GraphNode[];
  links: GraphLink[];
  interface: unknown[];
  unresolvedLinks: string[];
}

type DumpWithEditorGroups = {
  node_groups: Record<string, {
    name?: string;
    type?: string;
    nodes: DumpNode[];
    links: {
      from_node: string;
      from_socket: string;
      to_node: string;
      to_socket: string;
      from_type?: string;
      to_type?: string;
      to_idx?: number | null;
      multi_input_sort_id?: number | null;
      muted?: boolean;
    }[];
    interface?: unknown[];
  }>;
};

const nodeId = (groupName: string, nodeName: string): string => `${groupName}::${nodeName}`;

const socketId = (direction: GraphSocketDirection, identifier: string, occurrence: number): string =>
  `${direction}:${identifier}:${occurrence}`;

function rgb(color?: number[]): string | undefined {
  if (!color || color.length < 3) return undefined;
  const component = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0");
  return `#${component(color[0])}${component(color[1])}${component(color[2])}`;
}

function graphSockets(sockets: DumpSocket[] | undefined, direction: GraphSocketDirection): GraphSocket[] {
  const occurrences = new Map<string, number>();
  return (sockets ?? []).map((socket, index) => {
    const occurrence = occurrences.get(socket.identifier) ?? 0;
    occurrences.set(socket.identifier, occurrence + 1);
    return {
      id: socketId(direction, socket.identifier, occurrence),
      identifier: socket.identifier,
      name: socket.name,
      type: socket.type ?? "NodeSocketUndefined",
      direction,
      index: socket.idx ?? index,
      linked: Boolean(socket.linked),
      visible: socket.enabled !== false && socket.hide !== true,
      hideValue: Boolean(socket.hide_value),
      displayShape: socket.display_shape ?? "CIRCLE",
      value: Object.hasOwn(socket, "value") ? socket.value : socket.default,
    };
  });
}

function estimateHeight(node: DumpNode, inputs: GraphSocket[], outputs: GraphSocket[]): number {
  if (node.type === "NodeReroute") return 18;
  if (node.type === "NodeFrame") return Math.max(90, Number(node.ui?.height ?? 100));
  const stored = Number(node.ui?.dimensions?.[1] ?? 0) || Number(node.ui?.height ?? 0);
  if (stored > 30) return stored;
  const rows = Math.max(inputs.filter((socket) => socket.visible).length, outputs.filter((socket) => socket.visible).length, 1);
  return 34 + rows * 24 + (node.ui?.hide ? 0 : 8);
}

function nestedGroupName(node: DumpNode): string | undefined {
  const nodeTree = node.props?.node_tree;
  if (!nodeTree || typeof nodeTree !== "object") return node.group;
  const name = (nodeTree as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function chooseSocket(sockets: GraphSocket[], identifier: string, rawIndex?: number | null): GraphSocket | undefined {
  const matches = sockets.filter((socket) => socket.identifier === identifier);
  if (matches.length <= 1) return matches[0];
  if (typeof rawIndex === "number") return matches.find((socket) => socket.index === rawIndex) ?? matches[rawIndex] ?? matches[0];
  return matches[0];
}

/**
 * Converts the current extraction dump into a deterministic editor projection.
 * It deliberately never mutates or "repairs" the dump: GN-VM continues to read
 * the original payload, while the editor keeps source names and identifiers as
 * explicit provenance for selection, navigation, and eventual round-tripping.
 */
export function dumpGroupToEditorGraph(rawDump: Dump, groupName: string): EditorGraph {
  const dump = rawDump as unknown as DumpWithEditorGroups;
  const group = dump.node_groups[groupName];
  if (!group) throw new Error(`Geometry Nodes group not found: ${groupName}`);

  const rawByName = new Map(group.nodes.map((node) => [node.name, node]));
  const nodes = group.nodes.map((node): GraphNode => {
    const inputs = graphSockets(node.inputs, "input");
    const outputs = graphSockets(node.outputs, "output");
    const absoluteX = Number(node.ui?.location_absolute?.[0] ?? node.ui?.location?.[0] ?? 0);
    const absoluteY = -Number(node.ui?.location_absolute?.[1] ?? node.ui?.location?.[1] ?? 0);
    const parentName = node.ui?.parent ?? undefined;
    const parent = parentName ? rawByName.get(parentName) : undefined;
    const parentX = Number(parent?.ui?.location_absolute?.[0] ?? parent?.ui?.location?.[0] ?? 0);
    const parentY = -Number(parent?.ui?.location_absolute?.[1] ?? parent?.ui?.location?.[1] ?? 0);
    const kind: GraphNodeKind = node.type === "NodeFrame" ? "frame" : node.type === "NodeReroute" ? "reroute" : "node";
    return {
      id: nodeId(groupName, node.name),
      sourceName: node.name,
      sourceType: node.type,
      label: node.label?.trim() || String(node.props?.bl_label ?? node.name),
      kind,
      position: parent ? { x: absoluteX - parentX, y: absoluteY - parentY } : { x: absoluteX, y: absoluteY },
      absolutePosition: { x: absoluteX, y: absoluteY },
      width: kind === "reroute" ? 18 : Math.max(kind === "frame" ? 120 : 100, Number(node.ui?.width ?? 140)),
      height: estimateHeight(node, inputs, outputs),
      parentId: parent ? nodeId(groupName, parent.name) : undefined,
      muted: Boolean(node.ui?.mute),
      hidden: Boolean(node.ui?.hide),
      color: node.ui?.use_custom_color ? rgb(node.ui.color) : undefined,
      inputs,
      outputs,
      nestedGroup: nestedGroupName(node),
      properties: node.props ?? {},
    };
  });

  const editorByName = new Map(nodes.map((node) => [node.sourceName, node]));
  const unresolvedLinks: string[] = [];
  const duplicateLinks = new Map<string, number>();
  const links = group.links.flatMap((link, sourceIndex): GraphLink[] => {
    const source = editorByName.get(link.from_node);
    const target = editorByName.get(link.to_node);
    const sourceSocket = source && chooseSocket(source.outputs, link.from_socket);
    const targetSocket = target && chooseSocket(target.inputs, link.to_socket, link.to_idx);
    const rawKey = `${link.from_node}:${link.from_socket}->${link.to_node}:${link.to_socket}`;
    if (!source || !target || !sourceSocket || !targetSocket) {
      unresolvedLinks.push(rawKey);
      return [];
    }
    const occurrence = duplicateLinks.get(rawKey) ?? 0;
    duplicateLinks.set(rawKey, occurrence + 1);
    return [{
      id: `${groupName}::${rawKey}::${occurrence}`,
      sourceIndex,
      source: source.id,
      sourceHandle: sourceSocket.id,
      sourceSocketIdentifier: sourceSocket.identifier,
      target: target.id,
      targetHandle: targetSocket.id,
      targetSocketIdentifier: targetSocket.identifier,
      socketType: link.from_type ?? link.to_type ?? sourceSocket.type,
      muted: Boolean(link.muted),
      multiInputSortId: link.multi_input_sort_id ?? undefined,
    }];
  });

  return {
    groupName,
    nodes,
    links,
    interface: group.interface ?? [],
    unresolvedLinks,
  };
}

export function graphGroupPath(dump: Dump, rootGroup: string, nodeNames: string[]): string[] {
  const path = [rootGroup];
  let groupName = rootGroup;
  for (const nodeName of nodeNames) {
    const graph = dumpGroupToEditorGraph(dump, groupName);
    const node = graph.nodes.find((candidate) => candidate.sourceName === nodeName);
    if (!node?.nestedGroup || !dump.node_groups[node.nestedGroup]) break;
    path.push(node.nestedGroup);
    groupName = node.nestedGroup;
  }
  return path;
}
