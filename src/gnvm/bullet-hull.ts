import { Vec3 } from "./core";
import { Mesh } from "./geometry";
// @ts-expect-error Generated Emscripten module; its narrow API is declared below.
import createBulletHullModule from "./vendor/blender-bullet-hull.js";

interface BulletHullModule {
  HEAPF32: Float32Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _hull_compute(pointer: number, count: number): number;
  _hull_num_vertices(): number;
  _hull_vertex_original_index(vertex: number): number;
  _hull_num_faces(): number;
  _hull_face_size(face: number): number;
  _hull_face_vertex(face: number, corner: number): number;
}

let module: BulletHullModule | null = null;
let initPromise: Promise<void> | null = null;

/** Load Blender's double-precision Bullet hull backend. Safe to call repeatedly. */
export function ensureBulletHull(): Promise<void> {
  if (module) return Promise.resolve();
  if (!initPromise) {
    initPromise = createBulletHullModule().then((loaded: BulletHullModule) => {
      module = loaded;
    });
  }
  return initPromise!;
}

export function isBulletHullReady(): boolean {
  return module !== null;
}

/**
 * Match Blender's Geometry Nodes Convex Hull backend.
 *
 * Blender calls `btConvexHullComputer` with float coordinates while compiling
 * Bullet with `BT_USE_DOUBLE_PRECISION`. The precision mode changes which
 * nearly-coplanar source points survive, so generic QuickHull/Manifold output
 * is observably different on dense procedural meshes.
 */
export function blenderBulletHull(points: readonly Vec3[]): Mesh | null {
  if (!module || points.length < 1) return null;
  const flat = new Float32Array(points.length * 3);
  for (let index = 0; index < points.length; index++) {
    flat[index * 3] = points[index][0];
    flat[index * 3 + 1] = points[index][1];
    flat[index * 3 + 2] = points[index][2];
  }
  const pointer = module._malloc(flat.byteLength);
  try {
    // ALLOW_MEMORY_GROWTH can replace the heap view during malloc.
    module.HEAPF32.set(flat, pointer >>> 2);
    module._hull_compute(pointer, points.length);
    const out = new Mesh();
    out.materialSlots = [null];
    for (let vertex = 0; vertex < module._hull_num_vertices(); vertex++) {
      const source = points[module._hull_vertex_original_index(vertex)];
      if (!source) return null;
      out.positions.push([...source] as Vec3);
    }
    for (let face = 0; face < module._hull_num_faces(); face++) {
      const size = module._hull_face_size(face);
      const polygon = Array.from({ length: size }, (_, corner) =>
        module!._hull_face_vertex(face, corner));
      if (polygon.length >= 3) {
        out.faces.push(polygon);
        out.faceMaterial.push(0);
      }
    }
    return out;
  } finally {
    module._free(pointer);
  }
}
