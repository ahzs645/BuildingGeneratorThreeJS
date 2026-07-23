import * as THREE from "three";

/**
 * Expand a world-space box from transformed buffer vertices rather than from
 * transformed local AABB corners. The latter can substantially over-frame a
 * rotated mesh. `surfaceOnly` excludes loose line/point children and visits
 * only indices referenced by mesh faces.
 */
export function preciseObjectBounds(
  root: THREE.Object3D,
  surfaceOnly = false,
  target = new THREE.Box3(),
): THREE.Box3 {
  target.makeEmpty();
  root.updateWorldMatrix(true, true);
  const point = new THREE.Vector3();
  root.traverse((child) => {
    if (surfaceOnly && !(child instanceof THREE.Mesh)) return;
    const geometry = (child as THREE.Mesh | THREE.LineSegments | THREE.Points).geometry;
    if (!(geometry instanceof THREE.BufferGeometry)) return;
    const position = geometry.getAttribute("position");
    if (!position) return;
    const index = surfaceOnly ? geometry.getIndex() : null;
    const count = index?.count ?? position.count;
    for (let offset = 0; offset < count; offset++) {
      point.fromBufferAttribute(position, index ? index.getX(offset) : offset);
      target.expandByPoint(point.applyMatrix4(child.matrixWorld));
    }
  });
  return target;
}
