import {
  analyzeProgramCapabilities,
  REGISTRY,
  type DataRef,
  type Dump,
  type DumpInterfaceItem,
  type DumpModifierBakeState,
  type ProgramCapabilityReport,
  type RunDetail,
} from "../gnvm";
import { resolveObjectDependencyOrder } from "../gnvm/dependency-metadata";

export type BlendStudioRuntimeDetailSummary = {
  warningCount: number;
  budgetAdjustedCount: number;
  boundedAdaptivityCount: number;
};

export function summarizeBlendStudioRuntimeDetails(
  details: readonly RunDetail[],
): BlendStudioRuntimeDetailSummary {
  return {
    warningCount: details.filter((detail) => detail.severity === "warning").length,
    budgetAdjustedCount: details.filter((detail) =>
      detail.kind === "volume-grid-budget" && detail.adjusted).length,
    boundedAdaptivityCount: details.filter((detail) =>
      detail.kind === "bounded-grid-adaptivity").length,
  };
}

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
  | { kind: "ico-spheres"; spheres: Array<{ position: [number, number, number]; radius: number }>; subdivisions?: number }
  | { kind: "object"; objectName: string };

export type BlendStudioControl = {
  identifier: string;
  name: string;
  socketType: string;
  value: number | boolean | string;
  min: number;
  max: number;
  step: number;
  panelPath: string[];
  hiddenInModifier: boolean;
  hideValue: boolean;
};

export type BlendStudioDatablockControl = {
  identifier: string;
  name: string;
  socketType: string;
  datablock: "Object" | "Collection" | "Image" | "Material";
  value: DataRef | null;
  options: string[];
  panelPath: string[];
  hiddenInModifier: boolean;
};

export type BlendStudioCompatibility = {
  report: ProgramCapabilityReport;
  recognizedNodes: number;
  totalNodes: number;
  score: number;
  gaps: string[];
};

export type BlendStudioApproximationCount = {
  type: string;
  count: number;
};

/** Canonical warning-chip text shared by static compatibility and live runs. */
export function boundedApproximationBadgeLabel(
  entry: BlendStudioApproximationCount,
): string {
  return `Bounded approximation · ${entry.type} ×${entry.count}`;
}

/** Static warning for nodes whose evaluated inputs decide exactness. */
export function runtimeConditionalBadgeLabel(
  entry: BlendStudioApproximationCount,
): string {
  return `Runtime-conditional · ${entry.type} ×${entry.count}`;
}

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
  return executedGeometryNodeModifiersForBlendStudioTarget(dump, target)
    .map(({ root }) => root);
}

