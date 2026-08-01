import * as THREE from "three";

type CameraTarget = { target: THREE.Vector3; update(): void };

/** Fit an object without choosing a page-specific camera angle. */
export function fitPerspectiveCameraToObject(
  camera: THREE.PerspectiveCamera,
  controls: CameraTarget,
  object: THREE.Object3D,
  fallbackDirection = new THREE.Vector3(0, -1.35, .75),
  padding = 1.15,
): boolean {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return false;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const direction = camera.position.clone().sub(controls.target);
  if (direction.lengthSq() < 1e-6) direction.copy(fallbackDirection);
  direction.normalize();
  const halfFov = THREE.MathUtils.degToRad(camera.fov * .5);
  const distance = Math.max(sphere.radius * padding / Math.sin(halfFov), 1);
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  camera.near = Math.max(distance / 500, .001);
  camera.far = Math.max(distance * 100, 100);
  camera.updateProjectionMatrix();
  controls.target.copy(sphere.center);
  controls.update();
  return true;
}
