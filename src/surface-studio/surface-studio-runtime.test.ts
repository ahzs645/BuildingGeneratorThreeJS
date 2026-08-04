import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { surfaceGenerator } from './generator-catalog';
import type {
  GeneratorHostContext,
  SurfaceGeneratorAdapter,
  SurfaceGeneratorRuntime,
} from './generator-adapter';
import { SurfaceStudioRuntime } from './surface-studio-runtime';

class FakeElement extends EventTarget {
  readonly captures: number[] = [];
  getBoundingClientRect(): DOMRect {
    return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON() {} };
  }
  setPointerCapture(id: number): void { this.captures.push(id); }
  releasePointerCapture(): void {}
}

function adapter(id: 'ivy' | 'tree', counters: { reconciles: number; disposals: number }): SurfaceGeneratorAdapter<object> {
  return {
    descriptor: surfaceGenerator(id),
    defaultSettings: {},
    createRuntime(_host: GeneratorHostContext): SurfaceGeneratorRuntime<object> {
      return {
        setSettings: () => undefined,
        reconcile: () => { counters.reconciles++; },
        setVisible: () => undefined,
        dispose: () => { counters.disposals++; },
      };
    },
  };
}

test('coordinates one document/projector/input/manager lifecycle without owning a renderer', async () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 3;
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const targetRoot = new THREE.Group();
  targetRoot.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial()));
  const orbit = { enabled: true };
  const ivy = { reconciles: 0, disposals: 0 };
  const tree = { reconciles: 0, disposals: 0 };
  const runtime = new SurfaceStudioRuntime({
    element: new FakeElement() as unknown as HTMLElement,
    camera,
    orbitControls: orbit,
    targetRoot,
    managerHost: {
      scene,
      camera,
      surfaceRoot: targetRoot,
      compile: async () => undefined,
      setStatus: () => undefined,
    },
    adapters: [adapter('ivy', ivy), adapter('tree', tree)],
    activeGenerator: 'ivy',
  });
  await runtime.whenIdle();
  assert.equal(runtime.projector.targets.length, 1);
  assert.equal(runtime.activeGenerator, 'ivy');
  assert.equal(runtime.setInteractionMode('draw'), true);
  assert.equal(orbit.enabled, false);

  await runtime.setActiveGenerator('tree');
  assert.equal(runtime.input.mode, 'orbit');
  assert.equal(targetRoot.visible, false);
  assert.equal(runtime.document.snapshot.strokes.length, 0);

  targetRoot.clear();
  targetRoot.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
  await runtime.replaceSurface();
  assert.equal(runtime.projector.targets.length, 1);
  assert.equal(runtime.document.snapshot.surfaceRevision, 1);
  assert.equal(runtime.document.canUndo, false);

  runtime.dispose();
  assert.equal(ivy.disposals, 1);
  assert.equal(tree.disposals, 1);
  assert.equal(targetRoot.visible, true);
});
