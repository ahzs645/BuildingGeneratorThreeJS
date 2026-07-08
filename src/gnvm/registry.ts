// Node-handler registry + the API a handler sees. Keeping this separate from the
// evaluator breaks the import cycle (handlers import the registry; the evaluator
// imports the registry to dispatch).
import { Field, Vec3, Domain, Elem } from "./core";
import { Geometry } from "./geometry";

export interface RawSocket {
  name: string;
  identifier: string;
  idx?: number;
  type: string;
  linked: boolean;
  value: any;
}
export interface RawOutput {
  name: string;
  identifier: string;
  default?: any;
}
export interface RawNode {
  name: string;
  type: string;
  label: string | null;
  inputs: RawSocket[];
  outputs: RawOutput[];
  props?: Record<string, any>;
  group?: string;
}

// Datablock reference (material/object/image) as dumped.
export interface DataRef {
  datablock?: string;
  name: string;
}
export type SockVal = Geometry | Field | string | DataRef | null | undefined;

export interface EvalAPI {
  node: RawNode;
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

export function reg(types: string | string[], handler: Handler): void {
  for (const t of Array.isArray(types) ? types : [types]) REGISTRY.set(t, handler);
}
