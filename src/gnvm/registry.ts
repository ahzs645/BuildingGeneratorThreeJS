// Node-handler registry + the API a handler sees. Keeping this separate from the
// evaluator breaks the import cycle (handlers import the registry; the evaluator
// imports the registry to dispatch).
import { Field, Vec3, Domain, Elem } from "./core";
import { Geometry } from "./geometry";
import { MatrixValue } from "./matrix";
import type { DataRef, DumpModifier, DumpObject, FontAtlas, RawNode } from "./dump-schema";

export type {
  DataRef,
  DumpObject,
  FontAtlas,
  RawNode,
  RawOutput,
  RawSocket,
} from "./dump-schema";

/** Typed null value for an unconnected NodeSocketClosure boundary. */
export class EmptyClosureValue {
  readonly kind = "empty-closure";
}

export const EMPTY_CLOSURE = Object.freeze(new EmptyClosureValue());

/**
 * A Geometry Nodes closure is a deferred subgraph with a dynamic signature.
 *
 * Keep the boundary deliberately small: the evaluator owns zone execution,
 * while ordinary node handlers can invoke the captured callable without
 * depending on Invocation internals.
 */
export class ClosureValue {
  readonly kind = "closure";

  constructor(
    private readonly evaluateFn: (
      inputs: Record<string, SockVal>,
    ) => Record<string, SockVal>,
  ) {}

  evaluate(inputs: Record<string, SockVal>): Record<string, SockVal> {
    return this.evaluateFn(inputs);
  }
}

/**
 * Dense browser representation of a Blender volume/grid socket.
 *
 * This value contract lives beside SockVal instead of in the volume handlers,
 * so evaluators and handlers can exchange grids without an import cycle or an
 * unsafe cast.
 */
export interface VolumeGrid {
  kind: "GNVM_VOLUME_GRID";
  background: number;
  min: Vec3;
  max: Vec3;
  resolution: Vec3;
  origin: Vec3;
  voxelSize: Vec3;
  values: Float32Array;
  /** Spacing requested by the graph before the dense-browser safety budget. */
  requestedVoxelSize: number;
  /** Sample count the requested spacing/resolution would have allocated. */
  requestedSampleCount: number;
  /** True when the dense fallback coarsened the requested lattice. */
  budgetAdjusted: boolean;
  sampleBudget: number;
}

export type SockVal =
  | Geometry
  | Field
  | MatrixValue
  | EmptyClosureValue
  | ClosureValue
  | VolumeGrid
  | string
  | DataRef
  | null
  | undefined;

export interface EvalAPI {
  node: RawNode;
  /** Concrete node group containing node, including nested group execution. */
  group?: string;
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
// Tracks executed handlers that intentionally provide a bounded approximation
// instead of claiming Blender-exact semantics.
export const APPROXIMATIONS = new Map<string, number>();

// Dump-level context (scene objects) so nodes like Object Info can materialize
// referenced objects. Set by runGenerator before evaluation.
export const DUMP_CONTEXT: {
  objects: DumpObject[];
  collections: { name: string; objects: string[] }[];
  images: { name: string; filepath?: string; size: number[]; pixels_rgba8?: string; channels?: number; decoded?: Uint8Array }[];
  fonts: Record<string, FontAtlas>;
  activeObject?: DumpObject;
  /** Modifier instance whose node tree is currently being evaluated. */
  activeModifier?: DumpModifier;
  evaluatedObjects: Map<string, Geometry>;
  evaluatingObjects: Set<string>;
  legacyCurvePassthroughObjects: Set<string>;
  frame: number;
  fps: number;
} = { objects: [], collections: [], images: [], fonts: {}, evaluatedObjects: new Map(), evaluatingObjects: new Set(), legacyCurvePassthroughObjects: new Set(), frame: 0, fps: 24 };

export function reg(types: string | string[], handler: Handler): void {
  for (const t of Array.isArray(types) ? types : [types]) REGISTRY.set(t, handler);
}

export function recordApproximation(type: string): void {
  APPROXIMATIONS.set(type, (APPROXIMATIONS.get(type) ?? 0) + 1);
}
