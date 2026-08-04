import assert from 'node:assert/strict';
import test from 'node:test';
import { SURFACE_GENERATORS, surfaceGenerator } from './generator-catalog';

test('catalog contains every procedural and Blender surface tool once', () => {
  assert.deepEqual(
    SURFACE_GENERATORS.map((generator) => generator.id),
    [
      'ivy',
      'tree',
      'crystals',
      'molten',
      'aurora',
      'reef',
      'chrome-crayon',
      'periodic-brush',
      'typewriter',
      'stamp',
    ],
  );
  assert.equal(new Set(SURFACE_GENERATORS.map((generator) => generator.id)).size, 10);
});

test('Tree capability metadata disables surface authoring without discarding it', () => {
  const tree = surfaceGenerator('tree');
  assert.equal(tree.capabilities.input, 'ground');
  assert.equal(tree.capabilities.sceneMode, 'exclusive');
  assert.equal(tree.capabilities.usesProjectionTarget, false);
  assert.equal(tree.capabilities.usesDrawingArea, false);
  assert.equal(tree.capabilities.supportsUndoClear, false);
  assert.deepEqual(tree.capabilities.interactionModes, ['orbit', 'interact', 'flower']);
});

test('surface generators share projection, area, edit, undo and clear capabilities', () => {
  for (const generator of SURFACE_GENERATORS.filter(({ id }) => id !== 'tree')) {
    assert.equal(generator.capabilities.input, 'surface-strokes', generator.id);
    assert.equal(generator.capabilities.usesProjectionTarget, true, generator.id);
    assert.equal(generator.capabilities.usesDrawingArea, true, generator.id);
    assert.equal(generator.capabilities.supportsUndoClear, true, generator.id);
    for (const mode of ['orbit', 'pick-target', 'place-area', 'draw', 'select'] as const) {
      assert.ok(generator.capabilities.interactionModes.includes(mode), `${generator.id} supports ${mode}`);
    }
  }
});
