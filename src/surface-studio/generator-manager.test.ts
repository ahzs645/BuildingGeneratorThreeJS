import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import type { SurfaceGeneratorId } from './contracts';
import type {
  GeneratorEvaluationInput,
  GeneratorHostContext,
  SurfaceGeneratorAdapter,
  SurfaceGeneratorRuntime,
} from './generator-adapter';
import { surfaceGenerator } from './generator-catalog';
import { GeneratorManager } from './generator-manager';
import { SurfaceDocument } from './surface-document';
import { SurfaceProjector } from './surface-projector';

interface TestSettings {
  readonly value: number;
}

class TestRuntime implements SurfaceGeneratorRuntime<TestSettings> {
  readonly calls: GeneratorEvaluationInput[] = [];
  readonly visibility: boolean[] = [];
  readonly settings: Readonly<TestSettings>[] = [];
  updates = 0;
  disposed = 0;
  block = false;

  setSettings(settings: Readonly<TestSettings>): void {
    this.settings.push(settings);
  }

  reconcile(input: GeneratorEvaluationInput): void | Promise<void> {
    this.calls.push(input);
    if (!this.block) return;
    return new Promise((resolve) => {
      if (input.signal.aborted) resolve();
      else input.signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  setVisible(visible: boolean): void {
    this.visibility.push(visible);
  }

  update(): void {
    this.updates++;
  }

  dispose(): void {
    this.disposed++;
  }
}

function adapter(id: SurfaceGeneratorId, runtime: TestRuntime): SurfaceGeneratorAdapter<TestSettings> {
  return {
    descriptor: surfaceGenerator(id),
    defaultSettings: { value: 1 },
    createRuntime(_host: GeneratorHostContext) {
      return runtime;
    },
  };
}

function fixture(
  ids: readonly SurfaceGeneratorId[],
  activeGenerator: SurfaceGeneratorId = ids[0],
) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const surfaceRoot = new THREE.Group();
  const target = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  surfaceRoot.add(target);
  scene.add(surfaceRoot);
  const projector = new SurfaceProjector();
  projector.registerTargetRoot(surfaceRoot, { kind: 'all' });
  const document = new SurfaceDocument();
  document.setProjectionTarget({ kind: 'all' });
  const runtimes = new Map(ids.map((id) => [id, new TestRuntime()]));
  const manager = new GeneratorManager({
    document,
    projector,
    activeGenerator,
    adapters: ids.map((id) => adapter(id, runtimes.get(id)!)),
    host: {
      scene,
      camera,
      surfaceRoot,
      compile: async () => {},
      setStatus: () => {},
    },
  });
  return { scene, surfaceRoot, target, projector, document, runtimes, manager };
}

function addStroke(
  document: SurfaceDocument,
  targetId: string,
  generatorId: SurfaceGeneratorId,
  seed = 10,
): number {
  const id = document.beginStroke(generatorId, seed);
  document.appendPoint({
    targetId,
    targetPosition: [0, 0, 0],
    targetNormal: [0, 0, 1],
    surfaceOffset: 0.02,
  });
  document.appendPoint({
    targetId,
    targetPosition: [0.5, 0, 0],
    targetNormal: [0, 0, 1],
    surfaceOffset: 0.02,
  });
  document.commitStroke();
  return id;
}

test('partitions existing strokes by generator during initial reconciliation', async () => {
  // Build the shared document before the manager mounts, like route restoration.
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const surfaceRoot = new THREE.Group();
  const target = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  surfaceRoot.add(target); scene.add(surfaceRoot);
  const projector = new SurfaceProjector(); projector.registerTargetRoot(surfaceRoot, { kind: 'all' });
  const document = new SurfaceDocument(); document.setProjectionTarget({ kind: 'all' });
  addStroke(document, target.uuid, 'ivy', 11);
  addStroke(document, target.uuid, 'crystals', 22);
  const ivy = new TestRuntime(), crystals = new TestRuntime(), tree = new TestRuntime();
  const manager = new GeneratorManager({
    document,
    projector,
    activeGenerator: 'ivy',
    adapters: [adapter('ivy', ivy), adapter('crystals', crystals), adapter('tree', tree)],
    host: { scene, camera, surfaceRoot, compile: async () => {}, setStatus: () => {} },
  });
  await manager.whenIdle();

  assert.equal(ivy.calls.length, 1);
  assert.equal(ivy.calls[0].strokes.length, 1);
  assert.equal(ivy.calls[0].strokes[0].generatorId, 'ivy');
  assert.equal(crystals.calls.length, 1);
  assert.equal(crystals.calls[0].strokes[0].generatorId, 'crystals');
  assert.equal(tree.calls.length, 0, 'inactive ground generator is deferred');
  manager.dispose(); projector.dispose();
});

test('document changes reconcile only the adapter that owns the affected stroke', async () => {
  const value = fixture(['ivy', 'crystals']);
  await value.manager.whenIdle();
  const ivyBefore = value.runtimes.get('ivy')!.calls.length;
  const crystalBefore = value.runtimes.get('crystals')!.calls.length;

  addStroke(value.document, value.target.uuid, 'crystals');
  await value.manager.whenIdle();
  assert.equal(value.runtimes.get('ivy')!.calls.length, ivyBefore);
  assert.equal(value.runtimes.get('crystals')!.calls.length, crystalBefore + 1);
  assert.equal(value.runtimes.get('crystals')!.calls.at(-1)!.strokes.length, 1);
  value.manager.dispose(); value.projector.dispose();
});

test('Tree exclusive mode hides surface and overlays without deleting their outputs', async () => {
  const value = fixture(['ivy', 'crystals', 'tree']);
  await value.manager.whenIdle();
  const ivyRoot = value.manager.outputRoot('ivy')!;
  const crystalRoot = value.manager.outputRoot('crystals')!;
  const treeRoot = value.manager.outputRoot('tree')!;
  assert.equal(value.manager.activeCapabilities.usesProjectionTarget, true);
  assert.equal(ivyRoot.visible, true);
  assert.equal(crystalRoot.visible, true);
  assert.equal(treeRoot.visible, false);
  assert.equal(value.surfaceRoot.visible, true);

  const strokesBefore = value.document.snapshot.strokes;
  await value.manager.setActiveGenerator('tree');
  assert.equal(value.manager.activeCapabilities.usesProjectionTarget, false);
  assert.equal(value.manager.activeCapabilities.supportsUndoClear, false);
  assert.equal(ivyRoot.visible, false);
  assert.equal(crystalRoot.visible, false);
  assert.equal(treeRoot.visible, true);
  assert.equal(value.surfaceRoot.visible, false);
  assert.equal(value.document.snapshot.strokes, strokesBefore);

  await value.manager.setActiveGenerator('crystals');
  assert.equal(ivyRoot.visible, true);
  assert.equal(crystalRoot.visible, true);
  assert.equal(treeRoot.visible, false);
  assert.equal(value.surfaceRoot.visible, true);
  assert.equal(value.runtimes.get('ivy')!.disposed, 0);
  value.manager.dispose(); value.projector.dispose();
});

test('settings reconcile their runtime and superseding work aborts stale async input', async () => {
  const value = fixture(['ivy']);
  await value.manager.whenIdle();
  const runtime = value.runtimes.get('ivy')!;
  await value.manager.setSettings('ivy', { value: 7 });
  assert.deepEqual(runtime.settings.at(-1), { value: 7 });
  assert.deepEqual(value.manager.settingsFor<TestSettings>('ivy'), { value: 7 });

  runtime.block = true;
  const first = value.manager.reconcile('ivy');
  const firstInput = runtime.calls.at(-1)!;
  const second = value.manager.reconcile('ivy');
  const secondInput = runtime.calls.at(-1)!;
  assert.equal(firstInput.signal.aborted, true);
  assert.equal(secondInput.signal.aborted, false);
  await first;
  value.manager.dispose();
  assert.equal(secondInput.signal.aborted, true);
  await second;
  value.projector.dispose();
});

test('animation updates only visible runtimes and dispose removes owned roots', async () => {
  const value = fixture(['ivy', 'crystals', 'tree']);
  await value.manager.whenIdle();
  value.manager.update(0.016, 1);
  assert.equal(value.runtimes.get('ivy')!.updates, 1);
  assert.equal(value.runtimes.get('crystals')!.updates, 1);
  assert.equal(value.runtimes.get('tree')!.updates, 0);

  await value.manager.setActiveGenerator('tree');
  value.manager.update(0.016, 2);
  assert.equal(value.runtimes.get('ivy')!.updates, 1);
  assert.equal(value.runtimes.get('crystals')!.updates, 1);
  assert.equal(value.runtimes.get('tree')!.updates, 1);

  const roots = ['ivy', 'crystals', 'tree'].map((id) => value.manager.outputRoot(id as SurfaceGeneratorId)!);
  value.manager.dispose();
  assert.equal(value.surfaceRoot.visible, true);
  assert.ok(roots.every((root) => root.parent === null));
  assert.ok([...value.runtimes.values()].every((runtime) => runtime.disposed === 1));
  value.projector.dispose();
});
