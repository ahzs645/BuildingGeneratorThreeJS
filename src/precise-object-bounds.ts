import * as THREE from "three";

export type ObjectBoundsMode = "all" | "mesh" | "surface";

/**
 * Expand a world-space box from transformed buffer vertices rather than from
 * transformed local AABB corners. The latter can substantially over-frame a
 * rotated mesh. `mesh` excludes loose line/point children while retaining
 * unreferenced mesh vertices, matching Blender's evaluated-mesh bounds.
 * `surface` additionally visits only indices referenced by mesh faces.
 *
 * The legacy boolean argument remains supported: true means `surface`, while
 * false means `all`.
 */
export function preciseObjectBounds(
  root: THREE.Object3D,
  requestedMode: ObjectBoundsMode | boolean = "all",
  target = new THREE.Box3(),
): THREE.Box3 {
  const mode: ObjectBoundsMode = requestedMode === true
    ? "surface"
    : requestedMode === false
      ? "all"
      : requestedMode;
  target.makeEmpty();
  root.updateWorldMatrix(true, true);
  const point = new THREE.Vector3();
  root.traverse((child) => {
    if (mode !== "all" && !(child instanceof THREE.Mesh)) return;
    const geometry = (child as THREE.Mesh | THREE.LineSegments | THREE.Points).geometry;
    if (!(geometry instanceof THREE.BufferGeometry)) return;
    const position = geometry.getAttribute("position");
    if (!position) return;
    const index = mode === "surface" ? geometry.getIndex() : null;
    const count = index?.count ?? position.count;
    for (let offset = 0; offset < count; offset++) {
      point.fromBufferAttribute(position, index ? index.getX(offset) : offset);
      target.expandByPoint(point.applyMatrix4(child.matrixWorld));
    }
  });
  return target;
}
