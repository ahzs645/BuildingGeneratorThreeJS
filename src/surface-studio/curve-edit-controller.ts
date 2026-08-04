import * as THREE from 'three/webgpu';
import type {
  DrawingAreaState,
  SurfacePointRecord,
  SurfaceSelection,
  SurfaceStrokeRecord,
} from './contracts';
import { projectSurfaceStroke } from './generator-adapter';
import { SurfaceDocument, type NewSurfacePoint } from './surface-document';
import { SurfaceProjector } from './surface-projector';

export interface CurveEditViewport {
  readonly width: number;
  readonly height: number;
}

export type CurveEditHit =
  | {
    readonly kind: 'point';
    readonly strokeId: number;
    readonly pointId: number;
    readonly distancePx: number;
  }
  | {
    readonly kind: 'stroke';
    readonly strokeId: number;
    readonly segmentIndex: number;
    readonly distancePx: number;
  };

interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

interface DragState {
  readonly stroke: SurfaceStrokeRecord;
  readonly selection: SurfaceSelection;
}

/**
 * Renderer/UI-free curve selection and editing over the shared surface model.
 * Preview lines, point handles, and pointer capture remain concerns of the host.
 */
export class CurveEditController {
  private drag: DragState | null = null;

  constructor(
    private readonly document: SurfaceDocument,
    private readonly projector: SurfaceProjector,
  ) {}

  get isDragging(): boolean {
    return this.drag !== null;
  }

  /** Pick a projected control point first, then the nearest stroke segment. */
  pick(
    pointerNdc: THREE.Vector2,
    camera: THREE.Camera,
    viewport: CurveEditViewport,
    thresholdPx = 12,
  ): CurveEditHit | null {
    if (viewport.width <= 0 || viewport.height <= 0 || thresholdPx < 0) return null;
    camera.updateWorldMatrix(true, false);
    const pointer = ndcToScreen(pointerNdc.x, pointerNdc.y, viewport);
    let pointHit: Extract<CurveEditHit, { kind: 'point' }> | null = null;
    let strokeHit: Extract<CurveEditHit, { kind: 'stroke' }> | null = null;

    for (const source of this.document.snapshot.strokes) {
      const projected = projectSurfaceStroke(this.projector, source);
      if (!projected) continue;
      const screenPoints = projected.points.map((point) => projectToScreen(
        point.worldPosition,
        camera,
        viewport,
      ));

      for (let index = 0; index < screenPoints.length; index++) {
        const candidate = screenPoints[index];
        if (!candidate) continue;
        const distancePx = Math.hypot(pointer.x - candidate.x, pointer.y - candidate.y);
        if (distancePx <= thresholdPx && (!pointHit || distancePx < pointHit.distancePx)) {
          pointHit = {
            kind: 'point',
            strokeId: source.id,
            pointId: source.points[index].id,
            distancePx,
          };
        }
      }

      const segmentCount = source.cyclic && screenPoints.length > 2
        ? screenPoints.length
        : Math.max(0, screenPoints.length - 1);
      for (let index = 0; index < segmentCount; index++) {
        const from = screenPoints[index];
        const to = screenPoints[(index + 1) % screenPoints.length];
        if (!from || !to) continue;
        const distancePx = distanceToSegment(pointer, from, to);
        if (distancePx <= thresholdPx && (!strokeHit || distancePx < strokeHit.distancePx)) {
          strokeHit = { kind: 'stroke', strokeId: source.id, segmentIndex: index, distancePx };
        }
      }
    }
    return pointHit ?? strokeHit;
  }

  selectAt(
    pointerNdc: THREE.Vector2,
    camera: THREE.Camera,
    viewport: CurveEditViewport,
    thresholdPx = 12,
  ): CurveEditHit | null {
    const hit = this.pick(pointerNdc, camera, viewport, thresholdPx);
    this.document.select(hit ? selectionForHit(hit) : null);
    return hit;
  }

  /** Begin one coalesced drag, optionally selecting the supplied pick first. */
  beginDrag(hit?: CurveEditHit): boolean {
    if (this.drag) return false;
    if (hit) this.document.select(selectionForHit(hit));
    const selected = this.document.snapshot.selection;
    if (!selected) return false;
    const stroke = this.document.snapshot.strokes.find(({ id }) => id === selected.strokeId);
    if (!stroke) return false;
    this.document.beginHistoryGroup(selected.pointId === undefined
      ? 'Move selected stroke'
      : 'Move curve control point');
    this.drag = { stroke, selection: selected };
    return true;
  }

