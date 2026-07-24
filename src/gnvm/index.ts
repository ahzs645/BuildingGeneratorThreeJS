// Public entry point for the geometry-nodes VM.
import { Evaluator } from "./evaluator";
import { Geometry, toTriSoup } from "./geometry";
import { DUMP_CONTEXT, MISSING, REGISTRY, type DumpObject } from "./registry";
import { ensureManifold } from "./boolean";
import { ensureBulletHull } from "./bullet-hull";
import { matchLegacyCurvePassthrough } from "./nodes/geometry";
import { resolveObjectDependencyOrder } from "./dependency-metadata";
import type { Dump } from "./dump-schema";
import { baseGeometryOf } from "./dump-object-geometry";
import type { RunResult } from "./run-result";

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
import "./nodes/edge-paths";
import "./nodes/surface-sampling";

export { Evaluator, GEOMETRY_PROBE } from "./evaluator";
export { Geometry, toTriSoup } from "./geometry";
export type { TriSoup } from "./geometry";
export { REGISTRY, MISSING } from "./registry";
export { DumpValidationError, normalizeDump, validateDump } from "./dump-schema";
export type {
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
  DumpNodeGroup,
  DumpObject,
  DumpValidationIssue,
  FontAtlas,
  RawNode,
  RawOutput,
  RawSocket,
} from "./dump-schema";
export {
  analyzeProgramCapabilities,
  EDITOR_ONLY_NODE_TYPES,
  EVALUATOR_NATIVE_NODE_TYPES,
} from "./capabilities";
export type {
  MissingGroupReference,
  NodeCapabilityCount,
  NodeSupport,
  ProgramCapabilityReport,
} from "./capabilities";
export { ensureManifold, isManifoldReady } from "./boolean";
export { ensureBulletHull, isBulletHullReady } from "./bullet-hull";
export { baseGeometryOf } from "./dump-object-geometry";
export { createPrimitiveGeometry, runNodeGroup } from "./group-runner";
export type {
  GroupGeometrySeed,
  PrimitiveGeometrySeed,
  RunNodeGroupOptions,
} from "./group-runner";
export type { RunCoverage, RunResult } from "./run-result";

