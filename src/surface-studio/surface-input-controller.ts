import * as THREE from 'three/webgpu';
import type {
  SurfaceGeneratorId,
  SurfaceInteractionMode,
  Vec2,
  Vec3,
} from './contracts';
import { surfaceGenerator } from './generator-catalog';
import { SurfaceDocument, type NewSurfacePoint } from './surface-document';
import { SurfaceProjector, type SurfaceProjectionHit } from './surface-projector';

/** The only OrbitControls surface the headless controller needs. */
export interface OrbitEnabledControl {
  enabled: boolean;
}

export interface SurfacePointerContext {
  readonly event: PointerEvent;
  readonly generatorId: SurfaceGeneratorId;
  readonly mode: SurfaceInteractionMode;
  readonly ndc: THREE.Vector2;
  readonly hit: SurfaceProjectionHit | null;
}

/** Extension seams for the later drawing-area and curve-selection controllers. */
export interface SurfaceInputHooks {
  readonly onTargetPick?: (context: SurfacePointerContext & { hit: SurfaceProjectionHit }) => void;
  readonly onPlaceArea?: (context: SurfacePointerContext) => void;
  readonly onSelect?: (context: SurfacePointerContext) => void;
  readonly onInteract?: (context: SurfacePointerContext) => void;
  readonly onFlower?: (context: SurfacePointerContext) => void;
  readonly onPointerMove?: (context: SurfacePointerContext) => void;
  readonly onModeChange?: (
    mode: SurfaceInteractionMode,
    generatorId: SurfaceGeneratorId,
  ) => void;
  /** Return the drawing-area UV stored alongside a newly sampled point. */
  readonly areaPosition?: (
    hit: SurfaceProjectionHit,
    event: PointerEvent,
  ) => Vec2 | undefined;
}

export interface SurfaceInputControllerOptions {
  readonly element: HTMLElement;
  readonly camera: () => THREE.Camera;
  readonly projector: SurfaceProjector;
  readonly document: SurfaceDocument;
  readonly orbitControls: OrbitEnabledControl;
  readonly generatorId?: SurfaceGeneratorId;
  readonly mode?: SurfaceInteractionMode;
  readonly minDistance?: number;
  readonly surfaceOffset?: number | ((generatorId: SurfaceGeneratorId) => number);
  readonly nextSeed?: () => number;
  readonly hooks?: SurfaceInputHooks;
}

/**
 * One pointer owner for the shared surface-authoring document.
 *
 * This controller deliberately owns no scene objects or UI. Drawing-area
 * projection, curve selection, and generator-specific hover tools plug into
 * the hooks above while sharing the same capability-gated interaction mode.
 */
export class SurfaceInputController {
  private activeGeneratorId: SurfaceGeneratorId;
  private interactionMode: SurfaceInteractionMode;
  private activePointerId: number | null = null;
  private lastSamplePosition: THREE.Vector3 | null = null;
  private disposed = false;
  private seedCounter = 1;

  readonly minDistance: number;

  constructor(private readonly options: SurfaceInputControllerOptions) {
    this.activeGeneratorId = options.generatorId ?? 'ivy';
    const requestedMode = options.mode ?? 'orbit';
    this.interactionMode = this.supportsMode(requestedMode) ? requestedMode : 'orbit';
    this.minDistance = Math.max(0, options.minDistance ?? 0.035);

    options.projector.selectTarget(options.document.snapshot.target);
    options.element.addEventListener('pointerdown', this.onPointerDown);
    options.element.addEventListener('pointermove', this.onPointerMove);
    options.element.addEventListener('pointerup', this.onPointerUp);
    options.element.addEventListener('pointercancel', this.onPointerCancel);
    this.syncOrbitControls();
  }

  get generatorId(): SurfaceGeneratorId {
    return this.activeGeneratorId;
  }

  get mode(): SurfaceInteractionMode {
    return this.interactionMode;
  }

  supportsMode(mode: SurfaceInteractionMode): boolean {
    return surfaceGenerator(this.activeGeneratorId).capabilities.interactionModes.includes(mode);
  }

  /** Switch capability sets without clearing or otherwise replacing the document. */
  setGenerator(generatorId: SurfaceGeneratorId): void {
    if (generatorId === this.activeGeneratorId) return;
    this.cancelActivePointer();
    this.activeGeneratorId = generatorId;
    if (!this.supportsMode(this.interactionMode)) this.interactionMode = 'orbit';
    this.syncOrbitControls();
    this.options.hooks?.onModeChange?.(this.interactionMode, this.activeGeneratorId);
  }

  /** Returns false and leaves state unchanged when the active generator rejects a mode. */
  setMode(mode: SurfaceInteractionMode): boolean {
    if (!this.supportsMode(mode)) return false;
    if (mode === this.interactionMode) return true;
    this.cancelActivePointer();
    this.interactionMode = mode;
    this.syncOrbitControls();
    this.options.hooks?.onModeChange?.(mode, this.activeGeneratorId);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelActivePointer();
    const { element } = this.options;
    element.removeEventListener('pointerdown', this.onPointerDown);
    element.removeEventListener('pointermove', this.onPointerMove);
    element.removeEventListener('pointerup', this.onPointerUp);
    element.removeEventListener('pointercancel', this.onPointerCancel);
    this.options.orbitControls.enabled = true;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.disposed || event.button !== 0 || event.isPrimary === false) return;
    if (this.interactionMode === 'orbit') return;
    const context = this.pointerContext(event);
    if (!context) return;

