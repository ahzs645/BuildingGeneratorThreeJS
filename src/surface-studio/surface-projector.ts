import * as THREE from 'three/webgpu';
import type { MeshBVH } from 'three-mesh-bvh';
import {
  ALL_TARGET_SURFACES,
  PICK_TARGET_SURFACE,
  collectTargetSurfaces,
  surfacesForTarget,
  type TargetSurface,
} from '../surface-targets';
import {
  disposeRaycastIndex,
  firstHitOnly,
  indexForRaycasts,
} from '../geometry-painter/bvh';
import type {
  ProjectionTarget,
  SurfacePointId,
  SurfacePointRecord,
  SurfaceTargetId,
  Vec2,
} from './contracts';

/** A stored surface point materialized through its target's current transform. */
export interface MaterializedSurfacePoint {
  readonly id: SurfacePointId;
  readonly targetId: SurfaceTargetId;
  readonly worldPosition: THREE.Vector3;
  readonly worldNormal: THREE.Vector3;
  readonly targetPosition: THREE.Vector3;
  readonly targetNormal: THREE.Vector3;
  readonly areaPosition?: Vec2;
  readonly surfaceOffset: number;
}

/** A transient projection hit, before the document assigns it a point id. */
export interface SurfaceProjectionHit {
  readonly targetId: SurfaceTargetId;
  readonly target: THREE.Mesh;
  readonly worldPosition: THREE.Vector3;
  readonly worldNormal: THREE.Vector3;
  readonly targetPosition: THREE.Vector3;
  readonly targetNormal: THREE.Vector3;
  readonly surfaceOffset: number;
  readonly distance: number;
  readonly faceIndex: number | null;
}

type IndexedGeometry = THREE.BufferGeometry & { boundsTree?: MeshBVH };

/**
 * Renderer-independent surface projection and target-selection service.
 *
 * The projector borrows the registered scene graph; it never reparents,
 * materializes, or disposes source objects. BVHs that predate registration are
 * likewise borrowed. Only indexes created by this instance are released.
 */
export class SurfaceProjector {
  private root: THREE.Object3D | null = null;
  private targetSurfaces: TargetSurface[] = [];
  private targetSelection: ProjectionTarget = { kind: 'pick' };
  private readonly ownedIndexes = new Set<IndexedGeometry>();
  private readonly raycaster = firstHitOnly(new THREE.Raycaster());

  get targetRoot(): THREE.Object3D | null {
    return this.root;
  }

  get targets(): readonly TargetSurface[] {
    return this.targetSurfaces;
  }

  get projectionTarget(): ProjectionTarget {
    return this.targetSelection;
  }

  /** Register a borrowed root and index only geometries that need a BVH. */
  registerTargetRoot(
    root: THREE.Object3D,
    defaultTarget: ProjectionTarget = { kind: 'pick' },
  ): readonly TargetSurface[] {
    // The same wrapper root is commonly emptied and repopulated on model
    // import. Release indexes from its previous children before inventorying
    // the replacement; borrowed pre-existing indexes remain untouched.
    this.releaseOwnedIndexes();

    this.root = root;
    root.updateWorldMatrix(true, true);
    this.targetSurfaces = collectTargetSurfaces(root);

    const unindexed = new Map<IndexedGeometry, THREE.Mesh>();
    for (const { mesh } of this.targetSurfaces) {
      const geometry = mesh.geometry as IndexedGeometry;
      if (!geometry.boundsTree && !unindexed.has(geometry)) unindexed.set(geometry, mesh);
    }
    // Index only usable target meshes. The registered root may also contain
    // helper/empty meshes that are intentionally absent from the inventory.
    for (const [geometry, mesh] of unindexed) {
      indexForRaycasts(mesh);
      if (geometry.boundsTree) this.ownedIndexes.add(geometry);
    }

    this.targetSelection = this.isValidTarget(defaultTarget) ? defaultTarget : { kind: 'pick' };
    return this.targetSurfaces;
  }

  /** Refresh mesh inventory after callers mutate the borrowed root. */
  refreshTargets(): readonly TargetSurface[] {
    if (!this.root) {
      this.targetSurfaces = [];
      return this.targetSurfaces;
    }
    return this.registerTargetRoot(this.root, this.targetSelection);
  }

