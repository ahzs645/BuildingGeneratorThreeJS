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

export type BlendStudioAutoEvaluationPolicy = {
  enabled: boolean;
  reason: string;
};

function hasGeometryOutput(item: DumpInterfaceItem): boolean {
  return item.item_type === "SOCKET"
    && item.in_out === "OUTPUT"
    && item.socket_type === "NodeSocketGeometry";
}

function targetId(...parts: Array<string | number>): string {
  return parts.map((part) => encodeURIComponent(String(part))).join(":");
}

export type BlendStudioModifierStackIssue = {
  modifierIndex: number;
  modifierType: string;
  modifierName?: string;
  reason: string;
};

function objectForTarget(dump: Dump, target: BlendStudioTarget) {
  return target.kind === "object"
    ? dump.objects?.find((object) => object.name === target.objectName)
    : undefined;
}

function isPortableMatrix(value: unknown): boolean {
  return Array.isArray(value)
    && value.length === 4
    && value.every((row) =>
      Array.isArray(row)
      && row.length === 4
      && row.every((component) => Number.isFinite(Number(component))));
}

/**
 * Geometry-node roots the browser executes for a target. Blender modifier
 * indices address the complete modifier array, while GN-VM deliberately cooks
 * each Geometry Nodes modifier up to and including the selected one.
 */
export function executedGeometryNodeRootsForBlendStudioTarget(
  dump: Dump,
  target: BlendStudioTarget,
): string[] {
  if (target.kind === "group") return [target.groupName];
  const object = objectForTarget(dump, target);
  if (!object) return [target.groupName];
  return (object.modifiers ?? [])
    .slice(0, target.modifierIndex + 1)
    .flatMap((modifier) =>
      modifier.type === "NODES"
        && modifier.node_group
        && (modifier.show_viewport !== false || modifier === object.modifiers?.[target.modifierIndex])
        ? [modifier.node_group]
        : []);
}

/**
 * Report preceding Blender modifiers whose evaluated result GN-VM cannot
 * reproduce. Pre-Geometry-Nodes Hooks are the sole portable non-GN exception;
 * their extracted object/matrix payload is applied by baseGeometryOf().
 */
export function modifierStackIssuesForBlendStudioTarget(
  dump: Dump,
  target: BlendStudioTarget,
): BlendStudioModifierStackIssue[] {
  if (target.kind !== "object") return [];
  const object = objectForTarget(dump, target);
  if (!object) {
    return [{
      modifierIndex: target.modifierIndex,
      modifierType: "OBJECT",
      reason: `Object ${target.objectName} is missing from the portable dump`,
    }];
  }
  const issues: BlendStudioModifierStackIssue[] = [];
  let encounteredNodes = false;
  for (const [modifierIndex, modifier] of (object.modifiers ?? []).entries()) {
    if (modifierIndex >= target.modifierIndex) break;
    if (modifier.show_viewport === false) continue;
    if (modifier.type === "NODES") {
      encounteredNodes = true;
      if (!modifier.node_group) {
        issues.push({
          modifierIndex,
          modifierType: modifier.type,
          modifierName: modifier.name,
          reason: "Geometry Nodes modifier has no extracted node group",
        });
      } else if (!dump.node_groups[modifier.node_group]) {
        issues.push({
          modifierIndex,
          modifierType: modifier.type,
          modifierName: modifier.name,
          reason: `Geometry Nodes group ${modifier.node_group} is missing from the portable dump`,
        });
      }
      continue;
    }
    if (modifier.type === "HOOK" && !encounteredNodes) {
      if (!modifier.object) continue;
      const hookObject = dump.objects?.find((candidate) => candidate.name === modifier.object);
      const strength = Number(modifier.strength ?? 1);
      const exactSettings = Array.isArray(modifier.vertex_indices)
        && modifier.falloff_type === "NONE"
        && !modifier.vertex_group
        && Number.isFinite(strength)
        && strength >= 0
        && strength <= 1
        && isPortableMatrix(modifier.matrix_inverse)
        && isPortableMatrix(hookObject?.matrix_world);
      if (exactSettings) continue;
      issues.push({
        modifierIndex,
        modifierType: modifier.type,
        modifierName: modifier.name,
        reason: "Hook is portable only with explicit indices, no vertex group/falloff, bounded strength, and captured object matrices",
      });
      continue;
    }
    issues.push({
      modifierIndex,
      modifierType: modifier.type,
      modifierName: modifier.name,
      reason: encounteredNodes
        ? `${modifier.type} between Geometry Nodes modifiers is not executed by GN-VM`
        : `${modifier.type} before Geometry Nodes is not represented by the extracted base mesh`,
    });
  }
  return issues;
}

