// Public entry point for the geometry-nodes VM.
import { Evaluator, Program } from "./evaluator";
import { Geometry, Mesh, toTriSoup, TriSoup } from "./geometry";
import { DUMP_CONTEXT, MISSING, REGISTRY } from "./registry";

// Registering the handler modules populates the REGISTRY.
import "./nodes/math";
import "./nodes/inputs";
import "./nodes/geometry";
import "./nodes/meshops";
import "./nodes/fields";
import "./nodes/curves";
import "./nodes/topology";
import "./nodes/extra";

export { Evaluator } from "./evaluator";
export { Geometry, toTriSoup } from "./geometry";
export type { TriSoup } from "./geometry";
export { REGISTRY, MISSING } from "./registry";

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
  objects?: { name: string; modifiers?: { type: string; node_group?: string; input_values?: Record<string, any> }[] }[];
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
  if (!obj?.mesh) return null;
  const g = new Geometry();
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
  return g;
}

export function runGenerator(dump: Dump, opts: { object?: string; overrides?: Record<string, any> } = {}): RunResult {
  MISSING.clear();
  DUMP_CONTEXT.objects = (dump.objects ?? []) as any;
  const found = findModifierGroup(dump, opts.object);
  if (!found) throw new Error("no geometry-nodes modifier found in dump");
  const ev = new Evaluator(dump.node_groups);
  const merged: Record<string, any> = { ...found.inputs, ...(opts.overrides ?? {}) };
  // Blender feeds the object's own (pre-modifier) mesh into the tree's Geometry
  // input — e.g. the bubble vase's seed mesh. Bind it by socket identifier.
  const groupDef: any = dump.node_groups[found.group];
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
