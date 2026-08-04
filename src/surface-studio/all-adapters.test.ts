import assert from 'node:assert/strict';
import test from 'node:test';
import { SURFACE_GENERATORS } from './generator-catalog';
import { SURFACE_STUDIO_ADAPTERS } from './all-adapters';

test('registers exactly one adapter for every unified studio generator', () => {
  const ids = SURFACE_STUDIO_ADAPTERS.map(({ descriptor }) => descriptor.id);
  assert.deepEqual(ids, SURFACE_GENERATORS.map(({ id }) => id));
  assert.equal(new Set(ids).size, ids.length);
});
