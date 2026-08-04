import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import type { PaintMode, StrokeInstance, SurfaceSample } from '../geometry-painter/modes/mode';
import { surfaceGenerator } from './generator-catalog';
import type { GeneratorEvaluationInput, GeneratorHostContext, ProjectedSurfaceStroke } from './generator-adapter';
import { createPaintModeAdapter } from './paint-mode-adapter';

interface Settings { size: number }

function projectedStroke(id: number, x = 0): ProjectedSurfaceStroke {
  return {
    id,
    generatorId: 'crystals',
    seed: id * 3,
    cyclic: false,
    points: [{
      id: id * 10,
      targetId: 'mesh',
      worldPosition: new THREE.Vector3(x, 0, 0),
      worldNormal: new THREE.Vector3(0, 1, 0),
      targetPosition: new THREE.Vector3(x, 0, 0),
      targetNormal: new THREE.Vector3(0, 1, 0),
      surfaceOffset: 0,
    }],
  };
}

function input(strokes: readonly ProjectedSurfaceStroke[]): GeneratorEvaluationInput {
  return {
    documentRevision: 1,
    surfaceRevision: 1,
    strokes,
    targets: [],
    drawingArea: null,
    signal: new AbortController().signal,
  };
}

test('reconciles stable stroke ids and rebuilds only edited strokes', () => {
  let creates = 0;
  let disposals = 0;
  let updates = 0;
  let settingApplications = 0;
  const mode: PaintMode<Settings> = {
    id: 'fake',
    createStroke(samples: SurfaceSample[]): StrokeInstance {
      creates++;
      assert.ok(samples[0].local instanceof THREE.Vector3);
      const group = new THREE.Group();
      return {
        group,
        update: () => { updates++; },
        finishGrowth: () => undefined,
        applySettings: () => { settingApplications++; },
        dispose: () => { disposals++; },
      };
    },
  };
  const outputRoot = new THREE.Group();
  const host: GeneratorHostContext = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    outputRoot,
    compile: async () => undefined,
    setStatus: () => undefined,
  };
  const runtime = createPaintModeAdapter(surfaceGenerator('crystals'), mode, { size: 1 })
    .createRuntime(host, { size: 1 });

  runtime.reconcile(input([projectedStroke(1), projectedStroke(2)]));
  assert.equal(creates, 2);
  runtime.reconcile(input([projectedStroke(1), projectedStroke(2)]));
  assert.equal(creates, 2, 'unchanged projected strokes are retained');
  runtime.reconcile(input([projectedStroke(1, 0.5), projectedStroke(2)]));
  assert.equal(creates, 3);
  assert.equal(disposals, 1, 'only the edited stroke was replaced');

  runtime.setSettings({ size: 2 });
  assert.equal(settingApplications, 2);
  runtime.update?.(0.016, 1);
  assert.equal(updates, 2);
  runtime.setVisible(false);
  runtime.update?.(0.016, 2);
  assert.equal(updates, 2, 'hidden generator output does no frame work');

  runtime.dispose();
  assert.equal(disposals, 3);
  assert.equal(outputRoot.children.length, 0);
});

test('rebuilds all live strokes after settings change when mode has no live settings hook', () => {
  let creates = 0;
  let disposals = 0;
  const mode: PaintMode<Settings> = {
    id: 'fake-static',
    createStroke(): StrokeInstance {
      creates++;
      return {
        group: new THREE.Group(),
        update: () => undefined,
        finishGrowth: () => undefined,
        dispose: () => { disposals++; },
      };
    },
  };
  const host: GeneratorHostContext = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    outputRoot: new THREE.Group(),
    compile: async () => undefined,
    setStatus: () => undefined,
  };
  const runtime = createPaintModeAdapter(surfaceGenerator('crystals'), mode, { size: 1 })
    .createRuntime(host, { size: 1 });
  const evaluation = input([projectedStroke(1)]);
  runtime.reconcile(evaluation);
  runtime.setSettings({ size: 2 });
  runtime.reconcile(evaluation);
  assert.equal(creates, 2);
  assert.equal(disposals, 1);
  runtime.dispose();
});
