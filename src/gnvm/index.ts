// Public entry point for the geometry-nodes VM.
import { Evaluator } from "./evaluator";
import { Geometry, toTriSoup } from "./geometry";
import {
  APPROXIMATIONS,
  DUMP_CONTEXT,
  MISSING,
  REGISTRY,
  type DumpObject,
} from "./registry";
import { ensureManifold } from "./boolean";
import { ensureBulletHull } from "./bullet-hull";
import { matchLegacyCurvePassthrough } from "./nodes/geometry";
import { resolveObjectDependencyOrder } from "./dependency-metadata";
import type { Dump } from "./dump-schema";
import { baseGeometryOf } from "./dump-object-geometry";
import type { RunResult } from "./run-result";
import {
  beginRuntimeDetailCollection,
  endRuntimeDetailCollection,
  runtimeDetailSnapshot,
} from "./runtime-details";
import {
  resolveGeometrySeed,
  runNodeGroup,
  type GroupGeometrySeed,
  type RunNodeGroupOptions,
} from "./group-runner";
import { dumpAtFrame } from "./animation";
import { tagGeometryFingerprint } from "./evaluation-cache";

// Registering the handler modules populates the REGISTRY.
import "./nodes/math";
import "./nodes/inputs";
import "./nodes/meshops";
import "./nodes/fields";
import "./nodes/curves";
import "./nodes/topology";
import "./nodes/extra";
import "./nodes/crayon";
import "./nodes/volume";
import "./nodes/points";
import "./nodes/color";
import "./nodes/curve-handles";
import "./nodes/material-fields";
import "./nodes/edge-paths";
import "./nodes/surface-sampling";
import "./nodes/matrix";
import "./nodes/uv";
import "./nodes/import-stl";

export { Evaluator, GEOMETRY_PROBE } from "./evaluator";
export { Geometry, toTriSoup } from "./geometry";
export type { TriSoup } from "./geometry";
export { APPROXIMATIONS, REGISTRY, MISSING } from "./registry";
export type { SockVal, VolumeGrid } from "./registry";
export { DumpValidationError, normalizeDump, validateDump } from "./dump-schema";
export { animationFrameRange, dumpAtFrame, evaluateFCurve } from "./animation";
export {
  MAX_DENSE_SDF_SAMPLES,
  setDenseSdfSampleBudget,
} from "./nodes/volume";
export type {
  DumpAnimation,
  DumpAnimationFCurve,
  DumpAnimationKeyframe,
  DumpAnnotation,
  DumpAnnotationFrame,
  DumpAnnotationLayer,
  DumpAnnotationPoint,
  DumpAnnotationSpace,
  DumpAnnotationStroke,
  DataRef,
  Dump,
  DumpCurve,
  DumpEvaluatedMesh,
  DumpImage,
  DumpInterfaceItem,
  DumpLink,
  DumpMesh,
  DumpMeshAttribute,
  DumpModifier,
  DumpModifierBakeState,
  DumpNodeGroup,
  DumpNodeEditorView,
  DumpObject,
  DumpValidationIssue,
  DumpUnitSettings,
  BakeSnapshot,
  BakeSnapshotAttribute,
  BakeSnapshotGeometrySet,
  BakeSnapshotMesh,
  BakeSnapshotSpline,
  BakeSnapshotV2Item,
  BakeSnapshotVolumeGrid,
  FontAtlas,
  RawNode,
  RawOutput,
  RawSocket,
} from "./dump-schema";
export {
  analyzeProgramCapabilities,
  BOUNDED_APPROXIMATION_NODE_TYPES,
  EDITOR_ONLY_NODE_TYPES,
  EVALUATOR_NATIVE_NODE_TYPES,
  RUNTIME_CONDITIONAL_NODE_TYPES,
} from "./capabilities";
export type {
  MissingGroupReference,
  NodeCapabilityCount,
  NodeSupport,
  ProgramCapabilityContext,
  ProgramCapabilityReport,
} from "./capabilities";
export { ensureManifold, isManifoldReady } from "./boolean";
export { ensureBulletHull, isBulletHullReady } from "./bullet-hull";
export { baseGeometryOf } from "./dump-object-geometry";
export { createPrimitiveGeometry, resolveGeometrySeed, runNodeGroup } from "./group-runner";
export type {
  GroupGeometrySeed,
  PrimitiveGeometrySeed,
  RunNodeGroupOptions,
} from "./group-runner";
export type {
  RunCoverage,
  RunDetail,
  RunDetailSeverity,
  RunResult,
  RunVolumeGridStage,
} from "./run-result";

