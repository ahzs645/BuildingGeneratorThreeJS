import type { RawNode } from "./dump-schema";
import { Geometry, Mesh } from "./geometry";

type BakeSnapshot = NonNullable<RawNode["bake_snapshot"]>;
type GeometrySnapshot = BakeSnapshot["items"][string]["geometry"];

export function geometryFromBakeSnapshot(snapshot: GeometrySnapshot): Geometry {
  const geometry = new Geometry();
  const mesh = new Mesh();
  mesh.positions = snapshot.positions.map((position) => [...position]);
  mesh.edges = snapshot.edges.map((edge) => [...edge]);
  mesh.faces = snapshot.faces.map((face) => [...face]);
  mesh.faceMaterial = [...(snapshot.face_material ?? [])];
  mesh.materialSlots = [...(snapshot.material_slots ?? [])];
  for (const [name, attribute] of Object.entries(snapshot.attributes ?? {})) {
    mesh.attributes.set(name, {
      domain: attribute.domain,
      data: attribute.data.map((value) =>
        Array.isArray(value) ? [...value] : value),
    });
  }
  geometry.mesh = mesh;
  return geometry;
}

export function bakeSnapshotGeometry(
  node: RawNode,
  identifier: string,
): Geometry | null {
  const snapshot = node.bake_snapshot;
  if (snapshot?.schema_version !== 1) return null;
  const item = snapshot.items[identifier];
  if (!item || item.socket_type !== "NodeSocketGeometry") return null;
  return geometryFromBakeSnapshot(item.geometry);
}
