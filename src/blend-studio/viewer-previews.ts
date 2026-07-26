import type {
  Dump,
  DumpInterfaceItem,
  DumpLink,
  DumpNodeGroup,
  RawNode,
  RawSocket,
} from "../gnvm";

export type BlendStudioViewerPreview = {
  id: string;
  label: string;
  rootGroup: string;
  leafGroup: string;
  viewerNodeName: string;
  /** Group-node names followed from the root to reach the Viewer. */
  route: string[];
};

function geometryInputIdentifier(node: RawNode): string | undefined {
  return node.inputs.find((socket) => socket.type === "NodeSocketGeometry")?.identifier;
}

function sourceLink(group: DumpNodeGroup, viewer: RawNode): DumpLink | undefined {
  const input = geometryInputIdentifier(viewer);
  return group.links.find((link) =>
    !link.muted
    && link.to_node === viewer.name
    && (!input || link.to_socket === input));
}

export function viewerPreviewsForBlendStudioTarget(
  dump: Dump,
  rootGroup: string,
): BlendStudioViewerPreview[] {
  const previews: BlendStudioViewerPreview[] = [];
  const walk = (groupName: string, route: string[], ancestors: Set<string>): void => {
    const group = dump.node_groups[groupName];
    if (!group || ancestors.has(groupName)) return;
    const nextAncestors = new Set(ancestors).add(groupName);
    for (const node of group.nodes) {
      if (node.type === "GeometryNodeViewer" && sourceLink(group, node)) {
        const path = [...route, node.name];
        previews.push({
          id: path.map(encodeURIComponent).join("/"),
          label: `${route.length ? `${route.join(" › ")} › ` : ""}${node.label || node.name}`,
          rootGroup,
          leafGroup: groupName,
          viewerNodeName: node.name,
          route: [...route],
        });
      }
      if (node.type === "GeometryNodeGroup" && node.group)
        walk(node.group, [...route, node.name], nextAncestors);
    }
  };
  walk(rootGroup, [], new Set());
  return previews.sort((a, b) => a.label.localeCompare(b.label));
}

function outputNode(group: DumpNodeGroup): RawNode | undefined {
  return group.nodes.find((node) => node.type === "NodeGroupOutput");
}

function previewSocket(identifier: string, name: string): RawSocket {
  return {
    name,
    identifier,
    type: "NodeSocketGeometry",
    linked: true,
    value: null,
  };
}

function exposeOutput(
  group: DumpNodeGroup,
  identifier: string,
  name: string,
  link: Pick<DumpLink, "from_node" | "from_socket" | "from_type">,
): boolean {
  const output = outputNode(group);
  if (!output) return false;
  const item: DumpInterfaceItem = {
    name,
    item_type: "SOCKET",
    identifier,
    in_out: "OUTPUT",
    socket_type: "NodeSocketGeometry",
  };
  group.interface.push(item);
  output.inputs.push(previewSocket(identifier, name));
  group.links.push({
    ...link,
    to_node: output.name,
    to_socket: identifier,
    to_type: "NodeSocketGeometry",
  });
  return true;
}

export type AppliedViewerPreview = {
  dump: Dump;
  outputIdentifier: string;
};

/**
 * Route a Viewer socket through temporary nested group outputs. The authored
 * graph is cloned, so selecting a preview never mutates exported source data.
 */
export function applyViewerPreview(
  source: Dump,
  preview: BlendStudioViewerPreview,
): AppliedViewerPreview | null {
  const dump = structuredClone(source);
  const suffix = preview.id.replace(/[^a-z0-9]+/gi, "_").slice(-80);
  const identifier = `__blend_studio_viewer_${suffix}`;
  const name = `Viewer · ${preview.viewerNodeName}`;
  const leaf = dump.node_groups[preview.leafGroup];
  const viewer = leaf?.nodes.find((node) => node.name === preview.viewerNodeName);
  const viewerSource = leaf && viewer ? sourceLink(leaf, viewer) : undefined;
  if (!leaf || !viewerSource) return null;
  if (!exposeOutput(leaf, identifier, name, {
    from_node: viewerSource.from_node,
    from_socket: viewerSource.from_socket,
    from_type: viewerSource.from_type ?? "NodeSocketGeometry",
  })) return null;

  let childName = preview.leafGroup;
  for (let index = preview.route.length - 1; index >= 0; index--) {
    const parentName = index === 0
      ? preview.rootGroup
      : (() => {
          let current = preview.rootGroup;
          for (let step = 0; step < index; step++) {
            const node = dump.node_groups[current]?.nodes.find((candidate) =>
              candidate.name === preview.route[step]);
            if (!node?.group) return "";
            current = node.group;
          }
          return current;
        })();
    const parent = dump.node_groups[parentName];
    const groupNode = parent?.nodes.find((node) =>
      node.name === preview.route[index] && node.group === childName);
    if (!parent || !groupNode) return null;
    groupNode.outputs.push({
      name,
      identifier,
      type: "NodeSocketGeometry",
      linked: true,
    });
    if (!exposeOutput(parent, identifier, name, {
      from_node: groupNode.name,
      from_socket: identifier,
      from_type: "NodeSocketGeometry",
    })) return null;
    childName = parentName;
  }
  return { dump, outputIdentifier: identifier };
}
