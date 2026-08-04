import * as THREE from 'three/webgpu';
import type { DrawingAreaState, ProjectionTarget, Vec2, Vec3 } from './contracts';
import { SurfaceDocument } from './surface-document';
import { SurfaceProjector, type SurfaceProjectionHit } from './surface-projector';

export interface DrawingAreaPlaceOptions {
  readonly size?: number | Vec2;
  readonly projectionHeight?: number;
  readonly tangentHint?: THREE.Vector3;
}

export interface DrawingAreaProjectionOptions {
  readonly sourceGridDivisions?: number;
  readonly patchDivisions?: number;
  readonly contactProbeDivisions?: number;
  readonly surfaceOffset?: number;
  readonly rayStartOffset?: number;
  readonly contactDepth?: number;
  readonly maxProjectionDistance?: number;
  readonly facingThreshold?: number;
}

export interface DrawingAreaLineData {
  readonly points: readonly Vec3[];
}

export interface DrawingAreaSourceData {
  readonly center: Vec3;
  readonly lines: readonly DrawingAreaLineData[];
  readonly projectionRay: readonly [Vec3, Vec3];
}

export interface DrawingAreaPatchData {
  readonly positions: readonly Vec3[];
  readonly valid: readonly boolean[];
  readonly indices: readonly number[];
  readonly lines: readonly DrawingAreaLineData[];
}

export interface DrawingAreaProjectionStats {
  readonly rayHits: number;
  readonly fallbackHits: number;
  readonly rejectedRayHits: number;
  readonly rejectedFallbackHits: number;
}

export interface DrawingAreaProjectionResult {
  readonly area: DrawingAreaState | null;
  readonly source: DrawingAreaSourceData | null;
  readonly patch: DrawingAreaPatchData | null;
  readonly contact: boolean;
  readonly committed: boolean;
  readonly closestContactDistance: number | null;
  readonly stats: DrawingAreaProjectionStats;
}

const DEFAULT_SIZE = 2.4;
const MIN_SIZE = 1e-4;

/**
 * Owns renderer-independent drawing-area state and surface projection data.
 * TransformControls or another UI can drive the mutation methods without
 * owning document history or duplicating projection rules.
 */
export class DrawingAreaController {
  private transformGroupOpen = false;

  constructor(
    private readonly document: SurfaceDocument,
    private readonly projector: SurfaceProjector,
  ) {}

  get area(): DrawingAreaState | null {
    return this.document.snapshot.drawingArea;
  }

  place(hit: SurfaceProjectionHit, options: DrawingAreaPlaceOptions = {}): DrawingAreaState {
    let target: ProjectionTarget = this.document.snapshot.target;
    if (target.kind === 'pick') {
      target = { kind: 'mesh', targetId: hit.targetId };
      this.projector.selectTarget(target);
      this.document.setProjectionTarget(target);
    }

    const normal = hit.worldNormal.clone().normalize();
    const { u, v } = stableTangentFrame(normal, options.tangentHint);
    const size = typeof options.size === 'number'
      ? [options.size, options.size] as Vec2
      : options.size ?? [DEFAULT_SIZE, DEFAULT_SIZE];
    const center = hit.worldPosition.clone().addScaledVector(normal, -hit.surfaceOffset);
    const area: DrawingAreaState = {
      target,
      center: tuple(center),
      normal: tuple(normal),
      u: tuple(u),
      v: tuple(v),
      size: [Math.max(MIN_SIZE, size[0]), Math.max(MIN_SIZE, size[1])],
      projectionHeight: Math.max(0, options.projectionHeight ?? 0.85),
      committed: false,
    };
    this.document.setDrawingArea(area);
    return this.document.snapshot.drawingArea!;
  }

  translate(delta: THREE.Vector3): void {
    this.update((area) => ({
      ...area,
      center: tuple(vector(area.center).add(delta)),
    }));
  }