  selectTarget(target: ProjectionTarget): boolean {
    const valid = this.isValidTarget(target);
    if (valid) this.targetSelection = target;
    return valid;
  }

  selectedTargets(): readonly TargetSurface[] {
    return surfacesForTarget(this.targetSurfaces, legacyTargetId(this.targetSelection));
  }

  /** Raycast from normalized device coordinates through the selected targets. */
  raycastFromCamera(
    pointer: THREE.Vector2,
    camera: THREE.Camera,
    offset = 0,
  ): SurfaceProjectionHit | null {
    this.raycaster.setFromCamera(pointer, camera);
    return this.raycast(this.raycaster, offset);
  }

  /** Raycast an existing raycaster through the selected targets. */
  raycast(raycaster: THREE.Raycaster, offset = 0): SurfaceProjectionHit | null {
    const meshes = this.selectedTargets().map(({ mesh }) => mesh);
    if (!meshes.length) return null;
    const intersection = raycaster.intersectObjects(meshes, false)[0];
    if (!intersection?.face || !(intersection.object as THREE.Mesh).isMesh) return null;

    const target = intersection.object as THREE.Mesh;
    target.updateWorldMatrix(true, false);
    const worldNormal = intersection.face.normal.clone()
      .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(target.matrixWorld));
    return this.hitFromSurface(
      target,
      intersection.point,
      worldNormal,
      offset,
      intersection.distance,
      intersection.faceIndex ?? null,
    );
  }

  /** Find the selected surface point nearest a world-space query. */
  closestPoint(worldPoint: THREE.Vector3, offset = 0): SurfaceProjectionHit | null {
    let closest: SurfaceProjectionHit | null = null;
    for (const { mesh } of this.selectedTargets()) {
      const geometry = mesh.geometry as IndexedGeometry;
      if (!geometry.boundsTree) continue;
      mesh.updateWorldMatrix(true, false);
      const localQuery = mesh.worldToLocal(worldPoint.clone());
      const result = geometry.boundsTree.closestPointToPoint(localQuery);
      if (!result) continue;

      const localPosition = result.point.clone();
      const worldSurfacePoint = mesh.localToWorld(localPosition.clone());
      const distance = worldSurfacePoint.distanceTo(worldPoint);
      if (closest && distance >= closest.distance) continue;

      const localNormal = normalAt(geometry, localPosition, result.faceIndex ?? null);
      const worldNormal = localNormal.clone().applyNormalMatrix(
        new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld),
      );
      closest = this.hitFromSurface(
        mesh,
        worldSurfacePoint,
        worldNormal,
        offset,
        distance,
        result.faceIndex ?? null,
      );
    }
    return closest;
  }

  /** Store a world-space surface point in the renderer-independent document form. */
  store(
    id: SurfacePointId,
    targetId: SurfaceTargetId,
    worldSurfacePosition: THREE.Vector3,
    worldNormal: THREE.Vector3,
    surfaceOffset = 0,
    areaPosition?: Vec2,
  ): SurfacePointRecord | null {
    const target = this.surface(targetId)?.mesh;
    if (!target) return null;
    target.updateWorldMatrix(true, false);
    const targetPosition = target.worldToLocal(worldSurfacePosition.clone());
    // worldNormal = inverse-transpose(M) * localNormal, therefore the inverse
    // conversion is transpose(M) * worldNormal.
    const targetNormal = worldNormal.clone().applyMatrix3(
      new THREE.Matrix3().setFromMatrix4(target.matrixWorld).transpose(),
    ).normalize();
    return {
      id,
      targetId,
      targetPosition: targetPosition.toArray(),
      targetNormal: targetNormal.toArray(),
      ...(areaPosition ? { areaPosition: [...areaPosition] as Vec2 } : {}),
      surfaceOffset,
    };
  }

  /** Assign a stable document id to a transient raycast/closest-point hit. */
  storeHit(
    id: SurfacePointId,
    hit: SurfaceProjectionHit,
    areaPosition?: Vec2,
  ): SurfacePointRecord {
    return {
      id,
      targetId: hit.targetId,
      targetPosition: hit.targetPosition.toArray(),
      targetNormal: hit.targetNormal.toArray(),
      ...(areaPosition ? { areaPosition: [...areaPosition] as Vec2 } : {}),
      surfaceOffset: hit.surfaceOffset,
    };
  }

  /** Materialize a stored point through the target's current world transform. */
  materialize(point: SurfacePointRecord): MaterializedSurfacePoint | null {
    const target = this.surface(point.targetId)?.mesh;
    if (!target) return null;
    target.updateWorldMatrix(true, false);
    const targetPosition = new THREE.Vector3().fromArray(point.targetPosition);
    const targetNormal = new THREE.Vector3().fromArray(point.targetNormal).normalize();
    const worldNormal = targetNormal.clone().applyNormalMatrix(
      new THREE.Matrix3().getNormalMatrix(target.matrixWorld),
    );
    return {
      id: point.id,
      targetId: point.targetId,
      worldPosition: targetPosition.clone().applyMatrix4(target.matrixWorld)
        .addScaledVector(worldNormal, point.surfaceOffset),
      worldNormal,
      targetPosition,
      targetNormal,
      ...(point.areaPosition ? { areaPosition: [...point.areaPosition] as Vec2 } : {}),
      surfaceOffset: point.surfaceOffset,
    };
  }

  dispose(): void {
    this.releaseOwnedIndexes();
    this.root = null;
    this.targetSurfaces = [];
    this.targetSelection = { kind: 'pick' };
  }

  private surface(targetId: SurfaceTargetId): TargetSurface | undefined {
    return this.targetSurfaces.find(({ id }) => id === targetId);
  }

  private hitFromSurface(
    target: THREE.Mesh,
    worldSurfacePosition: THREE.Vector3,
    worldNormal: THREE.Vector3,
    surfaceOffset: number,
    distance: number,
    faceIndex: number | null,
  ): SurfaceProjectionHit {
    target.updateWorldMatrix(true, false);
    const targetPosition = target.worldToLocal(worldSurfacePosition.clone());
    const targetNormal = worldNormal.clone().applyMatrix3(
      new THREE.Matrix3().setFromMatrix4(target.matrixWorld).transpose(),
    ).normalize();
    return {
      targetId: target.uuid,
      target,
      worldPosition: worldSurfacePosition.clone().addScaledVector(worldNormal, surfaceOffset),
      worldNormal,
      targetPosition,
      targetNormal,
      surfaceOffset,
      distance,
      faceIndex,
    };
  }

  private isValidTarget(target: ProjectionTarget): boolean {
    return target.kind !== 'mesh'
      || this.targetSurfaces.some(({ id }) => id === target.targetId);
  }

  private releaseOwnedIndexes(): void {
    for (const geometry of this.ownedIndexes) disposeRaycastIndex(geometry);
    this.ownedIndexes.clear();
  }
}

