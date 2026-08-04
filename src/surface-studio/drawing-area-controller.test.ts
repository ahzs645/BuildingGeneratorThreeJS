import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { SurfaceDocument } from './surface-document';
import {
  DrawingAreaController,
  type DrawingAreaProjectionOptions,
} from './drawing-area-controller';
import { SurfaceProjector, type SurfaceProjectionHit } from './surface-projector';

const EPSILON = 1e-6;

function fixture(): {
  mesh: THREE.Mesh;
  document: SurfaceDocument;
  projector: SurfaceProjector;
  controller: DrawingAreaController;
  hit: SurfaceProjectionHit;
} {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial());
  root.add(mesh);
  const projector = new SurfaceProjector();
  projector.registerTargetRoot(root);
  const hit = projector.raycast(new THREE.Raycaster(
    new THREE.Vector3(0, 0, 3),
    new THREE.Vector3(0, 0, -1),
  ));
  assert.ok(hit);
  const document = new SurfaceDocument();
  const controller = new DrawingAreaController(document, projector);
  return { mesh, document, projector, controller, hit };
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

test('places a target-bound area with a stable orthonormal tangent frame', () => {
  const { mesh, document, projector, controller, hit } = fixture();
  const area = controller.place(hit, {
    size: [3, 2],
    projectionHeight: 0.6,
    // Parallel hints are deliberately degenerate; placement must choose a
    // deterministic tangent instead of emitting a zero frame.
    tangentHint: hit.worldNormal.clone(),
  });

  assert.deepEqual(document.snapshot.target, { kind: 'mesh', targetId: mesh.uuid });
  assert.deepEqual(area.target, { kind: 'mesh', targetId: mesh.uuid });
  assert.deepEqual(area.center, [0, 0, 0]);
  assert.deepEqual(area.size, [3, 2]);
  assert.equal(area.projectionHeight, 0.6);
  assert.equal(area.committed, false);
  assert.ok(Math.abs(dot(area.u, area.normal)) < EPSILON);
  assert.ok(Math.abs(dot(area.v, area.normal)) < EPSILON);
  assert.ok(Math.abs(dot(area.u, area.v)) < EPSILON);
  assert.ok(Math.abs(Math.hypot(...area.u) - 1) < EPSILON);
  assert.ok(Math.abs(Math.hypot(...area.v) - 1) < EPSILON);

  controller.dispose();
  projector.dispose();
});

test('returns renderer-neutral source lines and a conformed indexed patch on contact', () => {
  const { projector, controller, hit } = fixture();
  controller.place(hit, { size: 2, projectionHeight: 0.5 });
  const options: DrawingAreaProjectionOptions = {
    sourceGridDivisions: 2,
    patchDivisions: 2,
    contactProbeDivisions: 1,
    contactDepth: 0.2,
    maxProjectionDistance: 2,
    surfaceOffset: 0.02,
  };

  const floating = controller.project(options);
  assert.equal(floating.contact, false);
  assert.equal(floating.committed, false);
  assert.equal(floating.patch, null);
  assert.equal(floating.source?.lines.length, 6);
  assert.deepEqual(floating.source?.center, [0, 0, 0.5]);

  controller.setProjectionHeight(0.1);
  const touching = controller.project(options);
  assert.equal(touching.contact, true);
  assert.ok(Math.abs((touching.closestContactDistance ?? 0) - 0.12) < EPSILON);
  assert.ok(touching.patch);
  assert.equal(touching.patch.positions.length, 9);
  assert.equal(touching.patch.valid.every(Boolean), true);
  assert.equal(touching.patch.indices.length, 24);
  assert.equal(touching.patch.lines.length, 12);
  assert.equal(touching.stats.rayHits, 9);
  for (const point of touching.patch.positions) assert.ok(Math.abs(point[2] - 0.02) < EPSILON);
  assert.equal(Array.isArray(touching.patch.positions[0]), true, 'output is tuples, not renderer objects');

  controller.dispose();
  projector.dispose();
});

test('committed projection rejects far rays, falls back to closest points, and rejects back-facing frames', () => {
  const { projector, controller, hit } = fixture();
  controller.place(hit, { size: 2, projectionHeight: 1 });
  controller.setCommitted(true);
  const options: DrawingAreaProjectionOptions = {
    patchDivisions: 2,
    contactProbeDivisions: 1,
    contactDepth: 0.1,
    maxProjectionDistance: 0.2,
  };

  const fallback = controller.project(options);
  assert.equal(fallback.contact, false);
  assert.equal(fallback.committed, true);
  assert.ok(fallback.patch, 'commit projects even when the source grid is floating');
  assert.equal(fallback.stats.rejectedRayHits, 9);
  assert.equal(fallback.stats.fallbackHits, 9);
  assert.equal(fallback.patch.valid.every(Boolean), true);

  controller.rotate(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const sideFacing = controller.project(options);
  assert.ok(sideFacing.patch);
  assert.equal(sideFacing.patch.valid.some(Boolean), false);
  assert.equal(sideFacing.patch.indices.length, 0);
  assert.ok(sideFacing.stats.rejectedFallbackHits > 0);

  controller.dispose();
  projector.dispose();
});

test('move, rotate, scale, and height edits collapse into one transform undo', () => {
  const { document, projector, controller, hit } = fixture();
  const before = controller.place(hit, { size: [2, 3], projectionHeight: 0.8 });

  controller.beginTransformDrag();
  controller.translate(new THREE.Vector3(1, 0, 0));
  controller.translate(new THREE.Vector3(0, 2, 0));
  controller.rotate(new THREE.Vector3(0, 0, 1), Math.PI / 4);
  controller.scale(2, 0.5);
  controller.setProjectionHeight(0.25);
  controller.commitTransformDrag();
  assert.deepEqual(controller.area?.center, [1, 2, 0]);
  assert.deepEqual(controller.area?.size, [4, 1.5]);
  assert.equal(controller.area?.projectionHeight, 0.25);

  assert.equal(document.undo(), true);
  assert.deepEqual(controller.area, before, 'one undo restores the complete pre-drag area');

  controller.beginTransformDrag();
  controller.translate(new THREE.Vector3(5, 5, 5));
  controller.cancelTransformDrag();
  assert.deepEqual(controller.area, before, 'cancel restores the drag origin without history');

  controller.dispose();
  projector.dispose();
});

test('commit height and remove are document mutations, and remove can be undone', () => {
  const { document, projector, controller, hit } = fixture();
  controller.place(hit);
  controller.setCommitted(true, 0.1);
  assert.equal(controller.area?.committed, true);
  assert.equal(controller.area?.projectionHeight, 0.1);

  const beforeRemove = controller.area;
  controller.remove();
  assert.equal(controller.area, null);
  assert.equal(controller.project().source, null);
  assert.equal(document.undo(), true);
  assert.deepEqual(controller.area, beforeRemove);

  controller.dispose();
  projector.dispose();
});
