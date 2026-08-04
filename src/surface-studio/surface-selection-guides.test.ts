import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { SurfaceProjector } from './surface-projector';
import { SurfaceSelectionGuides } from './surface-selection-guides';

test('builds eight three-arm target brackets and hides them outside placement', () => {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), new THREE.MeshBasicMaterial()));
  const projector = new SurfaceProjector();
  projector.registerTargetRoot(root, { kind: 'all' });
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(6, -7, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const guides = new SurfaceSelectionGuides(camera, projector);
  guides.update(true);
  const positions = guides.lines.geometry.getAttribute('position');
  assert.equal(positions.count, 8 * 3 * 2, 'eight corners each contain three two-point arms');
  assert.equal(guides.lines.visible, true);

  guides.update(false);
  assert.equal(guides.lines.visible, false);
  guides.dispose();
  projector.dispose();
});
