import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { SurfaceStudioHostController } from './app-host';

function fixture() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const modelRoot = new THREE.Group();
  const outputParent = new THREE.Group();
  scene.add(modelRoot, outputParent);
  const compileCalls: THREE.Object3D[] = [];
  const statuses: Array<readonly [string, string]> = [];
  const controller = new SurfaceStudioHostController({
    scene,
    camera,
    modelRoot,
    outputParent,
    canvas: {} as HTMLCanvasElement,
    controls: {} as OrbitControls,
    compile: async (object) => { compileCalls.push(object); },
    setStatus: (state, message) => { statuses.push([state, message]); },
  });
  return { controller, host: controller.host, scene, camera, modelRoot, outputParent, compileCalls, statuses };
}

test('facade exposes stable scene resources and delegates compile/status', async () => {
  const value = fixture();
  assert.equal(value.host.scene, value.scene);
  assert.equal(value.host.camera, value.camera);
  assert.equal(value.host.modelRoot, value.modelRoot);
  assert.equal(value.host.outputParent, value.outputParent);
  const object = new THREE.Group();
  await value.host.compile(object);
  value.host.setStatus('busy', 'Preparing tree');
  assert.deepEqual(value.compileCalls, [object]);
  assert.deepEqual(value.statuses, [['busy', 'Preparing tree']]);
});

test('surface subscriptions receive current state and every monotonic revision', () => {
  const value = fixture();
  const revisions: number[] = [];
  const roots: THREE.Group[] = [];
  const unsubscribe = value.host.subscribeSurface((change) => {
    revisions.push(change.revision);
    roots.push(change.root);
  });
  value.controller.notifySurfaceChanged();
  value.controller.notifySurfaceChanged();
  unsubscribe();
  value.controller.notifySurfaceChanged();

  assert.deepEqual(revisions, [0, 1, 2]);
  assert.ok(roots.every((root) => root === value.modelRoot));
  assert.equal(value.host.surfaceRevision, 3);
});

test('frame tasks unregister independently and are cleared on dispose', () => {
  const value = fixture();
  const frames: Array<readonly [string, number, number]> = [];
  const removeFirst = value.host.registerFrameTask((dt, elapsed) => frames.push(['first', dt, elapsed]));
  value.host.registerFrameTask((dt, elapsed) => frames.push(['second', dt, elapsed]));
  value.controller.runFrameTasks(0.016, 1);
  removeFirst();
  value.controller.runFrameTasks(0.02, 2);
  value.controller.dispose();
  value.controller.runFrameTasks(0.03, 3);

  assert.deepEqual(frames, [
    ['first', 0.016, 1],
    ['second', 0.016, 1],
    ['second', 0.02, 2],
  ]);
  assert.throws(() => value.host.registerFrameTask(() => {}), /disposed/);
  assert.throws(() => value.host.subscribeSurface(() => {}), /disposed/);
});
