import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import type { GeneratorEvaluationInput, GeneratorHostContext } from './generator-adapter';
import { createTreeAdapter, type TreePlantRuntime } from './tree-adapter';

const input = (signal = new AbortController().signal): GeneratorEvaluationInput => ({
  documentRevision: 0,
  surfaceRevision: 0,
  strokes: [],
  targets: [],
  drawingArea: null,
  signal,
});

test('Tree adapter prepares asynchronously, updates only when visible, and rebuilds settings', async () => {
  let creates = 0;
  let disposals = 0;
  let updates = 0;
  let leafUpdates = 0;
  let resolveCompile!: () => void;
  const compilePromises: Promise<void>[] = [];
  const statuses: string[] = [];
  const outputRoot = new THREE.Group();
  const host: GeneratorHostContext = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    outputRoot,
    compile: () => {
      const promise = new Promise<void>((resolve) => { resolveCompile = resolve; });
      compilePromises.push(promise);
      return promise;
    },
    setStatus: (_state, message) => { statuses.push(message); },
  };
  const adapter = createTreeAdapter((): TreePlantRuntime => {
    creates++;
    return {
      group: new THREE.Group(),
      update: () => { updates++; },
      updateLeaves: () => { leafUpdates++; },
      dispose: () => { disposals++; },
    };
  });
  const runtime = adapter.createRuntime(host, adapter.defaultSettings);
  runtime.setVisible(true);
  runtime.reconcile(input());
  assert.equal(creates, 1);
  assert.equal(outputRoot.children[0].visible, false, 'tree stays hidden during preparation');
  runtime.update?.(0.016, 1);
  assert.equal(updates, 0);
  resolveCompile();
  await compilePromises[0];
  await Promise.resolve();
  assert.equal(outputRoot.children[0].visible, true);
  runtime.update?.(0.016, 1);
  assert.equal(updates, 1);
  assert.equal(leafUpdates, 1);

  runtime.setVisible(false);
  runtime.update?.(0.016, 2);
  assert.equal(updates, 1);
  runtime.setSettings({ ...adapter.defaultSettings, trunkHeight: 1.2 });
  runtime.reconcile(input());
  assert.equal(creates, 2);
  assert.equal(disposals, 1);
  assert.ok(statuses.some((message) => message.includes('Preparing the banyan tree')));
  runtime.dispose();
  assert.equal(disposals, 2);
});

test('Tree adapter ignores a stale compilation after its evaluation is aborted', async () => {
  let resolveCompile!: () => void;
  const controller = new AbortController();
  const outputRoot = new THREE.Group();
  const host: GeneratorHostContext = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    outputRoot,
    compile: () => new Promise<void>((resolve) => { resolveCompile = resolve; }),
    setStatus: () => undefined,
  };
  const adapter = createTreeAdapter(() => ({
    group: new THREE.Group(),
    update: () => undefined,
    updateLeaves: () => undefined,
    dispose: () => undefined,
  }));
  const runtime = adapter.createRuntime(host, adapter.defaultSettings);
  runtime.setVisible(true);
  runtime.reconcile(input(controller.signal));
  controller.abort();
  resolveCompile();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(outputRoot.children[0].visible, false);
  runtime.dispose();
});
