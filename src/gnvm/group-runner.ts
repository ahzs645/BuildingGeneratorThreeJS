import { ensureBulletHull } from "./bullet-hull";
import { ensureManifold } from "./boolean";
import type { Vec3 } from "./core";
import { baseGeometryOf } from "./dump-object-geometry";
import type { Dump, DumpInterfaceItem } from "./dump-schema";
import { Evaluator } from "./evaluator";
import { Geometry, toTriSoup } from "./geometry";
import { meshCube, meshGrid, meshLine } from "./primitives";
import { DUMP_CONTEXT, MISSING, REGISTRY } from "./registry";
import type { RunResult } from "./run-result";

// Keep this module usable as a direct entry point, not only through index.ts.
import "./nodes/math";
import "./nodes/inputs";
import "./nodes/geometry";
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

export type PrimitiveGeometrySeed =
  | {
    kind: "cube";
    /** Full XYZ dimensions. Defaults to Blender's 1 m cube. */
    size?: number | Vec3;
    /** Surface vertex counts along XYZ. Defaults to 2/2/2. */
    vertices?: Vec3;
  }
  | {
    kind: "grid";
    /** XY dimensions. Defaults to 1 x 1. */
    size?: [number, number];
    /** XY vertex counts. Defaults to 2 x 2. */
    vertices?: [number, number];
  }
  | {
    kind: "plane";
    /** XY dimensions. Defaults to 1 x 1. */
    size?: [number, number];
    /** XY vertex counts. Defaults to 2 x 2. */
    vertices?: [number, number];
  }
  | {
    kind: "line";
    count?: number;
    start?: Vec3;
    offset?: Vec3;
  }
  | {
    kind: "curve-circle";
    radius?: number;
    points?: number;
  }
  | {
    kind: "curve-line";
    start?: Vec3;
    end?: Vec3;
  };

export type GroupGeometrySeed =
  | Geometry
  | PrimitiveGeometrySeed
  | { kind: "object"; objectName: string }
  | { kind: "object"; object: string };

export interface RunNodeGroupOptions {
  /** Asset-only GeometryNodeTree to execute. */
  group: string;
  /** Interface values keyed by stable identifier or friendly socket name. */
  inputs?: Record<string, unknown>;
  /** Worker/API-friendly alias for inputs. */
  overrides?: Record<string, unknown>;
  /** Geometry supplied to one group-interface Geometry input. */
  geometry?: GroupGeometrySeed;
  /** Serializable worker/API-friendly alias for geometry. */
  seed?: Exclude<GroupGeometrySeed, Geometry>;
  /**
   * Target Geometry input identifier or friendly name. Required only when the
   * group exposes more than one Geometry input.
   */
  geometryInput?: string;
  /**
   * Geometry output identifier or friendly name. The first Geometry output is
   * used when omitted.
   */
  output?: string;
  /**
   * Object whose transform establishes Relative Object/Collection Info space.
   * An object seed selects that same object automatically.
   */
  activeObject?: string;
  frame?: number;
}

function interfaceSockets(
  items: DumpInterfaceItem[],
  direction: "INPUT" | "OUTPUT",
  socketType?: string,
): DumpInterfaceItem[] {
  return items.filter((item) =>
    item.item_type === "SOCKET"
      && item.in_out === direction
      && (!socketType || item.socket_type === socketType)
      && typeof item.identifier === "string",
  );
}

function selectSocket(
  sockets: DumpInterfaceItem[],
  requested: string | undefined,
  label: string,
): DumpInterfaceItem | undefined {
  if (!requested) {
    if (sockets.length > 1 && label === "Geometry input")
      throw new Error(`group has multiple Geometry inputs; choose one with geometryInput (${sockets.map((socket) => socket.name).join(", ")})`);
    return sockets[0];
  }
  const matches = sockets.filter((socket) => socket.identifier === requested || socket.name === requested);
  if (!matches.length) throw new Error(`${label} not found: ${requested}`);
  if (matches.length > 1 && !matches.some((socket) => socket.identifier === requested))
    throw new Error(`${label} name is ambiguous; use its interface identifier: ${requested}`);
  return matches.find((socket) => socket.identifier === requested) ?? matches[0];
}

export function createPrimitiveGeometry(seed: PrimitiveGeometrySeed): Geometry {
  if (seed.kind === "cube") {
    const scalarOrVector = seed.size ?? 1;
    const size = typeof scalarOrVector === "number"
      ? [scalarOrVector, scalarOrVector, scalarOrVector] as Vec3
      : scalarOrVector;
    const vertices = seed.vertices ?? [2, 2, 2];
    return meshCube(size, vertices[0], vertices[1], vertices[2]);
  }
  if (seed.kind === "grid" || seed.kind === "plane") {
    const size = seed.size ?? [1, 1];
    const vertices = seed.vertices ?? [2, 2];
    return meshGrid(size[0], size[1], vertices[0], vertices[1]);
  }
  if (seed.kind === "line")
    return meshLine(seed.count ?? 2, seed.start ?? [0, 0, 0], seed.offset ?? [1, 0, 0]);
  const geometry = new Geometry();
  if (seed.kind === "curve-circle") {
    const count = Math.max(3, Math.floor(seed.points ?? 32));
    const radius = seed.radius ?? 1;
    geometry.curves.push({
      cyclic: true,
      splineType: "POLY",
      resolution: 1,
      points: Array.from({ length: count }, (_, index) => {
        const angle = index / count * Math.PI * 2;
        return [Math.cos(angle) * radius, Math.sin(angle) * radius, 0] as Vec3;
      }),
    });
    return geometry;
  }
  geometry.curves.push({
    cyclic: false,
    splineType: "POLY",
    resolution: 1,
    points: [seed.start ?? [-1, 0, 0], seed.end ?? [1, 0, 0]].map((point) => [...point] as Vec3),
  });
  return geometry;
}

