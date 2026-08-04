import type { PaintMode, StrokeInstance } from '../geometry-painter/modes/mode';
import type { SurfaceGeneratorDescriptor } from './generator-catalog';
import {
  toPaintModeSamples,
  type GeneratorEvaluationInput,
  type GeneratorHostContext,
  type ProjectedSurfaceStroke,
  type SurfaceGeneratorAdapter,
  type SurfaceGeneratorRuntime,
} from './generator-adapter';

interface LivePaintStroke {
  readonly signature: string;
  readonly instance: StrokeInstance;
}

/**
 * Thin runtime over the existing procedural PaintMode contract. It reconciles
 * stable document stroke ids, so selecting another tool does not destroy old
 * output and editing one stroke rebuilds only that stroke.
 */
class PaintModeRuntime<Settings> implements SurfaceGeneratorRuntime<Settings> {
  private readonly live = new Map<number, LivePaintStroke>();
  private settingsDirty = false;
  private visible = true;

  constructor(
    private readonly host: GeneratorHostContext,
    private readonly mode: PaintMode<Settings>,
    private settings: Readonly<Settings>,
  ) {}

  setSettings(settings: Readonly<Settings>): void {
    this.settings = settings;
    this.settingsDirty = false;
    for (const { instance } of this.live.values()) {
      if (instance.applySettings) instance.applySettings(settings);
      else this.settingsDirty = true;
    }
  }

  reconcile(input: GeneratorEvaluationInput): void {
    if (input.signal.aborted) return;
    if (this.settingsDirty) {
      this.disposeStrokes();
      this.settingsDirty = false;
    }

    const retained = new Set(input.strokes.map(({ id }) => id));
    for (const [id, item] of this.live) {
      if (!retained.has(id)) this.remove(id, item);
    }

    for (const stroke of input.strokes) {
      const signature = strokeSignature(stroke);
      const existing = this.live.get(stroke.id);
      if (existing?.signature === signature) continue;
      if (existing) this.remove(stroke.id, existing);
      const instance = this.mode.createStroke(
        toPaintModeSamples(stroke, this.host.outputRoot),
        stroke.seed,
        this.settings as Settings,
      );
      instance.group.visible = this.visible;
      this.host.outputRoot.add(instance.group);
      this.live.set(stroke.id, { signature, instance });
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.host.outputRoot.visible = visible;
  }

  update(dt: number, elapsed: number): void {
    if (!this.visible) return;
    for (const { instance } of this.live.values()) instance.update(dt, elapsed);
  }

  dispose(): void {
    this.disposeStrokes();
  }

  private remove(id: number, item: LivePaintStroke): void {
    item.instance.group.removeFromParent();
    item.instance.dispose();
    this.live.delete(id);
  }

  private disposeStrokes(): void {
    for (const [id, item] of [...this.live]) this.remove(id, item);
  }
}

export function createPaintModeAdapter<Settings>(
  descriptor: SurfaceGeneratorDescriptor,
  mode: PaintMode<Settings>,
  defaultSettings: Readonly<Settings>,
): SurfaceGeneratorAdapter<Settings> {
  if (descriptor.capabilities.input !== 'surface-strokes') {
    throw new Error(`${descriptor.id} cannot use the surface PaintMode adapter`);
  }
  return {
    descriptor,
    defaultSettings,
    createRuntime(host, initialSettings) {
      return new PaintModeRuntime(host, mode, initialSettings);
    },
  };
}

function strokeSignature(stroke: ProjectedSurfaceStroke): string {
  const parts = [String(stroke.seed), stroke.cyclic ? '1' : '0'];
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