export interface RunGeneratorOptions {
  object?: string;
  group?: string;
  /** Zero-based index in the object's complete Blender modifier array. */
  modifierIndex?: number;
  overrides?: Record<string, any>;
  /** Replace the modifier's authored Geometry input with another geometry. */
  geometry?: GroupGeometrySeed;
  /** Serializable worker/API-friendly alias for geometry. */
  seed?: Exclude<GroupGeometrySeed, Geometry>;
  /** Target Geometry input identifier or friendly name. */
  geometryInput?: string;
  /** Blender scene frame used for extracted node-tree F-curves and Scene Time. */
  frame?: number;
}

export type RunGeometryTargetOptions =
  | ({ kind: "object" } & RunGeneratorOptions)
  | ({ kind: "group" } & RunNodeGroupOptions);

// Find the modifier group name for an object (or the first NODES modifier in the file).
export function findModifierGroup(
  dump: Dump,
  objectName?: string,
  groupName?: string,
  modifierIndex?: number,
): { group: string; inputs: Record<string, any>; objectName: string } | null {
  const objs = dump.objects ?? [];
  for (const o of objs) {
    if (objectName && o.name !== objectName) continue;
    for (const [index, m] of (o.modifiers ?? []).entries()) {
      if (modifierIndex !== undefined && index !== modifierIndex) continue;
      if (
        m.type === "NODES"
        && m.node_group
        && (modifierIndex !== undefined || m.show_viewport !== false)
        && (!groupName || m.node_group === groupName)
      ) return { group: m.node_group, inputs: m.input_values ?? {}, objectName: o.name };
    }
  }
  return null;
}

function modifierIndexForSelection(
  dump: Dump,
  objectName: string,
  groupName: string,
  requestedIndex?: number,
): number {
  const object = (dump.objects ?? []).find((candidate) => candidate.name === objectName);
  if (!object) return -1;
  if (requestedIndex !== undefined) {
    const modifier = object.modifiers?.[requestedIndex];
    return modifier?.type === "NODES" && modifier.node_group === groupName ? requestedIndex : -1;
  }
  return (object.modifiers ?? []).findIndex((modifier) =>
    modifier.type === "NODES" && modifier.node_group === groupName);
}

function applyFriendlyOverrides(
  groupDef: Dump["node_groups"][string] | undefined,
  savedInputs: Record<string, any>,
  overrides: Record<string, any>,
): Record<string, any> {
  const merged = { ...savedInputs };
  for (const [key, value] of Object.entries(overrides)) {
    merged[key] = value;
    // Friendly-name UI overrides must replace the identifier value captured in
    // the modifier dump; identifier-first binding otherwise restores the saved
    // value. Duplicate names intentionally update every matching socket.
    for (const item of groupDef?.interface ?? [])
      if (item.item_type === "SOCKET" && item.in_out === "INPUT" && item.name === key && item.identifier)
        merged[item.identifier] = value;
  }
  return merged;
}

function isGeometryPassthroughGroup(group: any): boolean {
  const input = group?.nodes?.find((node: any) => node.type === "NodeGroupInput");
  const output = group?.nodes?.find((node: any) => node.type === "NodeGroupOutput");
  if (!input || !output) return false;
  const geometryOutput = input.outputs?.find((socket: any) => socket.type === "NodeSocketGeometry");
  const geometryInput = output.inputs?.find((socket: any) => socket.type === "NodeSocketGeometry");
  return Boolean(geometryOutput && geometryInput && group.links?.some((link: any) =>
    !link.muted && link.from_node === input.name && link.from_socket === geometryOutput.identifier
      && link.to_node === output.name && link.to_socket === geometryInput.identifier));
}

function runtimeMeshMatchesEvaluatedSnapshot(
  geometry: Geometry,
  snapshot: NonNullable<DumpObject["evaluated_mesh"]>,
): boolean {
  const mesh = geometry.mesh;
  if (!mesh || mesh.positions.length !== snapshot.verts.length || mesh.faces.length !== snapshot.faces.length) return false;
  for (let vertex = 0; vertex < mesh.positions.length; vertex++) {
    const runtime = mesh.positions[vertex];
    const extracted = snapshot.verts[vertex];
    if (!extracted || runtime.length !== extracted.length) return false;
    for (let axis = 0; axis < runtime.length; axis++)
      if (Math.fround(runtime[axis]) !== Math.fround(extracted[axis])) return false;
  }
  for (let face = 0; face < mesh.faces.length; face++) {
    const runtime = mesh.faces[face];
    const extracted = snapshot.faces[face];
    if (!extracted || runtime.length !== extracted.length || runtime.some((vertex, corner) => vertex !== extracted[corner]))
      return false;
  }
  return true;
}

function hasPortableRuntimeMeshAttributes(geometry: Geometry): boolean {
  return Boolean(geometry.mesh && [...geometry.mesh.attributes.keys()].some((name) => !name.startsWith("__")));
}

