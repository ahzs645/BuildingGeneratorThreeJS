import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import type { SurfaceInteractionMode } from './contracts';
import { SurfaceDocument } from './surface-document';
import {
  SurfaceInputController,
  type OrbitEnabledControl,
  type SurfacePointerContext,
} from './surface-input-controller';
import { SurfaceProjector } from './surface-projector';

type PointerInit = {
  pointerId?: number;
  button?: number;
  isPrimary?: boolean;
  clientX: number;
  clientY: number;
};

class FakePointerElement {
  readonly captured = new Set<number>();
  prevented = 0;
  private readonly listeners = new Map<string, Set<(event: PointerEvent) => void>>();

  addEventListener(type: string, listener: (event: PointerEvent) => void): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: PointerEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  getBoundingClientRect(): DOMRect {
    return {
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  }

  setPointerCapture(pointerId: number): void {
    this.captured.add(pointerId);
  }

  releasePointerCapture(pointerId: number): void {
    this.captured.delete(pointerId);
  }

  dispatch(type: string, init: PointerInit): void {
    const event = {
      pointerId: init.pointerId ?? 1,
      button: init.button ?? 0,
      isPrimary: init.isPrimary ?? true,
      clientX: init.clientX,
      clientY: init.clientY,
      preventDefault: () => { this.prevented++; },
    } as PointerEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

function surfaceFixture(): {
  root: THREE.Group;
  mesh: THREE.Mesh;
  camera: THREE.OrthographicCamera;
  projector: SurfaceProjector;
} {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial());
  root.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
  camera.position.set(0, 0, 3);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const projector = new SurfaceProjector();
  projector.registerTargetRoot(root);
  return { root, mesh, camera, projector };
}

function element(value: FakePointerElement): HTMLElement {
  return value as unknown as HTMLElement;
}

test('draw mode samples by minimum distance and commits target-local points', () => {
  const { mesh, camera, projector } = surfaceFixture();
  const pointer = new FakePointerElement();
  const document = new SurfaceDocument();
  const orbit: OrbitEnabledControl = { enabled: true };
  const controller = new SurfaceInputController({
    element: element(pointer),
    camera: () => camera,
    projector,
    document,
    orbitControls: orbit,
    generatorId: 'crystals',
    mode: 'draw',
    minDistance: 0.15,
    surfaceOffset: 0.12,
    nextSeed: () => 99,
    hooks: { areaPosition: () => [0.25, -0.5] },
  });

  assert.equal(orbit.enabled, false);
  pointer.dispatch('pointerdown', { pointerId: 7, clientX: 50, clientY: 50 });
  assert.deepEqual(pointer.captured, new Set([7]));
  pointer.dispatch('pointermove', { pointerId: 7, clientX: 53, clientY: 50 });
  pointer.dispatch('pointermove', { pointerId: 7, clientX: 70, clientY: 50 });
  // Another pointer cannot add to or commit this stroke.
  pointer.dispatch('pointermove', { pointerId: 8, clientX: 90, clientY: 50 });
  pointer.dispatch('pointerup', { pointerId: 8, clientX: 90, clientY: 50 });
  assert.ok(document.snapshot.activeStroke);
  pointer.dispatch('pointerup', { pointerId: 7, clientX: 70, clientY: 50 });

  assert.equal(pointer.captured.size, 0);
  assert.equal(document.snapshot.activeStroke, null);
  assert.equal(document.snapshot.strokes.length, 1);
  const stroke = document.snapshot.strokes[0];
  assert.equal(stroke.generatorId, 'crystals');
  assert.equal(stroke.seed, 99);
  assert.equal(stroke.points.length, 2, 'nearby and foreign-pointer samples were rejected');
  assert.equal(stroke.points[0].targetId, mesh.uuid);
  assert.ok(Math.abs(stroke.points[0].targetPosition[0]) < 1e-6);
  assert.ok(Math.abs(stroke.points[1].targetPosition[0] - 0.4) < 1e-6);
  assert.deepEqual(stroke.points[0].areaPosition, [0.25, -0.5]);
  assert.equal(stroke.points[0].surfaceOffset, 0.12);
  assert.ok(pointer.prevented > 0);

  controller.dispose();
  projector.dispose();
});

test('drawing-area hook can reject samples outside the committed projection patch', () => {
  const { camera, projector } = surfaceFixture();
  const pointer = new FakePointerElement();
  const document = new SurfaceDocument();
  const controller = new SurfaceInputController({
    element: element(pointer),
    camera: () => camera,
    projector,
    document,
    orbitControls: { enabled: true },
    generatorId: 'chrome-crayon',
    mode: 'draw',
    hooks: { areaPosition: () => null },
  });

  pointer.dispatch('pointerdown', { pointerId: 3, clientX: 50, clientY: 50 });
  pointer.dispatch('pointermove', { pointerId: 3, clientX: 80, clientY: 50 });
  pointer.dispatch('pointerup', { pointerId: 3, clientX: 80, clientY: 50 });
  assert.equal(document.snapshot.strokes.length, 0);
  controller.dispose();
  projector.dispose();
});

test('pointer cancellation removes only the active stroke', () => {
  const { camera, projector } = surfaceFixture();
  const pointer = new FakePointerElement();
  const document = new SurfaceDocument();
  const controller = new SurfaceInputController({
    element: element(pointer),
    camera: () => camera,
    projector,
    document,
    orbitControls: { enabled: true },
    mode: 'draw',
  });

  pointer.dispatch('pointerdown', { pointerId: 2, clientX: 40, clientY: 50 });
  pointer.dispatch('pointermove', { pointerId: 2, clientX: 70, clientY: 50 });
  assert.ok(document.snapshot.activeStroke);
  pointer.dispatch('pointercancel', { pointerId: 2, clientX: 70, clientY: 50 });
  assert.equal(document.snapshot.activeStroke, null);
  assert.equal(document.snapshot.strokes.length, 0);

  controller.dispose();
  projector.dispose();
});

test('Tree rejects surface-authoring modes without clearing the shared document', () => {
  const { camera, projector } = surfaceFixture();
  const pointer = new FakePointerElement();
  const document = new SurfaceDocument();
  document.beginStroke('ivy', 4);
  for (const x of [0, 0.4]) document.appendPoint({
    targetId: projector.targets[0].id,
    targetPosition: [x, 0, 0],
    targetNormal: [0, 0, 1],
    surfaceOffset: 0,
  });
  document.commitStroke();
  const preservedStroke = document.snapshot.strokes[0];
  const orbit: OrbitEnabledControl = { enabled: true };
  const controller = new SurfaceInputController({
    element: element(pointer),
    camera: () => camera,
    projector,
    document,
    orbitControls: orbit,
    mode: 'draw',
  });

  controller.setGenerator('tree');
  assert.equal(controller.mode, 'orbit');
  assert.equal(orbit.enabled, true);
  for (const mode of ['draw', 'select', 'place-area', 'pick-target'] as SurfaceInteractionMode[]) {
    assert.equal(controller.setMode(mode), false, `Tree rejects ${mode}`);
  }
  assert.equal(controller.setMode('interact'), true);
  assert.equal(orbit.enabled, false);
  assert.equal(document.snapshot.strokes.length, 1);
  assert.equal(document.snapshot.strokes[0], preservedStroke);

  controller.setGenerator('ivy');
  assert.equal(controller.mode, 'orbit', 'unsupported Tree interaction falls back safely');
  assert.equal(controller.setMode('select'), true);
  assert.equal(document.snapshot.strokes[0], preservedStroke);

  controller.dispose();
  projector.dispose();
});

test('target pick sees all meshes and updates projector, document, and callback', () => {
  const root = new THREE.Group();
  const left = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1), new THREE.MeshBasicMaterial());
  const right = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1), new THREE.MeshBasicMaterial());
  left.position.x = -1;
  right.position.x = 1;
  root.add(left, right);
  const camera = new THREE.OrthographicCamera(-2, 2, 1, -1, 0.01, 10);
  camera.position.z = 3;
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const projector = new SurfaceProjector();
  projector.registerTargetRoot(root, { kind: 'mesh', targetId: left.uuid });
  const document = new SurfaceDocument();
  document.setProjectionTarget({ kind: 'mesh', targetId: left.uuid });
  const pointer = new FakePointerElement();
  let picked: SurfacePointerContext['hit'] = null;
  const controller = new SurfaceInputController({
    element: element(pointer),
    camera: () => camera,
    projector,
    document,
    orbitControls: { enabled: true },
    mode: 'pick-target',
    hooks: { onTargetPick: ({ hit }) => { picked = hit; } },
  });

  // x=75 maps to world x=1 with this orthographic camera.
  pointer.dispatch('pointerdown', { clientX: 75, clientY: 50 });
  assert.equal(picked?.targetId, right.uuid);
  assert.deepEqual(projector.projectionTarget, { kind: 'mesh', targetId: right.uuid });
  assert.deepEqual(document.snapshot.target, { kind: 'mesh', targetId: right.uuid });

  controller.dispose();
  projector.dispose();
});

