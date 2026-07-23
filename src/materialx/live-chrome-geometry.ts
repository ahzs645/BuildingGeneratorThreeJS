import * as THREE from "three";
import type { MaterialXGeometryContract } from "./essl-adapter";

function addFallbackTangents(geometry: THREE.BufferGeometry): void {
  if (geometry.getAttribute("tangent")) return;
  const normals = geometry.getAttribute("normal");
  if (!normals || normals.itemSize !== 3) {
    throw new Error("Native chrome.003 requires vertex normals");
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

/** Validate and describe the exact GN-VM geometry contract consumed by chrome.003. */
export function prepareLiveChromeCrayonGeometry(
  geometry: THREE.BufferGeometry,
): MaterialXGeometryContract {
  const positions = geometry.getAttribute("position");
  const rough = geometry.getAttribute("rough");
  if (!positions || positions.itemSize !== 3) {
    throw new Error("Native chrome.003 requires vertex positions");
  }
  if (!rough || rough.itemSize !== 1 || rough.count !== positions.count) {
    throw new Error("Native chrome.003 requires one rough value per GPU vertex");
  }
  for (let index = 0; index < rough.count; index += 1) {
    if (rough.getX(index) !== 0) {
      throw new Error(`Native chrome.003 exact geometry contract expects rough=0; found ${rough.getX(index)}`);
    }
  }
  addFallbackTangents(geometry);
  geometry.computeBoundingBox();
  if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) {
    throw new Error("Native chrome.003 cannot bind empty geometry bounds");
  }
  return {
    bounds: {
      space: "object",
      min: geometry.boundingBox.min.toArray(),
      max: geometry.boundingBox.max.toArray(),
    },
    geometryProperties: [{ name: "rough", type: "float", domain: "vertex" }],
  };
}
