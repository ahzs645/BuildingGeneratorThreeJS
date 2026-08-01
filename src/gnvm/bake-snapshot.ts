import { Field, type Elem, type Vec3 } from "./core";
import type {
  BakeSnapshot,
  BakeSnapshotAttribute,
  BakeSnapshotGeometrySet,
  BakeSnapshotMesh,
  DataRef,
  DumpModifier,
  DumpModifierBakeState,
  RawNode,
} from "./dump-schema";
import { Geometry, Mesh } from "./geometry";
import type { SockVal, VolumeGrid } from "./registry";

function vec3(value: Vec3): Vec3 {
  return [...value] as Vec3;
}

function attributeData(attribute: BakeSnapshotAttribute): Elem[] {
  return attribute.data.map((value) =>
    Array.isArray(value)
      ? [Number(value[0] ?? 0), Number(value[1] ?? 0), Number(value[2] ?? 0)]
      : Number(value ?? 0)) as Elem[];
}

function meshFromBakeSnapshot(snapshot: BakeSnapshotMesh): Mesh {
  const mesh = new Mesh();
  mesh.positions = snapshot.positions.map(vec3);
  mesh.edges = snapshot.edges.map((edge) => [...edge] as [number, number]);
  mesh.faces = snapshot.faces.map((face) => [...face]);
  mesh.faceMaterial = [...(snapshot.face_material ?? [])];
  mesh.materialSlots = [...(snapshot.material_slots ?? [])];
  for (const [name, attribute] of Object.entries(snapshot.attributes ?? {})) {
    mesh.attributes.set(name, {
      domain: attribute.domain,
      data: attributeData(attribute),
    });
  }
  return mesh;
}

export function geometryFromBakeSnapshot(
  snapshot: BakeSnapshotMesh | BakeSnapshotGeometrySet,
  depth = 0,
): Geometry {
  const geometry = new Geometry();
  if ("positions" in snapshot) {
    geometry.mesh = meshFromBakeSnapshot(snapshot);
    return geometry;
  }
  if (snapshot.mesh) geometry.mesh = meshFromBakeSnapshot(snapshot.mesh);
  geometry.curves = (snapshot.curves ?? []).map((spline) => ({
    points: spline.points.map(vec3),
    cyclic: spline.cyclic,
    splineType: spline.spline_type,
    resolution: spline.resolution,
    controlPoints: spline.control_points?.map(vec3),
    bezierLeft: spline.bezier_left?.map(vec3),
    bezierRight: spline.bezier_right?.map(vec3),
  }));
  for (const [name, attribute] of Object.entries(snapshot.curve_attributes ?? {})) {
    geometry.curveAttributes.set(name, {
      domain: attribute.domain,
      data: attributeData(attribute),
    });
  }
  // Guard malformed or cyclic hand-authored JSON while retaining practical
  // nested instance hierarchies from Blender.
  if (depth < 32) {
    geometry.instances = (snapshot.instances ?? []).map((instance) => ({
      geometry: geometryFromBakeSnapshot(instance.geometry, depth + 1),
      position: vec3(instance.position),
      rotation: vec3(instance.rotation),
      scale: vec3(instance.scale),
      transformMatrix: instance.transform_matrix?.map((row) => [...row]),
      attributes: instance.attributes
        ? new Map(Object.entries(instance.attributes).flatMap(([name, value]) => {
          if (typeof value === "number") return [[name, value] as [string, Elem]];
          if (Array.isArray(value) && value.length >= 3)
            return [[name, [Number(value[0]), Number(value[1]), Number(value[2])] as Vec3]];
          return [];
        }))
        : undefined,
    }));
  }
  return geometry;
}

function literalValue(socketType: string, value: unknown): SockVal {
  if (socketType === "NodeSocketString") return String(value ?? "");
  if (["NodeSocketObject", "NodeSocketCollection", "NodeSocketImage", "NodeSocketMaterial"].includes(socketType)) {
    if (value && typeof value === "object" && typeof (value as DataRef).name === "string")
      return { ...(value as DataRef) };
    return null;
  }
  if (socketType === "NodeSocketBool") return Field.of(value ? 1 : 0);
  if (Array.isArray(value))
    return Field.of([Number(value[0] ?? 0), Number(value[1] ?? 0), Number(value[2] ?? 0)]);
  if (typeof value === "number") return Field.of(value);
  return null;
}

export type BakeSnapshotResult = { value: SockVal };

/** Runtime-facing alias for modifier-instance Bake metadata. */
export type BakeInstanceState = DumpModifierBakeState;

function isBakeInstanceState(value: unknown): value is BakeInstanceState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<BakeInstanceState>;
  return Number.isInteger(state.bake_id)
    && Number(state.bake_id) >= 0
    && typeof state.node_group === "string"
    && typeof state.node === "string"
    && ["unbaked", "packed", "disk-backed", "unknown"].includes(state.status ?? "");
}

