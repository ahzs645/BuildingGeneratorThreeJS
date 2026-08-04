import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import type { TargetSurface } from '../surface-targets';
import type { IvyPlantRuntime } from './ivy-adapter';
import { createIvyAdapter } from './ivy-adapter';
import type { GeneratorEvaluationInput, GeneratorHostContext, ProjectedSurfaceStroke } from './generator-adapter';

function stroke(id: number, x = 0): ProjectedSurfaceStroke {
  return {
    id,
    generatorId: 'ivy',
    seed: id,
    cyclic: false,
    points: [{
      id,
      targetId: 'surface',
      worldPosition: new THREE.Vector3(x, 0, 0),
      worldNormal: new THREE.Vector3(0, 1, 0),
      targetPosition: new THREE.Vector3(x, 0, 0),
      targetNormal: new THREE.Vector3(0, 1, 0),
      surfaceOffset: 0,
    }],
  };
}

test('Ivy adapter retains stable strokes and skips hidden frame updates', () => {
  let creates = 0;
  let disposals = 0;
  let updates = 0;
  let leafUpdates = 0;
  let receivedTargets = 0;
  const adapter = createIvyAdapter((_samples, _seed, _settings, targets): IvyPlantRuntime => {
    creates++;
    receivedTargets = targets.length;
    return {
      group: new THREE.Group(),
      update: () => { updates++; },
      updateLeaves: () => { leafUpdates++; },
      dispose: () => { disposals++; },
    };
  });
  const outputRoot = new THREE.Group();
  const host: GeneratorHostContext = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    outputRoot,
    compile: async () => undefined,
    setStatus: () => undefined,
  };
  const targetMesh = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  const targets: TargetSurface[] = [{ id: 'surface', label: 'Surface', mesh: targetMesh }];
  const evaluation = (strokes: readonly ProjectedSurfaceStroke[]): GeneratorEvaluationInput => ({
    documentRevision: 1,
    surfaceRevision: 1,
    strokes,
    targets,
    drawingArea: null,
    signal: new AbortController().signal,
  });
  const runtime = adapter.createRuntime(host, adapter.defaultSettings);
  runtime.reconcile(evaluation([stroke(1), stroke(2)]));
  runtime.reconcile(evaluation([stroke(1), stroke(2)]));
  assert.equal(creates, 2);
  assert.equal(receivedTargets, 1);
  runtime.reconcile(evaluation([stroke(1, 0.5), stroke(2)]));
  assert.equal(creates, 3);
  assert.equal(disposals, 1);

  runtime.update?.(0.016, 1);
  assert.equal(updates, 2);
  assert.equal(leafUpdates, 2);
  runtime.setVisible(false);
  runtime.update?.(0.016, 2);
  assert.equal(updates, 2);

  runtime.setSettings({ ...adapter.defaultSettings, stemRadius: 0.02 });
  runtime.reconcile(evaluation([stroke(1, 0.5), stroke(2)]));
  assert.equal(creates, 5);
  assert.equal(disposals, 3);
  runtime.dispose();
  assert.equal(disposals, 5);
  assert.equal(outputRoot.children.length, 0);
});
