import * as THREE from 'three/webgpu';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type SurfaceStudioStatusState = 'ready' | 'busy' | 'error';
export type SurfaceStudioFrameTask = (dt: number, elapsed: number) => void;

export interface SurfaceStudioSurfaceChange {
  readonly root: THREE.Group;
  readonly revision: number;
}

export type SurfaceStudioSurfaceListener = (change: SurfaceStudioSurfaceChange) => void;

/** Narrow scene seam consumed by the shared document/projector/generator layer. */
export interface SurfaceStudioHost {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly controls: OrbitControls;
  readonly modelRoot: THREE.Group;
  readonly outputParent: THREE.Object3D;
  readonly surfaceRevision: number;

  compile(object: THREE.Object3D): Promise<void>;
  setStatus(state: SurfaceStudioStatusState, message: string): void;
  subscribeSurface(listener: SurfaceStudioSurfaceListener): () => void;
  registerFrameTask(task: SurfaceStudioFrameTask): () => void;
}

export interface SurfaceStudioHostResources {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  readonly controls: OrbitControls;
  readonly modelRoot: THREE.Group;
  readonly outputParent: THREE.Object3D;
  readonly compile: (object: THREE.Object3D) => Promise<void>;
  readonly setStatus: (state: SurfaceStudioStatusState, message: string) => void;
}

/**
 * App-owned lifecycle controller behind the public facade. Keeping mutation
 * methods off SurfaceStudioHost prevents consumers from advancing revisions or
 * running other consumers' frame tasks themselves.
 */
export class SurfaceStudioHostController {
  readonly host: SurfaceStudioHost;

  private revision = 0;
  private disposed = false;
  private readonly surfaceListeners = new Set<SurfaceStudioSurfaceListener>();
  private readonly frameTasks = new Set<SurfaceStudioFrameTask>();

  constructor(private readonly resources: SurfaceStudioHostResources) {
    const controller = this;
    this.host = Object.freeze({
      scene: resources.scene,
      camera: resources.camera,
      canvas: resources.canvas,
      controls: resources.controls,
      modelRoot: resources.modelRoot,
      outputParent: resources.outputParent,
      get surfaceRevision() { return controller.revision; },
      compile(object: THREE.Object3D) {
        controller.assertLive();
        return resources.compile(object);
      },
      setStatus(state: SurfaceStudioStatusState, message: string) {
        controller.assertLive();
        resources.setStatus(state, message);
      },
      subscribeSurface(listener: SurfaceStudioSurfaceListener) {
        return controller.subscribeSurface(listener);
      },
      registerFrameTask(task: SurfaceStudioFrameTask) {
        return controller.registerFrameTask(task);
      },
    });
  }

  /** Advance the target revision after a model install, replacement, or scale. */
  notifySurfaceChanged(): void {
    if (this.disposed) return;
    this.revision++;
    const change: SurfaceStudioSurfaceChange = Object.freeze({
      root: this.resources.modelRoot,
      revision: this.revision,
    });
    for (const listener of [...this.surfaceListeners]) listener(change);
  }

  runFrameTasks(dt: number, elapsed: number): void {
    if (this.disposed) return;
    for (const task of [...this.frameTasks]) task(dt, elapsed);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.surfaceListeners.clear();
    this.frameTasks.clear();
  }

  private subscribeSurface(listener: SurfaceStudioSurfaceListener): () => void {
    this.assertLive();
    this.surfaceListeners.add(listener);
    listener(Object.freeze({ root: this.resources.modelRoot, revision: this.revision }));
    return () => this.surfaceListeners.delete(listener);
  }

  private registerFrameTask(task: SurfaceStudioFrameTask): () => void {
    this.assertLive();
    this.frameTasks.add(task);
    return () => this.frameTasks.delete(task);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('SurfaceStudioHost has been disposed');
  }
}
