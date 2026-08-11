import * as THREE from "three";

type CameraTarget = { target: THREE.Vector3; update(): void };

/**
 * The distance at which a sphere of `radius` fits the frustum on BOTH axes.
 *
 * A perspective camera's `fov` is the *vertical* angle. In a portrait viewport
 * the horizontal half-angle is the narrower of the two, so solving on `fov`
 * alone frames the object correctly top-to-bottom and crops it left-to-right —
 * which is exactly what every phone-width viewport in the studio was doing.
 * Every framing routine in the app goes through this so the fix lands once.
 */
export function fitDistanceForRadius(
  camera: THREE.PerspectiveCamera,
  radius: number,
  padding = 1,
): number {
  const halfFovY = THREE.MathUtils.degToRad(camera.fov * .5);
  // A camera whose aspect has not been set yet reports NaN/0; treat it as
  // square so the fit is never wider than the eventual viewport.
  const aspect = Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : 1;
  const halfFovX = Math.atan(Math.tan(halfFovY) * aspect);
  return radius * padding / Math.sin(Math.min(halfFovY, halfFovX));
}

/**
 * A gate for "the viewport changed shape enough to be worth re-framing".
 *
 * Docks collapsing into the mobile sheet, a phone rotating, or the node editor
 * opening all change the aspect by a large step; a drag-resize changes it by a
 * pixel at a time. Re-framing on every resize fights the user's own orbiting,
 * so only steps past `threshold` (18% by default — the value the Recursive Bin
 * arrived at) count. The first call always passes, to establish the baseline.
 */
export function createAspectGate(threshold = .18): (aspect: number) => boolean {
  let last = 0;
  return (aspect: number): boolean => {
    if (!Number.isFinite(aspect) || aspect <= 0) return false;
    if (last <= 0) { last = aspect; return true; }
    if (Math.abs(aspect - last) / Math.max(last, .01) <= threshold) return false;
    last = aspect;
    return true;
  };
}

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
  const distance = Math.max(fitDistanceForRadius(camera, sphere.radius, padding), 1);
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  camera.near = Math.max(distance / 500, .001);
  camera.far = Math.max(distance * 100, 100);
  camera.updateProjectionMatrix();
  controls.target.copy(sphere.center);
  controls.update();
  return true;
}