    switch (this.interactionMode) {
      case 'draw': {
        if (!context.hit) return;
        event.preventDefault();
        this.activePointerId = event.pointerId;
        this.capturePointer(event.pointerId);
        this.options.document.beginStroke(this.activeGeneratorId, this.nextSeed());
        this.appendHit(context.hit, event);
        return;
      }
      case 'pick-target': {
        if (!context.hit) return;
        event.preventDefault();
        const target = { kind: 'mesh', targetId: context.hit.targetId } as const;
        this.options.projector.selectTarget(target);
        this.options.document.setProjectionTarget(target);
        this.options.hooks?.onTargetPick?.({ ...context, hit: context.hit });
        return;
      }
      case 'place-area':
        event.preventDefault();
        this.options.hooks?.onPlaceArea?.(context);
        return;
      case 'select':
        event.preventDefault();
        this.options.hooks?.onSelect?.(context);
        return;
      case 'interact':
        this.options.hooks?.onInteract?.(context);
        return;
      case 'flower':
        this.options.hooks?.onFlower?.(context);
        return;
      default:
        return;
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.disposed) return;
    if (this.interactionMode === 'orbit' && !this.options.hooks?.onPointerMove) return;
    const context = this.pointerContext(event);
    if (!context) return;
    this.options.hooks?.onPointerMove?.(context);

    if (this.interactionMode === 'draw'
      && this.activePointerId === event.pointerId
      && context.hit) {
      this.appendHit(context.hit, event);
    } else if (this.interactionMode === 'interact') {
      this.options.hooks?.onInteract?.(context);
    } else if (this.interactionMode === 'flower') {
      this.options.hooks?.onFlower?.(context);
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.disposed || this.activePointerId !== event.pointerId) return;
    this.options.document.commitStroke();
    this.releasePointer(event.pointerId);
    this.activePointerId = null;
    this.lastSamplePosition = null;
  };

  private onPointerCancel = (event: PointerEvent): void => {
    if (this.disposed || this.activePointerId !== event.pointerId) return;
    this.options.document.cancelStroke();
    this.releasePointer(event.pointerId);
    this.activePointerId = null;
    this.lastSamplePosition = null;
  };

  private appendHit(hit: SurfaceProjectionHit, event: PointerEvent): void {
    if (this.lastSamplePosition
      && hit.worldPosition.distanceTo(this.lastSamplePosition) < this.minDistance) return;
    const areaPosition = this.options.hooks?.areaPosition?.(hit, event);
    const value: NewSurfacePoint = {
      targetId: hit.targetId,
      targetPosition: hit.targetPosition.toArray() as Vec3,
      targetNormal: hit.targetNormal.toArray() as Vec3,
      ...(areaPosition ? { areaPosition } : {}),
      surfaceOffset: hit.surfaceOffset,
    };
    this.options.document.appendPoint(value);
    this.lastSamplePosition = hit.worldPosition.clone();
  }

  private pointerContext(event: PointerEvent): SurfacePointerContext | null {
    const ndc = pointerNdc(this.options.element, event);
    if (!ndc) return null;
    // Target-pick must see every candidate, even when the document is currently
    // locked to one mesh. Other modes honor the document's active target.
    this.options.projector.selectTarget(
      this.interactionMode === 'pick-target'
        ? { kind: 'all' }
        : this.options.document.snapshot.target,
    );
    return {
      event,
      generatorId: this.activeGeneratorId,
      mode: this.interactionMode,
      ndc,
      hit: this.options.projector.raycastFromCamera(
        ndc,
        this.options.camera(),
        this.surfaceOffset(),
      ),
    };
  }

  private nextSeed(): number {
    return this.options.nextSeed?.() ?? this.seedCounter++;
  }

  private surfaceOffset(): number {
    const { surfaceOffset = 0 } = this.options;
    return typeof surfaceOffset === 'function'
      ? surfaceOffset(this.activeGeneratorId)
      : surfaceOffset;
  }

  private cancelActivePointer(): void {
    if (this.activePointerId === null) return;
    const pointerId = this.activePointerId;
    this.options.document.cancelStroke();
    this.releasePointer(pointerId);
    this.activePointerId = null;
    this.lastSamplePosition = null;
  }

  private capturePointer(pointerId: number): void {
    try {
      this.options.element.setPointerCapture(pointerId);
    } catch {
      // Pointer capture is optional in embedded and headless hosts.
    }
  }

  private releasePointer(pointerId: number): void {
    try {
      this.options.element.releasePointerCapture(pointerId);
    } catch {
      // No active capture.
    }
  }

  private syncOrbitControls(): void {
    this.options.orbitControls.enabled = this.interactionMode === 'orbit';
  }
}

function pointerNdc(element: HTMLElement, event: PointerEvent): THREE.Vector2 | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
}