/** Safely read newer Bake metadata while retaining older dump compatibility. */
export function bakeStatesOfModifier(
  modifier: DumpModifier | undefined,
): BakeInstanceState[] {
  if (!modifier || !Array.isArray(modifier.bake_states)) return [];
  return modifier.bake_states.filter(isBakeInstanceState);
}

/**
 * Resolve the state owned by the active modifier for this concrete node.
 * Blender node names are unique inside a node group; bake_id disambiguates
 * malformed/forward-compatible payloads that contain duplicate entries.
 */
export function findBakeInstanceState(
  states: readonly BakeInstanceState[],
  groupName: string | undefined,
  node: RawNode,
): BakeInstanceState | undefined {
  if (!groupName) return undefined;
  let matches = states.filter((state) =>
    isBakeInstanceState(state)
    && state.node_group === groupName
    && state.node === node.name);
  const nodeBakeId = Number(node.bake_id);
  if (Number.isFinite(nodeBakeId))
    matches = matches.filter((state) => state.bake_id === nodeBakeId);
  return matches.length === 1 ? matches[0] : undefined;
}

const BAKE_ATTRIBUTE_DOMAINS = new Set([
  "POINT", "EDGE", "FACE", "CORNER", "CURVE", "INSTANCE",
]);

function finiteVector(value: unknown, length = 3): boolean {
  return Array.isArray(value)
    && value.length === length
    && value.every((component) => Number.isFinite(component));
}

function portableAttribute(
  value: unknown,
  expectedLengths: ReadonlyMap<string, number>,
): boolean {
  if (!value || typeof value !== "object") return false;
  const attribute = value as Partial<BakeSnapshotAttribute>;
  if (!BAKE_ATTRIBUTE_DOMAINS.has(attribute.domain ?? "")
    || !Array.isArray(attribute.data)) return false;
  const expectedLength = expectedLengths.get(attribute.domain!);
  return expectedLength !== undefined
    && attribute.data.length === expectedLength
    && attribute.data.every((item) =>
      Number.isFinite(item) || finiteVector(item));
}

function portableAttributes(
  value: unknown,
  expectedLengths: ReadonlyMap<string, number>,
): boolean {
  return value === undefined
    || Boolean(value && typeof value === "object" && !Array.isArray(value)
      && Object.values(value).every((attribute) =>
        portableAttribute(attribute, expectedLengths)));
}

function portableMesh(value: unknown): value is BakeSnapshotMesh {
  if (!value || typeof value !== "object") return false;
  const mesh = value as Partial<BakeSnapshotMesh>;
  if (!Array.isArray(mesh.positions)
    || !mesh.positions.every((position) => finiteVector(position))
    || !Array.isArray(mesh.edges)
    || !Array.isArray(mesh.faces)) return false;
  const vertexCount = mesh.positions.length;
  const indexIsValid = (index: unknown) =>
    Number.isInteger(index) && Number(index) >= 0 && Number(index) < vertexCount;
  if (!mesh.edges.every((edge) =>
    Array.isArray(edge) && edge.length === 2 && edge.every(indexIsValid))) return false;
  if (!mesh.faces.every((face) =>
    Array.isArray(face) && face.length >= 3 && face.every(indexIsValid))) return false;
  if (mesh.face_material !== undefined
    && (!Array.isArray(mesh.face_material)
      || mesh.face_material.length !== mesh.faces.length
      || !mesh.face_material.every((index) => Number.isInteger(index) && index >= 0))) return false;
  if (mesh.material_slots !== undefined
    && (!Array.isArray(mesh.material_slots)
      || !mesh.material_slots.every((name) => name === null || typeof name === "string"))) return false;
  return portableAttributes(mesh.attributes, new Map([
    ["POINT", vertexCount],
    ["EDGE", mesh.edges.length],
    ["FACE", mesh.faces.length],
    ["CORNER", mesh.faces.reduce((count, face) => count + face.length, 0)],
  ]));
}

