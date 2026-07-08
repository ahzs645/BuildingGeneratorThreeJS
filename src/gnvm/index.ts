// Public entry point for the geometry-nodes VM.
import { Evaluator, Program } from "./evaluator";
import { Geometry, toTriSoup, TriSoup } from "./geometry";
import { DUMP_CONTEXT, MISSING, REGISTRY } from "./registry";

// Registering the handler modules populates the REGISTRY.
import "./nodes/math";
import "./nodes/inputs";
import "./nodes/geometry";
import "./nodes/meshops";
import "./nodes/fields";
import "./nodes/curves";
import "./nodes/topology";

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
export function findModifierGroup(dump: Dump, objectName?: string): { group: string; inputs: Record<string, any> } | null {
  const objs = dump.objects ?? [];
  for (const o of objs) {
    if (objectName && o.name !== objectName) continue;
    for (const m of o.modifiers ?? []) {
      if (m.type === "NODES" && m.node_group) return { group: m.node_group, inputs: m.input_values ?? {} };
    }
  }
  return null;
}

export function runGenerator(dump: Dump, opts: { object?: string; overrides?: Record<string, any> } = {}): RunResult {
  MISSING.clear();
  DUMP_CONTEXT.objects = (dump.objects ?? []) as any;
  const found = findModifierGroup(dump, opts.object);
  if (!found) throw new Error("no geometry-nodes modifier found in dump");
  const ev = new Evaluator(dump.node_groups);
  const merged = { ...found.inputs, ...(opts.overrides ?? {}) };
  const { geometry } = ev.evalModifierGroup(found.group, merged);
  const soup = toTriSoup(geometry);
  const missingTypes = [...MISSING.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
  return {
    geometry,
    soup,
    coverage: { handled: REGISTRY.size, missingTypes },
  };
}
