import * as THREE from "three";
import type { MaterialXGeometryContract } from "./essl-adapter";

export type LiveGeometryProperty = MaterialXGeometryContract["geometryProperties"][number];

/** Add a stable tangent when an extracted material needs Tworld but the mesh has no UV tangent. */
export function ensureMaterialXTangents(geometry: THREE.BufferGeometry): void {
  if (geometry.getAttribute("tangent")) return;
  const normals = geometry.getAttribute("normal");
  if (!normals || normals.itemSize !== 3) {
    throw new Error("MaterialX live geometry requires vertex normals");
  }
  const tangentData = new Float32Array(normals.count * 3);
  const normal = new THREE.Vector3();
  const reference = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  for (let index = 0; index < normals.count; index += 1) {
    normal.fromBufferAttribute(normals, index).normalize();
    reference.set(Math.abs(normal.x) < 0.9 ? 1 : 0, Math.abs(normal.x) < 0.9 ? 0 : 1, 0);
    tangent.crossVectors(reference, normal).normalize();
    tangent.toArray(tangentData, index * 3);
  }
  geometry.setAttribute("tangent", new THREE.BufferAttribute(tangentData, 3));
}

/** Build the common bounds/property contract consumed by generated MaterialX ESSL. */
export function prepareLiveMaterialXGeometry(
  geometry: THREE.BufferGeometry,
  geometryProperties: LiveGeometryProperty[] = [],
): MaterialXGeometryContract {
  const positions = geometry.getAttribute("position");
  if (!positions || positions.itemSize !== 3) {
    throw new Error("MaterialX live geometry requires vertex positions");
  }
  ensureMaterialXTangents(geometry);
  geometry.computeBoundingBox();
  if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) {
    throw new Error("MaterialX live geometry cannot bind empty bounds");
  }
  for (const property of geometryProperties) {
    const attribute = geometry.getAttribute(property.name);
    if (!attribute || attribute.count !== positions.count) {
      throw new Error(`MaterialX live geometry requires one ${property.name} value per GPU vertex`);
    }
  }
  return {
    bounds: {
      space: "object",
      min: geometry.boundingBox.min.toArray(),
      max: geometry.boundingBox.max.toArray(),
    },
    geometryProperties,
  };
}
