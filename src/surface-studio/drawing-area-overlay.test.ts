import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import type {
  DrawingAreaPatchData,
  DrawingAreaProjectionResult,
  DrawingAreaSourceData,
} from './drawing-area-controller';
import { DrawingAreaOverlay } from './drawing-area-overlay';

const source: DrawingAreaSourceData = {
  center: [0, 0, 0.5],
  lines: [
    { points: [[-1, 0, 0.5], [0, 0, 0.5], [1, 0, 0.5]] },
    { points: [[0, -1, 0.5], [0, 1, 0.5]] },
  ],
  projectionRay: [[0, 0, 0.85], [0, 0, -0.12]],
};

const patch: DrawingAreaPatchData = {
  positions: [
    [-1, -1, 0.02],
    [1, -1, 0.02],
    [-1, 1, 0.02],
    [1, 1, 0.02],
  ],
  valid: [true, true, true, true],
  indices: [0, 2, 1, 1, 2, 3],
  lines: [
    { points: [[-1, -1, 0.02], [1, -1, 0.02]] },
    { points: [[-1, 1, 0.02], [1, 1, 0.02]] },
    { points: [[-1, -1, 0.02], [-1, 1, 0.02]] },
    { points: [[1, -1, 0.02], [1, 1, 0.02]] },
  ],
};

function projection(options: {
  source?: DrawingAreaSourceData | null;
  patch?: DrawingAreaPatchData | null;
  contact?: boolean;
  committed?: boolean;
} = {}): DrawingAreaProjectionResult {
  return {
    area: null,
    source: options.source === undefined ? source : options.source,
    patch: options.patch === undefined ? null : options.patch,
    contact: options.contact ?? false,
    committed: options.committed ?? false,
    closestContactDistance: null,
    stats: { rayHits: 0, fallbackHits: 0, rejectedRayHits: 0, rejectedFallbackHits: 0 },
  };
}

function helper<T extends THREE.Object3D>(overlay: DrawingAreaOverlay, name: string): T {
  const object = overlay.group.getObjectByName(name);
  assert.ok(object, `${name} helper exists`);
  return object as T;
}

test('builds WebGPU-safe white source grid and projection-ray helpers', () => {
  const overlay = new DrawingAreaOverlay({ renderOrder: 40 });
  overlay.update(projection());

  const grid = helper<THREE.LineSegments>(overlay, 'Drawing area source grid');
  const ray = helper<THREE.LineSegments>(overlay, 'Drawing area projection ray');
  const fill = helper<THREE.Mesh>(overlay, 'Drawing area conformed patch');
  const lines = helper<THREE.LineSegments>(overlay, 'Drawing area conformed grid');
  assert.equal(grid.visible, true);
  assert.equal(ray.visible, true);
  assert.equal(fill.visible, false);
  assert.equal(lines.visible, false);
  assert.equal(grid.renderOrder, 40);
  assert.equal(ray.renderOrder, 41);
  assert.equal(fill.renderOrder, 42);
  assert.equal(lines.renderOrder, 43);
  assert.equal((grid.geometry.getAttribute('position') as THREE.BufferAttribute).count, 6);
  assert.equal((ray.geometry.getAttribute('position') as THREE.BufferAttribute).count, 2);

  assert.ok(grid.material instanceof THREE.LineBasicMaterial);
  assert.ok(ray.material instanceof THREE.LineBasicMaterial);
  assert.ok(lines.material instanceof THREE.LineBasicMaterial);
  assert.ok(fill.material instanceof THREE.MeshBasicMaterial);
  assert.equal(grid.material.type, 'LineBasicMaterial');
  assert.equal(fill.material.type, 'MeshBasicMaterial');
  assert.equal(grid.material.toneMapped, false);
  assert.equal(fill.material.toneMapped, false);

  overlay.dispose();
});

test('shows indexed yellow contact and committed patch data with stable helpers', () => {
  const overlay = new DrawingAreaOverlay();
  const fill = helper<THREE.Mesh>(overlay, 'Drawing area conformed patch');
  const lines = helper<THREE.LineSegments>(overlay, 'Drawing area conformed grid');
  const originalFill = fill;
  const originalLines = lines;

  overlay.update(projection({ patch, contact: true }));
  assert.equal(fill.visible, true);
  assert.equal(lines.visible, true);
  assert.equal(fill.geometry.getAttribute('position').count, 4);
  assert.equal(fill.geometry.index?.count, 6);
  assert.equal(lines.geometry.getAttribute('position').count, 8);
  assert.equal((fill.material as THREE.MeshBasicMaterial).opacity, 0.58);
  assert.equal((fill.material as THREE.MeshBasicMaterial).color.getHex(), 0xffff32);

  overlay.update(projection({ patch, committed: true }));
  assert.equal(helper(overlay, 'Drawing area conformed patch'), originalFill);
  assert.equal(helper(overlay, 'Drawing area conformed grid'), originalLines);
  assert.equal((fill.material as THREE.MeshBasicMaterial).opacity, 0.68);

  overlay.dispose();
});

test('updates dispose replaced buffers while preserving shared materials and visibility', () => {
  const overlay = new DrawingAreaOverlay();
  overlay.update(projection({ patch, contact: true }));
  const grid = helper<THREE.LineSegments>(overlay, 'Drawing area source grid');
  const fill = helper<THREE.Mesh>(overlay, 'Drawing area conformed patch');
  const gridMaterial = grid.material;
  const fillMaterial = fill.material;
  const oldGridGeometry = grid.geometry;
  const oldFillGeometry = fill.geometry;
  let gridDisposed = 0;
  let fillDisposed = 0;
  oldGridGeometry.addEventListener('dispose', () => { gridDisposed++; });
  oldFillGeometry.addEventListener('dispose', () => { fillDisposed++; });

  overlay.setVisible(false);
  overlay.update(projection({ source: null, patch: null }));
  assert.equal(gridDisposed, 1);
  assert.equal(fillDisposed, 1);
  assert.notEqual(grid.geometry, oldGridGeometry);
  assert.notEqual(fill.geometry, oldFillGeometry);
  assert.equal(grid.material, gridMaterial);
  assert.equal(fill.material, fillMaterial);
  assert.equal(grid.visible, false);
  assert.equal(fill.visible, false);
  assert.equal(overlay.visible, false, 'content updates do not override caller visibility');

  overlay.dispose();
});

test('dispose removes the group and releases every current geometry and material once', () => {
  const parent = new THREE.Group();
  const overlay = new DrawingAreaOverlay({ parent });
  overlay.update(projection({ patch, committed: true }));
  const objects = overlay.group.children as Array<THREE.Mesh | THREE.LineSegments>;
  const geometries = objects.map(({ geometry }) => geometry);
  const materials = objects.map(({ material }) => material as THREE.Material);
  let geometryDisposals = 0;
  let materialDisposals = 0;
  for (const geometry of geometries) {
    geometry.addEventListener('dispose', () => { geometryDisposals++; });
  }
  for (const material of materials) {
    material.addEventListener('dispose', () => { materialDisposals++; });
  }

  assert.equal(parent.children.includes(overlay.group), true);
  overlay.dispose();
  overlay.dispose();
  assert.equal(parent.children.includes(overlay.group), false);
  assert.equal(overlay.group.children.length, 0);
  assert.equal(geometryDisposals, 4);
  assert.equal(materialDisposals, 4);

  // Updates after teardown are ignored and cannot allocate replacement buffers.
  overlay.update(projection({ patch, contact: true }));
  assert.equal(geometryDisposals, 4);
  assert.equal(materialDisposals, 4);
});
