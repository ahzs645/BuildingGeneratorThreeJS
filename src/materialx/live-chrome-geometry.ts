import * as THREE from "three";
import type { MaterialXGeometryContract } from "./essl-adapter";
import { prepareLiveMaterialXGeometry } from "./live-geometry";

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
  return prepareLiveMaterialXGeometry(
    geometry,
    [{ name: "rough", type: "float", domain: "vertex" }],
  );
}
