import assert from 'node:assert/strict';
import test from 'node:test';
import { PROCEDURAL_PAINT_ADAPTERS } from './procedural-adapters';

test('registers every procedural PaintMode behind the shared adapter contract', () => {
  assert.deepEqual(
    PROCEDURAL_PAINT_ADAPTERS.map(({ descriptor }) => descriptor.id),
    ['crystals', 'molten', 'aurora', 'reef'],
  );
  for (const adapter of PROCEDURAL_PAINT_ADAPTERS) {
    assert.equal(adapter.descriptor.capabilities.input, 'surface-strokes');
    assert.ok(adapter.defaultSettings);
  }
});