function portableGeometrySet(value: unknown, depth = 0): value is BakeSnapshotGeometrySet {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 32)
    return false;
  const geometry = value as Partial<BakeSnapshotGeometrySet>;
  if (geometry.mesh !== undefined && !portableMesh(geometry.mesh)) return false;
  if (geometry.curves !== undefined && !Array.isArray(geometry.curves)) return false;
  const curves = geometry.curves ?? [];
  if (!curves.every((spline) =>
    Boolean(spline && typeof spline === "object"
      && Array.isArray(spline.points)
      && spline.points.every((point) => finiteVector(point))
      && typeof spline.cyclic === "boolean"
      && (spline.resolution === undefined
        || (Number.isInteger(spline.resolution) && spline.resolution >= 0))
      && [spline.control_points, spline.bezier_left, spline.bezier_right]
        .every((points) => points === undefined
          || (Array.isArray(points) && points.every((point) => finiteVector(point))))))) return false;
  if (!portableAttributes(geometry.curve_attributes, new Map([
    ["POINT", curves.reduce((count, spline) => count + spline.points.length, 0)],
    ["CURVE", curves.length],
  ]))) return false;
  if (geometry.instances !== undefined && !Array.isArray(geometry.instances)) return false;
  return (geometry.instances ?? []).every((instance) =>
    Boolean(instance && typeof instance === "object"
      && portableGeometrySet(instance.geometry, depth + 1)
      && finiteVector(instance.position)
      && finiteVector(instance.rotation)
      && finiteVector(instance.scale)
      && (instance.transform_matrix === undefined
        || (Array.isArray(instance.transform_matrix)
          && instance.transform_matrix.length === 4
          && instance.transform_matrix.every((row) => finiteVector(row, 4))))
      && (instance.attributes === undefined
        || (instance.attributes && typeof instance.attributes === "object"
          && !Array.isArray(instance.attributes)
          && Object.values(instance.attributes).every((item) =>
            Number.isFinite(item) || finiteVector(item))))));
}

function snapshotItemIsPortable(
  snapshot: BakeSnapshot | undefined,
  identifier: string,
  socketType: string,
): boolean {
  if (!snapshot
    || snapshot.source !== "blender-evaluated"
    || !Number.isFinite(snapshot.frame)
    || !snapshot.items
    || typeof snapshot.items !== "object"
    || Array.isArray(snapshot.items)) return false;
  if (snapshot.schema_version === 1) {
    const item = snapshot.items[identifier];
    return Boolean(item
      && socketType === "NodeSocketGeometry"
      && item.socket_type === socketType
      && item.component_contract === "realized-mesh"
      && portableMesh(item.geometry));
  }
  if (snapshot.schema_version !== 2) return false;
  const item = snapshot.items[identifier];
  if (!item || item.socket_type !== socketType) return false;
  if (item.value_contract === "geometry-set")
    return socketType === "NodeSocketGeometry" && portableGeometrySet(item.geometry);
  if (item.value_contract === "volume-grid") {
    if (socketType !== "NodeSocketVolume") return false;
    const volume = item.volume_grid;
    if (!volume || typeof volume !== "object"
      || !finiteVector(volume.min)
      || !finiteVector(volume.max)
      || !finiteVector(volume.origin)
      || !finiteVector(volume.voxel_size)
      || !finiteVector(volume.resolution)
      || !volume.resolution.every((component) => Number.isInteger(component) && component >= 0)
      || ![volume.background, volume.requested_voxel_size,
        volume.requested_sample_count, volume.sample_budget].every(Number.isFinite)
      || typeof volume.budget_adjusted !== "boolean"
      || !Array.isArray(volume.values)) return false;
    const [x, y, z] = volume.resolution;
    const expected = x * y * z;
    return Number.isSafeInteger(expected)
      && item.volume_grid.values.length === expected
      && item.volume_grid.values.every(Number.isFinite);
  }
  if (item.value_contract !== "literal") return false;
  const value = item.value;
  if (socketType === "NodeSocketString") return typeof value === "string";
  if (["NodeSocketObject", "NodeSocketCollection", "NodeSocketImage", "NodeSocketMaterial"].includes(socketType))
    return value === null
      || Boolean(value && typeof value === "object" && typeof (value as DataRef).name === "string");
  if (socketType === "NodeSocketBool")
    return typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
  // GN-VM's field contract is RGB/vec3. Do not silently accept Blender RGBA
  // here: dropping a cache output's alpha could change downstream node math.
  if (["NodeSocketVector", "NodeSocketRotation", "NodeSocketColor"].includes(socketType))
    return finiteVector(value);
  if (socketType === "NodeSocketInt")
    return Number.isInteger(value);
  if (socketType === "NodeSocketFloat")
    return typeof value === "number" && Number.isFinite(value);
  return false;
}

/** True when every concrete Bake output has a portable evaluated value. */
export function hasCompleteBakeSnapshot(
  node: RawNode,
  snapshot?: BakeSnapshot,
): boolean {
  const source = arguments.length >= 2 ? snapshot : node.bake_snapshot;
  if (!source) return false;
  const outputs = node.outputs
    .filter((output) => output.identifier && output.identifier !== "__extend__");
  return outputs.length > 0
    && outputs.every((output) =>
      snapshotItemIsPortable(source, output.identifier!, output.type ?? ""));
}