function resolveGeometrySeed(dump: Dump, seed: GroupGeometrySeed): { geometry: Geometry; objectName?: string } {
  if (seed instanceof Geometry) return { geometry: seed.clone() };
  if (seed.kind === "object") {
    const objectName = "objectName" in seed ? seed.objectName : seed.object;
    if (!dump.objects?.some((object) => object.name === objectName))
      throw new Error(`geometry seed object not found: ${objectName}`);
    const geometry = baseGeometryOf(dump, objectName);
    if (!geometry) throw new Error(`geometry seed object has no mesh or curve data: ${objectName}`);
    return { geometry, objectName };
  }
  return { geometry: createPrimitiveGeometry(seed) };
}

function prepareDumpContext(dump: Dump, activeObjectName: string | undefined, frame: number | undefined): void {
  DUMP_CONTEXT.objects = dump.objects ?? [];
  DUMP_CONTEXT.collections = dump.collections ?? [];
  DUMP_CONTEXT.images = dump.images ?? [];
  DUMP_CONTEXT.fonts = dump.fonts ?? {};
  DUMP_CONTEXT.activeObject = activeObjectName
    ? DUMP_CONTEXT.objects.find((object) => object.name === activeObjectName)
    : undefined;
  DUMP_CONTEXT.evaluatedObjects.clear();
  DUMP_CONTEXT.evaluatingObjects.clear();
  DUMP_CONTEXT.legacyCurvePassthroughObjects.clear();
  DUMP_CONTEXT.frame = Number(frame ?? dump.scene?.frame_current ?? 0);
  DUMP_CONTEXT.fps = Number(dump.scene?.fps ?? 24) / Math.max(Number(dump.scene?.fps_base ?? 1), 1e-9);
}

/**
 * Execute an extracted GeometryNodeTree without inventing a modifier object.
 *
 * This is the asset-library counterpart to runGenerator(): it binds interface
 * defaults/overrides, optionally supplies seed geometry, and returns the same
 * renderer-ready geometry/soup/coverage contract.
 */
export async function runNodeGroup(dump: Dump, options: RunNodeGroupOptions): Promise<RunResult> {
  const group = dump.node_groups[options.group];
  if (!group) throw new Error(`group not found: ${options.group}`);
  if (group.type !== "GeometryNodeTree") throw new Error(`group is not a GeometryNodeTree: ${options.group}`);

  const geometryInputs = interfaceSockets(group.interface, "INPUT", "NodeSocketGeometry");
  const geometryOutputs = interfaceSockets(group.interface, "OUTPUT", "NodeSocketGeometry");
  if (!geometryOutputs.length) throw new Error(`group has no Geometry output: ${options.group}`);

  if (options.geometry && options.seed) throw new Error("choose either geometry or seed, not both");
  const bindings: Record<string, unknown> = { ...(options.overrides ?? {}), ...(options.inputs ?? {}) };
  let seedObjectName: string | undefined;
  const geometrySeed = options.geometry ?? options.seed;
  if (geometrySeed) {
    const inputSocket = selectSocket(geometryInputs, options.geometryInput, "Geometry input");
    if (!inputSocket?.identifier) throw new Error(`group has no Geometry input: ${options.group}`);
    const resolved = resolveGeometrySeed(dump, geometrySeed);
    bindings[inputSocket.identifier] = resolved.geometry;
    seedObjectName = resolved.objectName;
  } else if (options.geometryInput) {
    throw new Error("geometryInput requires a geometry seed");
  }

  const outputSocket = selectSocket(geometryOutputs, options.output, "Geometry output");
  if (!outputSocket?.identifier) throw new Error(`group has no selectable Geometry output: ${options.group}`);

  await Promise.all([ensureManifold(), ensureBulletHull()]);
  MISSING.clear();
  prepareDumpContext(dump, options.activeObject ?? seedObjectName, options.frame);
  try {
    const result = new Evaluator(dump.node_groups).evalModifierGroup(options.group, bindings);
    const selected = result.outputs[outputSocket.identifier];
    if (!(selected instanceof Geometry))
      throw new Error(`selected group output is not geometry: ${outputSocket.name}`);
    const geometry = selected;
    return {
      geometry,
      soup: toTriSoup(geometry),
      coverage: {
        handled: REGISTRY.size,
        missingTypes: [...MISSING.entries()]
          .map(([type, count]) => ({ type, count }))
          .sort((left, right) => right.count - left.count),
      },
    };
  } finally {
    DUMP_CONTEXT.evaluatingObjects.clear();
  }
}