test('area/select hooks are headless seams and disposal removes every listener', () => {
  const { camera, projector } = surfaceFixture();
  const pointer = new FakePointerElement();
  const document = new SurfaceDocument();
  const orbit: OrbitEnabledControl = { enabled: true };
  const calls: string[] = [];
  const controller = new SurfaceInputController({
    element: element(pointer),
    camera: () => camera,
    projector,
    document,
    orbitControls: orbit,
    hooks: {
      onPlaceArea: ({ hit }) => calls.push(`area:${Boolean(hit)}`),
      onSelect: ({ hit }) => calls.push(`select:${Boolean(hit)}`),
    },
  });
  const revision = document.snapshot.revision;

  assert.equal(controller.setMode('place-area'), true);
  pointer.dispatch('pointerdown', { clientX: 50, clientY: 50 });
  assert.equal(controller.setMode('select'), true);
  pointer.dispatch('pointerdown', { clientX: 50, clientY: 50 });
  assert.deepEqual(calls, ['area:true', 'select:true']);
  assert.equal(document.snapshot.revision, revision, 'extension hooks own their future mutations');
  assert.equal(pointer.listenerCount(), 4);

  controller.dispose();
  assert.equal(pointer.listenerCount(), 0);
  assert.equal(orbit.enabled, true);
  pointer.dispatch('pointerdown', { clientX: 50, clientY: 50 });
  assert.deepEqual(calls, ['area:true', 'select:true']);

  projector.dispose();
});
