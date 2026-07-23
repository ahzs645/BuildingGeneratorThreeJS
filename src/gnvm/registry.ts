// Node-handler registry + the API a handler sees. Keeping this separate from the
// evaluator breaks the import cycle (handlers import the registry; the evaluator
// imports the registry to dispatch).
import { Field, Vec3, Domain, Elem } from "./core";
import { Geometry } from "./geometry";
import type { DataRef, DumpObject, FontAtlas, RawNode } from "./dump-schema";

export type {
  DataRef,
  DumpObject,
  FontAtlas,
  RawNode,
  RawOutput,
  RawSocket,
} from "./dump-schema";
export type SockVal = Geometry | Field | string | DataRef | null | undefined;

export interface EvalAPI {
  node: RawNode;
  // Stable expanded-node path for anonymous attributes. The same node inside
  // a repeat zone keeps one identity across iterations, while separate nested
  // group-node instances receive distinct paths.
  scope?: string;
  input(name: string): SockVal; // raw pulled value
  inputs(name: string): SockVal[]; // all values feeding a multi-input socket
  geoInputs(name: string): Geometry[]; // multi-input, geometry only
  geo(name: string): Geometry; // as geometry (empty if absent)
  field(name: string): Field; // as field (const 0 if absent)
  num(name: string): number; // const-eval field -> number
  vec(name: string): Vec3; // const-eval field -> vec3
  bool(name: string): boolean;
  str(name: string): string;
  ref(name: string): DataRef | null; // material/object pointer
  prop<T = any>(name: string, dflt?: T): T;
  // Resolve a field to a per-element array on a geometry domain.
  resolve(field: Field, geo: Geometry, domain: Domain): Elem[];
}

export type Handler = (api: EvalAPI) => Record<string, SockVal>;

export const REGISTRY = new Map<string, Handler>();
// Tracks node types that were requested but had no handler (coverage reporting).
export const MISSING = new Map<string, number>();

// Dump-level context (scene objects) so nodes like Object Info can materialize
// referenced objects. Set by runGenerator before evaluation.
export const DUMP_CONTEXT: {
  objects: DumpObject[];
  collections: { name: string; objects: string[] }[];
  images: { name: string; filepath?: string; size: number[]; pixels_rgba8?: string; channels?: number; decoded?: Uint8Array }[];
  fonts: Record<string, FontAtlas>;
  activeObject?: DumpObject;
  evaluatedObjects: Map<string, Geometry>;
  evaluatingObjects: Set<string>;
  legacyCurvePassthroughObjects: Set<string>;
  frame: number;
  fps: number;
} = { objects: [], collections: [], images: [], fonts: {}, evaluatedObjects: new Map(), evaluatingObjects: new Set(), legacyCurvePassthroughObjects: new Set(), frame: 0, fps: 24 };

export function reg(types: string | string[], handler: Handler): void {
  for (const t of Array.isArray(types) ? types : [types]) REGISTRY.set(t, handler);
}
