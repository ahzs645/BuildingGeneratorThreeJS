import * as THREE from 'three/webgpu';
import type { SurfaceDocumentChange, SurfaceGeneratorId } from './contracts';
import {
  projectedStrokesFor,
  type GeneratorEvaluationInput,
  type GeneratorHostContext,
  type SurfaceGeneratorAdapter,
  type SurfaceGeneratorRuntime,
} from './generator-adapter';
import {
  surfaceGenerator,
  type SurfaceGeneratorCapabilities,
  type SurfaceGeneratorDescriptor,
} from './generator-catalog';
import { SurfaceDocument } from './surface-document';
import { SurfaceProjector } from './surface-projector';

type AnyAdapter = SurfaceGeneratorAdapter<any>;
type AnyRuntime = SurfaceGeneratorRuntime<any>;

export interface GeneratorManagerHost {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  /** Generated roots are parented here; defaults to the scene. */
  readonly outputParent?: THREE.Object3D;
  /** The shared model/target root hidden while an exclusive generator is active. */
  readonly surfaceRoot?: THREE.Object3D;
  compile(object: THREE.Object3D): Promise<void>;
  setStatus(state: 'ready' | 'busy' | 'error', message: string): void;
}

export interface GeneratorManagerOptions {
  readonly document: SurfaceDocument;
  readonly projector: SurfaceProjector;
  readonly host: GeneratorManagerHost;
  readonly adapters: readonly AnyAdapter[];
  readonly activeGenerator?: SurfaceGeneratorId;
}

interface RuntimeEntry {
  readonly adapter: AnyAdapter;
  readonly descriptor: SurfaceGeneratorDescriptor;
  readonly outputRoot: THREE.Group;
  readonly runtime: AnyRuntime;
  settings: unknown;
  visible: boolean;
  controller: AbortController | null;
  pending: Promise<void> | null;
}

/**
 * Owns generator runtimes while the SurfaceDocument remains the sole source of
 * authored strokes. Switching tools changes visibility/capabilities only: it
 * never deletes document state or recreates inactive runtimes.
 */
export class GeneratorManager {
  private readonly document: SurfaceDocument;
  private readonly projector: SurfaceProjector;
  private readonly host: GeneratorManagerHost;
  private readonly entries = new Map<SurfaceGeneratorId, RuntimeEntry>();
  private readonly unsubscribe: () => void;
  private activeId: SurfaceGeneratorId;
  private disposed = false;

  constructor(options: GeneratorManagerOptions) {
    this.document = options.document;
    this.projector = options.projector;
    this.host = options.host;

    for (const adapter of options.adapters) {
      const id = adapter.descriptor.id;
      if (this.entries.has(id)) throw new Error(`Duplicate surface generator adapter: ${id}`);
      // The catalog is the canonical capabilities source. This also rejects a
      // stale/custom id before it can create scene resources.
      const descriptor = surfaceGenerator(id);
      const outputRoot = new THREE.Group();
      outputRoot.name = `Surface generator · ${descriptor.label}`;
      (options.host.outputParent ?? options.host.scene).add(outputRoot);
      const runtimeHost: GeneratorHostContext = {
        scene: options.host.scene,
        camera: options.host.camera,
        outputRoot,
        compile: (object) => options.host.compile(object),
        setStatus: (state, message) => options.host.setStatus(state, message),
      };
      const settings = adapter.defaultSettings;
      const runtime = adapter.createRuntime(runtimeHost, settings);
      this.entries.set(id, {
        adapter,
        descriptor,
        outputRoot,
        runtime,
        settings,
        visible: false,
        controller: null,
        pending: null,
      });
    }

    const initial = options.activeGenerator ?? options.adapters[0]?.descriptor.id;
    if (!initial || !this.entries.has(initial)) {
      this.disposeEntries();
      throw new Error(initial
        ? `No adapter registered for active surface generator: ${initial}`
        : 'GeneratorManager requires at least one adapter');
    }
    this.activeId = initial;
    this.applyVisibility();
    this.unsubscribe = this.document.subscribe((change) => this.onDocumentChange(change));
    void this.reconcile();
  }

  get activeGenerator(): SurfaceGeneratorId {
    return this.activeId;
  }

  /** Always read capabilities from the canonical catalog, never adapter-local copies. */
  get activeCapabilities(): SurfaceGeneratorCapabilities {
    return surfaceGenerator(this.activeId).capabilities;
  }

  get activeDescriptor(): SurfaceGeneratorDescriptor {
    return surfaceGenerator(this.activeId);
  }

  outputRoot(generatorId: SurfaceGeneratorId): THREE.Group | null {
    return this.entries.get(generatorId)?.outputRoot ?? null;
  }

  settingsFor<Settings>(generatorId: SurfaceGeneratorId): Readonly<Settings> | undefined {
    return this.entries.get(generatorId)?.settings as Readonly<Settings> | undefined;
  }

