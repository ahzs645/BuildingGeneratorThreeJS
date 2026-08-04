import assert from "node:assert/strict";
import test from "node:test";
import { SweptContactSelection } from "./swept-contact-selection";

const topology = { vertexCount: 9, cellCount: 4 };

test("contacts persist after the projector no longer touches them", () => {
  const selection = new SweptContactSelection();
  selection.createPatch("area", topology);

  selection.accumulate({
    vertices: [{ index: 0, point: [1, 2, 3] }],
    cells: [{ index: 0, weight: 0.4, point: [1, 1, 1] }],
  });
  selection.accumulate({
    vertices: [{ index: 8, point: [8, 2, 3] }],
    cells: [{ index: 3, point: [3, 1, 1] }],
  });
  selection.accumulate({});

  assert.deepEqual([...selection.vertexContacts().keys()], [0, 8]);
  assert.deepEqual([...selection.cellContacts().keys()], [0, 3]);
  assert.deepEqual(selection.vertexContacts().get(0)?.point, [1, 2, 3]);
});

test("strongest contact retains the best draped point and accumulates evidence", () => {
  const selection = new SweptContactSelection({ pointMode: "strongest" });
  selection.createPatch("area", topology);
  selection.accumulate({ cells: [{ index: 1, weight: 0.25, point: [0, 0, 0] }] });
  selection.accumulate({ cells: [{ index: 1, weight: 1, point: [0, 0, 2] }] });
  selection.accumulate({ cells: [{ index: 1, weight: 0.5, point: [0, 0, 9] }] });

  const contact = selection.cellContacts().get(1);
  assert.equal(contact?.strength, 1);
  assert.equal(contact?.accumulatedWeight, 1.75);
  assert.equal(contact?.touches, 3);
  assert.deepEqual(contact?.point, [0, 0, 2]);
});

test("weighted mean point mode supports smooth accumulated contact positions", () => {
  const selection = new SweptContactSelection({ pointMode: "weighted-mean" });
  selection.createPatch("area", topology);
  selection.accumulate({ vertices: [{ index: 2, weight: 0.25, point: [0, 0, 0] }] });
  selection.accumulate({ vertices: [{ index: 2, weight: 0.75, point: [4, 0, 0] }] });

  assert.deepEqual(selection.vertexContacts().get(2)?.point, [3, 0, 0]);
});

test("multiple independent patches accumulate without erasing each other", () => {
  const selection = new SweptContactSelection();
  selection.createPatch("first", topology);
  selection.accumulate({ cells: [{ index: 0 }] });
  selection.createPatch("second", topology);
  selection.accumulate({ cells: [{ index: 3 }] });

  assert.deepEqual(selection.patchIds, ["first", "second"]);
  assert.deepEqual([...selection.cellContacts("first").keys()], [0]);
  assert.deepEqual([...selection.cellContacts("second").keys()], [3]);
});

test("explicit invalidation resets a transformed patch while ordinary motion does not", () => {
  const selection = new SweptContactSelection();
  selection.createPatch("area", topology);
  selection.accumulate({ vertices: [{ index: 4, point: [1, 2, 3] }] });
  selection.accumulate({});
  assert.equal(selection.hasContact(), true);

  selection.invalidatePatch();
  assert.equal(selection.hasContact(), false);
});

test("resize remaps logical indices and can transform retained surface points", () => {
  const selection = new SweptContactSelection();
  selection.createPatch("area", topology);
  selection.accumulate({
    vertices: [
      { index: 0, point: [0, 0, 0] },
      { index: 8, point: [2, 2, 0] },
    ],
    cells: [{ index: 3, point: [1.5, 1.5, 0] }],
  });

  selection.remapPatch("area", { vertexCount: 4, cellCount: 1 }, {
    vertexIndex: (oldIndex) => oldIndex === 8 ? 3 : oldIndex,
    cellIndex: () => 0,
    point: ([x, y, z]) => [x * 0.5, y * 0.5, z],
  });

  assert.deepEqual([...selection.vertexContacts().keys()], [0, 3]);
  assert.deepEqual(selection.vertexContacts().get(3)?.point, [1, 1, 0]);
  assert.deepEqual([...selection.cellContacts().keys()], [0]);
});

test("point transforms preserve selection while moving retained geometry", () => {
  const selection = new SweptContactSelection();
  selection.createPatch("area", topology);
  selection.accumulate({ vertices: [{ index: 1, point: [1, 2, 3] }] });
  selection.transformPoints("area", ([x, y, z]) => [x + 4, y, z - 1]);

  assert.deepEqual(selection.vertexContacts().get(1)?.point, [5, 2, 2]);
  assert.deepEqual([...selection.vertexContacts().keys()], [1]);
});

test("explicit checkpoints undo accumulation and patch lifecycle changes", () => {
  const selection = new SweptContactSelection({ undoLimit: 3 });
  selection.createPatch("area", topology);
  selection.accumulate({ cells: [{ index: 0 }] });
  selection.checkpoint();
  selection.accumulate({ cells: [{ index: 1 }] });
  selection.createPatch("extra", topology);

  assert.equal(selection.undo(), true);
  assert.deepEqual(selection.patchIds, ["area"]);
  assert.deepEqual([...selection.cellContacts().keys()], [0]);
  assert.equal(selection.undo(), false);
});

test("out-of-range contacts fail loudly instead of corrupting a patch", () => {
  const selection = new SweptContactSelection();
  selection.createPatch("area", topology);
  assert.throws(() => selection.accumulate({ cells: [{ index: 4 }] }), /outside/);
});
