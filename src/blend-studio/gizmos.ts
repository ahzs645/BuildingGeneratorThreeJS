import type {
  Dump,
  DumpInterfaceItem,
  DumpNodeGroup,
  RawNode,
} from "../gnvm";
import type { BlendStudioTarget } from "./model";

export type BlendStudioGizmoKind = "linear" | "dial";

export type BlendStudioGizmoContract = {
  id: string;
  kind: BlendStudioGizmoKind;
  groupName: string;
  nodeName: string;
  rootInputIdentifier: string;
  rootInputName: string;
  socketType: string;
  component?: 0 | 1 | 2;
  rootValue: unknown;
  value: number;
  min: number;
  max: number;
  step: number;
  direction: [number, number, number];
  position: [number, number, number];
  screenSpace: boolean;
  drawStyle?: string;
  colorId?: string;
};

type LocalBinding = {
  identifier: string;
  component?: 0 | 1 | 2;
};

function node(group: DumpNodeGroup, name: string): RawNode | undefined {
  return group.nodes.find((candidate) => candidate.name === name);
}

function socketValue(candidate: RawNode, name: string): unknown {
  return candidate.inputs.find((socket) =>
    socket.identifier === name || socket.name === name)?.value;
}

function vec3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  const result = value.slice(0, 3).map(Number);
  return result.every(Number.isFinite)
    ? result as [number, number, number]
    : fallback;
}

function linkedInputs(group: DumpNodeGroup, nodeName: string) {
  return group.links.filter((link) => !link.muted && link.to_node === nodeName);
}

/**
 * Trace one gizmo value upstream to a group interface input. Blender permits
 * invertible gizmo paths through ordinary math/vector nodes; for authoring UI
 * we need the root socket identity, not a forward field evaluation.
 */