function executedGeometryNodeModifiersForBlendStudioTarget(
  dump: Dump,
  target: BlendStudioTarget,
): { root: string; bakeStates?: DumpModifierBakeState[] }[] {
  if (target.kind === "group") return [{ root: target.groupName }];
  const object = objectForTarget(dump, target);
  if (!object) return [{ root: target.groupName, bakeStates: [] }];
  const targetModifiers = (object.modifiers ?? [])
    .slice(0, target.modifierIndex + 1)
    .flatMap((modifier) =>
      modifier.type === "NODES"
        && modifier.node_group
        && (modifier.show_viewport !== false || modifier === object.modifiers?.[target.modifierIndex])
        ? [{ root: modifier.node_group, bakeStates: modifier.bake_states ?? [] }]
        : []);
  // runGenerator cooks referenced Object Info dependencies before the target
  // stack. Include the same modifier-instance closures here so a packed or
  // unknown Bake in a dependency cannot disappear from the Studio warning UI.
  const dependencyNames = [...new Set(targetModifiers.flatMap(({ root }) =>
    resolveObjectDependencyOrder(dump, root, object.name)))];
  const dependencyModifiers = dependencyNames.flatMap((name) => {
    const dependency = dump.objects?.find((candidate) => candidate.name === name);
    const modifier = dependency?.modifiers?.find((candidate) =>
      candidate.type === "NODES"
      && candidate.node_group
      && candidate.show_viewport !== false
      && Boolean(dump.node_groups[candidate.node_group]));
    return modifier?.node_group
      ? [{ root: modifier.node_group, bakeStates: modifier.bake_states ?? [] }]
      : [];
  });
  return [...dependencyModifiers, ...targetModifiers];
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
  const roots = executedGeometryNodeModifiersForBlendStudioTarget(dump, target);
  const reports = roots.map(({ root, bakeStates }) =>
    analyzeProgramCapabilities(dump.node_groups, root, REGISTRY, { bakeStates }));
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
  const runtimeConditionalNodeTypes = nodeTypes
    .filter((entry) => entry.support === "runtime-conditional")
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
    runtimeConditionalNodeTypes,
    approximatedNodeTypes,
    portable: !missingGroups.length && !unsupportedNodeTypes.length && !stackIssues.length,
    exact: !missingGroups.length
      && !unsupportedNodeTypes.length
      && !runtimeConditionalNodeTypes.length
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

function panelPaths(items: DumpInterfaceItem[]): Map<string, string[]> {
  const panels = new Map<string, DumpInterfaceItem>();
  for (const item of items) {
    if (item.item_type !== "PANEL") continue;
    panels.set(item.identifier ?? item.name, item);
  }
  const cache = new Map<string, string[]>();
  const resolve = (identifier: string | undefined, seen = new Set<string>()): string[] => {
    if (!identifier || seen.has(identifier)) return [];
    const cached = cache.get(identifier);
    if (cached) return cached;
    const panel = panels.get(identifier);
    if (!panel) return [];
    const path = [
      ...resolve(panel.parent_identifier, new Set(seen).add(identifier)),
      panel.name,
    ];
    cache.set(identifier, path);
    return path;
  };
  for (const identifier of panels.keys()) resolve(identifier);
  return cache;
}

export function controlsForBlendStudioTarget(dump: Dump, target: BlendStudioTarget): BlendStudioControl[] {
  const group = dump.node_groups[target.groupName];
  if (!group) return [];
  const paths = panelPaths(group.interface);
  return group.interface.flatMap((item) => {
    if (
      item.item_type !== "SOCKET"
      || item.in_out !== "INPUT"
      || !item.identifier
      || item.socket_type === "NodeSocketGeometry"
      || (!item.socket_type?.includes("Float")
        && !item.socket_type?.includes("Int")
        && item.socket_type !== "NodeSocketBool"
        && item.socket_type !== "NodeSocketString")
    ) return [];
    const stored = target.savedInputs[item.identifier] ?? target.savedInputs[item.name];
    const fallback = item.socket_type === "NodeSocketBool"
      ? false
      : item.socket_type === "NodeSocketString" ? "" : 0;
    const raw = stored ?? item.default ?? fallback;
    const value = item.socket_type === "NodeSocketBool"
      ? Boolean(raw)
      : item.socket_type === "NodeSocketString" ? String(raw) : Number(raw) || 0;
    const [min, max, step] = rangeFor(item, typeof value === "number" ? value : 0);
    return [{
      identifier: item.identifier,
      name: item.name,
      socketType: item.socket_type,
      value,
      min,
      max,
      step,
      panelPath: paths.get(item.parent_identifier ?? "") ?? [],
      hiddenInModifier: Boolean(item.hide_in_modifier),
      hideValue: Boolean(item.hide_value),
    }];
  });
}

export type BlendStudioProgressivePreviewContract = {
  control: BlendStudioControl;
  previewValue: number;
};

/**
 * Exact-word names only. Substring matches are deliberately excluded so a
 * semantic input like "bubble density" or "wall resolution factor" can never
 * be hijacked into a fidelity dial.
 */
const RESOLUTION_CLASS_NAME = /^(resolution|res|quality|detail|subdiv(isions?)?|segments|steps)$/i;

/**
 * Find the exposed control that behaves like Blender's viewport fidelity dial
 * (Resolution, Segments, Subdivisions, …) and compute a cheap preview value
 * for it: floats drop to min + 25% of the authored-or-current span above min,
 * integers to max(min, ceil(25% of current)). Returns null when no control
 * safely matches, the range is degenerate, or the preview would not actually
 * be lower than the current value — the progressive-preview feature simply
 * stays off for that tool.
 */
export function progressivePreviewContractForBlendStudioTarget(
  dump: Dump,
  target: BlendStudioTarget,
): BlendStudioProgressivePreviewContract | null {
  const candidates = controlsForBlendStudioTarget(dump, target).filter((control) =>
    typeof control.value === "number"
    && (control.socketType.includes("Float") || control.socketType.includes("Int"))
    && RESOLUTION_CLASS_NAME.test(control.name.trim()));
  const control = candidates.find((candidate) =>
    candidate.name.trim().toLowerCase() === "resolution") ?? candidates[0];
  if (!control) return null;
  const value = Number(control.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (!(control.max - control.min > 0)) return null;
  const previewValue = control.socketType.includes("Int")
    ? Math.max(control.min, Math.ceil(value * .25))
    : Math.max(control.min, control.min + (value - control.min) * .25);
  if (!Number.isFinite(previewValue) || previewValue >= value) return null;
  return { control, previewValue };
}

function dataRef(value: unknown): DataRef | null {
  return value
    && typeof value === "object"
    && typeof (value as { name?: unknown }).name === "string"
    ? {
        datablock: typeof (value as { datablock?: unknown }).datablock === "string"
          ? (value as { datablock: string }).datablock
          : undefined,
        name: (value as { name: string }).name,
      }
    : null;
}

/**
 * Expose typed pointer sockets without guessing a replacement. The options are
 * limited to datablocks already embedded in the portable dump, so every choice
 * remains serializable and worker-safe.
 */
export function datablockControlsForBlendStudioTarget(
  dump: Dump,
  target: BlendStudioTarget,
): BlendStudioDatablockControl[] {
  const group = dump.node_groups[target.groupName];
  if (!group) return [];
  const paths = panelPaths(group.interface);
  const types = new Map<string, BlendStudioDatablockControl["datablock"]>([
    ["NodeSocketObject", "Object"],
    ["NodeSocketCollection", "Collection"],
    ["NodeSocketImage", "Image"],
    ["NodeSocketMaterial", "Material"],
  ]);
  const options = {
    Object: (dump.objects ?? []).map((object) => object.name),
    Collection: (dump.collections ?? []).map((collection) => collection.name),
    Image: (dump.images ?? []).map((image) => image.name),
    Material: Object.keys(dump.materials ?? {}),
  };
  return group.interface.flatMap((item) => {
    if (
      item.item_type !== "SOCKET"
      || item.in_out !== "INPUT"
      || !item.identifier
      || !item.socket_type
    ) return [];
    const datablock = types.get(item.socket_type);
    if (!datablock) return [];
    const stored = Object.prototype.hasOwnProperty.call(target.savedInputs, item.identifier)
      ? target.savedInputs[item.identifier]
      : Object.prototype.hasOwnProperty.call(target.savedInputs, item.name)
        ? target.savedInputs[item.name]
        : item.default;
    return [{
      identifier: item.identifier,
      name: item.name,
      socketType: item.socket_type,
      datablock,
      value: dataRef(stored),
      options: [...new Set(options[datablock])].sort((a, b) => a.localeCompare(b)),
      panelPath: paths.get(item.parent_identifier ?? "") ?? [],
      hiddenInModifier: Boolean(item.hide_in_modifier),
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
      ...report.runtimeConditionalNodeTypes.map(runtimeConditionalBadgeLabel),
      ...report.approximatedNodeTypes.map(boundedApproximationBadgeLabel),
      ...report.missingGroups.map((entry) => `Missing group ${entry.group}`),
      ...stackIssues.map((entry) =>
        `Unsupported modifier ${entry.modifierType} at stack position ${entry.modifierIndex + 1} · ${entry.reason}`),
    ],
  };
}

/** A measured run at or under this duration turns live evaluation on. */
export const BLEND_STUDIO_LIVE_EVALUATION_ENABLE_SECONDS = 2;
/** A measured run over this duration turns live evaluation off. */
export const BLEND_STUDIO_LIVE_EVALUATION_DISABLE_SECONDS = 4;
/** Unmeasured closures above this node count start in explicit-preview mode. */
const UNMEASURED_LIVE_NODE_BUDGET = 500;

export const BLEND_STUDIO_EVALUATION_HISTORY_MAX_ENTRIES = 100;
export const BLEND_STUDIO_EVALUATION_HISTORY_MAX_RUNS = 3;

export type BlendStudioEvaluationRunOutcome = "ready" | "error" | "timeout";

export type BlendStudioEvaluationRunRecord = {
  /** Wall-clock duration; timeouts and errors record the safety ceiling, not nothing. */
  seconds: number;
  outcome: BlendStudioEvaluationRunOutcome;
  /** Epoch milliseconds when the run completed; drives LRU eviction. */
  at: number;
};

export type BlendStudioEvaluationHistoryEntry = {
  runs: BlendStudioEvaluationRunRecord[];
  usedAt: number;
};

export type BlendStudioEvaluationHistoryStore = {
  entries: Record<string, BlendStudioEvaluationHistoryEntry>;
};

/**
 * Stable history key for one (source file, execution target) pair. The
 * fingerprint survives re-imports of the same file, unlike the page-level
 * sourceKey which embeds an import serial.
 */
export function blendStudioEvaluationHistoryKey(
  sourceFingerprint: string,
  targetIdentifier: string,
): string {
  return `${sourceFingerprint}\0${targetIdentifier}`;
}

function sanitizedEvaluationRun(value: unknown): BlendStudioEvaluationRunRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<BlendStudioEvaluationRunRecord>;
  const seconds = Number(record.seconds);
  const at = Number(record.at);
  return Number.isFinite(seconds)
    && seconds >= 0
    && (record.outcome === "ready" || record.outcome === "error" || record.outcome === "timeout")
    ? { seconds, outcome: record.outcome, at: Number.isFinite(at) ? at : 0 }
    : null;
}

/**
 * Parse untrusted persisted history (localStorage JSON) into a well-formed
 * store, dropping malformed keys instead of failing the whole record.
 */
function sanitizedHistoryEntries(store: unknown): Record<string, BlendStudioEvaluationHistoryEntry> {
  const entries = (store as { entries?: unknown } | null | undefined)?.entries;
  if (!entries || typeof entries !== "object") return {};
  const result: Record<string, BlendStudioEvaluationHistoryEntry> = {};
  for (const [key, value] of Object.entries(entries)) {
    const runs = (value as { runs?: unknown } | null)?.runs;
    if (!Array.isArray(runs)) continue;
    const sanitized = runs
      .map(sanitizedEvaluationRun)
      .filter((run): run is BlendStudioEvaluationRunRecord => run !== null);
    if (!sanitized.length) continue;
    const usedAt = Number((value as { usedAt?: unknown }).usedAt);
    result[key] = {
      runs: sanitized.slice(-BLEND_STUDIO_EVALUATION_HISTORY_MAX_RUNS),
      usedAt: Number.isFinite(usedAt) ? usedAt : 0,
    };
  }
  return result;
}

export function blendStudioEvaluationRunsForKey(
  store: unknown,
  key: string,
): BlendStudioEvaluationRunRecord[] {
  return sanitizedHistoryEntries(store)[key]?.runs ?? [];
}

/**
 * Append a completed run, keeping the newest runs per key and evicting the
 * least recently used keys beyond the entry cap.
 */
export function recordBlendStudioEvaluationRun(
  store: unknown,
  key: string,
  run: BlendStudioEvaluationRunRecord,
): BlendStudioEvaluationHistoryStore {
  const entries = sanitizedHistoryEntries(store);
  entries[key] = {
    runs: [...entries[key]?.runs ?? [], run].slice(-BLEND_STUDIO_EVALUATION_HISTORY_MAX_RUNS),
    usedAt: run.at,
  };
  const keys = Object.keys(entries);
  if (keys.length <= BLEND_STUDIO_EVALUATION_HISTORY_MAX_ENTRIES) return { entries };
  const keep = keys
    .sort((a, b) => entries[b].usedAt - entries[a].usedAt || a.localeCompare(b))
    .slice(0, BLEND_STUDIO_EVALUATION_HISTORY_MAX_ENTRIES);
  return { entries: Object.fromEntries(keep.map((kept) => [kept, entries[kept]])) };
}

/**
 * Mark a key as used (a known tool was re-imported) so it stays inside the
 * LRU window. Returns null when the key has no recorded history.
 */
export function touchBlendStudioEvaluationHistory(
  store: unknown,
  key: string,
  at: number,
): BlendStudioEvaluationHistoryStore | null {
  const entries = sanitizedHistoryEntries(store);
  if (!entries[key]) return null;
  entries[key] = { ...entries[key], usedAt: at };
  return { entries };
}

/**
 * Fold measured runs (oldest first) into a live/explicit decision. Fast runs
 * enable, slow or failed runs disable, and the 2–4 s band keeps the previous
 * decision so the gate cannot flap while a tool hovers near the budget.
 */
function measuredLiveDecision(
  measuredRuns: readonly BlendStudioEvaluationRunRecord[],
  unmeasuredDefault: boolean,
): boolean {
  let live = unmeasuredDefault;
  for (const run of measuredRuns) {
    if (run.outcome !== "ready" || run.seconds > BLEND_STUDIO_LIVE_EVALUATION_DISABLE_SECONDS) {
      live = false;
    } else if (run.seconds <= BLEND_STUDIO_LIVE_EVALUATION_ENABLE_SECONDS) {
      live = true;
    }
  }
  return live;
}

/**
 * Live evaluation is reserved for closures the static capability pass can run
 * without silently skipping semantics. Unsupported targets stay available for
 * an explicit, capability-labelled preview, but cannot replace a last-known-
 * good viewport result merely because a graph control changed.
 *
 * Beyond the static gates the budget is empirical: once any evaluation of the
 * target has completed, measured wall-clock durations (injected as
 * `measuredRuns`, oldest first) decide live vs explicit. Node count only
 * seeds the default while no run has been observed.
 */
export function autoEvaluationPolicyForBlendStudioTarget(
  dump: Dump,
  target: BlendStudioTarget,
  measuredRuns: readonly BlendStudioEvaluationRunRecord[] = [],
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
  const resourceBounded = [
    ...report.approximatedNodeTypes,
    ...report.runtimeConditionalNodeTypes,
  ].filter((entry) =>
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
  if (measuredRuns.length) {
    const live = measuredLiveDecision(
      measuredRuns,
      reachableNodeCount <= UNMEASURED_LIVE_NODE_BUDGET,
    );
    const last = measuredRuns[measuredRuns.length - 1];
    if (live) {
      return {
        enabled: true,
        reason: `Live evaluation enabled · last run took ${last.seconds.toFixed(1)} s`,
      };
    }
    if (last.outcome === "timeout") {
      return {
        enabled: false,
        reason: `Last evaluation was stopped at the ${last.seconds.toFixed(0)} second safety limit`,
      };
    }
    if (last.outcome === "error") {
      return {
        enabled: false,
        reason: `Last evaluation failed, which counts as over the ${BLEND_STUDIO_LIVE_EVALUATION_DISABLE_SECONDS} s live-edit budget`,
      };
    }
    return {
      enabled: false,
      reason: last.seconds > BLEND_STUDIO_LIVE_EVALUATION_DISABLE_SECONDS
        ? `Last evaluation took ${last.seconds.toFixed(1)} s, above the ${BLEND_STUDIO_LIVE_EVALUATION_DISABLE_SECONDS} s live-edit budget`
        : `Last evaluation took ${last.seconds.toFixed(1)} s; a run at or under ${BLEND_STUDIO_LIVE_EVALUATION_ENABLE_SECONDS} s re-enables live evaluation`,
    };
  }
  if (reachableNodeCount > UNMEASURED_LIVE_NODE_BUDGET) {
    return {
      enabled: false,
      reason: `This ${reachableNodeCount.toLocaleString()}-node closure requires explicit preview until a measured run proves it fits the live-edit budget`,
    };
  }
  if (report.approximatedNodeTypes.length) {
    return {
      enabled: true,
      reason: "Live evaluation enabled with reported bounded approximations",
    };
  }
  if (report.runtimeConditionalNodeTypes.length) {
    return {
      enabled: true,
      reason: "Live evaluation enabled; evaluated inputs determine exact versus bounded execution",
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
