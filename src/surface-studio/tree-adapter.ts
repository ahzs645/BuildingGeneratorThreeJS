import * as THREE from 'three/webgpu';
import {
  TreePlant,
  defaultTreeSettings,
  type TreeSettings,
} from '../vegetation-generator/tree';
import { surfaceGenerator } from './generator-catalog';
import type {
  GeneratorEvaluationInput,
  GeneratorHostContext,
  SurfaceGeneratorAdapter,
  SurfaceGeneratorRuntime,
} from './generator-adapter';

export interface TreePlantRuntime {
  readonly group: THREE.Group;
  update(dt: number): void;
  updateLeaves(elapsed: number): void;
  dispose(): void;
}

export type TreePlantFactory = (settings: TreeSettings, seed: number) => TreePlantRuntime;

class TreeRuntime implements SurfaceGeneratorRuntime<TreeSettings> {
  private tree: TreePlantRuntime | null = null;
  private settingsDirty = true;
  private visible = false;
  private ready = false;
  private disposed = false;
  private generation = 0;

  constructor(
    private readonly host: GeneratorHostContext,
    private readonly createTree: TreePlantFactory,
    private settings: Readonly<TreeSettings>,
    private readonly seed: number,
  ) {}

  setSettings(settings: Readonly<TreeSettings>): void {
    this.settings = settings;
    this.settingsDirty = true;
  }

  reconcile(input: GeneratorEvaluationInput): void {
    if (input.signal.aborted || this.disposed) return;
    if (!this.tree || this.settingsDirty) this.rebuild(input.signal);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.host.outputRoot.visible = visible;
    if (this.tree) this.tree.group.visible = visible && this.ready;
  }

  update(dt: number, elapsed: number): void {
    if (!this.visible || !this.ready || !this.tree?.group.visible) return;
    this.tree.update(dt);
    this.tree.updateLeaves(elapsed);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.disposeTree();
  }

  private rebuild(signal: AbortSignal): void {
    this.settingsDirty = false;
    this.ready = false;
    this.disposeTree();
    const tree = this.createTree(this.settings as TreeSettings, this.seed);
    const generation = ++this.generation;
    tree.group.visible = false;
    this.host.outputRoot.add(tree.group);
    this.tree = tree;
    this.host.setStatus('busy', 'Preparing the banyan tree… You can keep orbiting while it loads.');
    void this.host.compile(tree.group)
      .then(() => {
        if (this.disposed || signal.aborted || generation !== this.generation || this.tree !== tree) return;
        this.ready = true;
        tree.group.visible = this.visible;
        this.host.setStatus('ready', 'Banyan tree ready.');
      })
      .catch((error: unknown) => {
        if (this.disposed || signal.aborted || generation !== this.generation || this.tree !== tree) return;
        // Compilation is an optimization. Let the normal renderer path try the
        // object instead of making the generator permanently unavailable.
        this.ready = true;
        tree.group.visible = this.visible;
        this.host.setStatus('error', `Tree preparation fell back to normal rendering: ${String(error)}`);
      });
  }

  private disposeTree(): void {
    if (!this.tree) return;
    this.tree.group.removeFromParent();
    this.tree.dispose();
    this.tree = null;
  }
}

const defaultTreeFactory: TreePlantFactory = (settings, seed) => new TreePlant(settings, seed);

export function createTreeAdapter(
  createTree: TreePlantFactory = defaultTreeFactory,
  seed = 7777,
): SurfaceGeneratorAdapter<TreeSettings> {
  return {
    descriptor: surfaceGenerator('tree'),
    defaultSettings: defaultTreeSettings,
    createRuntime(host, initialSettings) {
      return new TreeRuntime(host, createTree, initialSettings, seed);
    },
  };
}

export const treeAdapter = createTreeAdapter();

