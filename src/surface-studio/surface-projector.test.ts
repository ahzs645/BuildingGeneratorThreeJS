import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { indexForRaycasts } from '../geometry-painter/bvh';
import { SurfaceProjector } from './surface-projector';

const EPSILON = 1e-6;

function assertVector(actual: THREE.Vector3, expected: THREE.Vector3): void {
  assert.ok(
    actual.distanceTo(expected) < EPSILON,
    `expected ${expected.toArray().join(', ')}, received ${actual.toArray().join(', ')}`,
  );
}

test('registers borrowed meshes and applies explicit projection-target selection', () => {
  const root = new THREE.Group();
  const first = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  const second = new THREE.Mesh(new THREE.SphereGeometry(), new THREE.MeshBasicMaterial());
  first.name = 'Body';
  second.name = 'Detail';
  root.add(first, second);

  const projector = new SurfaceProjector();
  assert.deepEqual(
    projector.registerTargetRoot(root).map(({ id, label }) => ({ id, label })),
    [
      { id: first.uuid, label: 'Body' },
      { id: second.uuid, label: 'Detail' },
    ],
  );
  assert.equal(projector.selectedTargets().length, 2, 'pick mode raycasts all candidates');
  assert.equal(projector.selectTarget({ kind: 'mesh', targetId: second.uuid }), true);
  assert.deepEqual(projector.selectedTargets().map(({ id }) => id), [second.uuid]);
  assert.equal(projector.selectTarget({ kind: 'mesh', targetId: 'missing' }), false);
  assert.deepEqual(projector.projectionTarget, { kind: 'mesh', targetId: second.uuid });
  assert.equal(projector.selectTarget({ kind: 'all' }), true);
  assert.equal(projector.selectedTargets().length, 2);

  projector.dispose();
});

test('raycasts and closest-point queries produce target-local, offset-aware hits', () => {
  const root = new THREE.Group();
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
  root.add(plane);
  const projector = new SurfaceProjector();
  projector.registerTargetRoot(root, { kind: 'mesh', targetId: plane.uuid });

  const raycaster = new THREE.Raycaster(
    new THREE.Vector3(0.2, -0.3, 2),
    new THREE.Vector3(0, 0, -1),
  );
  const hit = projector.raycast(raycaster, 0.25);
  assert.ok(hit);
  assert.equal(hit.targetId, plane.uuid);
  assertVector(hit.targetPosition, new THREE.Vector3(0.2, -0.3, 0));
  assertVector(hit.targetNormal, new THREE.Vector3(0, 0, 1));
  assertVector(hit.worldPosition, new THREE.Vector3(0.2, -0.3, 0.25));
  assert.equal(hit.surfaceOffset, 0.25);

  const stored = projector.storeHit(17, hit, [0.4, -0.2]);
  assert.deepEqual(stored, {
    id: 17,
    targetId: plane.uuid,
    targetPosition: [0.2, -0.3, 0],
    targetNormal: [0, 0, 1],
    areaPosition: [0.4, -0.2],
    surfaceOffset: 0.25,
  });
  const materialized = projector.materialize(stored);
  assert.ok(materialized);
  assertVector(materialized.worldPosition, hit.worldPosition);
  assertVector(materialized.worldNormal, hit.worldNormal);

  const closest = projector.closestPoint(new THREE.Vector3(-0.4, 0.1, 1.5), 0.1);
  assert.ok(closest);
  assertVector(closest.targetPosition, new THREE.Vector3(-0.4, 0.1, 0));
  assertVector(closest.worldPosition, new THREE.Vector3(-0.4, 0.1, 0.1));
  assert.ok(Math.abs(closest.distance - 1.5) < EPSILON);

  projector.dispose();
});

test('stored target-local points follow later target transforms with correct normals', () => {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  mesh.position.set(2, -1, 3);
  mesh.rotation.set(0.2, -0.4, 0.3);
  mesh.scale.set(2, 0.75, 1.4);
  root.add(mesh);
  root.updateWorldMatrix(true, true);

  const localPosition = new THREE.Vector3(0.2, -0.1, 0.5);
  const localNormal = new THREE.Vector3(0, 0, 1);
  const worldSurfacePosition = localPosition.clone().applyMatrix4(mesh.matrixWorld);
  const worldNormal = localNormal.clone().applyNormalMatrix(
    new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld),
  );

  const projector = new SurfaceProjector();
  projector.registerTargetRoot(root);
  const stored = projector.store(9, mesh.uuid, worldSurfacePosition, worldNormal, 0.2);
  assert.ok(stored);
  assertVector(new THREE.Vector3().fromArray(stored.targetPosition), localPosition);
  assertVector(new THREE.Vector3().fromArray(stored.targetNormal), localNormal);

  mesh.position.set(-4, 2, 1);
  mesh.rotation.set(-0.35, 0.1, 0.8);
  mesh.scale.set(0.5, 3, 1.25);
  root.updateWorldMatrix(true, true);
  const expectedNormal = localNormal.clone().applyNormalMatrix(
    new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld),
  );
  const expectedPosition = localPosition.clone().applyMatrix4(mesh.matrixWorld)
    .addScaledVector(expectedNormal, 0.2);
  const materialized = projector.materialize(stored);
  assert.ok(materialized);
  assertVector(materialized.worldNormal, expectedNormal);
  assertVector(materialized.worldPosition, expectedPosition);

  projector.dispose();
});

test('dispose releases only projector-owned BVHs and never source meshes or materials', () => {
  const borrowedGeometry = new THREE.BoxGeometry();
  const ownedGeometry = new THREE.SphereGeometry();
  const borrowedMaterial = new THREE.MeshBasicMaterial();
  const ownedMaterial = new THREE.MeshBasicMaterial();
  const borrowedMesh = new THREE.Mesh(borrowedGeometry, borrowedMaterial);
  const ownedMesh = new THREE.Mesh(ownedGeometry, ownedMaterial);
  const root = new THREE.Group();
  root.add(borrowedMesh, ownedMesh);

  indexForRaycasts(borrowedMesh);
  assert.ok((borrowedGeometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree);
  assert.equal((ownedGeometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree, undefined);

  let geometryDisposed = false;
  let materialDisposed = false;
  ownedGeometry.addEventListener('dispose', () => { geometryDisposed = true; });
  ownedMaterial.addEventListener('dispose', () => { materialDisposed = true; });

  const projector = new SurfaceProjector();
  projector.registerTargetRoot(root);
  assert.ok((ownedGeometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree);
  projector.dispose();

  assert.ok(
    (borrowedGeometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree,
    'borrowed pre-existing BVH remains installed',
  );
  assert.equal(
    (ownedGeometry as THREE.BufferGeometry & { boundsTree?: unknown }).boundsTree,
    null,
    'projector-created BVH is released',
  );
  assert.equal(root.children.includes(borrowedMesh), true);
  assert.equal(root.children.includes(ownedMesh), true);
  assert.equal(geometryDisposed, false);
  assert.equal(materialDisposed, false);

  borrowedGeometry.disposeBoundsTree?.();
  borrowedGeometry.dispose();
  ownedGeometry.dispose();
  borrowedMaterial.dispose();
  ownedMaterial.dispose();
});
