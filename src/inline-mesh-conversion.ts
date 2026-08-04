import * as THREE from "three";
import type { InlineMeshSeed, TriSoup } from "./gnvm/index";

/**
 * Viewer-side bridge from renderer geometry into the GN-VM seed contract.
 *
 * The GN-VM is deliberately THREE-free, so these converters live outside
 * src/gnvm: they flatten THREE objects (imported GLB/OBJ/STL scenes) or an
 * evaluated TriSoup into the serializable inline-mesh seed that crosses the
 * evaluation-worker boundary.
 */

/** An evaluated asset's soup re-enters another graph unchanged. */
export function inlineMeshSeedFromTriSoup(soup: TriSoup, name?: string, fingerprint?: string): InlineMeshSeed {
  if (!soup.indices.length) throw new Error("evaluated result has no mesh surface to reuse");
  return { kind: "inline-mesh", positions: soup.positions, indices: soup.indices, name, fingerprint };
}

/**
 * Flatten every mesh under `root` into one triangle list with world transforms
 * baked, so the seed matches what the viewer displays regardless of scene
 * nesting or instancing scale.
 */
export function inlineMeshSeedFromObject(root: THREE.Object3D, name?: string, fingerprint?: string): InlineMeshSeed {
  root.updateWorldMatrix(true, true);
  const positions: number[] = [];
  const indices: number[] = [];
  const vertex = new THREE.Vector3();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const position = child.geometry?.getAttribute?.("position");
    if (!position) return;
    const base = positions.length / 3;
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(child.matrixWorld);
      positions.push(vertex.x, vertex.y, vertex.z);
    }
    const index = child.geometry.getIndex();
    const triangleVertexCount = index ? index.count : position.count;
    for (let i = 0; i + 2 < triangleVertexCount; i += 3) {
      indices.push(
        base + (index ? index.getX(i) : i),
        base + (index ? index.getX(i + 1) : i + 1),
        base + (index ? index.getX(i + 2) : i + 2),
      );
    }
  });
  if (!indices.length) throw new Error("object contains no triangle meshes");
  return {
    kind: "inline-mesh",
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    name,
    fingerprint,
  };
}

/** Minimal renderer-side view of a soup; materials are the caller's concern. */
export function bufferGeometryFromTriSoup(soup: TriSoup): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(soup.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(soup.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
  return geometry;
}