  rotate(axis: THREE.Vector3, radians: number): void {
    if (axis.lengthSq() < 1e-12 || Math.abs(radians) < 1e-12) return;
    const rotation = new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), radians);
    this.update((area) => {
      const normal = vector(area.normal).applyQuaternion(rotation).normalize();
      const u = vector(area.u).applyQuaternion(rotation);
      u.addScaledVector(normal, -u.dot(normal)).normalize();
      const safeU = u.lengthSq() > 1e-12 ? u : stableTangentFrame(normal).u;
      const v = normal.clone().cross(safeU).normalize();
      return { ...area, normal: tuple(normal), u: tuple(safeU), v: tuple(v) };
    });
  }

  scale(scaleU: number, scaleV = scaleU): void {
    this.update((area) => ({
      ...area,
      size: [
        Math.max(MIN_SIZE, area.size[0] * Math.max(0, scaleU)),
        Math.max(MIN_SIZE, area.size[1] * Math.max(0, scaleV)),
      ],
    }));
  }

  setProjectionHeight(height: number): void {
    this.update((area) => ({ ...area, projectionHeight: Math.max(0, height) }));
  }

  setCommitted(committed: boolean, projectionHeight?: number): void {
    this.update((area) => ({
      ...area,
      committed,
      ...(projectionHeight === undefined
        ? {}
        : { projectionHeight: Math.max(0, projectionHeight) }),
    }));
  }

  remove(): void {
    this.finishTransformGroup('commit');
    this.document.setDrawingArea(null);
  }

  beginTransformDrag(label = 'Transform drawing area'): void {
    if (this.transformGroupOpen) throw new Error('A drawing-area transform drag is already active');
    this.document.beginHistoryGroup(label);
    this.transformGroupOpen = true;
  }

  commitTransformDrag(): void {
    this.finishTransformGroup('commit');
  }

  cancelTransformDrag(): void {
    this.finishTransformGroup('cancel');
  }

  dispose(): void {
    this.finishTransformGroup('cancel');
  }

  project(options: DrawingAreaProjectionOptions = {}): DrawingAreaProjectionResult {
    const area = this.area;
    if (!area) return emptyProjectionResult();

    const targetAvailable = this.projector.selectTarget(area.target);
    const center = vector(area.center);
    const normal = vector(area.normal).normalize();
    const u = vector(area.u).normalize();
    const v = vector(area.v).normalize();
    const sourceCenter = center.clone().addScaledVector(normal, area.projectionHeight);
    const halfU = area.size[0] * 0.5;
    const halfV = area.size[1] * 0.5;
    const sourceGridDivisions = divisions(options.sourceGridDivisions, 10);
    const patchDivisions = divisions(options.patchDivisions, 18);
    const contactProbeDivisions = divisions(options.contactProbeDivisions, 4);
    const surfaceOffset = options.surfaceOffset ?? 0.016;
    const rayStartOffset = options.rayStartOffset ?? 0.02;
    const contactDepth = options.contactDepth
      ?? Math.max(0.14, Math.min(area.size[0], area.size[1]) * 0.055);
    const maxProjectionDistance = options.maxProjectionDistance
      ?? Math.max(0.65, Math.min(area.size[0], area.size[1]) * 0.55);
    const facingThreshold = options.facingThreshold ?? 0.05;

    const sourceLines: DrawingAreaLineData[] = [];
    for (let index = 0; index <= sourceGridDivisions; index++) {
      const x = -halfU + area.size[0] * index / sourceGridDivisions;
      const y = -halfV + area.size[1] * index / sourceGridDivisions;
      sourceLines.push({ points: [
        tuple(sourceCenter.clone().addScaledVector(u, x).addScaledVector(v, -halfV)),
        tuple(sourceCenter.clone().addScaledVector(u, x).addScaledVector(v, halfV)),
      ] });
      sourceLines.push({ points: [
        tuple(sourceCenter.clone().addScaledVector(u, -halfU).addScaledVector(v, y)),
        tuple(sourceCenter.clone().addScaledVector(u, halfU).addScaledVector(v, y)),
      ] });
    }

    const rayStart = sourceCenter.clone().addScaledVector(normal, 0.35);
    const rayEnd = center.clone().addScaledVector(normal, -0.12);
    const source: DrawingAreaSourceData = {
      center: tuple(sourceCenter),
      lines: sourceLines,
      projectionRay: [tuple(rayStart), tuple(rayEnd)],
    };

    // A model replacement can invalidate a mesh-specific area before the
    // document receives its surface-replacement notification. Never project
    // against whatever target happened to be selected previously.
    if (!targetAvailable) {
      return {
        area,
        source,
        patch: null,
        contact: false,
        committed: area.committed,
        closestContactDistance: null,
        stats: emptyStats(),
      };
    }

    let closestContactDistance = Number.POSITIVE_INFINITY;
    for (let row = 0; row <= contactProbeDivisions; row++) {
      for (let column = 0; column <= contactProbeDivisions; column++) {
        const x = -halfU + area.size[0] * column / contactProbeDivisions;
        const y = -halfV + area.size[1] * row / contactProbeDivisions;
        const sourcePoint = sourceCenter.clone().addScaledVector(u, x).addScaledVector(v, y);
        const hit = raycastDown(this.projector, sourcePoint, normal, rayStartOffset);
        if (hit) closestContactDistance = Math.min(closestContactDistance, hit.distance);
      }
    }
    const contact = closestContactDistance <= contactDepth;
    if (!contact && !area.committed) {
      return {
        area,
        source,
        patch: null,
        contact: false,
        committed: false,
        closestContactDistance: Number.isFinite(closestContactDistance)
          ? closestContactDistance
          : null,
        stats: emptyStats(),
      };
    }

    const positions: Vec3[] = [];
    const valid: boolean[] = [];
    const indices: number[] = [];
    const stats = { rayHits: 0, fallbackHits: 0, rejectedRayHits: 0, rejectedFallbackHits: 0 };
    const projectPoint = (x: number, y: number): THREE.Vector3 | null => {
      const guess = center.clone().addScaledVector(u, x).addScaledVector(v, y);
      const sourcePoint = sourceCenter.clone().addScaledVector(u, x).addScaledVector(v, y);
      const rayHit = raycastDown(this.projector, sourcePoint, normal, rayStartOffset);
      if (rayHit) {
        const facing = rayHit.worldNormal.dot(normal);
        if (rayHit.distance <= maxProjectionDistance && facing > facingThreshold) {
          stats.rayHits++;
          return rayHit.worldPosition.clone().addScaledVector(rayHit.worldNormal, surfaceOffset);
        }
        stats.rejectedRayHits++;
      }

      const fallback = this.projector.closestPoint(guess);
      if (fallback) {
        const distance = fallback.worldPosition.distanceTo(guess);
        const facing = fallback.worldNormal.dot(normal);
        if (distance <= maxProjectionDistance && facing > facingThreshold) {
          stats.fallbackHits++;
          return fallback.worldPosition.clone().addScaledVector(fallback.worldNormal, surfaceOffset);
        }
        stats.rejectedFallbackHits++;
      }
      return null;
    };

    for (let row = 0; row <= patchDivisions; row++) {
      const y = -halfV + area.size[1] * row / patchDivisions;
      for (let column = 0; column <= patchDivisions; column++) {
        const x = -halfU + area.size[0] * column / patchDivisions;
        const projected = projectPoint(x, y);
        valid.push(projected !== null);
        positions.push(tuple(projected ?? center));
      }
    }
    for (let row = 0; row < patchDivisions; row++) {
      for (let column = 0; column < patchDivisions; column++) {
        const a = row * (patchDivisions + 1) + column;
        const b = a + 1;
        const c = a + patchDivisions + 1;
        const d = c + 1;
        if (valid[a] && valid[c] && valid[b]) indices.push(a, c, b);
        if (valid[b] && valid[c] && valid[d]) indices.push(b, c, d);
      }
    }

    const lines: DrawingAreaLineData[] = [];
    for (let row = 0; row <= patchDivisions; row++) {
      for (let column = 0; column < patchDivisions; column++) {
        const a = row * (patchDivisions + 1) + column;
        const b = a + 1;
        if (valid[a] && valid[b]) lines.push({ points: [positions[a], positions[b]] });
      }
    }
    for (let column = 0; column <= patchDivisions; column++) {
      for (let row = 0; row < patchDivisions; row++) {
        const a = row * (patchDivisions + 1) + column;
        const b = a + patchDivisions + 1;
        if (valid[a] && valid[b]) lines.push({ points: [positions[a], positions[b]] });
      }
    }

    return {
      area,
      source,
      patch: { positions, valid, indices, lines },
      contact,
      committed: area.committed,
      closestContactDistance: Number.isFinite(closestContactDistance)
        ? closestContactDistance
        : null,
      stats,
    };
  }

  private update(transform: (area: DrawingAreaState) => DrawingAreaState): void {
    const area = this.area;
    if (!area) return;
    this.document.setDrawingArea(transform(area));
  }

  private finishTransformGroup(action: 'commit' | 'cancel'): void {
    if (!this.transformGroupOpen) return;
    this.transformGroupOpen = false;
    if (action === 'commit') this.document.commitHistoryGroup();
    else this.document.cancelHistoryGroup();
  }
}

