import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three/webgpu';
import type { Dump, TriSoup } from '../gnvm/index';
import type { ProjectedSurfaceStroke } from './generator-adapter';
import {
  GnBrushEvaluatorClient,
  StaleGnEvaluationError,
  bufferGeometryFromGnSoup,
  chromeCrayonAdapter,
  chromeCrayonCurvePayload,
  periodicBrushAdapter,
  periodicCurvePayload,
  stampAdapter,
  stampsAlongProjectedStroke,
  typewriterAdapter,
  typewriterGeometryAlongStroke,
  wrapChromeCrayonSoup,
  type GnEvaluatorWorker,
} from './blender-gn-adapters';

const projectedStroke = (
  id: number,
  coordinates: readonly (readonly [number, number, number])[],
  cyclic = false,
): ProjectedSurfaceStroke => ({
  id,
  generatorId: 'chrome-crayon',
  seed: id * 10,
  cyclic,
  points: coordinates.map((coordinate, index) => ({
    id: id * 100 + index,
    targetId: 'target',
    worldPosition: new THREE.Vector3(...coordinate),
    worldNormal: new THREE.Vector3(0, 0, 1),
    targetPosition: new THREE.Vector3(...coordinate),
    targetNormal: new THREE.Vector3(0, 0, 1),
    surfaceOffset: 0,
  })),
});

const soup = (positions = [0, 0, 0]): TriSoup => ({
  positions: new Float32Array(positions),
  normals: new Float32Array(positions.map((_, index) => index % 3 === 2 ? 1 : 0)),
  indices: new Uint32Array([0, 0, 0]),
  attributes: {},
  groups: [{ start: 0, count: 3, material: null }],
  stats: { verts: positions.length / 3, faces: 1, tris: 1 },
});

test('builds periodic world curves and filters one-point strokes', () => {
  const usable = projectedStroke(1, [[1, 2, 3], [4, 5, 6]], true);
  const payload = periodicCurvePayload([projectedStroke(2, [[0, 0, 0]]), usable]);
  assert.deepEqual(payload, [{ points: [[1, 2, 3], [4, 5, 6]], cyclic: true }]);
});

test('flattens Chrome Crayon by arc length then wraps soup over projected normals', () => {
  const stroke = projectedStroke(1, [[1, 2, 3], [3, 2, 3]]);
  const { curves, layouts } = chromeCrayonCurvePayload([stroke]);
  assert.deepEqual(curves[0].points, [[0, 0, 0], [40, 0, 0]]);
  assert.equal(layouts[0].length, 2);

  const result = soup([20, 20, 10]);
  wrapChromeCrayonSoup(result, layouts);
  // Halfway along + one unit lateral (+Y) + half unit normal (+Z).
  assert.deepEqual([...result.positions].map((value) => Number(value.toFixed(5))), [2, 3, 3.5]);
  assert.deepEqual([...result.normals], [0, 0, 1]);
});

test('creates ordinary indexed BufferGeometry and retains draw groups', () => {
  const geometry = bufferGeometryFromGnSoup(soup([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  assert.equal(geometry.getAttribute('position').count, 3);
  assert.equal(geometry.index?.count, 3);
  assert.deepEqual(geometry.groups, [{ start: 0, count: 3, materialIndex: 0 }]);
  geometry.dispose();
});

test('maps typewriter glyph axes into tangent, lateral, and surface normal', () => {
  const stroke = projectedStroke(1, [[0, 0, 0], [2, 0, 0]]);
  const layout = chromeCrayonCurvePayload([stroke]).layouts[0];
  const glyph = soup([0, -1, 0, 2, 1, 1]);
  glyph.indices = new Uint32Array([0, 1, 1]);
  const geometry = typewriterGeometryAlongStroke(glyph, layout, { fitStroke: true, size: 1, offset: 0 });
  const positions = geometry.getAttribute('position');
  assert.deepEqual([positions.getX(0), positions.getY(0)], [0, -1]);
  assert.deepEqual([positions.getX(1), positions.getY(1)], [2, 1]);
  assert.ok(Math.abs(positions.getZ(0) - 0.018) < 1e-6);
  assert.ok(Math.abs(positions.getZ(1) - 1.018) < 1e-6);
  geometry.dispose();
});

test('places rigid stamps along a stroke and enforces the shared vertex budget', () => {
  const stroke = projectedStroke(1, [[0, 0, 0], [3, 0, 0]]);
  const layout = chromeCrayonCurvePayload([stroke]).layouts[0];
  const asset = soup([-.5, -.5, 0, .5, -.5, 0, 0, .5, 1]);
  asset.indices = new Uint32Array([0, 1, 2]);
  const result = stampsAlongProjectedStroke(asset, layout, 0.5, 0.5, 6);
  assert.ok(result);
  assert.equal(result.count, 2);
  assert.equal(result.capped, true);
  assert.equal(result.geometry.getAttribute('position').count, 6);
  result.geometry.dispose();
});

class FakeWorker implements GnEvaluatorWorker {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: ((event: { readonly message: string }) => void) | null = null;
  readonly messages: Record<string, unknown>[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.messages.push(message as Record<string, unknown>);
    const value = message as { kind: string; installId?: string };
    if (value.kind === 'install') queueMicrotask(() => this.reply({ ok: true, installed: value.installId }));
  }

  reply(data: unknown): void {
    this.onmessage?.({ data });
  }

  terminate(): void {
    this.terminated = true;
  }
}

test('caches worker installation and rejects results superseded by a newer request', async () => {
  const worker = new FakeWorker();
  const client = new GnBrushEvaluatorClient(() => worker);
  const dump = {} as Dump;
  const first = client.evaluate({ dump, object: 'OBJECT', curves: [], overrides: {} });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  const second = client.evaluate({ dump, object: 'OBJECT', curves: [], overrides: {} });
  await assert.rejects(first, StaleGnEvaluationError);

  const evaluations = worker.messages.filter(({ kind }) => kind === 'evaluate');
  assert.equal(worker.messages.filter(({ kind }) => kind === 'install').length, 1);
  assert.equal(evaluations.length, 2);
  const secondId = evaluations[1].id as number;
  const expected = soup([1, 2, 3]);
  worker.reply({ id: secondId, ok: true, soup: expected });
  assert.equal(await second, expected);
  client.dispose();
  assert.equal(worker.terminated, true);
});

test('cancels a pending evaluation through the shared manager AbortSignal', async () => {
  const worker = new FakeWorker();
  const client = new GnBrushEvaluatorClient(() => worker);
  const controller = new AbortController();
  const pending = client.evaluate({
    dump: {} as Dump,
    object: 'OBJECT',
    curves: [],
    overrides: {},
    signal: controller.signal,
  });
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  client.dispose();
});

test('exports canonical adapters for both Blender GN brushes', () => {
  assert.equal(chromeCrayonAdapter.descriptor.id, 'chrome-crayon');
  assert.equal(periodicBrushAdapter.descriptor.id, 'periodic-brush');
  assert.equal(typewriterAdapter.descriptor.id, 'typewriter');
  assert.equal(stampAdapter.descriptor.id, 'stamp');
});
