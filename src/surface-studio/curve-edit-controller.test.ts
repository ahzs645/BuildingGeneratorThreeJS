import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import { CurveEditController, type CurveEditViewport } from './curve-edit-controller';
import { SurfaceDocument } from './surface-document';
import { SurfaceProjector } from './surface-projector';

const VIEWPORT: CurveEditViewport = { width: 800, height: 800 };

function fixture() {
  const root = new THREE.Group();
  const target = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial());
  root.add(target);
  const projector = new SurfaceProjector();
  projector.registerTargetRoot(root, { kind: 'all' });
  const document = new SurfaceDocument();
  document.setProjectionTarget({ kind: 'all' });
  const strokeId = document.beginStroke('crystals', 71);
  for (const x of [-0.5, 0.5]) document.appendPoint({
    targetId: target.uuid,
    targetPosition: [x, 0, 0],
    targetNormal: [0, 0, 1],
    surfaceOffset: 0,
  });
  document.commitStroke();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateWorldMatrix(true, false);
  const controller = new CurveEditController(document, projector);
  return { root, target, projector, document, strokeId, camera, controller };
}

function ndc(world: THREE.Vector3, camera: THREE.Camera): THREE.Vector2 {
  const projected = world.clone().project(camera);
  return new THREE.Vector2(projected.x, projected.y);
}

test('picks projected control points before the nearest stroke segment', () => {
  const value = fixture();
  const firstPoint = value.document.snapshot.strokes[0].points[0];
  const pointHit = value.controller.pick(
    ndc(new THREE.Vector3(-0.5, 0, 0), value.camera),
    value.camera,
    VIEWPORT,
    10,
  );
  assert.deepEqual(pointHit && { kind: pointHit.kind, strokeId: pointHit.strokeId }, {
    kind: 'point',
    strokeId: value.strokeId,
  });
  assert.equal(pointHit?.kind === 'point' ? pointHit.pointId : null, firstPoint.id);

  const strokeHit = value.controller.pick(
    ndc(new THREE.Vector3(0, 0, 0), value.camera),
    value.camera,
    VIEWPORT,
    10,
  );
  assert.equal(strokeHit?.kind, 'stroke');
  assert.equal(strokeHit?.strokeId, value.strokeId);
  assert.equal(strokeHit?.kind === 'stroke' ? strokeHit.segmentIndex : null, 0);

  assert.equal(value.controller.selectAt(new THREE.Vector2(0.9, 0.9), value.camera, VIEWPORT, 5), null);
  assert.equal(value.document.snapshot.selection, null);
  value.projector.dispose();
});

test('moves one selected point through closest-surface projection as one undo step', () => {
  const value = fixture();
  const pointId = value.document.snapshot.strokes[0].points[0].id;
  value.document.select({ strokeId: value.strokeId, pointId });
  assert.equal(value.controller.beginDrag(), true);
  assert.equal(value.controller.movePoint(new THREE.Vector3(-0.4, 0.2, 1)), true);
  assert.equal(value.controller.movePoint(new THREE.Vector3(-0.3, 0.4, 2)), true);
  assert.equal(value.controller.commitDrag(), true);

  const edited = value.document.snapshot.strokes[0];
  assert.equal(edited.generatorId, 'crystals', 'generator ownership survives tool switches/edits');
  assert.deepEqual(edited.points.map(({ id }) => id), [pointId, edited.points[1].id]);
  assert.ok(Math.abs(edited.points[0].targetPosition[0] + 0.3) < 1e-6);
  assert.ok(Math.abs(edited.points[0].targetPosition[1] - 0.4) < 1e-6);
  assert.ok(Math.abs(edited.points[0].targetPosition[2]) < 1e-6);
  assert.deepEqual(value.projector.projectionTarget, { kind: 'all' });

  assert.equal(value.document.undo(), true);
  assert.deepEqual(value.document.snapshot.strokes[0].points[0].targetPosition, [-0.5, 0, 0]);
  assert.equal(value.document.undo(), true, 'the next undo removes the original Add stroke');
  assert.deepEqual(value.document.snapshot.strokes, []);
  value.projector.dispose();
});

test('translates from the drag baseline and cancel restores the complete stroke', () => {
  const value = fixture();
  const hit = value.controller.selectAt(
    ndc(new THREE.Vector3(0, 0, 0), value.camera),
    value.camera,
    VIEWPORT,
    10,
  );
  assert.equal(hit?.kind, 'stroke');
  assert.equal(value.controller.beginDrag(), true);
  assert.equal(value.controller.translateStroke(new THREE.Vector3(0, 0.25, 0)), true);
  assert.equal(value.controller.translateStroke(new THREE.Vector3(0, 0.6, 0)), true);
  assert.equal(value.controller.cancelDrag(), true);
  assert.deepEqual(
    value.document.snapshot.strokes[0].points.map(({ targetPosition }) => targetPosition),
    [[-0.5, 0, 0], [0.5, 0, 0]],
  );

  // Cancellation does not add history; the prior Add stroke is still next.
  assert.equal(value.document.undo(), true);
  assert.deepEqual(value.document.snapshot.strokes, []);
  value.projector.dispose();
});

test('committed whole-stroke translation reprojects every point and keeps selection', () => {
  const value = fixture();
  value.document.select({ strokeId: value.strokeId });
  assert.equal(value.controller.beginDrag(), true);
  assert.equal(value.controller.translateStroke(new THREE.Vector3(0.2, -0.35, 0.8)), true);
  assert.equal(value.controller.commitDrag(), true);

  const stroke = value.document.snapshot.strokes[0];
  assert.deepEqual(stroke.points.map(({ targetPosition }) => targetPosition.map((number) => (
    Math.abs(number) < 1e-10 ? 0 : Number(number.toFixed(6))
  ))), [[-0.3, -0.35, 0], [0.7, -0.35, 0]]);
  assert.deepEqual(value.document.snapshot.selection, { strokeId: value.strokeId });
  assert.equal(stroke.generatorId, 'crystals');
  value.projector.dispose();
});

test('drawing-area coordinates are refreshed after projection', () => {
  const value = fixture();
  value.document.setDrawingArea({
    target: { kind: 'mesh', targetId: value.target.uuid },
    center: [0, 0, 0],
    normal: [0, 0, 1],
    u: [1, 0, 0],
    v: [0, 1, 0],
    size: [2, 2],
    projectionHeight: 0.5,
    committed: true,
  });
  const pointId = value.document.snapshot.strokes[0].points[0].id;
  value.document.select({ strokeId: value.strokeId, pointId });
  value.controller.beginDrag();
  value.controller.movePoint(new THREE.Vector3(-0.2, 0.45, 1));
  value.controller.commitDrag();
  const areaPosition = value.document.snapshot.strokes[0].points[0].areaPosition!;
  assert.ok(Math.abs(areaPosition[0] + 0.2) < 1e-6);
  assert.ok(Math.abs(areaPosition[1] - 0.45) < 1e-6);
  value.projector.dispose();
});