  /** Move the selected control point to an absolute proposed world position. */
  movePoint(proposedWorldPosition: THREE.Vector3): boolean {
    const drag = this.drag;
    const pointId = drag?.selection.pointId;
    if (!drag || pointId === undefined) return false;
    const pointIndex = drag.stroke.points.findIndex(({ id }) => id === pointId);
    if (pointIndex < 0) return false;
    const projected = this.projectPoint(drag.stroke.points[pointIndex], proposedWorldPosition);
    if (!projected) return false;
    const points = drag.stroke.points.map((point, index) => index === pointIndex
      ? projected
      : withoutId(point));
    this.document.replaceStrokePoints(drag.stroke.id, points);
    return true;
  }

  /** Translate the selected stroke by an absolute delta from its drag start. */
  translateStroke(worldDelta: THREE.Vector3): boolean {
    const drag = this.drag;
    if (!drag || drag.selection.pointId !== undefined) return false;
    const points: NewSurfacePoint[] = [];
    for (const point of drag.stroke.points) {
      const materialized = this.projector.materialize(point);
      if (!materialized) return false;
      const projected = this.projectPoint(point, materialized.worldPosition.clone().add(worldDelta));
      if (!projected) return false;
      points.push(projected);
    }
    this.document.replaceStrokePoints(drag.stroke.id, points);
    return true;
  }

  commitDrag(): boolean {
    if (!this.drag) return false;
    this.document.commitHistoryGroup();
    this.drag = null;
    return true;
  }

  cancelDrag(): boolean {
    if (!this.drag) return false;
    this.document.cancelHistoryGroup();
    this.drag = null;
    return true;
  }

  private projectPoint(
    source: SurfacePointRecord,
    proposedWorldPosition: THREE.Vector3,
  ): NewSurfacePoint | null {
    const previousTarget = this.projector.projectionTarget;
    try {
      if (!this.projector.selectTarget({ kind: 'mesh', targetId: source.targetId })) return null;
      const hit = this.projector.closestPoint(proposedWorldPosition, source.surfaceOffset);
      if (!hit || hit.targetId !== source.targetId) return null;
      const stored = this.projector.storeHit(source.id, hit, areaPosition(hit.worldPosition, this.document.snapshot.drawingArea));
      return withoutId(stored);
    } finally {
      this.projector.selectTarget(previousTarget);
    }
  }
}

function selectionForHit(hit: CurveEditHit): SurfaceSelection {
  return hit.kind === 'point'
    ? { strokeId: hit.strokeId, pointId: hit.pointId }
    : { strokeId: hit.strokeId };
}

function withoutId(point: SurfacePointRecord): NewSurfacePoint {
  return {
    targetId: point.targetId,
    targetPosition: point.targetPosition,
    targetNormal: point.targetNormal,
    ...(point.areaPosition ? { areaPosition: point.areaPosition } : {}),
    surfaceOffset: point.surfaceOffset,
  };
}

function areaPosition(
  worldPosition: THREE.Vector3,
  area: DrawingAreaState | null,
): readonly [number, number] | undefined {
  if (!area) return undefined;
  const delta = worldPosition.clone().sub(new THREE.Vector3().fromArray(area.center));
  return [
    delta.dot(new THREE.Vector3().fromArray(area.u)),
    delta.dot(new THREE.Vector3().fromArray(area.v)),
  ];
}

function projectToScreen(
  worldPosition: THREE.Vector3,
  camera: THREE.Camera,
  viewport: CurveEditViewport,
): ScreenPoint | null {
  const ndc = worldPosition.clone().project(camera);
  if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || ndc.z < -1 || ndc.z > 1) return null;
  return ndcToScreen(ndc.x, ndc.y, viewport);
}

function ndcToScreen(x: number, y: number, viewport: CurveEditViewport): ScreenPoint {
  return {
    x: (x + 1) * 0.5 * viewport.width,
    y: (1 - y) * 0.5 * viewport.height,
  };
}

function distanceToSegment(point: ScreenPoint, from: ScreenPoint, to: ScreenPoint): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= Number.EPSILON) return Math.hypot(point.x - from.x, point.y - from.y);
  const t = Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSq));
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t));
}
