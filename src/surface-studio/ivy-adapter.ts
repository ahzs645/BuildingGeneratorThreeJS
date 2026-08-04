import * as THREE from 'three/webgpu';
import {
  IvyPlant,
  defaultIvySettings,
  type IvySettings,
  type SurfaceSample as IvySurfaceSample,
} from '../vegetation-generator/ivy';
import { surfaceGenerator } from './generator-catalog';
import type {
  GeneratorEvaluationInput,
  GeneratorHostContext,
  ProjectedSurfaceStroke,
  SurfaceGeneratorAdapter,
  SurfaceGeneratorRuntime,
} from './generator-adapter';

export interface IvyPlantRuntime {
  readonly group: THREE.Group;
  update(dt: number): void;
  updateLeaves(elapsed: number): void;
  dispose(): void;
}

export type IvyPlantFactory = (
  samples: IvySurfaceSample[],
  seed: number,
  settings: IvySettings,
  targets: THREE.Object3D[],
) => IvyPlantRuntime;

interface LiveIvyStroke {
  readonly signature: string;
  readonly plant: IvyPlantRuntime;
}

class IvyRuntime implements SurfaceGeneratorRuntime<IvySettings> {
  private readonly live = new Map<number, LiveIvyStroke>();
  private settingsDirty = false;
  private visible = true;

  constructor(
    private readonly host: GeneratorHostContext,
    private readonly createPlant: IvyPlantFactory,
    private settings: Readonly<IvySettings>,
  ) {}

  setSettings(settings: Readonly<IvySettings>): void {
    this.settings = settings;
    this.settingsDirty = true;
  }

  reconcile(input: GeneratorEvaluationInput): void {
    if (input.signal.aborted) return;
    if (this.settingsDirty) {
      this.disposePlants();
      this.settingsDirty = false;
    }

    const retained = new Set(input.strokes.map(({ id }) => id));
    for (const [id, item] of this.live) {
      if (!retained.has(id)) this.remove(id, item);
    }

    const targets = input.targets.map(({ mesh }) => mesh);
    for (const stroke of input.strokes) {
      const signature = ivySignature(stroke);
      const existing = this.live.get(stroke.id);
      if (existing?.signature === signature) continue;
      if (existing) this.remove(stroke.id, existing);
      const samples = stroke.points.map((point) => ({
        position: point.worldPosition.clone(),
        normal: point.worldNormal.clone(),
      }));
      const plant = this.createPlant(samples, stroke.seed, this.settings as IvySettings, targets);
      plant.group.visible = this.visible;
      this.host.outputRoot.add(plant.group);
      this.live.set(stroke.id, { signature, plant });
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.host.outputRoot.visible = visible;
  }

  update(dt: number, elapsed: number): void {
    if (!this.visible) return;
    for (const { plant } of this.live.values()) {
      plant.update(dt);
      plant.updateLeaves(elapsed);
    }
  }

  dispose(): void {
    this.disposePlants();
  }

  private remove(id: number, item: LiveIvyStroke): void {
    item.plant.group.removeFromParent();
    item.plant.dispose();
    this.live.delete(id);
  }

  private disposePlants(): void {
    for (const [id, item] of [...this.live]) this.remove(id, item);
  }
}

const defaultPlantFactory: IvyPlantFactory = (samples, seed, settings, targets) =>
  new IvyPlant(samples, seed, settings, targets);

export function createIvyAdapter(
  createPlant: IvyPlantFactory = defaultPlantFactory,
): SurfaceGeneratorAdapter<IvySettings> {
  return {
    descriptor: surfaceGenerator('ivy'),
    defaultSettings: defaultIvySettings,
    createRuntime(host, initialSettings) {
      return new IvyRuntime(host, createPlant, initialSettings);
    },
  };
}

export const ivyAdapter = createIvyAdapter();

function ivySignature(stroke: ProjectedSurfaceStroke): string {
  const parts = [String(stroke.seed)];
  for (const point of stroke.points) {
    parts.push(
      point.targetId,
      point.worldPosition.x.toPrecision(12),
      point.worldPosition.y.toPrecision(12),
      point.worldPosition.z.toPrecision(12),
      point.worldNormal.x.toPrecision(8),
      point.worldNormal.y.toPrecision(8),
      point.worldNormal.z.toPrecision(8),
    );
  }
  return parts.join('|');
}

