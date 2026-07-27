// Cross-evaluation memoization for the GN-VM evaluator.
//
// A re-evaluation of the same dump with slightly different overrides used to
// re-run every node from scratch. This module gives the evaluator a
// persistent, per-dump node-output cache so only nodes actually reached by
// the changed bindings re-run.
//
// Soundness model
// ---------------
// A node's outputs are a pure function of
//   (program identity, group, scope, bindings restricted to the group inputs
//    that can reach the node)
// provided that
//   * no probe/trace hook is active (probes observe live evaluation),
//   * the node is not "impure": it neither reads mutable global context
//     (DUMP_CONTEXT-derived values such as Object Info, Scene Time, Self
//     Object) nor records per-run diagnostics (MISSING / APPROXIMATIONS /
//     runtime details) — and no such node can reach it through links,
//   * the node is not a member of a repeat/foreach/closure zone (zone members
//     read per-iteration state that is not part of the bindings). The zone
//     OUTPUT node is exempt — its result is the converged loop state, a
//     deterministic function of the bindings — unless it is also inside some
//     other zone.
//
// Reachability of group inputs is computed per group as a fixpoint over the
// link graph (including the repeat/foreach state feedback edge), treating a
// nested GeometryNodeGroup call as an opaque node whose outputs depend on the
// union of its socket inputs. This over-approximates — extra identifiers in a
// key only cost cache hits, never correctness.
//
// Binding fingerprints: constants (const Fields, strings, matrices, data
// refs, structurally empty geometry) fingerprint by value. Everything else
// fingerprints by object identity. Identity matches across runs exactly when
// the object came out of this cache (the cache retains it), so hits cascade
// down the graph from unaffected roots. Root geometry bindings built
// deterministically from the dump are tagged with an explicit fingerprint by
// the run entry points (see tagGeometryFingerprint).
//
// The cache never observes probe runs (the evaluator bypasses it entirely
// while any probe or trace hook is active).

import { Elem, Field } from "./core";
import { Geometry } from "./geometry";
import { MatrixValue } from "./matrix";
import { ClosureValue, EmptyClosureValue, REGISTRY, SockVal } from "./registry";
import type { RawNode } from "./registry";

// Minimal structural views of evaluator types (import type would create an
// import cycle at the type level only, but keeping these local also keeps the
// contract explicit).
interface GroupLink {
  from_node: string;
  from_socket: string;
  to_node: string;
  to_socket: string;
  muted?: boolean;
}
interface GroupLike {
  name: string;
  nodes: RawNode[];
  links: GroupLink[];
}
type ProgramLike = Record<string, GroupLike | undefined>;

// ---- danger lists ----------------------------------------------------------

// Node types whose handlers read mutable global context or emit per-run
// diagnostics. They must execute on every evaluation, and nothing downstream
// of them may be served from the cache (a downstream hit would skip them).
const IMPURE_TYPES = new Set<string>([
  // DUMP_CONTEXT readers (active object, evaluated objects, scene time...).
  "GeometryNodeObjectInfo",
  "GeometryNodeCollectionInfo",
  "GeometryNodeSelfObject",
  "GeometryNodeInputSceneTime",
  "GeometryNodeInputActiveCamera",
  "GeometryNodeIsViewport",
  // Reads persisted bake snapshots + records approximations.
  "GeometryNodeBake",
  // Emits authored runtime warnings.
  "GeometryNodeWarning",
  // recordApproximation callers — coverage counts must reflect execution.
  "GeometryNodeUVUnwrap",
  "GeometryNodeUVPackIslands",
  "GeometryNodeSetMeshNormal",
  "GeometryNodeVolumeCube",
  "GeometryNodeMeshToSDFGrid",
  "GeometryNodePointsToSDFGrid",
  "GeometryNodeGridToMesh",
  "GeometryNodeVolumeToMesh",
]);