/** Return all modifier-owned snapshots without duplicating the legacy slot. */
export function bakeSnapshotsOfState(
  state: BakeInstanceState | undefined,
): BakeSnapshot[] {
  if (!state) return [];
  const snapshots = Array.isArray(state.snapshots)
    ? state.snapshots.filter((snapshot): snapshot is BakeSnapshot =>
      Boolean(snapshot && typeof snapshot === "object"))
    : [];
  if (snapshots.length === 0 && state.snapshot) snapshots.push(state.snapshot);
  return snapshots;
}

/** Select only the cache value Blender owns at this scene frame. */
export function bakeSnapshotAtFrame(
  state: BakeInstanceState | undefined,
  frame: number,
): BakeSnapshot | undefined {
  const snapshots = bakeSnapshotsOfState(state);
  if (snapshots.length === 0) return undefined;
  // A still Bake is frozen at its cached frame and reused at every scene
  // frame. Legacy single snapshots predate bake_mode and follow that behavior.
  if (state?.bake_mode === "STILL" || (state?.bake_mode === undefined && snapshots.length === 1))
    return snapshots.length === 1 ? snapshots[0] : undefined;
  if (state?.bake_mode === "ANIMATION" && (
    !Number.isInteger(frame)
    || (Number.isInteger(state.frame_start) && frame < state.frame_start!)
    || (Number.isInteger(state.frame_end) && frame > state.frame_end!)
  )) return undefined;
  const matches = snapshots.filter((snapshot) => snapshot.frame === frame);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Static exactness requires every frame in an animation cache. */
export function hasCompleteBakeStateSnapshotCoverage(
  node: RawNode,
  state: BakeInstanceState | undefined,
): boolean {
  if (!state) return false;
  const snapshots = bakeSnapshotsOfState(state);
  if (state.bake_mode === "STILL" || (state.bake_mode === undefined && snapshots.length === 1))
    return snapshots.length === 1 && hasCompleteBakeSnapshot(node, snapshots[0]);
  if (state.bake_mode !== "ANIMATION"
    || !Number.isInteger(state.frame_start)
    || !Number.isInteger(state.frame_end)
    || state.frame_end! < state.frame_start!) return false;
  const requiredCount = state.frame_end! - state.frame_start! + 1;
  if (!Number.isSafeInteger(requiredCount) || requiredCount > 100_000) return false;
  const byFrame = new Map<number, BakeSnapshot>();
  for (const snapshot of snapshots) {
    if (!Number.isInteger(snapshot.frame)
      || snapshot.frame < state.frame_start!
      || snapshot.frame > state.frame_end!
      || byFrame.has(snapshot.frame)
      || !hasCompleteBakeSnapshot(node, snapshot)) return false;
    byFrame.set(snapshot.frame, snapshot);
  }
  return byFrame.size === requiredCount;
}

/** Restore one portable evaluated Bake item, preserving null as a valid value. */
export function bakeSnapshotValue(
  node: RawNode,
  identifier: string,
  snapshot?: BakeSnapshot,
): BakeSnapshotResult | null {
  const source = arguments.length >= 3 ? snapshot : node.bake_snapshot;
  if (!source) return null;
  if (source.schema_version === 1) {
    const item = source.items[identifier];
    if (!item) return null;
    return { value: geometryFromBakeSnapshot(item.geometry) };
  }
  const item = source.items[identifier];
  if (!item) return null;
  if (item.value_contract === "geometry-set")
    return { value: geometryFromBakeSnapshot(item.geometry) };
  if (item.value_contract === "volume-grid") {
    const source = item.volume_grid;
    const expected = Math.max(0,
      Math.trunc(source.resolution[0])
      * Math.trunc(source.resolution[1])
      * Math.trunc(source.resolution[2]));
    if (source.values.length !== expected) return null;
    const grid: VolumeGrid = {
      kind: "GNVM_VOLUME_GRID",
      background: source.background,
      min: vec3(source.min),
      max: vec3(source.max),
      resolution: vec3(source.resolution),
      origin: vec3(source.origin),
      voxelSize: vec3(source.voxel_size),
      values: Float32Array.from(source.values),
      requestedVoxelSize: source.requested_voxel_size,
      requestedSampleCount: source.requested_sample_count,
      budgetAdjusted: source.budget_adjusted,
      sampleBudget: source.sample_budget,
    };
    return { value: grid };
  }
  return { value: literalValue(item.socket_type, item.value) };
}

/** Backwards-compatible convenience for callers that only accept geometry. */
export function bakeSnapshotGeometry(
  node: RawNode,
  identifier: string,
): Geometry | null {
  const result = bakeSnapshotValue(node, identifier);
  return result?.value instanceof Geometry ? result.value : null;
}
