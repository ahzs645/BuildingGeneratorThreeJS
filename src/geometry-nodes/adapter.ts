import type {
  DumpGraph,
  DumpLink,
  DumpNode,
  DumpSocket,
  EditorEdge,
  EditorGraph,
  EditorNode,
  EditorSocket,
  GeometryNodesDump,
  GeometryNodesWorkspaceModel,
  GnSocketDirection,
} from "./model";

const part = (value: string): string => encodeURIComponent(value);

export const editorGroupId = (groupName: string): string => `gn:group:${part(groupName)}`;
export const editorNodeId = (groupName: string, nodeName: string): string => `${editorGroupId(groupName)}:node:${part(nodeName)}`;
export const editorSocketId = (direction: GnSocketDirection, identifier: string): string => `${direction}:${part(identifier)}`;

function edgeSignature(groupName: string, link: DumpLink): string {
  return [groupName, link.from_node, link.from_socket, link.to_node, link.to_socket, link.multi_input_sort_id ?? ""].map((value) => part(String(value))).join(":");
}

function rgb(color: number[] | undefined): string | null {
  if (!color || color.length < 3) return null;
  const channel = (value: number): number => Math.max(0, Math.min(255, Math.round(value * 255)));
  return `rgb(${channel(color[0])} ${channel(color[1])} ${channel(color[2])})`;
}

function socketValue(socket: DumpSocket): unknown {
  return Object.prototype.hasOwnProperty.call(socket, "value") ? socket.value : socket.default;
}

function adaptSockets(node: DumpNode, direction: GnSocketDirection): EditorSocket[] {
  const sockets = direction === "input" ? node.inputs : node.outputs;
  return sockets.map((socket, order) => ({
    id: editorSocketId(direction, socket.identifier),
    name: socket.name,
    identifier: socket.identifier,
    direction,
    dataType: socket.type,
    linked: Boolean(socket.linked),
    visible: socket.enabled !== false && socket.identifier !== "__extend__" && (!socket.hide || socket.linked),
    editable: direction === "input" && !socket.linked && !socket.hide_value,
    displayShape: socket.display_shape ?? "CIRCLE",
    order,
    value: socketValue(socket),
    source: socket,
  }));
}

function adaptNode(groupName: string, node: DumpNode): EditorNode {
  const location = node.ui?.location_absolute ?? node.ui?.location ?? [0, 0];
  const kind = node.type === "NodeFrame" ? "frame" : node.type === "NodeReroute" ? "reroute" : "node";
  return {
    id: editorNodeId(groupName, node.name),
    groupName,
    name: node.name,
    title: node.label || node.name,
    nodeType: node.type,
    kind,
    position: { x: Number(location[0] ?? 0), y: -Number(location[1] ?? 0) },
    size: {
      width: Math.max(kind === "reroute" ? 16 : 80, Number(node.ui?.width ?? 140)),
      height: Math.max(kind === "reroute" ? 16 : 30, Number(node.ui?.height ?? 100)),
    },
    parentName: node.ui?.parent ?? null,
    groupDependency: node.group && node.group !== groupName ? node.group : null,
    inputs: adaptSockets(node, "input"),
    outputs: adaptSockets(node, "output"),
    muted: Boolean(node.ui?.mute),
    collapsed: Boolean(node.ui?.hide),
    customColor: node.ui?.use_custom_color ? rgb(node.ui.color) : null,
    source: node,
  };
}

function findSocket(node: EditorNode | undefined, reference: string, index: number | null | undefined, direction: GnSocketDirection): EditorSocket | undefined {
  const sockets = direction === "input" ? node?.inputs : node?.outputs;
  return sockets?.find((socket) => socket.identifier === reference)
    ?? sockets?.find((socket) => socket.name === reference)
    ?? (index == null ? undefined : sockets?.find((socket) => socket.source.idx === index) ?? sockets?.[index]);
}

export function adaptDumpGraph(groupName: string, graph: DumpGraph): EditorGraph {
  const nodes = graph.nodes.map((node) => adaptNode(groupName, node));
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const warnings: string[] = [];
  const occurrences = new Map<string, number>();
  const edges: EditorEdge[] = [];

  for (const link of graph.links) {
    const sourceNode = byName.get(link.from_node);
    const targetNode = byName.get(link.to_node);
    const sourceSocket = findSocket(sourceNode, link.from_socket, link.from_idx, "output");
    const targetSocket = findSocket(targetNode, link.to_socket, link.to_idx, "input");
    if (!sourceNode || !targetNode || !sourceSocket || !targetSocket) {
      warnings.push(`Unresolved link ${link.from_node}.${link.from_socket} → ${link.to_node}.${link.to_socket}`);
      continue;
    }
    const signature = edgeSignature(groupName, link);
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    edges.push({
      id: `gn:edge:${signature}:${occurrence}`,
      groupName,
      source: sourceNode.id,
      sourceHandle: sourceSocket.id,
      target: targetNode.id,
      targetHandle: targetSocket.id,
      dataType: link.from_type || sourceSocket.dataType || link.to_type || targetSocket.dataType,
      muted: Boolean(link.muted),
      multiInputOrder: link.multi_input_sort_id ?? null,
      sourceSocket,
      targetSocket,
      sourceLink: link,
    });
  }

  return {
    id: editorGroupId(groupName),
    name: groupName,
    nodes,
    edges,
    dependencies: [...new Set(nodes.flatMap((node) => node.groupDependency ? [node.groupDependency] : []))].sort(),
    warnings,
    source: graph,
  };
}

export function findRootGroup(dump: GeometryNodesDump, preferredObject?: string): string {
  const objects = preferredObject ? [...dump.objects].sort((a) => a.name === preferredObject ? -1 : 1) : dump.objects;
  for (const object of objects) {
    if (preferredObject && object.name !== preferredObject) continue;
    const modifier = object.modifiers?.find((candidate) => candidate.type === "NODES" && candidate.node_group && dump.node_groups[candidate.node_group]);
    if (modifier?.node_group) return modifier.node_group;
  }
  for (const object of dump.objects) {
    const modifier = object.modifiers?.find((candidate) => candidate.node_group && dump.node_groups[candidate.node_group]);
    if (modifier?.node_group) return modifier.node_group;
  }
  const fallback = Object.keys(dump.node_groups).sort()[0];
  if (!fallback) throw new Error("Portable dump does not contain a Geometry Nodes group");
  return fallback;
}

export function adaptGeometryNodesDump(dump: GeometryNodesDump, preferredObject?: string): GeometryNodesWorkspaceModel {
  const names = Object.keys(dump.node_groups).sort();
  const groups = Object.fromEntries(names.map((name) => [name, adaptDumpGraph(name, dump.node_groups[name])]));
  return {
    rootGroup: findRootGroup(dump, preferredObject),
    groups,
    dependencies: Object.fromEntries(names.map((name) => [name, groups[name].dependencies])),
  };
}

export function refreshDumpLinkedFlags(graph: DumpGraph): void {
  const inputLinks = new Set(graph.links.map((link) => `${link.to_node}\u0000${link.to_socket}`));
  const outputLinks = new Set(graph.links.map((link) => `${link.from_node}\u0000${link.from_socket}`));
  for (const node of graph.nodes) {
    for (const socket of node.inputs) socket.linked = inputLinks.has(`${node.name}\u0000${socket.identifier}`) || inputLinks.has(`${node.name}\u0000${socket.name}`);
    for (const socket of node.outputs) socket.linked = outputLinks.has(`${node.name}\u0000${socket.identifier}`) || outputLinks.has(`${node.name}\u0000${socket.name}`);
  }
}
