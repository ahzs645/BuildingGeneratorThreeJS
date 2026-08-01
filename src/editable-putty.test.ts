import assert from "node:assert/strict";
import test from "node:test";
import { EditablePuttyDocument } from "./editable-putty";

test("putty blobs keep stable ids while selected blobs move", () => {
  const document = new EditablePuttyDocument();
  const first = document.add([0, 0, 0], 1);
  const second = document.add([2, 0, 0], .75);
  document.select(first.id);
  assert.equal(document.moveSelected([.5, 1, -.25]), true);
  assert.deepEqual(document.blobs, [
    { id: first.id, position: [.5, 1, -.25], radius: 1 },
    { id: second.id, position: [2, 0, 0], radius: .75 },
  ]);
});

test("putty blobs can be duplicated, resized, and deleted", () => {
  const document = new EditablePuttyDocument();
  const source = document.add([1, 2, 3], .8);
  const copy = document.duplicateSelected([1, 0, 0]);
  assert.ok(copy);
  assert.notEqual(copy.id, source.id);
  assert.deepEqual(copy.position, [2, 2, 3]);
  document.resizeSelected(1.4);
  assert.equal(copy.radius, 1.4);
  assert.equal(document.deleteSelected(), true);
  assert.equal(document.blobs.length, 1);
});

test("putty serializes every blob into one Geometry Nodes seed", () => {
  const document = new EditablePuttyDocument();
  document.add([-1, 0, 0], 1);
  document.add([1, 0, 0], .5);
  assert.deepEqual(document.toSeed(3), {
    kind: "ico-spheres",
    subdivisions: 3,
    spheres: [
      { position: [-1, 0, 0], radius: 1 },
      { position: [1, 0, 0], radius: .5 },
    ],
  });
});
