import * as THREE from "three";

export const PICK_TARGET_SURFACE = "__pick__";
export const ALL_TARGET_SURFACES = "__all__";

export type TargetSurface = {
  id: string;
  label: string;
  mesh: THREE.Mesh;
};

function objectPath(object: THREE.Object3D, root: THREE.Object3D): string {
  const names: string[] = [];
  let cursor: THREE.Object3D | null = object;
  while (cursor && cursor !== root) {
    if (cursor.name.trim()) names.unshift(cursor.name.trim());
    cursor = cursor.parent;
  }
  return names.join(" / ");
}

/**
 * Builds the stable surface inventory used by the picker. Import formats may
 * nest meshes differently, so target identity is based on Three's object UUID
 * while labels preserve the useful part of the source hierarchy.
 */
export function collectTargetSurfaces(root: THREE.Object3D): TargetSurface[] {
  const surfaces: TargetSurface[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const position = object.geometry?.getAttribute("position");
    if (!position?.count) return;
    surfaces.push({
      id: object.uuid,
      label: objectPath(object, root) || `Mesh ${surfaces.length + 1}`,
      mesh: object,
    });
  });

  const labelCounts = new Map<string, number>();
  return surfaces.map((surface) => {
    const count = (labelCounts.get(surface.label) ?? 0) + 1;
    labelCounts.set(surface.label, count);
    return count === 1 ? surface : { ...surface, label: `${surface.label} (${count})` };
  });
}

export function surfacesForTarget(
  surfaces: TargetSurface[],
  target: string,
): TargetSurface[] {
  if (target === PICK_TARGET_SURFACE || target === ALL_TARGET_SURFACES) return surfaces;
  const selected = surfaces.find((surface) => surface.id === target);
  return selected ? [selected] : surfaces;
}

export function targetLabel(surfaces: TargetSurface[], target: string): string {
  if (target === PICK_TARGET_SURFACE) return "Click an object to lock it";
  if (target === ALL_TARGET_SURFACES) return "All visible meshes";
  return surfaces.find((surface) => surface.id === target)?.label ?? "All visible meshes";
}
