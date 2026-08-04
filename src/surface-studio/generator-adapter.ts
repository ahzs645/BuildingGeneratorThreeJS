import * as THREE from 'three/webgpu';
import type { SurfaceSample } from '../geometry-painter/modes/mode';
import type { TargetSurface } from '../surface-targets';
import type {
  DrawingAreaState,
  SurfaceDocumentSnapshot,
  SurfaceGeneratorId,
  SurfaceStrokeRecord,
} from './contracts';
import type { SurfaceGeneratorDescriptor } from './generator-catalog';
import {
  SurfaceProjector,
  type MaterializedSurfacePoint,
} from './surface-projector';

/** One durable document stroke resolved through the target's current transform. */
export interface ProjectedSurfaceStroke {
  readonly id: number;
  readonly generatorId: SurfaceGeneratorId;
  readonly seed: number;
  readonly cyclic: boolean;
  readonly points: readonly MaterializedSurfacePoint[];
}

export interface GeneratorEvaluationInput {
  readonly documentRevision: number;
  readonly surfaceRevision: number;
  readonly strokes: readonly ProjectedSurfaceStroke[];
  readonly targets: readonly TargetSurface[];
  readonly drawingArea: DrawingAreaState | null;
  readonly signal: AbortSignal;
}

export interface GeneratorHostContext {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  readonly outputRoot: THREE.Group;
  compile(object: THREE.Object3D): Promise<void>;
  setStatus(state: 'ready' | 'busy' | 'error', message: string): void;
}

export interface SurfaceGeneratorRuntime<Settings> {
  setSettings(settings: Readonly<Settings>): void;
  reconcile(input: GeneratorEvaluationInput): void | Promise<void>;
  setVisible(visible: boolean): void;
  update?(dt: number, elapsed: number): void;
  dispose(): void;
}

export interface SurfaceGeneratorAdapter<Settings> {
  readonly descriptor: SurfaceGeneratorDescriptor;
  readonly defaultSettings: Readonly<Settings>;
  createRuntime(
    host: GeneratorHostContext,
    initialSettings: Readonly<Settings>,
  ): SurfaceGeneratorRuntime<Settings>;
}

/**
 * Resolve one immutable document stroke into the current scene. Missing target
 * meshes invalidate only that stroke, not the rest of the document.
 */
export function projectSurfaceStroke(
  projector: SurfaceProjector,
  stroke: SurfaceStrokeRecord,
): ProjectedSurfaceStroke | null {
  const points: MaterializedSurfacePoint[] = [];
  for (const point of stroke.points) {
    const materialized = projector.materialize(point);
    if (!materialized) return null;
    points.push(materialized);
  }
  return {
    id: stroke.id,
    generatorId: stroke.generatorId,
    seed: stroke.seed,
    cyclic: stroke.cyclic,
    points,
  };
}

/** Materialize and partition only the strokes owned by one generator adapter. */
export function projectedStrokesFor(
  snapshot: SurfaceDocumentSnapshot,
  generatorId: SurfaceGeneratorId,
  projector: SurfaceProjector,
): readonly ProjectedSurfaceStroke[] {
  const projected: ProjectedSurfaceStroke[] = [];
  for (const stroke of snapshot.strokes) {
    if (stroke.generatorId !== generatorId) continue;
    const materialized = projectSurfaceStroke(projector, stroke);
    if (materialized) projected.push(materialized);
  }
  return projected;
}

/**
 * Convert the shared projected format to the existing procedural PaintMode
 * sample shape. This is the thin adapter that lets Crystals, Molten, Aurora,
 * and Reef keep their current generators unchanged.
 */
export function toPaintModeSamples(
  stroke: ProjectedSurfaceStroke,
  outputAnchor: THREE.Object3D,
): SurfaceSample[] {
  outputAnchor.updateWorldMatrix(true, false);
  const inverseAnchor = outputAnchor.matrixWorld.clone().invert();
  return stroke.points.map((point) => ({
    position: point.worldPosition.clone(),
    normal: point.worldNormal.clone(),
    local: point.worldPosition.clone().applyMatrix4(inverseAnchor),
    localNormal: point.worldNormal.clone().transformDirection(inverseAnchor),
  }));
}