// Types the evaluator dispatches itself (no REGISTRY handler required).
const BUILTIN_TYPES = new Set<string>([
  "NodeReroute",
  "NodeFrame",
  "NodeGroupInput",
  "NodeGroupOutput",
  "GeometryNodeGroup",
  "GeometryNodeRepeatInput",
  "GeometryNodeRepeatOutput",
  "GeometryNodeForeachGeometryElementInput",
  "GeometryNodeForeachGeometryElementOutput",
  "NodeClosureInput",
  "NodeClosureOutput",
]);

// Zone input node types; their paired outputs are named by `paired_output`.
const ZONE_INPUT_TYPES = new Set<string>([
  "GeometryNodeRepeatInput",
  "GeometryNodeForeachGeometryElementInput",
  "GeometryNodeSimulationInput",
  "NodeClosureInput",
]);

// Node types that are never worth caching (trivial passthroughs / binding
// sources) even when sound.
const SKIP_TYPES = new Set<string>([
  "NodeReroute",
  "NodeFrame",
  "NodeGroupInput",
  "NodeGroupOutput",
]);

// ---- static per-group analysis ---------------------------------------------

interface NodeAnalysis {
  /** Sorted group-input identifiers that can reach this node. */
  deps: string[];
  cacheable: boolean;
}

interface GroupAnalysis {
  nodes: Map<string, NodeAnalysis>;
}

