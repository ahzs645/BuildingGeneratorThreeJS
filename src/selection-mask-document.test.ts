import assert from "node:assert/strict";
import test from "node:test";
import { SelectionMaskDocument, selectionMaskFromContactPatch } from "./selection-mask-document";
import { SweptContactSelection } from "./swept-contact-selection";

const topology = { vertexCount: 8, cellCount: 6 };

test("replace/add/subtract/intersect compose stable vertex and cell masks in layer order", () => {
  const document = new SelectionMaskDocument(topology);
  document.createSelector("base", { mask: { vertices: [0, 1, 2], cells: [0, 1] } });
  document.createSelector("add", { operation: "add", mask: { vertices: [3], cells: [2] } });
  document.createSelector("cut", { operation: "subtract", mask: { vertices: [1], cells: [0] } });
  document.createSelector("limit", {
    operation: "intersect",
    mask: { vertices: [0, 3, 7], cells: [1, 2, 5] },
  });

  assert.deepEqual(document.compose(), {
    vertices: [0, 3],
    cells: [1, 2],
    appliedSelectorIds: ["base", "add", "cut", "limit"],
  });
});

test("hidden selectors do not affect the result unless explicitly requested", () => {
  const document = new SelectionMaskDocument(topology);
  document.createSelector("base", { mask: { cells: [0, 1, 2] } });
  document.createSelector("hidden-cut", { operation: "subtract", visible: false, mask: { cells: [1] } });

  assert.deepEqual(document.compose().cells, [0, 1, 2]);
  assert.deepEqual(document.compose({ includeHidden: true }).cells, [0, 2]);
  assert.deepEqual(document.compose({ selectorIds: ["hidden-cut", "base"] }).cells, [0, 1, 2]);
});

test("multiple selectors keep independent masks and an explicit active selector", () => {
  const document = new SelectionMaskDocument(topology);
  document.createSelector("roof", { mask: { cells: [0] } });
  document.createSelector("window", { mask: { cells: [4] } });

  assert.deepEqual(document.selectorIds, ["roof", "window"]);
  assert.equal(document.activeSelectorId, "window");
  document.setActiveSelector("roof");
  assert.equal(document.activeSelectorId, "roof");
  assert.deepEqual(document.getSelector("roof").mask.cells, [0]);
  assert.deepEqual(document.getSelector("window").mask.cells, [4]);
});

test("locked and non-editable selectors reject mask edits but remain composited", () => {
  const document = new SelectionMaskDocument(topology);
  document.createSelector("locked", { locked: true, mask: { cells: [2] } });
  document.createSelector("generated", { editable: false, mask: { cells: [3] } });

  assert.throws(() => document.editMask("locked", { cells: [1] }, "add"), /locked/);
  assert.throws(() => document.clearSelectorMask("generated"), /not editable/);
  assert.deepEqual(document.compose().cells, [2, 3]);

  document.editMask("locked", { cells: [1] }, "add", { force: true });
  assert.deepEqual(document.getSelector("locked").mask.cells, [1, 2]);
});

test("incremental add keeps contacts selected after a projector pushes through", () => {
  const document = new SelectionMaskDocument(topology);
  document.createSelector("projector");
  document.beginHistoryGroup();
  document.editMask("projector", { cells: [0, 1] }, "add");
  document.editMask("projector", { cells: [2, 3] }, "add");
  document.editMask("projector", {}, "add");
  document.endHistoryGroup();

  assert.deepEqual(document.getSelector("projector").mask.cells, [0, 1, 2, 3]);
  assert.equal(document.undo(), true);
  assert.deepEqual(document.getSelector("projector").mask.cells, []);
  assert.equal(document.redo(), true);
  assert.deepEqual(document.getSelector("projector").mask.cells, [0, 1, 2, 3]);
});

test("document snapshots are deep, restorable, and include state and active selection", () => {
  const document = new SelectionMaskDocument(topology);
  document.createSelector("first", { name: "First area", mask: { vertices: [0], cells: [1] } });
  document.createSelector("second", { operation: "subtract", visible: false, locked: true });
  const snapshot = document.snapshot();

  document.updateSelector("first", { name: "Changed", editable: false });
  document.removeSelector("second", { force: true });
  document.restore(snapshot);

  assert.deepEqual(document.snapshot(), snapshot);
  assert.equal(document.activeSelectorId, "second");
});

test("a new mutation after undo invalidates redo", () => {
  const document = new SelectionMaskDocument(topology);
  document.createSelector("area");
  document.editMask("area", { cells: [0] }, "add");
  assert.equal(document.undo(), true);
  assert.equal(document.canRedo, true);

  document.editMask("area", { cells: [4] }, "add");
  assert.equal(document.canRedo, false);
  assert.equal(document.redo(), false);
});

test("history transactions roll back on failure and commit as one undo step", () => {
  const document = new SelectionMaskDocument(topology);
  document.createSelector("area");
  const before = document.snapshot();
  assert.throws(() => document.transaction(() => {
    document.editMask("area", { cells: [1] }, "add");
    document.editMask("area", { cells: [99] }, "add");
  }), /outside/);
  assert.deepEqual(document.snapshot(), before);

  document.transaction(() => {
    document.editMask("area", { cells: [1] }, "add");
    document.updateSelector("area", { name: "Finished" });
  });
  assert.equal(document.getSelector("area").name, "Finished");
  document.undo();
  assert.deepEqual(document.snapshot(), before);
});

test("swept-contact snapshots bridge directly into a selector mask", () => {
  const contacts = new SweptContactSelection();
  contacts.createPatch("patch", topology);
  contacts.accumulate({ vertices: [{ index: 6 }], cells: [{ index: 4 }, { index: 1 }] });
  const patch = contacts.snapshot().patches[0];
  assert.ok(patch);

  assert.deepEqual(selectionMaskFromContactPatch(patch), { vertices: [6], cells: [1, 4] });
});

test("invalid indices and duplicate IDs fail without corrupting the document", () => {
  const document = new SelectionMaskDocument(topology);
  document.createSelector("area", { mask: { cells: [0] } });
  assert.throws(() => document.createSelector("area"), /already exists/);
  assert.throws(() => document.editMask("area", { vertices: [8] }, "add"), /outside/);
  assert.deepEqual(document.getSelector("area").mask.cells, [0]);
});
