import * as THREE from "three";
import type { TriSoup } from "./gnvm";

export type CornerUvBinding = {
  sourceAttribute: string;
  geometry: THREE.BufferGeometry;
};

/**
 * Bind Blender's active CORNER-domain UV map to Three's `uv` vertex input.
 *
 * An indexed vertex can own different UVs on adjacent face corners, so the
 * render geometry is expanded while the GN-VM mesh/topology stays untouched.
 */
export function expandCornerDomainUv(
  geometry: THREE.BufferGeometry,
  soup: TriSoup,
  preferredName = "UVMap",
): CornerUvBinding | null {
  const entries = Object.entries(soup.attributes);
  const selected = entries.find(([name, attribute]) =>
    name === preferredName && attribute.domain === "CORNER" && attribute.domainData)
    ?? entries.find(([name, attribute]) =>
      /uv/i.test(name) && attribute.domain === "CORNER" && attribute.domainData);
  const triangleCorners = soup.triangleCorners;
  if (!geometry.index || !triangleCorners || !selected) return null;

  const [sourceAttribute, attribute] = selected;
  const source = attribute.domainData!;
  const cornerCount = soup.indices.length;
  const uv = new Float32Array(cornerCount * 2);
  for (let corner = 0; corner < cornerCount; corner++) {
    const sourceCorner = triangleCorners[corner] ?? 0;
    uv[corner * 2] = source[sourceCorner * attribute.itemSize] ?? 0;
    uv[corner * 2 + 1] = source[sourceCorner * attribute.itemSize + 1] ?? 0;
  }

  const expanded = geometry.toNonIndexed();
  expanded.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return { sourceAttribute, geometry: expanded };
}