function forwardClosure(
  starts: Iterable<string>,
  outgoing: Map<string, string[]>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const s of starts) if (!seen.has(s)) { seen.add(s); queue.push(s); }
  while (queue.length) {
    const cur = queue.pop()!;
    for (const next of outgoing.get(cur) ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

/**
 * Nodes that can actually execute: every pull in the evaluator follows links,
 * and the only evaluation roots are the Group Output node's inputs (zone and
 * closure bodies are reached through links too). Dangling sinks — notably
 * GeometryNodeViewer, which has no handler — are never pulled, so they must
 * not poison the group as impure.
 */
function executableNodes(group: GroupLike): Set<string> {
  const incomingSources = new Map<string, string[]>();
  for (const link of group.links) {
    if (link.muted) continue;
    (incomingSources.get(link.to_node) ?? incomingSources.set(link.to_node, []).get(link.to_node)!).push(link.from_node);
  }
  const roots = group.nodes.filter((node) => node.type === "NodeGroupOutput").map((node) => node.name);
  return forwardClosure(roots, incomingSources); // "forward" over reversed edges = backward closure
}

function isImpureNode(
  node: RawNode,
  program: ProgramLike,
  impureGroups: Map<string, boolean>,
  visiting: Set<string>,
): boolean {
  if (node.type === "GeometryNodeGroup") {
    if (!node.group) return true;
    if (node.props?.gnvm_coordinate_context) return true; // reads active object
    return isImpureGroup(node.group, program, impureGroups, visiting);
  }
  if (IMPURE_TYPES.has(node.type)) return true;
  // Unregistered types record MISSING counts on execution — must run live.
  if (!BUILTIN_TYPES.has(node.type) && !REGISTRY.has(node.type)) return true;
  return false;
}

/** A group is impure when any node in its transitive closure is impure. */
function isImpureGroup(
  name: string,
  program: ProgramLike,
  impureGroups: Map<string, boolean>,
  visiting: Set<string> = new Set(),
): boolean {
  const known = impureGroups.get(name);
  if (known !== undefined) return known;
  // Recursive group references are invalid in Blender; treat a cycle as
  // impure without memoizing the in-progress groups.
  if (visiting.has(name)) return true;
  visiting.add(name);
  const group = program[name];
  let impure = !group;
  if (group) {
    const executable = executableNodes(group);
    for (const node of group.nodes) {
      if (!executable.has(node.name)) continue; // dangling sinks never run
      if (isImpureNode(node, program, impureGroups, visiting)) { impure = true; break; }
    }
  }
  visiting.delete(name);
  impureGroups.set(name, impure);
  return impure;
}

function analyzeGroup(group: GroupLike, program: ProgramLike, impureGroups: Map<string, boolean>): GroupAnalysis {
  const byName = new Map<string, RawNode>();
  for (const node of group.nodes) byName.set(node.name, node);
  const links = group.links.filter((link) => !link.muted && byName.has(link.from_node) && byName.has(link.to_node));

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, GroupLink[]>();
  for (const link of links) {
    (outgoing.get(link.from_node) ?? outgoing.set(link.from_node, []).get(link.from_node)!).push(link.to_node);
    (incoming.get(link.to_node) ?? incoming.set(link.to_node, []).get(link.to_node)!).push(link);
  }

  // Zone pairs: input node carries paired_output. Fall back to "only zone of
  // that type in the group" like the evaluator does.
  const zoneInputs = group.nodes.filter((node) => ZONE_INPUT_TYPES.has(node.type));
  const pairedOutputOf = new Map<string, string>(); // input name -> output name
  for (const input of zoneInputs) {
    const paired = (input as { paired_output?: string }).paired_output;
    if (paired && byName.has(paired)) pairedOutputOf.set(input.name, paired);
  }

  // Per-zone forward closures (zone membership).
  const zoneForward = new Map<string, Set<string>>();
  for (const input of zoneInputs) zoneForward.set(input.name, forwardClosure([input.name], outgoing));

  // Impure taint: impure nodes poison themselves and everything downstream.
  // Feedback: an impure node inside a zone taints the whole zone body via the
  // output -> input state edge (add it to the closure graph).
  const taintGraph = new Map<string, string[]>(outgoing);
  for (const [inputName, outputName] of pairedOutputOf) {
    const list = taintGraph.get(outputName)?.slice() ?? [];
    list.push(inputName);
    taintGraph.set(outputName, list);
  }
  const executable = executableNodes(group);
  const impureRoots = group.nodes
    .filter((node) => executable.has(node.name) && isImpureNode(node, program, impureGroups, new Set()))
    .map((node) => node.name);
  const tainted = forwardClosure(impureRoots, taintGraph);

  // Zone membership (uncacheable): any node forward-reachable from a zone
  // input. A paired zone OUTPUT is exempt when its only zone is its own —
  // its result is the converged loop state, deterministic in the bindings.
  const zoneMembers = new Set<string>();
  for (const set of zoneForward.values()) for (const name of set) zoneMembers.add(name);
  for (const input of zoneInputs) zoneMembers.add(input.name);
  const exemptOutputs = new Set<string>();
  for (const [inputName, outputName] of pairedOutputOf) {
    let onlyOwnZone = true;
    for (const [otherInput, set] of zoneForward) {
      if (otherInput !== inputName && set.has(outputName)) { onlyOwnZone = false; break; }
    }
    if (onlyOwnZone) exemptOutputs.add(outputName);
  }

  // Group-input reachability fixpoint. Contribution of a link:
  //   from NodeGroupInput   -> { from_socket }
  //   from NodeClosureInput -> {} (dynamic closure parameters, not captured
  //                            environment; closure bodies are uncacheable)
  //   otherwise             -> deps(from_node)
  // plus the zone state feedback edge (input inherits output's deps).
  const deps = new Map<string, Set<string>>();
  for (const node of group.nodes) deps.set(node.name, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of group.nodes) {
      const mine = deps.get(node.name)!;
      const before = mine.size;
      for (const link of incoming.get(node.name) ?? []) {
        const source = byName.get(link.from_node)!;
        if (source.type === "NodeGroupInput") mine.add(link.from_socket);
        else if (source.type === "NodeClosureInput") continue;
        else for (const id of deps.get(link.from_node)!) mine.add(id);
      }
      if (mine.size !== before) changed = true;
    }
    for (const [inputName, outputName] of pairedOutputOf) {
      const mine = deps.get(inputName)!;
      const before = mine.size;
      for (const id of deps.get(outputName)!) mine.add(id);
      if (mine.size !== before) changed = true;
    }
  }

  const nodes = new Map<string, NodeAnalysis>();
  for (const node of group.nodes) {
    const uncacheableZoneMember = zoneMembers.has(node.name) && !exemptOutputs.has(node.name);
    const cacheable = !tainted.has(node.name)
      && !uncacheableZoneMember
      && !SKIP_TYPES.has(node.type)
      && !ZONE_INPUT_TYPES.has(node.type);
    nodes.set(node.name, {
      deps: [...deps.get(node.name)!].sort(),
      cacheable,
    });
  }
  return { nodes };
}

// ---- fingerprints -----------------------------------------------------------

/**
 * Explicit value fingerprint for a deterministically constructed Geometry
 * (dump base meshes, primitive seeds). Attach right before binding — clones
 * do not inherit the tag, so any later mutation path loses it naturally.
 */
const GEOMETRY_FINGERPRINT = Symbol.for("gnvm.geometryFingerprint");

export function tagGeometryFingerprint<T extends Geometry>(geometry: T, tag: string): T {
  Object.defineProperty(geometry, GEOMETRY_FINGERPRINT, {
    value: tag,
    enumerable: false,
    configurable: true,
  });
  return geometry;
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
function idOf(value: object): number {
  let id = objectIds.get(value);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(value, id);
  }
  return id;
}

const numberFp = (value: number): string => (Object.is(value, -0) ? "-0" : String(value));

/** Value fingerprint of a const-field element; null when not representable. */
function elemFp(value: Elem): string | null {
  if (typeof value === "number") return numberFp(value);
  if (Array.isArray(value)) {
    let extra = "";
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      // Rotation values may carry a hidden native quaternion; two rotations
      // with equal Euler displays but different quaternions are NOT equal.
      const payload = (value as unknown as Record<symbol, unknown>)[symbol];
      if (Array.isArray(payload) && payload.every((entry) => typeof entry === "number")) {
        extra += `|${String(symbol.description)}:${payload.map(numberFp).join(",")}`;
      } else {
        return null; // unknown hidden payload — refuse a value fingerprint
      }
    }
    if (value.some((entry) => typeof entry !== "number")) return null;
    return `[${value.map(numberFp).join(",")}]${extra}`;
  }
  return null;
}

