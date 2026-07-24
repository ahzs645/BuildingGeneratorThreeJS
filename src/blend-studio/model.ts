import {
  analyzeProgramCapabilities,
  type Dump,
  type DumpInterfaceItem,
  type ProgramCapabilityReport,
} from "../gnvm";

export type BlendStudioTarget =
  | {
      id: string;
      kind: "object";
      label: string;
      detail: string;
      objectName: string;
      groupName: string;
      modifierIndex: number;
      savedInputs: Record<string, unknown>;
    }
  | {
      id: string;
      kind: "group";
      label: string;
      detail: string;
      groupName: string;
      savedInputs: Record<string, unknown>;
    };

export type BlendStudioSeed =
  | { kind: "cube" }
  | { kind: "plane" }
  | { kind: "curve-circle" }
  | { kind: "curve-line" }
  | { kind: "object"; objectName: string };

export type BlendStudioControl = {
  identifier: string;
  name: string;
  socketType: string;
  value: number | boolean;
  min: number;
  max: number;
  step: number;
};

export type BlendStudioCompatibility = {
  report: ProgramCapabilityReport;
  recognizedNodes: number;
  totalNodes: number;
  score: number;
  gaps: string[];
};

function hasGeometryOutput(item: DumpInterfaceItem): boolean {
  return item.item_type === "SOCKET"
    && item.in_out === "OUTPUT"
    && item.socket_type === "NodeSocketGeometry";
}

function targetId(...parts: Array<string | number>): string {
  return parts.map((part) => encodeURIComponent(String(part))).join(":");
}

/**
 * Discover both Blender modifier entry points and reusable, unassigned root
 * groups. Nested groups stay reachable through the graph editor without
 * cluttering the target picker.
 */
export function discoverBlendStudioTargets(dump: Dump): BlendStudioTarget[] {
  const targets: BlendStudioTarget[] = [];
  const assignedGroups = new Set<string>();
  for (const object of dump.objects ?? []) {
    for (const [modifierIndex, modifier] of (object.modifiers ?? []).entries()) {
      if (modifier.type !== "NODES" || !modifier.node_group || !dump.node_groups[modifier.node_group]) continue;
      assignedGroups.add(modifier.node_group);
      targets.push({
        id: targetId("object", object.name, modifierIndex, modifier.node_group),
        kind: "object",
        label: object.name,
        detail: modifier.node_group,
        objectName: object.name,
        groupName: modifier.node_group,
        modifierIndex,
        savedInputs: modifier.input_values ?? {},
      });
    }
  }

  const nestedGroups = new Set<string>();
  for (const group of Object.values(dump.node_groups)) {
    for (const node of group.nodes ?? []) {
      if (node.type === "GeometryNodeGroup" && node.group) nestedGroups.add(node.group);
    }
  }

  for (const [groupName, group] of Object.entries(dump.node_groups)) {
    if (assignedGroups.has(groupName) || nestedGroups.has(groupName)) continue;
    if (!(group.interface ?? []).some(hasGeometryOutput)) continue;
    targets.push({
      id: targetId("group", groupName),
      kind: "group",
      label: groupName,
      detail: "Reusable node group",
      groupName,
      savedInputs: {},
    });
  }

  return targets.sort((a, b) =>
    Number(a.kind === "group") - Number(b.kind === "group")
    || a.label.localeCompare(b.label)
    || a.groupName.localeCompare(b.groupName));
}

function finiteRange(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) < 1e6 ? number : fallback;
}

function rangeFor(item: DumpInterfaceItem, value: number): [number, number, number] {
  const integer = item.socket_type?.includes("Int");
  const factor = item.socket_type?.includes("Factor") || item.name.toLowerCase().includes("factor");
  if (integer) {
    const min = finiteRange(item.min_value, Math.min(0, value));
    const max = finiteRange(item.max_value, Math.max(20, value * 2, min + 1));
    return [min, max, 1];
  }
  if (factor) return [0, 1, .001];
  let min = finiteRange(item.min_value, Math.min(0, value * 2));
  let max = finiteRange(item.max_value, Math.max(1, Math.abs(value) * 3));
  if (max <= min || max - min > Math.max(10_000, Math.abs(value) * 1_000)) {
    min = Math.min(0, value * 2);
    max = Math.max(1, Math.abs(value) * 3, min + 1);
  }
  return [min, max, Math.max((max - min) / 1_000, .0001)];
}

export function controlsForBlendStudioTarget(dump: Dump, target: BlendStudioTarget): BlendStudioControl[] {
  const group = dump.node_groups[target.groupName];
  if (!group) return [];
  return group.interface.flatMap((item) => {
    if (
      item.item_type !== "SOCKET"
      || item.in_out !== "INPUT"
      || !item.identifier
      || item.socket_type === "NodeSocketGeometry"
      || (!item.socket_type?.includes("Float")
        && !item.socket_type?.includes("Int")
        && item.socket_type !== "NodeSocketBool")
    ) return [];
    const stored = target.savedInputs[item.identifier] ?? target.savedInputs[item.name];
    const raw = stored ?? item.default ?? (item.socket_type === "NodeSocketBool" ? false : 0);
    const value = item.socket_type === "NodeSocketBool" ? Boolean(raw) : Number(raw) || 0;
    const [min, max, step] = rangeFor(item, typeof value === "number" ? value : 0);
    return [{
      identifier: item.identifier,
      name: item.name,
      socketType: item.socket_type,
      value,
      min,
      max,
      step,
    }];
  });
}

export function compatibilityForBlendStudioTarget(
  dump: Dump,
  target: BlendStudioTarget,
): BlendStudioCompatibility {
  const report = analyzeProgramCapabilities(dump.node_groups, target.groupName);
  const totalNodes = report.nodeTypes.reduce((sum, entry) => sum + entry.count, 0);
  const recognizedNodes = report.nodeTypes
    .filter((entry) => entry.support !== "unsupported")
    .reduce((sum, entry) => sum + entry.count, 0);
  const totalRecords = totalNodes + report.missingGroups.length;
  const score = totalRecords ? Math.round(recognizedNodes / totalRecords * 100) : 100;
  return {
    report,
    recognizedNodes,
    totalNodes,
    score,
    gaps: [
      ...report.unsupportedNodeTypes.map((entry) => `${entry.type} ×${entry.count}`),
      ...report.missingGroups.map((entry) => `Missing group ${entry.group}`),
    ],
  };
}

export function seedableObjectNames(dump: Dump): string[] {
  return (dump.objects ?? [])
    .filter((object) => Boolean(object.mesh || object.curves?.length))
    .map((object) => object.name)
    .sort((a, b) => a.localeCompare(b));
}