function legacyTargetId(target: ProjectionTarget): string {
  if (target.kind === 'pick') return PICK_TARGET_SURFACE;
  if (target.kind === 'all') return ALL_TARGET_SURFACES;
  return target.targetId;
}

function normalAt(
  geometry: THREE.BufferGeometry,
  point: THREE.Vector3,
  faceIndex: number | null,
): THREE.Vector3 {
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  if (faceIndex === null || !positions) return new THREE.Vector3(0, 1, 0);

  const index = geometry.index;
  const offset = faceIndex * 3;
  const ai = index ? index.getX(offset) : offset;
  const bi = index ? index.getX(offset + 1) : offset + 1;
  const ci = index ? index.getX(offset + 2) : offset + 2;
  const triangle = new THREE.Triangle(
    new THREE.Vector3().fromBufferAttribute(positions, ai),
    new THREE.Vector3().fromBufferAttribute(positions, bi),
    new THREE.Vector3().fromBufferAttribute(positions, ci),
  );
  const normals = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (!normals) return triangle.getNormal(new THREE.Vector3());

  const barycentric = triangle.getBarycoord(point, new THREE.Vector3());
  if (!barycentric) return triangle.getNormal(new THREE.Vector3());
  return new THREE.Vector3().fromBufferAttribute(normals, ai).multiplyScalar(barycentric.x)
    .addScaledVector(new THREE.Vector3().fromBufferAttribute(normals, bi), barycentric.y)
    .addScaledVector(new THREE.Vector3().fromBufferAttribute(normals, ci), barycentric.z)
    .normalize();
}