  async setActiveGenerator(generatorId: SurfaceGeneratorId): Promise<void> {
    this.assertLive();
    this.entry(generatorId);
    this.activeId = generatorId;
    this.applyVisibility();
    await this.reconcile(generatorId);
  }

  async setSettings<Settings>(
    generatorId: SurfaceGeneratorId,
    settings: Readonly<Settings>,
  ): Promise<void> {
    this.assertLive();
    const entry = this.entry(generatorId);
    entry.settings = settings;
    entry.runtime.setSettings(settings);
    await this.reconcile(generatorId);
  }

  /**
   * Reconcile one generator, or every generator that can currently contribute
   * output. Inactive stroke outputs remain live; inactive ground generators are
   * deferred until selected so Tree is not built during ordinary startup.
   */
  async reconcile(generatorId?: SurfaceGeneratorId): Promise<void> {
    this.assertLive();
    const ids = generatorId ? [generatorId] : this.relevantGeneratorIds();
    await Promise.all(ids.map((id) => this.reconcileOne(this.entry(id))));
  }

  update(dt: number, elapsed: number): void {
    if (this.disposed) return;
    for (const entry of this.entries.values()) {
      if (entry.visible) entry.runtime.update?.(dt, elapsed);
    }
  }

  /** Test/integration hook for awaiting document-triggered async evaluations. */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.pending).filter(Boolean));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.disposeEntries();
    if (this.host.surfaceRoot) this.host.surfaceRoot.visible = true;
  }

  private relevantGeneratorIds(): SurfaceGeneratorId[] {
    const ids = new Set<SurfaceGeneratorId>([this.activeId]);
    for (const stroke of this.document.snapshot.strokes) {
      if (this.entries.has(stroke.generatorId)) ids.add(stroke.generatorId);
    }
    return [...ids];
  }

  private async reconcileOne(entry: RuntimeEntry): Promise<void> {
    entry.controller?.abort();
    const controller = new AbortController();
    entry.controller = controller;
    const snapshot = this.document.snapshot;
    this.projector.selectTarget(snapshot.target);
    const input: GeneratorEvaluationInput = {
      documentRevision: snapshot.revision,
      surfaceRevision: snapshot.surfaceRevision,
      strokes: entry.descriptor.capabilities.input === 'surface-strokes'
        ? projectedStrokesFor(snapshot, entry.descriptor.id, this.projector)
        : [],
      targets: this.projector.selectedTargets(),
      drawingArea: snapshot.drawingArea,
      signal: controller.signal,
    };

    let pending: Promise<void>;
    try {
      pending = Promise.resolve(entry.runtime.reconcile(input));
    } catch (error) {
      pending = Promise.reject(error);
    }
    const observed = pending.catch((error: unknown) => {
      if (controller.signal.aborted || this.disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.host.setStatus('error', `${entry.descriptor.label}: ${message}`);
    }).finally(() => {
      if (entry.controller === controller) entry.controller = null;
      if (entry.pending === observed) entry.pending = null;
    });
    entry.pending = observed;
    await observed;
  }

  private onDocumentChange(change: SurfaceDocumentChange): void {
    if (this.disposed || change.kind === 'selection') return;
    const ids = new Set<SurfaceGeneratorId>();
    if (change.kind === 'strokes') {
      for (const strokeId of change.affectedStrokeIds) {
        const stroke = change.after.strokes.find(({ id }) => id === strokeId)
          ?? change.before.strokes.find(({ id }) => id === strokeId);
        if (stroke && this.entries.has(stroke.generatorId)) ids.add(stroke.generatorId);
      }
    } else if (change.kind === 'surface') {
      for (const id of this.relevantGeneratorIds()) ids.add(id);
    } else {
      // Target and drawing-area changes can alter every projected evaluation.
      for (const stroke of change.after.strokes) {
        if (this.entries.has(stroke.generatorId)) ids.add(stroke.generatorId);
      }
    }
    if (ids.size) void Promise.all([...ids].map((id) => this.reconcileOne(this.entry(id))));
  }

  private applyVisibility(): void {
    const exclusive = surfaceGenerator(this.activeId).capabilities.sceneMode === 'exclusive';
    for (const [id, entry] of this.entries) {
      const visible = exclusive
        ? id === this.activeId
        : entry.descriptor.capabilities.sceneMode === 'overlay';
      entry.visible = visible;
      entry.outputRoot.visible = visible;
      entry.runtime.setVisible(visible);
    }
    if (this.host.surfaceRoot) this.host.surfaceRoot.visible = !exclusive;
  }

  private entry(generatorId: SurfaceGeneratorId): RuntimeEntry {
    const entry = this.entries.get(generatorId);
    if (!entry) throw new Error(`No adapter registered for surface generator: ${generatorId}`);
    return entry;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('GeneratorManager has been disposed');
  }

  private disposeEntries(): void {
    for (const entry of this.entries.values()) {
      entry.controller?.abort();
      entry.controller = null;
      entry.pending = null;
      entry.runtime.dispose();
      entry.outputRoot.removeFromParent();
    }
    this.entries.clear();
  }
}