function stableTangentFrame(
  normal: THREE.Vector3,
  hint?: THREE.Vector3,
): { u: THREE.Vector3; v: THREE.Vector3 } {
  let u = hint?.clone() ?? leastAlignedAxis(normal);
  u.addScaledVector(normal, -u.dot(normal));
  if (u.lengthSq() < 1e-12) {
    u = leastAlignedAxis(normal).addScaledVector(normal, -leastAlignedAxis(normal).dot(normal));
  }
  u.normalize();
  return { u, v: normal.clone().cross(u).normalize() };
}

function leastAlignedAxis(normal: THREE.Vector3): THREE.Vector3 {
  const axes = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ];
  axes.sort((a, b) => Math.abs(a.dot(normal)) - Math.abs(b.dot(normal)));
  return axes[0];
}

function raycastDown(
  projector: SurfaceProjector,
  sourcePoint: THREE.Vector3,
  normal: THREE.Vector3,
  rayStartOffset: number,
): SurfaceProjectionHit | null {
  const raycaster = new THREE.Raycaster(
    sourcePoint.clone().addScaledVector(normal, rayStartOffset),
    normal.clone().negate(),
  );
  return projector.raycast(raycaster);
}

function divisions(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.round(value ?? fallback));
}

function tuple(value: THREE.Vector3): Vec3 {
  return value.toArray() as Vec3;
}

function vector(value: Vec3): THREE.Vector3 {
  return new THREE.Vector3().fromArray(value);
}

function emptyStats(): DrawingAreaProjectionStats {
  return { rayHits: 0, fallbackHits: 0, rejectedRayHits: 0, rejectedFallbackHits: 0 };
}

function emptyProjectionResult(): DrawingAreaProjectionResult {
  return {
    area: null,
    source: null,
    patch: null,
    contact: false,
    committed: false,
    closestContactDistance: null,
    stats: emptyStats(),
  };
}
