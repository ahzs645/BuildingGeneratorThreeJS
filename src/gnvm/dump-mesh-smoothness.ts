import type { DumpMesh } from "./dump-schema";
import type { Mesh } from "./geometry";

/**
 * Seed Blender's inverse face-smooth convention on imported mesh geometry.
 * Geometry Nodes exposes polygon smoothness as the built-in `sharp_face`
 * attribute, where true means flat and false means smooth.
 */
export function applyDumpFaceSmoothness(mesh: Mesh, source: DumpMesh): void {
  if (source.face_smooth === undefined) return;
  if (source.face_smooth.length !== mesh.faces.length) {
    throw new RangeError(
      `face_smooth length ${source.face_smooth.length} does not match ${mesh.faces.length} faces`,
    );
  }
  mesh.attributes.set("sharp_face", {
    domain: "FACE",
    data: source.face_smooth.map((smooth) => smooth ? 0 : 1),
  });
}
