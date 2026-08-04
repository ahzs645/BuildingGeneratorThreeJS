import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { SurfaceStudioHostController } from './app-host';
import { attachSurfaceStudioRuntime } from './attach-app-host';
import { surfaceGenerator } from './generator-catalog';
import type {
  GeneratorHostContext,
  SurfaceGeneratorAdapter,
  SurfaceGeneratorRuntime,
} from './generator-adapter';

class FakeCanvas extends EventTarget {
  getBoundingClientRect(): DOMRect {
    return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON() {} };
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
}

test('attaches document/generator runtime to the narrow App host lifecycle', async () => {
  let updates = 0;
  let disposals = 0;
  const adapter: SurfaceGeneratorAdapter<object> = {
    descriptor: surfaceGenerator('ivy'),
    defaultSettings: {},
    createRuntime(_host: GeneratorHostContext): SurfaceGeneratorRuntime<object> {
      return {
        setSettings: () => undefined,
        reconcile: () => undefined,
        setVisible: () => undefined,
        update: () => { updates++; },
        dispose: () => { disposals++; },
      };
    },
  };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
  const controls = { enabled: true };
  const modelRoot = new THREE.Group();
  modelRoot.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial()));
  const controller = new SurfaceStudioHostController({
    scene,
    camera,
    canvas,
    controls: controls as never,
    modelRoot,
    outputParent: scene,
    compile: async () => undefined,
    setStatus: () => undefined,
  });
  const attached = attachSurfaceStudioRuntime(controller.host, [adapter]);
  await attached.runtime.whenIdle();
  assert.equal(attached.runtime.document.snapshot.surfaceRevision, 0);
  controller.runFrameTasks(0.016, 1);
  assert.equal(updates, 1);

  controller.notifySurfaceChanged();
  await attached.runtime.whenIdle();
  assert.equal(attached.runtime.document.snapshot.surfaceRevision, 1);
  attached.dispose();
  controller.runFrameTasks(0.016, 2);
  assert.equal(updates, 1);
  assert.equal(disposals, 1);
  controller.dispose();
});
