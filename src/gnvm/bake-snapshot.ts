import { Field, type Elem, type Vec3 } from "./core";
import type {
  BakeSnapshotAttribute,
  BakeSnapshotGeometrySet,
  BakeSnapshotMesh,
  DataRef,
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

/** Restore one portable evaluated Bake item, preserving null as a valid value. */
export function bakeSnapshotValue(
  node: RawNode,
  identifier: string,
): BakeSnapshotResult | null {
  const snapshot = node.bake_snapshot;
  if (!snapshot) return null;
  if (snapshot.schema_version === 1) {
    const item = snapshot.items[identifier];
    if (!item) return null;
    return { value: geometryFromBakeSnapshot(item.geometry) };
  }
  const item = snapshot.items[identifier];
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