function localBinding(
  group: DumpNodeGroup,
  nodeName: string,
  socketName: string,
  visited = new Set<string>(),
): LocalBinding | null {
  const key = `${nodeName}\0${socketName}`;
  if (visited.has(key)) return null;
  visited.add(key);
  const link = group.links.find((candidate) =>
    !candidate.muted
    && candidate.to_node === nodeName
    && candidate.to_socket === socketName);
  if (!link) return null;
  const source = node(group, link.from_node);
  if (!source) return null;
  if (source.type === "NodeGroupInput")
    return { identifier: link.from_socket };

  if (source.type === "ShaderNodeSeparateXYZ") {
    const component = ({ X: 0, Y: 1, Z: 2 } as const)[link.from_socket as "X" | "Y" | "Z"];
    const traced = localBinding(group, source.name, "Vector", visited);
    return traced && component !== undefined ? { ...traced, component } : traced;
  }

  if (source.type === "ShaderNodeCombineXYZ") {
    const candidates = ["X", "Y", "Z"]
      .map((component) => localBinding(group, source.name, component, new Set(visited)))
      .filter((binding): binding is LocalBinding => Boolean(binding));
    const unique = new Map(candidates.map((binding) =>
      [`${binding.identifier}:${binding.component ?? ""}`, binding]));
    return unique.size === 1 ? [...unique.values()][0] : null;
  }

  const candidates = linkedInputs(group, source.name)
    .map((input) =>
      localBinding(group, source.name, input.to_socket, new Set(visited)))
    .filter((binding): binding is LocalBinding => Boolean(binding));
  const unique = new Map(candidates.map((binding) =>
    [`${binding.identifier}:${binding.component ?? ""}`, binding]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function interfaceItem(group: DumpNodeGroup, identifier: string): DumpInterfaceItem | undefined {
  return group.interface.find((item) =>
    item.item_type === "SOCKET"
    && item.in_out === "INPUT"
    && item.identifier === identifier);
}

function finite(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) < 1e9 ? number : fallback;
}

function range(
  item: DumpInterfaceItem,
  kind: BlendStudioGizmoKind,
  component: number | undefined,
  value: number,
): [number, number, number] {
  if (kind === "dial" || component !== undefined || item.socket_type === "NodeSocketRotation")
    return [-Math.PI, Math.PI, .001];
  let min = finite(item.min_value, Math.min(0, value * 2, value - 1));
  let max = finite(item.max_value, Math.max(1, value * 2, value + 1));
  if (max <= min || max - min > 1e6) {
    min = Math.min(0, value * 2, value - 1);
    max = Math.max(1, value * 2, value + 1);
  }
  return [min, max, Math.max((max - min) / 1_000, .0001)];
}

function savedRootValue(
  target: BlendStudioTarget,
  item: DumpInterfaceItem,
): unknown {
  return item.identifier && Object.prototype.hasOwnProperty.call(
    target.savedInputs,
    item.identifier,
  )
    ? target.savedInputs[item.identifier]
    : Object.prototype.hasOwnProperty.call(target.savedInputs, item.name)
      ? target.savedInputs[item.name]
      : item.default;
}

function savedValue(
  target: BlendStudioTarget,
  item: DumpInterfaceItem,
  component: number | undefined,
): number {
  const raw = savedRootValue(target, item);
  return component === undefined
    ? finite(raw, 0)
    : finite(Array.isArray(raw) ? raw[component] : 0, 0);
}

function childBindings(
  parent: DumpNodeGroup,
  groupNode: RawNode,
  inherited: Map<string, LocalBinding>,
): Map<string, LocalBinding> {
  const result = new Map<string, LocalBinding>();
  for (const input of groupNode.inputs) {
    if (!input.identifier || input.identifier === "__extend__") continue;
    const local = localBinding(parent, groupNode.name, input.identifier);
    if (!local) continue;
    const root = inherited.get(local.identifier);
    if (!root) continue;
    result.set(input.identifier, {
      ...root,
      ...(local.component !== undefined ? { component: local.component } : {}),
    });
  }
  return result;
}

export function gizmoContractsForBlendStudioTarget(
  dump: Dump,
  target: BlendStudioTarget,
): BlendStudioGizmoContract[] {
  const root = dump.node_groups[target.groupName];
  if (!root) return [];
  const rootBindings = new Map(
    root.interface.flatMap((item) =>
      item.item_type === "SOCKET"
      && item.in_out === "INPUT"
      && item.identifier
        ? [[item.identifier, { identifier: item.identifier } as LocalBinding] as const]
        : []),
  );
  const contracts: BlendStudioGizmoContract[] = [];
  const walk = (
    groupName: string,
    bindings: Map<string, LocalBinding>,
    path: string[],
  ): void => {
    if (path.length > 12 || path.includes(groupName)) return;
    const group = dump.node_groups[groupName];
    if (!group) return;
    for (const candidate of group.nodes) {
      if (
        candidate.type === "GeometryNodeGizmoLinear"
        || candidate.type === "GeometryNodeGizmoDial"
      ) {
        const local = localBinding(group, candidate.name, "Value");
        const binding = local ? bindings.get(local.identifier) : undefined;
        if (!binding) continue;
        const component = local?.component ?? binding.component;
        const item = interfaceItem(root, binding.identifier);
        if (!item?.identifier || !item.socket_type) continue;
        const kind = candidate.type === "GeometryNodeGizmoDial" ? "dial" : "linear";
        const value = savedValue(target, item, component);
        const [min, max, step] = range(item, kind, component, value);
        contracts.push({
          id: `${path.join("/")}/${groupName}/${candidate.name}/${item.identifier}/${component ?? ""}`,
          kind,
          groupName,
          nodeName: candidate.name,
          rootInputIdentifier: item.identifier,
          rootInputName: item.name,
          socketType: item.socket_type,
          ...(component !== undefined ? { component } : {}),
          rootValue: savedRootValue(target, item),
          value,
          min,
          max,
          step,
          direction: vec3(
            socketValue(candidate, kind === "dial" ? "Up" : "Direction"),
            kind === "dial" ? [0, 0, 1] : [1, 0, 0],
          ),
          position: vec3(socketValue(candidate, "Position"), [0, 0, 0]),
          screenSpace: Boolean(socketValue(candidate, "Screen Space")),
          drawStyle: String(candidate.props?.draw_style ?? ""),
          colorId: String(candidate.props?.color_id ?? ""),
        });
      }
      if (candidate.type === "GeometryNodeGroup" && candidate.group) {
        const nextBindings = childBindings(group, candidate, bindings);
        if (nextBindings.size)
          walk(candidate.group, nextBindings, [...path, groupName, candidate.name]);
      }
    }
  };
  walk(target.groupName, rootBindings, []);
  return contracts.sort((a, b) =>
    a.rootInputName.localeCompare(b.rootInputName)
    || a.kind.localeCompare(b.kind)
    || a.nodeName.localeCompare(b.nodeName));
}

export function setGizmoValue(
  current: Record<string, unknown>,
  contract: BlendStudioGizmoContract,
  value: number,
): Record<string, unknown> {
  if (contract.component === undefined)
    return { ...current, [contract.rootInputIdentifier]: value };
  const existing = current[contract.rootInputIdentifier];
  const vector = Array.isArray(existing)
    ? [...existing]
    : Array.isArray(contract.rootValue)
      ? [...contract.rootValue]
      : [0, 0, 0];
  vector[contract.component] = value;
  return { ...current, [contract.rootInputIdentifier]: vector };
}
