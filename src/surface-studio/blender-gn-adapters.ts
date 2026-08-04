import * as THREE from 'three/webgpu';
import type { Dump, TriSoup } from '../gnvm/index';
import type { TargetSurface } from '../surface-targets';
import type { DrawingAreaState } from './contracts';
import { surfaceGenerator } from './generator-catalog';
import type {
  GeneratorEvaluationInput,
  GeneratorHostContext,
  ProjectedSurfaceStroke,
  SurfaceGeneratorAdapter,
  SurfaceGeneratorRuntime,
} from './generator-adapter';

const CRAYON_SCALE = 20;

export interface GnCurvePayload {
  readonly points: number[][];
  readonly cyclic: boolean;
}

export interface ChromeCrayonSettings {
  readonly thickness: number;
  readonly peakHeight: number;
  readonly sigilize: number;
  readonly soften: number;
  readonly resolution: number;
  readonly spiro: number;
  readonly extrudeBase: number;
  readonly flatten: boolean;
  readonly color: THREE.ColorRepresentation;
}

export interface PeriodicBrushSettings {
  readonly spacing: number;
  readonly size: number;
  readonly color: THREE.ColorRepresentation;
}

export interface TypewriterSettings {
  readonly text: string;
  readonly fitStroke: boolean;
  readonly size: number;
  readonly offset: number;
  readonly color: THREE.ColorRepresentation;
}

export interface StampSettings {
  readonly assetId: string;
  readonly size: number;
  readonly spacing: number;
  readonly vertexBudget: number;
  readonly color: THREE.ColorRepresentation;
}

export interface StampAssetInfo {
  readonly id: string;
  readonly title: string;
  readonly object: string;
  readonly dump: string;
}

export const defaultChromeCrayonSettings: Readonly<ChromeCrayonSettings> = Object.freeze({
  thickness: 6,
  peakHeight: 10,
  sigilize: 0,
  soften: 3,
  resolution: 0.835,
  spiro: 1,
  extrudeBase: 1,
  flatten: false,
  color: 0xc7dcff,
});

export const defaultPeriodicBrushSettings: Readonly<PeriodicBrushSettings> = Object.freeze({
  spacing: 0.38,
  size: 0.012,
  color: 0xff8d68,
});

export const defaultTypewriterSettings: Readonly<TypewriterSettings> = Object.freeze({
  text: 'NODE DOJO',
  fitStroke: true,
  size: 0.35,
  offset: 0,
  color: 0xc7dcff,
});

export const defaultStampSettings: Readonly<StampSettings> = Object.freeze({
  assetId: '',
  size: 0.45,
  spacing: 0.6,
  vertexBudget: 400_000,
  color: 0xc7dcff,
});

interface WorkerInstallReply {
  readonly ok: true;
  readonly installed: string;
}

type WorkerEvaluationReply =
  | { readonly id: number; readonly ok: true; readonly soup: TriSoup }
  | { readonly id: number; readonly ok: false; readonly error: string };

interface WorkerMessageEvent<T = unknown> {
  readonly data: T;
}