// Find the modifier group name for an object (or the first NODES modifier in the file).
export function findModifierGroup(
  dump: Dump,
  objectName?: string,
  groupName?: string,
): { group: string; inputs: Record<string, any>; objectName: string } | null {
  const objs = dump.objects ?? [];
  for (const o of objs) {
    if (objectName && o.name !== objectName) continue;
    for (const m of o.modifiers ?? []) {
      if (
        m.type === "NODES"
        && m.node_group
        && (!groupName || m.node_group === groupName)
      ) return { group: m.node_group, inputs: m.input_values ?? {}, objectName: o.name };
    }
  }
  return null;
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
  opts: { object?: string; group?: string; overrides?: Record<string, any> } = {},
): Promise<RunResult> {
  // Mesh boolean and Blender-compatible convex hull need WASM; load both once.
  await Promise.all([ensureManifold(), ensureBulletHull()]);
  MISSING.clear();
  DUMP_CONTEXT.objects = (dump.objects ?? []) as any;
  DUMP_CONTEXT.collections = dump.collections ?? [];
  DUMP_CONTEXT.images = dump.images ?? [];
  DUMP_CONTEXT.fonts = dump.fonts ?? {};
  DUMP_CONTEXT.evaluatedObjects.clear();
  DUMP_CONTEXT.evaluatingObjects.clear();
  DUMP_CONTEXT.legacyCurvePassthroughObjects.clear();
  for (const object of DUMP_CONTEXT.objects) {
    const modifier = object.modifiers?.find((candidate) => candidate.type === "NODES" && candidate.node_group);
    if (object.type === "CURVE" && modifier?.node_group && isGeometryPassthroughGroup(dump.node_groups[modifier.node_group]))
      DUMP_CONTEXT.legacyCurvePassthroughObjects.add(object.name);
  }
  DUMP_CONTEXT.frame = Number(opts.overrides?.__frame ?? dump.scene?.frame_current ?? 0);
  DUMP_CONTEXT.fps = Number(dump.scene?.fps ?? 24) / Math.max(Number(dump.scene?.fps_base ?? 1), 1e-9);
  const found = findModifierGroup(dump, opts.object, opts.group);
  if (!found) {
    const selection = [opts.object, opts.group].filter(Boolean).join(" / ");
    throw new Error(`no matching geometry-nodes modifier found in dump${selection ? `: ${selection}` : ""}`);
  }
  DUMP_CONTEXT.activeObject = DUMP_CONTEXT.objects.find((object) => object.name === found.objectName);
  // Note: Solidify N++ Thickness in this dump is intentionally ~0.1 (unlinked).
  // "Wall thiccness" drives bubble displacement, NOT solidify depth — do not
  // rebind it onto Solidify or dual walls balloon into self-intersecting shells.
  const ev = new Evaluator(dump.node_groups);
  // Evaluate reachable referenced-object modifier roots before the main root.
  // Object Info sees Blender's evaluated geometry set, including curve-only
  // outputs that cannot be represented by Object.to_mesh() during extraction.
  const dependencyNames = resolveObjectDependencyOrder(dump, found.group, found.objectName);
  const objectsByName = new Map(DUMP_CONTEXT.objects.map((object) => [object.name, object]));
  // Keep the main object pending while its dependencies cook. Object Info
  // back-edges to it then match Blender's unavailable cycle edge instead of
  // materializing the main object's base geometry.
  DUMP_CONTEXT.evaluatingObjects.add(found.objectName);
  try {
    for (const dependencyName of dependencyNames) {
      const object = objectsByName.get(dependencyName);
      if (!object) continue;
      const modifier = object.modifiers?.find((candidate) => candidate.type === "NODES" && candidate.node_group && dump.node_groups[candidate.node_group]);
      if (!modifier?.node_group) continue;
      const dependencyGroup: any = dump.node_groups[modifier.node_group];
      const dependencyInputs: Record<string, any> = { ...(modifier.input_values ?? {}) };
      const geometrySocket = dependencyGroup?.interface?.find((item: any) => item.item_type === "SOCKET" && item.in_out === "INPUT" && item.socket_type === "NodeSocketGeometry");
      if (geometrySocket) {
        const base = baseGeometryOf(dump, object.name);
        if (base) dependencyInputs[geometrySocket.identifier] = base;
      }
      DUMP_CONTEXT.activeObject = object;
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
    DUMP_CONTEXT.activeObject = DUMP_CONTEXT.objects.find((object) => object.name === found.objectName);
    const groupDef: any = dump.node_groups[found.group];
    const merged: Record<string, any> = { ...found.inputs };
    for (const [key, value] of Object.entries(opts.overrides ?? {})) {
      merged[key] = value;
      // Friendly-name UI overrides must replace the identifier value captured in
      // the modifier dump; identifier-first binding otherwise restores the saved
      // value. Duplicate names intentionally update every matching socket.
      for (const item of groupDef?.interface ?? [])
        if (item.item_type === "SOCKET" && item.in_out === "INPUT" && item.name === key)
          merged[item.identifier] = value;
    }
    // Blender feeds the object's own (pre-modifier) mesh into the tree's Geometry
    // input — e.g. the bubble vase's seed mesh. Bind it by socket identifier.
    const geoSocket = groupDef?.interface?.find(
      (it: any) => it.item_type === "SOCKET" && it.in_out === "INPUT" && it.socket_type === "NodeSocketGeometry"
    );
    if (geoSocket) {
      const base = baseGeometryOf(dump, found.objectName);
      if (base) merged[geoSocket.identifier] = base;
    }
    const { geometry } = ev.evalModifierGroup(found.group, merged);
    const soup = toTriSoup(geometry);
    const missingTypes = [...MISSING.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
    return {
      geometry,
      soup,
      coverage: { handled: REGISTRY.size, missingTypes },
    };
  } finally {
    DUMP_CONTEXT.evaluatingObjects.clear();
  }
}
