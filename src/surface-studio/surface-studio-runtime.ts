import * as THREE from 'three/webgpu';
import type { SurfaceGeneratorId, SurfaceInteractionMode } from './contracts';
import type { SurfaceGeneratorAdapter } from './generator-adapter';
import {
  GeneratorManager,
  type GeneratorManagerHost,
} from './generator-manager';
import { SurfaceDocument } from './surface-document';
import {
  SurfaceInputController,
  type OrbitEnabledControl,
  type SurfaceInputHooks,
} from './surface-input-controller';
import { SurfaceProjector } from './surface-projector';

export interface SurfaceStudioRuntimeOptions {
  readonly element: HTMLElement;
  readonly camera: THREE.Camera;
  readonly orbitControls: OrbitEnabledControl;
  readonly targetRoot: THREE.Object3D;
  readonly managerHost: GeneratorManagerHost;
  readonly adapters: readonly SurfaceGeneratorAdapter<any>[];
  readonly activeGenerator?: SurfaceGeneratorId;
  readonly inputHooks?: SurfaceInputHooks;
  readonly minSampleDistance?: number;
  readonly surfaceOffset?: number | ((generatorId: SurfaceGeneratorId) => number);
}

/**
 * Coordinates the shared document, target projector, input owner, and generator
 * manager without owning a renderer. The procedural WebGPU App supplies the
 * host scene/camera/canvas and remains the single viewport owner.
 */
export class SurfaceStudioRuntime {
  readonly document = new SurfaceDocument();
  readonly projector = new SurfaceProjector();
  readonly generators: GeneratorManager;
  readonly input: SurfaceInputController;

  private surfaceRevision = 0;
  private disposed = false;

  constructor(private readonly options: SurfaceStudioRuntimeOptions) {
    this.projector.registerTargetRoot(options.targetRoot);
    this.generators = new GeneratorManager({
      document: this.document,
      projector: this.projector,
      host: options.managerHost,
      adapters: options.adapters,
      activeGenerator: options.activeGenerator,
    });
    this.input = new SurfaceInputController({
      element: options.element,
      camera: () => options.camera,
      projector: this.projector,
      document: this.document,
      orbitControls: options.orbitControls,
      generatorId: this.generators.activeGenerator,
      mode: 'orbit',
      minDistance: options.minSampleDistance,
      surfaceOffset: options.surfaceOffset,
      hooks: options.inputHooks,
    });
  }

  get activeGenerator(): SurfaceGeneratorId {
    return this.generators.activeGenerator;
  }

  async setActiveGenerator(generatorId: SurfaceGeneratorId): Promise<void> {
    this.assertLive();
    this.input.setGenerator(generatorId);
    await this.generators.setActiveGenerator(generatorId);
  }

  setInteractionMode(mode: SurfaceInteractionMode): boolean {
    this.assertLive();
    return this.input.setMode(mode);
  }

  async setGeneratorSettings<Settings>(
    generatorId: SurfaceGeneratorId,
    settings: Readonly<Settings>,
  ): Promise<void> {
    this.assertLive();
    await this.generators.setSettings(generatorId, settings);
  }

  /** Call after the host replaces or mutates the shared target root. */
  async replaceSurface(
    targetRoot: THREE.Object3D = this.options.targetRoot,
    revision?: number,
  ): Promise<void> {
    this.assertLive();
    this.input.setMode('orbit');
    this.projector.registerTargetRoot(targetRoot);
    this.surfaceRevision = revision ?? this.surfaceRevision + 1;
    this.document.replaceSurface(this.surfaceRevision);
    await this.generators.whenIdle();
  }

  undo(): boolean {
    this.assertLive();
    return this.document.undo();
  }

  clear(): void {
    this.assertLive();
    this.document.clearStrokes();
  }

  update(dt: number, elapsed: number): void {
    if (this.disposed) return;
    this.generators.update(dt, elapsed);
  }

  async whenIdle(): Promise<void> {
    await this.generators.whenIdle();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.dispose();
    this.generators.dispose();
    this.projector.dispose();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('SurfaceStudioRuntime has been disposed');
  }
}
