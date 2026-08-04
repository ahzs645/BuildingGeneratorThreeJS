import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import type { SurfaceDocumentSnapshot, SurfaceStrokeRecord } from './contracts';
import {
  projectedStrokesFor,
  projectSurfaceStroke,
  toPaintModeSamples,
} from './generator-adapter';
import { SurfaceProjector } from './surface-projector';

const stroke = (
  generatorId: SurfaceStrokeRecord['generatorId'],
  targetId: string,
  id = 1,
): SurfaceStrokeRecord => ({
  id,
  generatorId,
  seed: id * 10,
  cyclic: false,
  points: [{
    id: id * 100,
    targetId,
    targetPosition: [0.25, -0.5, 0],
    targetNormal: [0, 0, 1],
    surfaceOffset: 0.1,
  }],
});

test('materializes and partitions shared document strokes by generator', () => {
  const root = new THREE.Group();
  const target = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  target.position.set(2, 3, 4);
  root.add(target);
  const projector = new SurfaceProjector();
  projector.registerTargetRoot(root);

  const ivy = stroke('ivy', target.uuid, 1);
  const crystal = stroke('crystals', target.uuid, 2);
  const snapshot: SurfaceDocumentSnapshot = {
    revision: 4,
    surfaceRevision: 1,
    target: { kind: 'all' },
    drawingArea: null,
    strokes: [ivy, crystal],
    activeStroke: null,
    selection: null,
  };
  const projected = projectedStrokesFor(snapshot, 'crystals', projector);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].id, crystal.id);
  assert.deepEqual(projected[0].points[0].worldPosition.toArray(), [2.25, 2.5, 4.1]);
  projector.dispose();
});

test('returns null when a stroke target no longer exists', () => {
  const projector = new SurfaceProjector();
  projector.registerTargetRoot(new THREE.Group());
  assert.equal(projectSurfaceStroke(projector, stroke('ivy', 'missing')), null);
  projector.dispose();
});

test('converts projected points into world and output-anchor local PaintMode samples', () => {
  const root = new THREE.Group();
  const target = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
  root.add(target);
  const projector = new SurfaceProjector();
  projector.registerTargetRoot(root);
  const projected = projectSurfaceStroke(projector, stroke('molten', target.uuid));
  assert.ok(projected);

  const anchor = new THREE.Group();
  anchor.position.set(0.25, -0.25, 0.05);
  anchor.rotation.z = Math.PI / 2;
  anchor.updateWorldMatrix(true, false);
  const [sample] = toPaintModeSamples(projected, anchor);
  const expectedLocal = projected.points[0].worldPosition.clone().applyMatrix4(anchor.matrixWorld.clone().invert());
  assert.ok(sample.position.distanceTo(projected.points[0].worldPosition) < 1e-7);
  assert.ok(sample.local.distanceTo(expectedLocal) < 1e-7);
  assert.ok(Math.abs(sample.localNormal.length() - 1) < 1e-7);
  projector.dispose();
});