function isStructurallyEmptyGeometry(geometry: Geometry): boolean {
  if (geometry.curves.length || geometry.instances.length || geometry.curveAttributes.size) return false;
  const mesh = geometry.mesh;
  if (!mesh) return true;
  return !mesh.positions.length && !mesh.edges.length && !mesh.faces.length
    && !mesh.attributes.size && !mesh.materialSlots.length && !mesh.faceMaterial.length;
}

// ---- the cache --------------------------------------------------------------

interface CacheEntry {
  outs: Record<string, SockVal>;
  weight: number;
}

function geometryWeight(geometry: Geometry): number {
  let weight = 1
    + (geometry.mesh ? geometry.mesh.positions.length + geometry.mesh.faces.length : 0)
    + geometry.curvePointCount();
  for (const instance of geometry.instances) weight += 4 + geometryWeight(instance.geometry);
  return weight;
}

function outsWeight(outs: Record<string, SockVal>): number {
  let weight = 1;
  for (const key in outs) {
    const value = outs[key];
    if (value instanceof Geometry) weight += geometryWeight(value);
  }
  return weight;
}

const MAX_ENTRIES = 2048;
const MAX_WEIGHT = 8_000_000;

export class DumpEvaluationCache {
  private entries = new Map<string, CacheEntry>(); // insertion order = LRU order
  private totalWeight = 0;
  private analyses = new WeakMap<object, GroupAnalysis>();
  private impureGroups = new Map<string, boolean>();
  /**
   * Objects that came out of this cache. Their identity is stable across
   * runs for as long as the entry lives, so keys built from them can match
   * cross-run. Fresh per-run objects get "volatile" tokens instead and such
   * keys are not persisted (they could never match a later run and would
   * only churn the LRU).
   */
  private stableObjects = new WeakSet<object>();