export async function runGenerator(
  dump: Dump,
  opts: RunGeneratorOptions = {},
): Promise<RunResult> {
  const frame = Number(opts.frame ?? opts.overrides?.__frame ?? dump.scene?.frame_current ?? 0);
  dump = dumpAtFrame(dump, frame);
  // Mesh boolean and Blender-compatible convex hull need WASM; load both once.
  await Promise.all([ensureManifold(), ensureBulletHull()]);
  MISSING.clear();
  APPROXIMATIONS.clear();
  DUMP_CONTEXT.objects = (dump.objects ?? []) as any;
  DUMP_CONTEXT.collections = dump.collections ?? [];
  DUMP_CONTEXT.images = dump.images ?? [];
  DUMP_CONTEXT.fonts = dump.fonts ?? {};
  DUMP_CONTEXT.activeModifier = undefined;
  DUMP_CONTEXT.evaluatedObjects.clear();
  DUMP_CONTEXT.evaluatingObjects.clear();
  DUMP_CONTEXT.legacyCurvePassthroughObjects.clear();
  for (const object of DUMP_CONTEXT.objects) {
    const modifier = object.modifiers?.find((candidate) =>
      candidate.type === "NODES"
      && candidate.node_group
      && candidate.show_viewport !== false);
    if (object.type === "CURVE" && modifier?.node_group && isGeometryPassthroughGroup(dump.node_groups[modifier.node_group]))
      DUMP_CONTEXT.legacyCurvePassthroughObjects.add(object.name);
  }
  DUMP_CONTEXT.frame = frame;
  DUMP_CONTEXT.fps = Number(dump.scene?.fps ?? 24) / Math.max(Number(dump.scene?.fps_base ?? 1), 1e-9);
  const found = findModifierGroup(dump, opts.object, opts.group, opts.modifierIndex);
  if (!found) {
    const selection = [
      opts.object,
      opts.modifierIndex === undefined ? undefined : `modifier ${opts.modifierIndex}`,
      opts.group,
    ].filter((value) => value !== undefined && value !== "").join(" / ");
    throw new Error(`no matching geometry-nodes modifier found in dump${selection ? `: ${selection}` : ""}`);
  }
  const activeObject = DUMP_CONTEXT.objects.find((object) => object.name === found.objectName);
  const targetModifierIndex = modifierIndexForSelection(
    dump,
    found.objectName,
    found.group,
    opts.modifierIndex,
  );
  if (!activeObject || targetModifierIndex < 0)
    throw new Error(`geometry-nodes modifier selection became unavailable: ${found.objectName} / ${found.group}`);
  const modifierStack = (activeObject.modifiers ?? [])
    .map((modifier, index) => ({ modifier, index }))
    .filter(({ modifier, index }) =>
      index <= targetModifierIndex
      && modifier.type === "NODES"
      && Boolean(modifier.node_group)
      && (index === targetModifierIndex || modifier.show_viewport !== false)
      && Boolean(dump.node_groups[modifier.node_group!]));
  DUMP_CONTEXT.activeObject = activeObject;
  // Note: Solidify N++ Thickness in this dump is intentionally ~0.1 (unlinked).
  // "Wall thiccness" drives bubble displacement, NOT solidify depth — do not
  // rebind it onto Solidify or dual walls balloon into self-intersecting shells.
  const ev = new Evaluator(dump.node_groups);
  // Evaluate reachable referenced-object modifier roots before the main root.
  // Object Info sees Blender's evaluated geometry set, including curve-only
  // outputs that cannot be represented by Object.to_mesh() during extraction.
  const dependencyNames = [...new Set(modifierStack.flatMap(({ modifier }) =>
    resolveObjectDependencyOrder(dump, modifier.node_group!, found.objectName)))];
  const objectsByName = new Map(DUMP_CONTEXT.objects.map((object) => [object.name, object]));
  // Keep the main object pending while its dependencies cook. Object Info
  // back-edges to it then match Blender's unavailable cycle edge instead of
  // materializing the main object's base geometry.
  DUMP_CONTEXT.evaluatingObjects.add(found.objectName);
  beginRuntimeDetailCollection();
  try {
    for (const dependencyName of dependencyNames) {
      const object = objectsByName.get(dependencyName);
      if (!object) continue;
      const modifier = object.modifiers?.find((candidate) =>
        candidate.type === "NODES"
        && candidate.node_group
        && candidate.show_viewport !== false
        && dump.node_groups[candidate.node_group]);
      if (!modifier?.node_group) continue;
      const dependencyGroup: any = dump.node_groups[modifier.node_group];
      const dependencyInputs: Record<string, any> = { ...(modifier.input_values ?? {}) };
      const geometrySocket = dependencyGroup?.interface?.find((item: any) => item.item_type === "SOCKET" && item.in_out === "INPUT" && item.socket_type === "NodeSocketGeometry");
      if (geometrySocket) {
        const base = baseGeometryOf(dump, object.name);
        if (base) dependencyInputs[geometrySocket.identifier] = tagGeometryFingerprint(base, `base:${object.name}`);
      }
      DUMP_CONTEXT.activeObject = object;
      DUMP_CONTEXT.activeModifier = modifier;
      DUMP_CONTEXT.evaluatingObjects.add(object.name);
      let dependencyGeometry: Geometry;
      try {
        dependencyGeometry = ev.evalModifierGroup(modifier.node_group, dependencyInputs).geometry;
      } finally {
        DUMP_CONTEXT.evaluatingObjects.delete(object.name);
      }
      if (object.type === "CURVE" && isGeometryPassthroughGroup(dependencyGroup))
        matchLegacyCurvePassthrough(dependencyGeometry);
      // Pure-mesh dependencies already have Blender's exact evaluated mesh in the
      // portable dump. Keep that authoritative snapshot for Object Info unless
      // runtime evaluation reproduces the snapshot exactly and adds portable
      // attributes that evaluated.to_mesh() omitted (Flat Stickie Pack needs the
      // modifier-created `col` field used by its authored materials).
      const exactRuntimeAttributes = Boolean(
        object.evaluated_mesh
        && hasPortableRuntimeMeshAttributes(dependencyGeometry)
        && runtimeMeshMatchesEvaluatedSnapshot(dependencyGeometry, object.evaluated_mesh),
      );
      if (dependencyGeometry.curves.length || dependencyGeometry.instances.length || !object.evaluated_mesh || exactRuntimeAttributes)
        DUMP_CONTEXT.evaluatedObjects.set(object.name, dependencyGeometry);
    }
    DUMP_CONTEXT.activeObject = activeObject;
    DUMP_CONTEXT.activeModifier = undefined;
    if (opts.geometry && opts.seed) throw new Error("choose either geometry or seed, not both");
    const replacementGeometry = opts.geometry ?? opts.seed;
    let incomingGeometry = baseGeometryOf(dump, found.objectName);
    // Deterministic per (dump, object) — see resolveGeometrySeed for the twin.
    if (incomingGeometry) tagGeometryFingerprint(incomingGeometry, `base:${found.objectName}`);
    let geometry = new Geometry();
    for (const { modifier, index } of modifierStack) {
      DUMP_CONTEXT.activeModifier = modifier;
      const groupName = modifier.node_group!;
      const groupDef = dump.node_groups[groupName];
      const selected = index === targetModifierIndex;
      const merged = applyFriendlyOverrides(
        groupDef,
        modifier.input_values ?? {},
        selected ? opts.overrides ?? {} : {},
      );
      const geometrySockets = groupDef.interface?.filter(
        (item) => item.item_type === "SOCKET"
          && item.in_out === "INPUT"
          && item.socket_type === "NodeSocketGeometry",
      ) ?? [];
      const requestedGeometryInput = selected ? opts.geometryInput : undefined;
      const geometrySocket = requestedGeometryInput
        ? geometrySockets.find((socket) =>
            socket.identifier === requestedGeometryInput || socket.name === requestedGeometryInput)
        : geometrySockets[0];
      if (requestedGeometryInput && !geometrySocket)
        throw new Error(`Geometry input not found: ${requestedGeometryInput}`);
      if (selected && replacementGeometry && !geometrySocket)
        throw new Error(`modifier group has no Geometry input: ${groupName}`);
      if (geometrySocket) {
        const input = selected && replacementGeometry
          ? resolveGeometrySeed(dump, replacementGeometry).geometry
          : incomingGeometry;
        if (input && geometrySocket.identifier) merged[geometrySocket.identifier] = input;
      }
      geometry = ev.evalModifierGroup(groupName, merged).geometry;
      incomingGeometry = geometry;
    }
    const soup = toTriSoup(geometry);
    const missingTypes = [...MISSING.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
    const approximateTypes = [...APPROXIMATIONS.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
    return {
      geometry,
      soup,
      coverage: { handled: REGISTRY.size, missingTypes, approximateTypes },
      details: runtimeDetailSnapshot(),
    };
  } finally {
    endRuntimeDetailCollection();
    DUMP_CONTEXT.activeModifier = undefined;
    DUMP_CONTEXT.evaluatingObjects.clear();
  }
}

/**
 * One execution boundary for Studio/API callers. Object modifiers retain their
 * saved bindings and dependency cooking; reusable groups bind their interface
 * directly. Both accept the same serializable seed geometry contract.
 */
export async function runGeometryTarget(
  dump: Dump,
  options: RunGeometryTargetOptions,
): Promise<RunResult> {
  if (options.kind === "group") {
    const { kind: _kind, ...groupOptions } = options;
    return runNodeGroup(dump, groupOptions);
  }
  const { kind: _kind, ...generatorOptions } = options;
  return runGenerator(dump, generatorOptions);
}