export function aggregateCapabilityReportForBlendStudioTarget(
  dump: Dump,
  target: BlendStudioTarget,
): ProgramCapabilityReport {
  const roots = executedGeometryNodeRootsForBlendStudioTarget(dump, target);
  const reports = roots.map((root) => analyzeProgramCapabilities(dump.node_groups, root));
  const nodeCounts = new Map<string, ProgramCapabilityReport["nodeTypes"][number]>();
  for (const report of reports) {
    for (const entry of report.nodeTypes) {
      const key = `${entry.type}\0${entry.support}`;
      const current = nodeCounts.get(key);
      nodeCounts.set(key, current
        ? { ...current, count: current.count + entry.count }
        : { ...entry });
    }
  }
  const nodeTypes = [...nodeCounts.values()]
    .sort((a, b) => a.type.localeCompare(b.type) || a.support.localeCompare(b.support));
  const unsupportedNodeTypes = nodeTypes
    .filter((entry) => entry.support === "unsupported")
    .map(({ type, count }) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const approximatedNodeTypes = nodeTypes
    .filter((entry) => entry.support === "bounded-approximation")
    .map(({ type, count }) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const missingGroups = reports.flatMap((report) => report.missingGroups);
  const stackIssues = modifierStackIssuesForBlendStudioTarget(dump, target);
  return {
    rootGroup: target.groupName,
    reachableGroups: [...new Set(reports.flatMap((report) => report.reachableGroups))]
      .sort((a, b) => a.localeCompare(b)),
    missingGroups,
    nodeTypes,
    unsupportedNodeTypes,
    approximatedNodeTypes,
    portable: !missingGroups.length && !unsupportedNodeTypes.length && !stackIssues.length,
    exact: !missingGroups.length
      && !unsupportedNodeTypes.length
      && !approximatedNodeTypes.length
      && !stackIssues.length,
  };
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
  const report = aggregateCapabilityReportForBlendStudioTarget(dump, target);
  const stackIssues = modifierStackIssuesForBlendStudioTarget(dump, target);
  const totalNodes = report.nodeTypes.reduce((sum, entry) => sum + entry.count, 0);
  const recognizedNodes = report.nodeTypes
    .filter((entry) => entry.support !== "unsupported")
    .reduce((sum, entry) => sum + entry.count, 0);
  const totalRecords = totalNodes + report.missingGroups.length + stackIssues.length;
  const score = totalRecords ? Math.round(recognizedNodes / totalRecords * 100) : 100;
  return {
    report,
    recognizedNodes,
    totalNodes,
    score,
    gaps: [
      ...report.unsupportedNodeTypes.map((entry) => `${entry.type} ×${entry.count}`),
      ...report.approximatedNodeTypes.map((entry) =>
        `Bounded approximation · ${entry.type} ×${entry.count}`),
      ...report.missingGroups.map((entry) => `Missing group ${entry.group}`),
      ...stackIssues.map((entry) =>
        `Unsupported modifier ${entry.modifierType} at stack position ${entry.modifierIndex + 1} · ${entry.reason}`),
    ],
  };
}

/**
 * Live evaluation is reserved for closures the static capability pass can run
 * without silently skipping semantics. Unsupported targets stay available for
 * an explicit, capability-labelled preview, but cannot replace a last-known-
 * good viewport result merely because a graph control changed.
 */
export function autoEvaluationPolicyForBlendStudioTarget(
  dump: Dump,
  target: BlendStudioTarget,
): BlendStudioAutoEvaluationPolicy {
  const report = aggregateCapabilityReportForBlendStudioTarget(dump, target);
  if (report.missingGroups.length) {
    return {
      enabled: false,
      reason: `${report.missingGroups.length} referenced ${report.missingGroups.length === 1 ? "group is" : "groups are"} missing`,
    };
  }
  const stackIssues = modifierStackIssuesForBlendStudioTarget(dump, target);
  if (stackIssues.length) {
    return {
      enabled: false,
      reason: `${stackIssues.length} preceding Blender ${stackIssues.length === 1 ? "modifier is" : "modifiers are"} not portable; target-aware extraction is required`,
    };
  }
  const reachableNodeCount = report.nodeTypes.reduce((sum, entry) => sum + entry.count, 0);
  if (report.unsupportedNodeTypes.length) {
    return {
      enabled: false,
      reason: `${report.unsupportedNodeTypes.length} unsupported ${report.unsupportedNodeTypes.length === 1 ? "node type requires" : "node types require"} explicit preview`,
    };
  }
  const resourceBounded = report.approximatedNodeTypes.filter((entry) =>
    entry.type === "GeometryNodeGridToMesh"
    || entry.type === "GeometryNodeMeshToSDFGrid"
    || entry.type === "GeometryNodePointsToSDFGrid"
    || entry.type === "GeometryNodeVolumeCube"
    || entry.type === "GeometryNodeVolumeToMesh");
  if (resourceBounded.length) {
    return {
      enabled: false,
      reason: "Volume-grid approximations require explicit preview because evaluation cost depends on voxel density",
    };
  }
  if (reachableNodeCount > 500) {
    return {
      enabled: false,
      reason: `This ${reachableNodeCount.toLocaleString()}-node closure requires explicit preview to stay inside the live-edit budget`,
    };
  }
  if (report.approximatedNodeTypes.length) {
    return {
      enabled: true,
      reason: "Live evaluation enabled with reported bounded approximations",
    };
  }
  return {
    enabled: true,
    reason: "Live evaluation enabled for this portable closure",
  };
}

export function seedableObjectNames(dump: Dump): string[] {
  return (dump.objects ?? [])
    .filter((object) => Boolean(object.mesh || object.curves?.length))
    .map((object) => object.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Return interface Geometry inputs that actually feed the root graph. Blender
 * generators often retain a conventional but disconnected Geometry socket;
 * offering a replacement mesh for those sockets implies behavior the graph
 * does not author.
 */
export function connectedGeometryInputsForBlendStudioTarget(
  dump: Dump,
  target: BlendStudioTarget,
): DumpInterfaceItem[] {
  const group = dump.node_groups[target.groupName];
  if (!group) return [];
  const connected = new Set(
    (group.links ?? [])
      .filter((link) => !link.muted
        && group.nodes.some((node) =>
          node.name === link.from_node && node.type === "NodeGroupInput"))
      .map((link) => link.from_socket),
  );
  return (group.interface ?? []).filter((item) =>
    item.item_type === "SOCKET"
    && item.in_out === "INPUT"
    && item.socket_type === "NodeSocketGeometry"
    && Boolean(item.identifier)
    && connected.has(item.identifier!));
}
