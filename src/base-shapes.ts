import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { evaluateLibraryShape, type LibraryShapeInfo } from "./base-shape-catalog";
import type { InlineMeshSeed } from "./gnvm/index";
import {
  bufferGeometryFromTriSoup,
  inlineMeshSeedFromObject,
  inlineMeshSeedFromTriSoup,
} from "./inline-mesh-conversion";

/**
 * One place every plain-`three` tool can source a base shape from: the ported
 * reference library (evaluated live through the GN-VM), or any local mesh
 * file. Each shape arrives in both forms a tool needs — a THREE object for
 * the viewport and raycasting, and a serializable inline-mesh seed for graph
 * inputs. The catalog/evaluation half lives in base-shape-catalog.ts (THREE-
 * free) so the WebGPU painter can share it despite its separate THREE build.
 */

export { evaluateLibraryShape, listLibraryShapes, type LibraryShapeInfo } from "./base-shape-catalog";

export type BaseShape = {
  label: string;
  /** Display/raycast form; a fresh unmaterialed mesh for library shapes, the loaded scene for files. */
  object: THREE.Object3D;
  /** The same triangles as a worker-safe graph seed. */
  seed: InlineMeshSeed;
};

export const SHAPE_FILE_ACCEPT = ".glb,.gltf,.obj,.stl,.ply,.fbx";

export async function loadLibraryBaseShape(info: LibraryShapeInfo): Promise<BaseShape> {
  const soup = await evaluateLibraryShape(info);
  const mesh = new THREE.Mesh(bufferGeometryFromTriSoup(soup));
  mesh.name = info.title;
  return {
    label: info.title,
    object: mesh,
    seed: inlineMeshSeedFromTriSoup(soup, info.title, `library:${info.id}`),
  };
}

/** GLB/GLTF/OBJ/STL/PLY/FBX file → viewport object + graph seed. */
export async function loadFileBaseShape(file: File): Promise<BaseShape> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const url = URL.createObjectURL(file);
  try {
    let loaded: THREE.Object3D;
    if (ext === "glb" || ext === "gltf") loaded = (await new GLTFLoader().loadAsync(url)).scene;
    else if (ext === "obj") loaded = new OBJLoader().parse(await file.text());
    else if (ext === "stl") loaded = new THREE.Mesh(new STLLoader().parse(await file.arrayBuffer()));
    else if (ext === "ply") loaded = new THREE.Mesh(await new PLYLoader().loadAsync(url));
    else if (ext === "fbx") loaded = await new FBXLoader().loadAsync(url);
    else throw new Error("Choose a GLB, GLTF, OBJ, STL, PLY, or FBX file.");
    const fingerprint = `file:${file.name}:${file.size}:${file.lastModified}`;
    return {
      label: file.name,
      object: loaded,
      seed: inlineMeshSeedFromObject(loaded, file.name, fingerprint),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Uniformly rescale and recenter a shape so its largest extent is `extent`,
 * optionally resting it on z=0 (Blender-style ground). Returns the applied scale.
 */
export function fitBaseShape(object: THREE.Object3D, extent: number, ground = false): number {
  object.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return 1;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = extent / Math.max(size.x, size.y, size.z, 1e-6);
  object.scale.multiplyScalar(scale);
  object.position.sub(center.multiplyScalar(scale));
  // After recentering, the shape spans symmetrically around the origin;
  // lift it so its lowest point rests on z = 0 when grounding is requested.
  if (ground) object.position.z += size.z * scale / 2;
  object.updateWorldMatrix(true, true);
  return scale;
}
