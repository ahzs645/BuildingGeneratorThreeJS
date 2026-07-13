// Public entry point for the geometry-nodes VM.
import { Evaluator, Program } from "./evaluator";
import { Geometry, Mesh, toTriSoup, TriSoup } from "./geometry";
import { DUMP_CONTEXT, MISSING, REGISTRY } from "./registry";
import { ensureManifold } from "./boolean";

// Registering the handler modules populates the REGISTRY.
import "./nodes/math";
import "./nodes/inputs";
import "./nodes/geometry";
import "./nodes/meshops";
import "./nodes/fields";
import "./nodes/curves";
import "./nodes/topology";
import "./nodes/extra";
import "./nodes/crayon";

export { Evaluator } from "./evaluator";
export { Geometry, toTriSoup } from "./geometry";
export type { TriSoup } from "./geometry";
export { REGISTRY, MISSING } from "./registry";
export { ensureManifold, isManifoldReady } from "./boolean";

export interface RunResult {
  geometry: Geometry;
  soup: TriSoup;
  coverage: {
    handled: number;
    missingTypes: { type: string; count: number }[];
  };
}

// A dump-file shape (subset we consume).
export interface Dump {
  node_groups: Program;
  scene?: { frame_current?: number; fps?: number; fps_base?: number };
  collections?: { name: string; objects: string[] }[];
  images?: { name: string; filepath?: string; size: number[]; pixels_rgba8?: string; channels?: number }[];
  dependency_objects?: string[];
  objects?: {
    name: string;
    location?: number[];
    rotation?: number[];
    scale?: number[];
    modifiers?: { type: string; node_group?: string; input_values?: Record<string, any> }[];
    curves?: { points: number[][]; cyclic: boolean; tilts?: number[] }[];
  }[];
  materials?: Record<string, { nodes?: { type: string; inputs?: { name: string; identifier: string; linked: boolean; value: unknown }[] }[] }>;
}

// Find the modifier group name for an object (or the first NODES modifier in the file).
export function findModifierGroup(dump: Dump, objectName?: string): { group: string; inputs: Record<string, any>; objectName: string } | null {
  const objs = dump.objects ?? [];
  for (const o of objs) {
    if (objectName && o.name !== objectName) continue;
    for (const m of o.modifiers ?? []) {
      if (m.type === "NODES" && m.node_group) return { group: m.node_group, inputs: m.input_values ?? {}, objectName: o.name };
    }
  }
  return null;
}

// Build a Geometry from a dump object's embedded base mesh (pre-modifier obj.data).
function baseGeometryOf(dump: Dump, objectName: string): Geometry | null {
  const obj: any = (dump.objects ?? []).find((o) => o.name === objectName);
  const g = new Geometry();
  if (obj?.mesh) {
    const m = new Mesh();
    m.positions = obj.mesh.verts.map((p: number[]) => [p[0], p[1], p[2]] as [number, number, number]);
    m.faces = obj.mesh.faces.map((f: number[]) => [...f]);
    m.faceMaterial = obj.mesh.face_materials ? [...obj.mesh.face_materials] : m.faces.map(() => 0);
    m.materialSlots = obj.materials?.length ? [...obj.materials] : [null];
    m.edges = (obj.mesh.edges ?? []).map((e: number[]) => [e[0], e[1]] as [number, number]);
    // authored custom attributes (e.g. the vase's 'bottom' vertex tag)
    for (const [name, a] of Object.entries<any>(obj.mesh.attributes ?? {})) {
      m.attributes.set(name, { domain: a.domain ?? "POINT", data: [...a.data] });
    }
    g.mesh = m;
  }
  if (obj?.curves) {
    g.curves = obj.curves.map((s: any) => ({ cyclic: Boolean(s.cyclic), points: s.points.map((p: number[]) => [p[0], p[1], p[2]]) }));
    const tilts = obj.curves.flatMap((s: any) => s.tilts ?? s.points.map(() => 0));
    if (tilts.some((value: number) => value !== 0)) g.curveAttributes.set("tilt", { domain: "POINT", data: tilts });
    const radii = obj.curves.flatMap((s: any) => s.radii ?? s.points.map(() => 1));
    if (radii.some((value: number) => value !== 1)) g.curveAttributes.set("radius", { domain: "POINT", data: radii });
  }
  return g.mesh || g.curves.length ? g : null;
}

export async function runGenerator(dump: Dump, opts: { object?: string; overrides?: Record<string, any> } = {}): Promise<RunResult> {
  // Mesh boolean needs Manifold WASM; load once before evaluation.
  await ensureManifold();
  MISSING.clear();
  DUMP_CONTEXT.objects = (dump.objects ?? []) as any;
  DUMP_CONTEXT.collections = dump.collections ?? [];
  DUMP_CONTEXT.images = dump.images ?? [];
  DUMP_CONTEXT.evaluatedObjects.clear();
  DUMP_CONTEXT.frame = Number(opts.overrides?.__frame ?? dump.scene?.frame_current ?? 0);
  DUMP_CONTEXT.fps = Number(dump.scene?.fps ?? 24) / Math.max(Number(dump.scene?.fps_base ?? 1), 1e-9);
  const found = findModifierGroup(dump, opts.object);
  if (!found) throw new Error("no geometry-nodes modifier found in dump");
  DUMP_CONTEXT.activeObject = DUMP_CONTEXT.objects.find((object) => object.name === found.objectName);
  // Note: Solidify N++ Thickness in this dump is intentionally ~0.1 (unlinked).
  // "Wall thiccness" drives bubble displacement, NOT solidify depth — do not
  // rebind it onto Solidify or dual walls balloon into self-intersecting shells.
  const ev = new Evaluator(dump.node_groups);
  // Evaluate reachable referenced-object modifier roots before the main root.
  // Object Info sees Blender's evaluated geometry set, including curve-only
  // outputs that cannot be represented by Object.to_mesh() during extraction.
  const dependencyNames = new Set(dump.dependency_objects ?? []);
  for (const object of DUMP_CONTEXT.objects) {
    if (object.name === found.objectName) continue;
    if (!dependencyNames.has(object.name)) continue;
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
    const dependencyGeometry = ev.evalModifierGroup(modifier.node_group, dependencyInputs).geometry;
    // Prefer the procedural runtime result when it produced a component. If an
    // unsupported structural node leaves it empty, Object Info can still use
    // the exact evaluated mesh embedded by Blender extraction.
    if (dependencyGeometry.mesh?.positions.length || dependencyGeometry.curves.length || dependencyGeometry.instances.length || !object.evaluated_mesh)
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
}