export interface GnEvaluatorWorker {
  onmessage: ((event: WorkerMessageEvent) => void) | null;
  onerror: ((event: { readonly message: string }) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface GnEvaluationRequest {
  readonly dump: Dump;
  readonly object: string;
  readonly curves: readonly GnCurvePayload[];
  readonly overrides: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

interface PendingEvaluation {
  readonly reject: (error: Error) => void;
  readonly resolve: (soup: TriSoup) => void;
  readonly removeAbortListener: () => void;
}

/** A superseded GN evaluation is expected control flow, not a brush error. */
export class StaleGnEvaluationError extends Error {
  constructor(message = 'GN brush evaluation was superseded') {
    super(message);
    this.name = 'StaleGnEvaluationError';
  }
}

/**
 * Persistent client for blend-import-worker's install/evaluate protocol.
 *
 * The worker has one dump slot. Repeated evaluations therefore transfer a
 * multi-megabyte dump only once, while a newer request immediately retires the
 * previous result even though the worker itself cannot interrupt GN-VM yet.
 */
export class GnBrushEvaluatorClient {
  private worker: GnEvaluatorWorker | null = null;
  private installedDump: Dump | null = null;
  private installedId = '';
  private installPromise: Promise<void> | null = null;
  private installResolve: (() => void) | null = null;
  private installReject: ((error: Error) => void) | null = null;
  private installCounter = 0;
  private requestCounter = 0;
  private latestRequestId = 0;
  private readonly pending = new Map<number, PendingEvaluation>();
  private disposed = false;

  constructor(
    private readonly createWorker: () => GnEvaluatorWorker = () => new Worker(
      new URL('../blend-import-worker.ts', import.meta.url),
      { type: 'module', name: 'surface-studio-gnvm' },
    ) as unknown as GnEvaluatorWorker,
  ) {}

  async evaluate(request: GnEvaluationRequest): Promise<TriSoup> {
    if (this.disposed) throw new Error('GN brush evaluator is disposed');
    if (request.signal?.aborted) throw abortError();
    await this.ensureInstalled(request.dump);
    if (request.signal?.aborted) throw abortError();

    const id = ++this.requestCounter;
    this.latestRequestId = id;
    for (const [pendingId, pending] of this.pending) {
      pending.removeAbortListener();
      pending.reject(new StaleGnEvaluationError());
      this.pending.delete(pendingId);
    }

    return new Promise<TriSoup>((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(id);
        reject(abortError());
      };
      request.signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        removeAbortListener: () => request.signal?.removeEventListener('abort', abort),
      });
      this.requireWorker().postMessage({
        kind: 'evaluate',
        installId: this.installedId,
        id,
        object: request.object,
        curves: request.curves,
        overrides: request.overrides,
      });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error('GN brush evaluator is disposed');
    this.installReject?.(error);
    for (const item of this.pending.values()) {
      item.removeAbortListener();
      item.reject(error);
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private async ensureInstalled(dump: Dump): Promise<void> {
    if (this.installedDump === dump && this.installedId) return;
    if (this.installPromise) {
      await this.installPromise;
      if (this.installedDump === dump && this.installedId) return;
    }

    const installId = `surface-studio-${++this.installCounter}`;
    this.installedDump = dump;
    this.installedId = installId;
    this.installPromise = new Promise<void>((resolve, reject) => {
      this.installResolve = resolve;
      this.installReject = reject;
    });
    this.requireWorker().postMessage({ kind: 'install', installId, dump });
    try {
      await this.installPromise;
    } catch (error) {
      this.installedDump = null;
      this.installedId = '';
      throw error;
    } finally {
      this.installPromise = null;
      this.installResolve = null;
      this.installReject = null;
    }
  }

  private requireWorker(): GnEvaluatorWorker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (event) => this.receive(event.data as WorkerInstallReply | WorkerEvaluationReply);
    worker.onerror = (event) => this.fail(new Error(event.message));
    this.worker = worker;
    return worker;
  }

  private receive(reply: WorkerInstallReply | WorkerEvaluationReply): void {
    if ('installed' in reply) {
      if (reply.installed !== this.installedId) {
        this.installReject?.(new Error(`Unexpected GN dump installation: ${reply.installed}`));
      } else {
        this.installResolve?.();
      }
      return;
    }
    const item = this.pending.get(reply.id);
    if (!item) return;
    this.pending.delete(reply.id);
    item.removeAbortListener();
    if (reply.id !== this.latestRequestId) item.reject(new StaleGnEvaluationError());
    else if (reply.ok) item.resolve(reply.soup);
    else item.reject(new Error(reply.error));
  }

  private fail(error: Error): void {
    this.installReject?.(error);
    for (const item of this.pending.values()) {
      item.removeAbortListener();
      item.reject(error);
    }
    this.pending.clear();
  }
}

export interface ChromeCurveLayout {
  readonly stroke: ProjectedSurfaceStroke;
  readonly start: number;
  readonly length: number;
}

export interface ChromeSigilLayout {
  readonly center: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly u: THREE.Vector3;
  readonly v: THREE.Vector3;
  readonly size: number;
}

/** Periodic Brush consumes the durable projected points directly in world space. */
export function periodicCurvePayload(strokes: readonly ProjectedSurfaceStroke[]): GnCurvePayload[] {
  return strokes.filter(hasCurve).map((stroke) => ({
    cyclic: stroke.cyclic,
    points: stroke.points.map(({ worldPosition }) => worldPosition.toArray()),
  }));
}

/**
 * Chrome Crayon is evaluated along a flat distance axis, matching Brush Lab.
 * `wrapChromeCrayonSoup` then bends the evaluated mesh back over the stroke's
 * per-point projected normals.
 */
export function chromeCrayonCurvePayload(strokes: readonly ProjectedSurfaceStroke[]): {
  curves: GnCurvePayload[];
  layouts: ChromeCurveLayout[];
} {
  const curves: GnCurvePayload[] = [];
  const layouts: ChromeCurveLayout[] = [];
  let cursor = 0;
  for (const stroke of strokes.filter(hasCurve)) {
    let distance = 0;
    const points: number[][] = [[cursor * CRAYON_SCALE, 0, 0]];
    for (let index = 1; index < stroke.points.length; index++) {
      distance += stroke.points[index].worldPosition.distanceTo(stroke.points[index - 1].worldPosition);
      points.push([(cursor + distance) * CRAYON_SCALE, 0, 0]);
    }
    if (stroke.cyclic && stroke.points.length > 2) {
      distance += stroke.points.at(-1)!.worldPosition.distanceTo(stroke.points[0].worldPosition);
    }
    curves.push({ points, cyclic: stroke.cyclic });
    layouts.push({ stroke, start: cursor, length: distance });
    cursor += distance + 1;
  }
  return { curves, layouts };
}

/** Build the normalized planar input used by Brush Lab's unique-sigil mode. */
export function chromeSigilCurvePayload(
  strokes: readonly ProjectedSurfaceStroke[],
  drawingArea: DrawingAreaState | null,
): { curves: GnCurvePayload[]; layout: ChromeSigilLayout } {
  const useful = strokes.filter(hasCurve);
  const points = useful.flatMap((stroke) => stroke.points);
  const frame = sigilFrame(points, drawingArea);
  const local = useful.map((stroke) => stroke.points.map((point) => {
    if (drawingArea && point.areaPosition) return [point.areaPosition[0], point.areaPosition[1], 0];
    const delta = point.worldPosition.clone().sub(frame.center);
    return [delta.dot(frame.u), delta.dot(frame.v), 0];
  }));
  const flat = local.flat();
  const minX = Math.min(...flat.map((point) => point[0]));
  const maxX = Math.max(...flat.map((point) => point[0]));
  const minY = Math.min(...flat.map((point) => point[1]));
  const maxY = Math.max(...flat.map((point) => point[1]));
  const sourceSpan = Math.max(maxX - minX, maxY - minY, 1e-9);
  const scale = 96 / sourceSpan;
  const curves = local.map((curve) => ({
    cyclic: false,
    points: curve.map((point) => [
      Number((point[0] * scale).toFixed(6)),
      Number((point[1] * scale).toFixed(6)),
      0,
    ]),
  }));
  const lineLength = useful.reduce((total, stroke) => total + strokeLength(stroke), 0);
  return {
    curves,
    layout: {
      ...frame,
      size: drawingArea ? Math.min(...drawingArea.size) * 0.82 : Math.min(lineLength * 0.72, 2.6),
    },
  };
}

/** Bend flat Chrome Crayon output into the shared projected-stroke frames. */
export function wrapChromeCrayonSoup(soup: TriSoup, layouts: readonly ChromeCurveLayout[]): TriSoup {
  if (!layouts.length) return soup;
  const position = soup.positions;
  const normal = soup.normals;
  for (let offset = 0; offset < position.length; offset += 3) {
    const x = position[offset] / CRAYON_SCALE;
    const layout = nearestLayout(layouts, x);
    const frame = frameAlongStroke(layout, x - layout.start);
    const y = position[offset + 1] / CRAYON_SCALE;
    const z = position[offset + 2] / CRAYON_SCALE;
    const world = frame.point.clone()
      .addScaledVector(frame.lateral, y)
      .addScaledVector(frame.normal, z);
    position.set(world.toArray(), offset);
    const worldNormal = frame.tangent.clone().multiplyScalar(normal[offset])
      .addScaledVector(frame.lateral, normal[offset + 1])
      .addScaledVector(frame.normal, normal[offset + 2])
      .normalize();
    normal.set(worldNormal.toArray(), offset);
  }
  return soup;
}

/** Conform one evaluated sigil stamp to the currently selected surface. */
export function projectChromeSigilSoup(
  soup: TriSoup,
  layout: ChromeSigilLayout,
  targets: readonly TargetSurface[],
): TriSoup {
  const { min, max } = soupBounds(soup);
  const span = Math.max(max[0] - min[0], max[1] - min[1], 1e-9);
  const heightSpan = Math.max(max[2] - min[2], 1e-9);
  const scale = layout.size / span;
  const centerX = (min[0] + max[0]) * 0.5;
  const centerY = (min[1] + max[1]) * 0.5;
  for (let index = 0; index < soup.positions.length; index += 3) {
    const planePoint = layout.center.clone()
      .addScaledVector(layout.u, (soup.positions[index] - centerX) * scale)
      .addScaledVector(layout.v, (soup.positions[index + 1] - centerY) * scale);
    const surface = closestTargetSurface(targets, planePoint);
    const point = surface?.point ?? planePoint;
    const normal = surface?.normal ?? layout.normal;
    point.addScaledVector(normal, ((soup.positions[index + 2] - min[2]) / heightSpan) * 0.09 + 0.012);
    soup.positions.set(point.toArray(), index);
    soup.normals.set(normal.toArray(), index);
  }
  return soup;
}

/** Renderer bridge used by either WebGL or WebGPU hosts. */
export function bufferGeometryFromGnSoup(soup: TriSoup, rebuildNormals = false): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(soup.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(soup.indices, 1));
  if (rebuildNormals) geometry.computeVertexNormals();
  else geometry.setAttribute('normal', new THREE.BufferAttribute(soup.normals, 3));
  for (const group of soup.groups) geometry.addGroup(group.start, group.count);
  return geometry;
}

/** Sweep one evaluated typewriter result through a projected stroke frame. */
export function typewriterGeometryAlongStroke(
  soup: TriSoup,
  layout: ChromeCurveLayout,
  settings: Pick<TypewriterSettings, 'fitStroke' | 'size' | 'offset'>,
): THREE.BufferGeometry {
  const source = soup.positions;
  const positions = new Float32Array(source.length);
  const { min, max } = soupBounds(soup);
  const scale = settings.fitStroke
    ? layout.length / Math.max(max[0] - min[0], 1e-9)
    : settings.size / Math.max(max[1] - min[1], 1e-9);
  const lateralCenter = (min[1] + max[1]) * 0.5;
  for (let index = 0; index < source.length; index += 3) {
    const frame = extendedFrameAlongStroke(layout, (source[index] - min[0]) * scale);
    const point = frame.point.clone()
      .addScaledVector(frame.lateral, (source[index + 1] - lateralCenter) * scale + settings.offset)
      .addScaledVector(frame.normal, (source[index + 2] - min[2]) * scale + 0.018);
    positions.set(point.toArray(), index);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(soup.indices.slice(), 1));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Rigidly repeat an evaluated reference object through one projected stroke.
 * Asset X follows the tangent, Y the lateral, and Blender Z the surface normal.
 */
export function stampsAlongProjectedStroke(
  soup: TriSoup,
  layout: ChromeCurveLayout,
  size: number,
  spacing: number,
  vertexBudget: number,
): { geometry: THREE.BufferGeometry; count: number; capped: boolean } | null {
  const source = soup.positions;
  const vertexCount = source.length / 3;
  if (!vertexCount || vertexBudget < vertexCount) return null;
  const { min, max } = soupBounds(soup);
  const footprint = Math.max(max[0] - min[0], max[1] - min[1], 1e-9);
  const scale = Math.max(size, 1e-6) / footprint;
  const centerX = (min[0] + max[0]) * 0.5;
  const centerY = (min[1] + max[1]) * 0.5;
  const safeSpacing = Math.max(spacing, 1e-6);
  const fitCount = Math.max(1, Math.floor((layout.length - size) / safeSpacing) + 1);
  const budgetCount = Math.floor(vertexBudget / vertexCount);
  const count = Math.max(1, Math.min(fitCount, budgetCount));
  const startDistance = (layout.length - (count - 1) * safeSpacing) * 0.5;
  const positions = new Float32Array(source.length * count);
  const indices = new Uint32Array(soup.indices.length * count);
  for (let stamp = 0; stamp < count; stamp++) {
    const frame = frameAlongStroke(layout, startDistance + stamp * safeSpacing);
    const vertexBase = stamp * vertexCount;
    const positionBase = stamp * source.length;
    for (let index = 0; index < source.length; index += 3) {
      const x = (source[index] - centerX) * scale;
      const y = (source[index + 1] - centerY) * scale;
      const z = (source[index + 2] - min[2]) * scale + 0.018;
      const point = frame.point.clone()
        .addScaledVector(frame.tangent, x)
        .addScaledVector(frame.lateral, y)
        .addScaledVector(frame.normal, z);
      positions.set(point.toArray(), positionBase + index);
    }
    const indexBase = stamp * soup.indices.length;
    for (let index = 0; index < soup.indices.length; index++) {
      indices[indexBase + index] = soup.indices[index] + vertexBase;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return { geometry, count, capped: count < fitCount };
}

export interface BlenderGnAdapterDependencies {
  readonly loadDump?: (kind: 'chrome-crayon' | 'periodic-brush') => Promise<Dump>;
  readonly createClient?: () => GnBrushEvaluatorClient;
}

export interface BlenderPlacementAdapterDependencies {
  readonly loadTypewriterDump?: () => Promise<Dump>;
  readonly createClient?: () => GnBrushEvaluatorClient;
  readonly loadStampAsset?: (assetId: string) => Promise<{ info: StampAssetInfo; soup: TriSoup }>;
}

type BrushKind = 'chrome-crayon' | 'periodic-brush';
type BrushSettings = ChromeCrayonSettings | PeriodicBrushSettings;

class BlenderGnRuntime<Settings extends BrushSettings> implements SurfaceGeneratorRuntime<Settings> {
  private readonly root = new THREE.Group();
  private readonly client: GnBrushEvaluatorClient;
  private settings: Readonly<Settings>;
  private visible = true;
  private revision = 0;
  private disposed = false;

  constructor(
    private readonly host: GeneratorHostContext,
    private readonly kind: BrushKind,
    settings: Readonly<Settings>,
    private readonly loadDump: (kind: BrushKind) => Promise<Dump>,
    createClient: () => GnBrushEvaluatorClient,
  ) {
    this.settings = settings;
    this.client = createClient();
    this.root.name = `Blender GN output · ${kind}`;
    host.outputRoot.add(this.root);
  }

  setSettings(settings: Readonly<Settings>): void {
    this.settings = settings;
  }

  async reconcile(input: GeneratorEvaluationInput): Promise<void> {
    if (input.signal.aborted || this.disposed) return;
    const revision = ++this.revision;
    const useful = input.strokes.filter(hasCurve);
    if (!useful.length) {
      this.clear();
      this.host.setStatus('ready', `Draw a stroke to evaluate ${this.label}`);
      return;
    }

    this.host.setStatus('busy', `Evaluating ${this.label} in GN-VM…`);
    try {
      const dump = await this.loadDump(this.kind);
      if (input.signal.aborted || revision !== this.revision || this.disposed) return;
      const sigil = this.kind === 'chrome-crayon'
        && (this.settings as Readonly<ChromeCrayonSettings>).sigilize > 0
        ? chromeSigilCurvePayload(useful, input.drawingArea)
        : null;
      const chrome = this.kind === 'chrome-crayon' && !sigil ? chromeCrayonCurvePayload(useful) : null;
      const soup = await this.client.evaluate({
        dump,
        object: this.kind === 'chrome-crayon' ? 'CHROME CRAYON OBJECT' : 'PERIODIC BRUSH',
        curves: sigil?.curves ?? chrome?.curves ?? periodicCurvePayload(useful),
        overrides: overridesFor(this.kind, this.settings),
        signal: input.signal,
      });
      if (input.signal.aborted || revision !== this.revision || this.disposed) return;
      if (sigil) projectChromeSigilSoup(soup, sigil.layout, input.targets);
      else if (chrome) wrapChromeCrayonSoup(soup, chrome.layouts);
      const geometry = bufferGeometryFromGnSoup(soup, this.kind === 'chrome-crayon');
      const color = this.settings.color;
      const material = this.kind === 'chrome-crayon'
        ? new THREE.MeshStandardMaterial({ color, metalness: 0.92, roughness: 0.16 })
        : new THREE.MeshStandardMaterial({ color, metalness: 0.18, roughness: 0.42 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = this.label;
      mesh.visible = this.visible;
      await this.host.compile(mesh);
      if (input.signal.aborted || revision !== this.revision || this.disposed) {
        geometry.dispose();
        material.dispose();
        return;
      }
      this.clear();
      this.root.add(mesh);
      this.host.setStatus('ready', `${this.label} evaluated · ${soup.stats.verts.toLocaleString()} verts`);
    } catch (error) {
      if (input.signal.aborted || error instanceof StaleGnEvaluationError || revision !== this.revision || this.disposed) return;
      this.host.setStatus('error', error instanceof Error ? error.message : String(error));
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.visible = visible;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    this.client.dispose();
    this.clear();
    this.root.removeFromParent();
  }

  private get label(): string {
    return this.kind === 'chrome-crayon' ? 'Chrome Crayon' : 'Periodic Brush';
  }

  private clear(): void {
    for (const child of [...this.root.children]) {
      child.removeFromParent();
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) material.dispose();
      }
    }
  }
}

let chromeDumpPromise: Promise<Dump> | null = null;
let periodicDumpPromise: Promise<Dump> | null = null;

/** Replace the live Chrome graph resource; the evaluator reinstalls on identity change. */
export function installChromeCrayonDump(dump: Dump): void {
  chromeDumpPromise = Promise.resolve(dump);
}

function defaultDumpLoader(kind: BrushKind): Promise<Dump> {
  const current = kind === 'chrome-crayon' ? chromeDumpPromise : periodicDumpPromise;
  if (current) return current;
  const relative = kind === 'chrome-crayon' ? 'dojo/crayon/dump.json' : 'dojo/periodic-brush/dump.json';
  const base = import.meta.env?.BASE_URL ?? '/';
  const url = `${base.endsWith('/') ? base : `${base}/`}${relative}`;
  const promise = fetch(url).then((response) => {
    if (!response.ok) throw new Error(`${kind} graph failed to load (${response.status})`);
    return response.json() as Promise<Dump>;
  });
  promise.catch(() => {
    if (kind === 'chrome-crayon') chromeDumpPromise = null;
    else periodicDumpPromise = null;
  });
  if (kind === 'chrome-crayon') chromeDumpPromise = promise;
  else periodicDumpPromise = promise;
  return promise;
}

export function createChromeCrayonAdapter(
  dependencies: BlenderGnAdapterDependencies = {},
): SurfaceGeneratorAdapter<ChromeCrayonSettings> {
  return createAdapter('chrome-crayon', defaultChromeCrayonSettings, dependencies);
}

export function createPeriodicBrushAdapter(
  dependencies: BlenderGnAdapterDependencies = {},
): SurfaceGeneratorAdapter<PeriodicBrushSettings> {
  return createAdapter('periodic-brush', defaultPeriodicBrushSettings, dependencies);
}

export const chromeCrayonAdapter = createChromeCrayonAdapter();
export const periodicBrushAdapter = createPeriodicBrushAdapter();

class TypewriterRuntime implements SurfaceGeneratorRuntime<TypewriterSettings> {
  private readonly root = new THREE.Group();
  private readonly client: GnBrushEvaluatorClient;
  private readonly soupCache = new Map<string, TriSoup>();
  private settings: Readonly<TypewriterSettings>;
  private revision = 0;
  private visible = true;
  private disposed = false;

  constructor(
    private readonly host: GeneratorHostContext,
    settings: Readonly<TypewriterSettings>,
    private readonly loadDump: () => Promise<Dump>,
    createClient: () => GnBrushEvaluatorClient,
  ) {
    this.settings = settings;
    this.client = createClient();
    this.root.name = 'Blender GN output · typewriter';
    host.outputRoot.add(this.root);
  }

  setSettings(settings: Readonly<TypewriterSettings>): void {
    this.settings = settings;
  }

  async reconcile(input: GeneratorEvaluationInput): Promise<void> {
    if (input.signal.aborted || this.disposed) return;
    const revision = ++this.revision;
    const text = this.settings.text.trim();
    const layouts = chromeCrayonCurvePayload(input.strokes).layouts;
    if (!text || !layouts.length) {
      clearGeneratedRoot(this.root);
      this.host.setStatus('ready', text ? 'Draw a stroke to place the text' : 'Type some text first');
      return;
    }
    this.host.setStatus('busy', 'Evaluating typewriter glyphs in GN-VM…');
    try {
      let soup = this.soupCache.get(text);
      if (!soup) {
        soup = await this.client.evaluate({
          dump: await this.loadDump(),
          object: '_Typewriter Node Container',
          curves: [],
          overrides: { __frame: 2400, 'Text input': text, 'Keyframe to Backspace': 100000 },
          signal: input.signal,
        });
        if (!input.signal.aborted) this.soupCache.set(text, soup);
      }
      if (input.signal.aborted || revision !== this.revision || this.disposed) return;
      const group = new THREE.Group();
      const material = chromeMaterial(this.settings.color);
      let vertices = 0;
      for (const layout of layouts) {
        const geometry = typewriterGeometryAlongStroke(soup, layout, this.settings);
        vertices += geometry.getAttribute('position').count;
        group.add(new THREE.Mesh(geometry, material));
      }
      group.visible = this.visible;
      await this.host.compile(group);
      if (input.signal.aborted || revision !== this.revision || this.disposed) {
        disposeGeneratedObject(group);
        return;
      }
      clearGeneratedRoot(this.root);
      this.root.add(group);
      this.host.setStatus('ready', `Typewriter text wrapped onto the surface · ${vertices.toLocaleString()} verts`);
    } catch (error) {
      if (input.signal.aborted || error instanceof StaleGnEvaluationError || revision !== this.revision || this.disposed) return;
      this.host.setStatus('error', error instanceof Error ? error.message : String(error));
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.visible = visible;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    this.client.dispose();
    clearGeneratedRoot(this.root);
    this.root.removeFromParent();
  }
}

class StampRuntime implements SurfaceGeneratorRuntime<StampSettings> {
  private readonly root = new THREE.Group();
  private settings: Readonly<StampSettings>;
  private revision = 0;
  private visible = true;
  private disposed = false;

  constructor(
    private readonly host: GeneratorHostContext,
    settings: Readonly<StampSettings>,
    private readonly loadAsset: (assetId: string) => Promise<{ info: StampAssetInfo; soup: TriSoup }>,
  ) {
    this.settings = settings;
    this.root.name = 'Blender GN output · stamp';
    host.outputRoot.add(this.root);
  }

  setSettings(settings: Readonly<StampSettings>): void {
    this.settings = settings;
  }

  async reconcile(input: GeneratorEvaluationInput): Promise<void> {
    if (input.signal.aborted || this.disposed) return;
    const revision = ++this.revision;
    const layouts = chromeCrayonCurvePayload(input.strokes).layouts;
    if (!this.settings.assetId || !layouts.length) {
      clearGeneratedRoot(this.root);
      this.host.setStatus('ready', this.settings.assetId ? 'Draw a stroke to place stamps' : 'Choose a reference object to stamp');
      return;
    }
    this.host.setStatus('busy', 'Evaluating stamp reference object in GN-VM…');
    try {
      const { info, soup } = await this.loadAsset(this.settings.assetId);
      if (input.signal.aborted || revision !== this.revision || this.disposed) return;
      const group = new THREE.Group();
      const material = chromeMaterial(this.settings.color);
      let budget = Math.max(0, Math.floor(this.settings.vertexBudget));
      let count = 0;
      let vertices = 0;
      let capped = false;
      for (const layout of layouts) {
        const result = stampsAlongProjectedStroke(soup, layout, this.settings.size, this.settings.spacing, budget);
        if (!result) {
          capped = true;
          continue;
        }
        count += result.count;
        capped ||= result.capped;
        const placedVertices = result.geometry.getAttribute('position').count;
        vertices += placedVertices;
        budget -= placedVertices;
        group.add(new THREE.Mesh(result.geometry, material));
      }
      group.visible = this.visible;
      await this.host.compile(group);
      if (input.signal.aborted || revision !== this.revision || this.disposed) {
        disposeGeneratedObject(group);
        return;
      }
      clearGeneratedRoot(this.root);
      this.root.add(group);
      this.host.setStatus('ready', `${info.title} · ${count} stamp${count === 1 ? '' : 's'} · ${vertices.toLocaleString()} verts${capped ? ' · capped' : ''}`);
    } catch (error) {
      if (input.signal.aborted || revision !== this.revision || this.disposed) return;
      this.host.setStatus('error', error instanceof Error ? error.message : String(error));
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.visible = visible;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    clearGeneratedRoot(this.root);
    this.root.removeFromParent();
  }
}

let typewriterDumpPromise: Promise<Dump> | null = null;
const stampAssetCache = new Map<string, Promise<{ info: StampAssetInfo; soup: TriSoup }>>();

function defaultTypewriterDumpLoader(): Promise<Dump> {
  typewriterDumpPromise ??= fetch(publicAssetUrl('dojo/typewriter/dump.json')).then((response) => {
    if (!response.ok) throw new Error(`Typewriter graph failed to load (${response.status})`);
    return response.json() as Promise<Dump>;
  });
  typewriterDumpPromise.catch(() => { typewriterDumpPromise = null; });
  return typewriterDumpPromise;
}

function defaultStampAssetLoader(assetId: string): Promise<{ info: StampAssetInfo; soup: TriSoup }> {
  let cached = stampAssetCache.get(assetId);
  if (cached) return cached;
  cached = import('../base-shape-catalog').then(async ({ evaluateLibraryShape, listLibraryShapes }) => {
    const info = (await listLibraryShapes()).find(({ id }) => id === assetId);
    if (!info) throw new Error(`Unknown stamp reference object: ${assetId}`);
    return { info, soup: await evaluateLibraryShape(info) };
  });
  cached.catch(() => stampAssetCache.delete(assetId));
  stampAssetCache.set(assetId, cached);
  return cached;
}

export function createTypewriterAdapter(
  dependencies: BlenderPlacementAdapterDependencies = {},
): SurfaceGeneratorAdapter<TypewriterSettings> {
  const loadDump = dependencies.loadTypewriterDump ?? defaultTypewriterDumpLoader;
  const createClient = dependencies.createClient ?? (() => new GnBrushEvaluatorClient());
  return {
    descriptor: surfaceGenerator('typewriter'),
    defaultSettings: defaultTypewriterSettings,
    createRuntime(host, settings) {
      return new TypewriterRuntime(host, settings, loadDump, createClient);
    },
  };
}

export function createStampAdapter(
  dependencies: BlenderPlacementAdapterDependencies = {},
): SurfaceGeneratorAdapter<StampSettings> {
  const loadAsset = dependencies.loadStampAsset ?? defaultStampAssetLoader;
  return {
    descriptor: surfaceGenerator('stamp'),
    defaultSettings: defaultStampSettings,
    createRuntime(host, settings) {
      return new StampRuntime(host, settings, loadAsset);
    },
  };
}

export const typewriterAdapter = createTypewriterAdapter();
export const stampAdapter = createStampAdapter();

function createAdapter<Settings extends BrushSettings>(
  kind: BrushKind,
  defaults: Readonly<Settings>,
  dependencies: BlenderGnAdapterDependencies,
): SurfaceGeneratorAdapter<Settings> {
  const loadDump = dependencies.loadDump ?? defaultDumpLoader;
  const createClient = dependencies.createClient ?? (() => new GnBrushEvaluatorClient());
  return {
    descriptor: surfaceGenerator(kind),
    defaultSettings: defaults,
    createRuntime(host, settings) {
      return new BlenderGnRuntime(host, kind, settings, loadDump, createClient);
    },
  };
}

function hasCurve(stroke: ProjectedSurfaceStroke): boolean {
  return stroke.points.length > 1;
}

function strokeLength(stroke: ProjectedSurfaceStroke): number {
  let length = 0;
  for (let index = 1; index < stroke.points.length; index++) {
    length += stroke.points[index].worldPosition.distanceTo(stroke.points[index - 1].worldPosition);
  }
  return length;
}

function sigilFrame(
  points: readonly ProjectedSurfaceStroke['points'][number][],
  drawingArea: DrawingAreaState | null,
): Omit<ChromeSigilLayout, 'size'> {
  if (drawingArea) {
    return {
      center: new THREE.Vector3().fromArray(drawingArea.center),
      normal: new THREE.Vector3().fromArray(drawingArea.normal).normalize(),
      u: new THREE.Vector3().fromArray(drawingArea.u).normalize(),
      v: new THREE.Vector3().fromArray(drawingArea.v).normalize(),
    };
  }
  const center = points.reduce(
    (sum, point) => sum.add(point.worldPosition),
    new THREE.Vector3(),
  ).multiplyScalar(1 / Math.max(points.length, 1));
  const normal = points.reduce(
    (sum, point) => sum.add(point.worldNormal),
    new THREE.Vector3(),
  ).normalize();
  if (normal.lengthSq() < 1e-9) normal.set(0, 0, 1);
  const first = points[0]?.worldPosition;
  const last = points.at(-1)?.worldPosition;
  const u = first && last ? last.clone().sub(first) : new THREE.Vector3(1, 0, 0);
  u.addScaledVector(normal, -u.dot(normal));
  if (u.lengthSq() < 1e-9) u.copy(Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).cross(normal);
  u.normalize();
  return { center, normal, u, v: normal.clone().cross(u).normalize() };
}

function closestTargetSurface(
  targets: readonly TargetSurface[],
  worldPoint: THREE.Vector3,
): { point: THREE.Vector3; normal: THREE.Vector3; distance: number } | null {
  let closest: { point: THREE.Vector3; normal: THREE.Vector3; distance: number } | null = null;
  for (const { mesh } of targets) {
    const geometry = mesh.geometry as THREE.BufferGeometry & {
      boundsTree?: { closestPointToPoint(point: THREE.Vector3): { point: THREE.Vector3; distance: number; faceIndex?: number } };
    };
    if (!geometry.boundsTree) continue;
    mesh.updateWorldMatrix(true, false);
    const localQuery = mesh.worldToLocal(worldPoint.clone());
    const hit = geometry.boundsTree.closestPointToPoint(localQuery);
    const localPoint = hit.point.clone();
    const point = mesh.localToWorld(localPoint.clone());
    const distance = point.distanceTo(worldPoint);
    if (closest && distance >= closest.distance) continue;
    let normal = new THREE.Vector3(0, 0, 1);
    if (hit.faceIndex !== undefined) {
      const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
      const index = geometry.index;
      const offset = hit.faceIndex * 3;
      const a = index ? index.getX(offset) : offset;
      const b = index ? index.getX(offset + 1) : offset + 1;
      const c = index ? index.getX(offset + 2) : offset + 2;
      normal = new THREE.Triangle(
        new THREE.Vector3().fromBufferAttribute(positions, a),
        new THREE.Vector3().fromBufferAttribute(positions, b),
        new THREE.Vector3().fromBufferAttribute(positions, c),
      ).getNormal(new THREE.Vector3()).applyNormalMatrix(
        new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld),
      ).normalize();
    }
    closest = { point, normal, distance };
  }
  return closest;
}

function overridesFor(kind: BrushKind, settings: Readonly<BrushSettings>): Record<string, unknown> {
  if (kind === 'chrome-crayon') {
    const chrome = settings as Readonly<ChromeCrayonSettings>;
    return {
      'Line Thiccness': chrome.thickness,
      'Peak Height': chrome.peakHeight,
      Sigilize: chrome.sigilize,
      Soften: chrome.soften,
      resolution: chrome.resolution,
      SPIRO: chrome.spiro,
      'Extrude Base': chrome.extrudeBase,
      FLATTEN: chrome.flatten,
    };
  }
  const periodic = settings as Readonly<PeriodicBrushSettings>;
  return { 'Dot Distance': periodic.spacing, 'dot size': periodic.size };
}

function nearestLayout(layouts: readonly ChromeCurveLayout[], distance: number): ChromeCurveLayout {
  let nearest = layouts[0];
  let nearestDistance = Infinity;
  for (const candidate of layouts) {
    const delta = distance < candidate.start
      ? candidate.start - distance
      : distance > candidate.start + candidate.length
        ? distance - candidate.start - candidate.length
        : 0;
    if (delta < nearestDistance) {
      nearest = candidate;
      nearestDistance = delta;
    }
  }
  return nearest;
}

function frameAlongStroke(layout: ChromeCurveLayout, rawDistance: number): {
  point: THREE.Vector3;
  tangent: THREE.Vector3;
  lateral: THREE.Vector3;
  normal: THREE.Vector3;
} {
  const points = layout.stroke.points;
  let distance = THREE.MathUtils.clamp(rawDistance, 0, layout.length);
  let aIndex = 0;
  let bIndex = 1;
  const segmentCount = layout.stroke.cyclic ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index++) {
    const next = (index + 1) % points.length;
    const segment = points[index].worldPosition.distanceTo(points[next].worldPosition);
    aIndex = index;
    bIndex = next;
    if (distance <= segment || index === segmentCount - 1) break;
    distance -= segment;
  }
  const a = points[aIndex];
  const b = points[bIndex];
  const segmentLength = Math.max(a.worldPosition.distanceTo(b.worldPosition), 1e-9);
  const t = THREE.MathUtils.clamp(distance / segmentLength, 0, 1);
  const point = a.worldPosition.clone().lerp(b.worldPosition, t);
  const tangent = b.worldPosition.clone().sub(a.worldPosition).normalize();
  const normal = a.worldNormal.clone().lerp(b.worldNormal, t).normalize();
  let lateral = normal.clone().cross(tangent).normalize();
  if (lateral.lengthSq() < 1e-9) lateral = new THREE.Vector3(0, 1, 0);
  return { point, tangent, lateral, normal };
}

function extendedFrameAlongStroke(
  layout: ChromeCurveLayout,
  distance: number,
): ReturnType<typeof frameAlongStroke> {
  const clamped = THREE.MathUtils.clamp(distance, 0, layout.length);
  const frame = frameAlongStroke(layout, clamped);
  if (distance !== clamped) frame.point.addScaledVector(frame.tangent, distance - clamped);
  return frame;
}

function soupBounds(soup: TriSoup): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < soup.positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], soup.positions[index + axis]);
      max[axis] = Math.max(max[axis], soup.positions[index + axis]);
    }
  }
  return { min, max };
}

function chromeMaterial(color: THREE.ColorRepresentation): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.92, roughness: 0.16 });
}

function clearGeneratedRoot(root: THREE.Object3D): void {
  for (const child of [...root.children]) {
    child.removeFromParent();
    disposeGeneratedObject(child);
  }
}

function disposeGeneratedObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    geometries.add(child.geometry);
    const list = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of list) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

function publicAssetUrl(relative: string): string {
  const base = import.meta.env?.BASE_URL ?? '/';
  return `${base.endsWith('/') ? base : `${base}/`}${relative.replace(/^\/+/, '')}`;
}

function abortError(): Error {
  return new DOMException('GN brush evaluation aborted', 'AbortError');
}
