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
  type?: string;
  default?: any;
}
export interface RawNode {
  name: string;
  type: string;
  label: string | null;
  ui?: { mute?: boolean };
  inputs: RawSocket[];
  outputs: RawOutput[];
  props?: Record<string, any>;
  group?: string;
  // Repeat/simulation zones: name of the paired output node (on the input node).
  paired_output?: string;
}

// Datablock reference (material/object/image) as dumped.
export interface DataRef {
  datablock?: string;
  name: string;
}
export interface FontAtlas {
  name: string;
  error?: string;
  align_offsets?: Record<string, number>;
  glyphs: Record<string, { advance: number; curves: { cyclic: boolean; points: number[][] }[] }>;
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

// Dump-level context (scene objects) so nodes like Object Info can materialize
// referenced objects. Set by runGenerator before evaluation.
export interface DumpObject {
  name: string;
  location?: number[];
  rotation?: number[];
  scale?: number[];
  materials?: string[];
  mesh?: { verts: number[][]; faces: number[][]; face_materials?: number[]; edges?: [number, number][] };
  evaluated_mesh?: { verts: number[][]; faces: number[][]; face_materials?: number[]; edges?: [number, number][]; materials?: (string | null)[] };
  curves?: { points: number[][]; cyclic: boolean; tilts?: number[]; radii?: number[]; tangents?: number[][] }[];
  modifiers?: { type: string; node_group?: string; input_values?: Record<string, any> }[];
}
export const DUMP_CONTEXT: {
  objects: DumpObject[];
  collections: { name: string; objects: string[] }[];
  images: { name: string; filepath?: string; size: number[]; pixels_rgba8?: string; channels?: number; decoded?: Uint8Array }[];
  fonts: Record<string, FontAtlas>;
  activeObject?: DumpObject;
  evaluatedObjects: Map<string, Geometry>;
  frame: number;
  fps: number;
} = { objects: [], collections: [], images: [], fonts: {}, evaluatedObjects: new Map(), frame: 0, fps: 24 };

export function reg(types: string | string[], handler: Handler): void {
  for (const t of Array.isArray(types) ? types : [types]) REGISTRY.set(t, handler);
}
