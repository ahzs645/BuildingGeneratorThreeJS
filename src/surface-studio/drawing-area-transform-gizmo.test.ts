import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { DrawingAreaController } from './drawing-area-controller';
import { DrawingAreaTransformGizmo } from './drawing-area-transform-gizmo';
import { SurfaceDocument } from './surface-document';
import { SurfaceProjector } from './surface-projector';

function setup(): {
  document: SurfaceDocument;
  controller: DrawingAreaController;
  gizmo: DrawingAreaTransformGizmo;
} {
  const document = new SurfaceDocument();
  document.setDrawingArea({
    target: { kind: 'pick' },
    center: [0, 0, 0],
    normal: [0, 0, 1],
    u: [1, 0, 0],
    v: [0, 1, 0],
    size: [2, 2],
    projectionHeight: 1,
    committed: false,
  });
  const controller = new DrawingAreaController(document, new SurfaceProjector());
  const gizmo = new DrawingAreaTransformGizmo({ controller, worldSize: 1 });
  return { document, controller, gizmo };
}

test('builds renderer-safe RGB arrows and Blender plane handles at the source grid', () => {
  const { gizmo } = setup();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  gizmo.sync(camera, 600);

  assert.equal(gizmo.group.visible, true);
  assert.deepEqual(gizmo.group.position.toArray(), [0, 0, 1]);
  for (const name of [
    'Drawing area gizmo axis-x arrow',
    'Drawing area gizmo axis-y arrow',
    'Drawing area gizmo axis-z arrow',
    'Drawing area gizmo plane-xy handle',
    'Drawing area gizmo plane-xz handle',
    'Drawing area gizmo plane-yz handle',
  ]) {
    const object = gizmo.group.getObjectByName(name);
    assert.ok(object, `${name} exists`);
    assert.ok(object instanceof THREE.Mesh);
    assert.ok(object.material instanceof THREE.MeshBasicMaterial);
    assert.equal(object.material.depthTest, false);
    assert.equal(object.material.toneMapped, false);
  }

  gizmo.dispose();
});

test('axis drag translates the drawing area as one undoable history group', () => {
  const { document, gizmo } = setup();
  const camera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  gizmo.sync(camera, 400);

  const startRay = new THREE.Ray(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));
  assert.equal(gizmo.beginDrag({
    handle: 'axis-x',
    point: new THREE.Vector3(0.5, 0, 1),
    distance: 9,
  }, startRay), true);
  assert.equal(gizmo.dragToRay(new THREE.Ray(
    new THREE.Vector3(1.25, 0.6, 10),
    new THREE.Vector3(0, 0, -1),
  )), true);
  gizmo.endDrag();

  assert.deepEqual(document.snapshot.drawingArea?.center, [1.25, 0, 0]);
  assert.equal(document.canUndo, true);
  assert.equal(document.undo(), true);
  assert.deepEqual(document.snapshot.drawingArea?.center, [0, 0, 0]);
  gizmo.dispose();
});

test('cancelled plane drag restores the area transform', () => {
  const { document, gizmo } = setup();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.updateMatrixWorld(true);
  gizmo.sync(camera, 600);
  const startRay = new THREE.Ray(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1));

  assert.equal(gizmo.beginDrag({
    handle: 'plane-xy',
    point: new THREE.Vector3(0.2, 0.2, 1),
    distance: 9,
  }, startRay), true);
  gizmo.dragToRay(new THREE.Ray(
    new THREE.Vector3(0.5, -0.75, 10),
    new THREE.Vector3(0, 0, -1),
  ));
  assert.deepEqual(document.snapshot.drawingArea?.center, [0.5, -0.75, 0]);
  gizmo.cancelDrag();
  assert.deepEqual(document.snapshot.drawingArea?.center, [0, 0, 0]);
  gizmo.dispose();
});