  /**
   * Build the cache key for a node, or null when the node must not be cached.
   * `volatile` output flags keys containing identities of objects that did
   * not come from this cache (store-skip; lookups can still never match).
   */
  keyFor(
    program: ProgramLike,
    group: GroupLike,
    scope: string,
    node: RawNode,
    bindings: Record<string, SockVal>,
  ): { key: string; volatile: boolean } | null {
    let analysis = this.analyses.get(group);
    if (!analysis) {
      analysis = analyzeGroup(group, program, this.impureGroups);
      this.analyses.set(group, analysis);
    }
    const nodeAnalysis = analysis.nodes.get(node.name);
    if (!nodeAnalysis?.cacheable) return null;
    let volatile = false;
    let fp = "";
    for (const identifier of nodeAnalysis.deps) {
      const part = this.fingerprintValue(bindings[identifier]);
      if (part === null) return null;
      if (part.volatile) volatile = true;
      fp += `${identifier}=${part.fp}`;
    }
    return { key: `${scope}\u0000${node.name}\u0000${fp}`, volatile };
  }

  private fingerprintValue(value: SockVal): { fp: string; volatile: boolean } | null {
    if (value === undefined) return { fp: "u", volatile: false };
    if (value === null) return { fp: "n", volatile: false };
    if (typeof value === "string") return { fp: `s${JSON.stringify(value)}`, volatile: false };
    if (value instanceof Field) {
      if (value.isConst) {
        const elem = elemFp(value.value);
        if (elem !== null) {
          return { fp: `f${elem}|${value.srcDomain ?? ""}|${value.srcDomainValueType ?? ""}`, volatile: false };
        }
      }
      return this.objectFp(value);
    }
    if (value instanceof Geometry) {
      const tag = (value as unknown as Record<symbol, unknown>)[GEOMETRY_FINGERPRINT];
      if (typeof tag === "string") return { fp: `gt${tag}`, volatile: false };
      if (isStructurallyEmptyGeometry(value)) return { fp: "ge", volatile: false };
      return this.objectFp(value);
    }
    if (value instanceof MatrixValue) return { fp: `m${JSON.stringify(value.rows)}`, volatile: false };
    if (value instanceof EmptyClosureValue) return { fp: "ec", volatile: false };
    if (value instanceof ClosureValue) return this.objectFp(value);
    if (typeof value === "object") {
      // VolumeGrid and friends: identity. Plain data refs: by referenced name.
      const record = value as { kind?: string; name?: unknown; datablock?: unknown };
      if (record.kind === undefined && typeof record.name === "string") {
        return { fp: `r${JSON.stringify(record.datablock ?? "")}:${JSON.stringify(record.name)}`, volatile: false };
      }
      return this.objectFp(value as object);
    }
    // Unknown scalar (number/boolean should not appear as raw SockVal, but be safe).
    if (typeof value === "number" || typeof value === "boolean") {
      return { fp: `p${String(value)}`, volatile: false };
    }
    return null;
  }

  private objectFp(value: object): { fp: string; volatile: boolean } {
    return { fp: `o${idOf(value)}`, volatile: !this.stableObjects.has(value) };
  }

  get(key: string): Record<string, SockVal> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Refresh recency.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.markStable(entry.outs);
    return entry.outs;
  }

  set(key: string, outs: Record<string, SockVal>): void {
    const weight = outsWeight(outs);
    if (weight > MAX_WEIGHT / 4) return; // never let one entry dominate the budget
    const existing = this.entries.get(key);
    if (existing) {
      this.totalWeight -= existing.weight;
      this.entries.delete(key);
    }
    this.entries.set(key, { outs, weight });
    this.totalWeight += weight;
    this.markStable(outs);
    while (this.entries.size > MAX_ENTRIES || this.totalWeight > MAX_WEIGHT) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value)!;
      this.entries.delete(oldest.value);
      this.totalWeight -= evicted.weight;
    }
  }

  private markStable(outs: Record<string, SockVal>): void {
    for (const key in outs) {
      const value = outs[key];
      if (value && typeof value === "object") this.stableObjects.add(value);
    }
  }
}

const caches = new WeakMap<object, DumpEvaluationCache>();

/** The persistent cache for one program (dump.node_groups) identity. */
export function evaluationCacheFor(program: object): DumpEvaluationCache {
  let cache = caches.get(program);
  if (!cache) {
    cache = new DumpEvaluationCache();
    caches.set(program, cache);
  }
  return cache;
}
