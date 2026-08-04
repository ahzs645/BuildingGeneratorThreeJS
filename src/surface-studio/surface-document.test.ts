import assert from "node:assert/strict";
import test from "node:test";
import type { DrawingAreaState } from "./contracts";
import { SurfaceDocument, type NewSurfacePoint } from "./surface-document";

const sample = (x: number, targetId = "mesh-a"): NewSurfacePoint => ({
  targetId,
  targetPosition: [x, x + 1, x + 2],
  targetNormal: [0, 0, 1],
  areaPosition: [x, -x],
  surfaceOffset: 0.02,
});

const drawingArea = (targetId = "mesh-a"): DrawingAreaState => ({
  target: { kind: "mesh", targetId },
  center: [0, 0, 0],
  normal: [0, 0, 1],
  u: [1, 0, 0],
  v: [0, 1, 0],
  size: [2.4, 2.4],
  projectionHeight: 0.85,
  committed: true,
});

function addStroke(document: SurfaceDocument, offset = 0): number {
  const id = document.beginStroke("chrome-crayon", 17 + offset);
  document.appendPoint(sample(offset));
  document.appendPoint(sample(offset + 1));
  assert.equal(document.commitStroke()?.id, id);
  return id;
}

test("surface document commits immutable records with stable, non-reused ids", () => {
  const document = new SurfaceDocument();
  const firstId = addStroke(document);
  const first = document.snapshot.strokes[0];
  const firstPointIds = first.points.map(({ id }) => id);

  assert.equal(firstId, 1);
  assert.deepEqual(firstPointIds, [1, 2]);
  assert.equal(Object.isFrozen(document.snapshot), true);
  assert.equal(Object.isFrozen(document.snapshot.strokes), true);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.points[0].targetPosition), true);
  assert.throws(() => {
    (document.snapshot as { revision: number }).revision = -1;
  }, TypeError);

  document.clearStrokes();
  const secondId = addStroke(document, 5);
  assert.equal(secondId, 2);
  assert.deepEqual(document.snapshot.strokes[0].points.map(({ id }) => id), [3, 4]);
});

test("subscriptions report monotonic revisions and stop after unsubscribe", () => {
  const document = new SurfaceDocument();
  const revisions: number[] = [];
  const kinds: string[] = [];
  const unsubscribe = document.subscribe((change) => {
    assert.equal(change.before.revision + 1, change.after.revision);
    revisions.push(change.after.revision);
    kinds.push(change.kind);
  });

  addStroke(document);
  const committedRevision = document.snapshot.revision;
  assert.equal(document.undo(), true);
  assert.equal(document.snapshot.revision, committedRevision + 1);
  assert.deepEqual(document.snapshot.strokes, []);
  assert.deepEqual(revisions, [1, 2, 3, 4, 5]);
  assert.deepEqual(kinds, ["strokes", "strokes", "strokes", "strokes", "strokes"]);

  unsubscribe();
  document.setProjectionTarget({ kind: "all" });
  assert.equal(revisions.length, 5);
});

test("target changes clear dependent authoring state and can be undone on the same surface", () => {
  const document = new SurfaceDocument();
  document.setProjectionTarget({ kind: "all" });
  document.setDrawingArea(drawingArea());
  const strokeId = addStroke(document);

  document.setProjectionTarget({ kind: "mesh", targetId: "mesh-b" });
  assert.deepEqual(document.snapshot.target, { kind: "mesh", targetId: "mesh-b" });
  assert.equal(document.snapshot.drawingArea, null);
  assert.deepEqual(document.snapshot.strokes, []);
  assert.equal(document.snapshot.selection, null);

  assert.equal(document.undo(), true);
  assert.deepEqual(document.snapshot.target, { kind: "all" });
  assert.equal(document.snapshot.drawingArea?.committed, true);
  assert.equal(document.snapshot.strokes[0].id, strokeId);
});

test("surface replacement invalidates target ids and clears undo without reusing ids", () => {
  const document = new SurfaceDocument();
  document.setProjectionTarget({ kind: "mesh", targetId: "old-mesh" });
  addStroke(document);
  assert.equal(document.canUndo, true);

  document.replaceSurface(9);
  assert.equal(document.snapshot.surfaceRevision, 9);
  assert.deepEqual(document.snapshot.target, { kind: "pick" });
  assert.equal(document.snapshot.drawingArea, null);
  assert.deepEqual(document.snapshot.strokes, []);
  assert.equal(document.snapshot.selection, null);
  assert.equal(document.canUndo, false);
  assert.equal(document.undo(), false);

  assert.equal(addStroke(document, 10), 2);
  assert.deepEqual(document.snapshot.strokes[0].points.map(({ id }) => id), [3, 4]);
});

test("a grouped point drag is one undo step and preserves point identity", () => {
  const document = new SurfaceDocument();
  const strokeId = addStroke(document);
  const original = document.snapshot.strokes[0];
  const originalPointIds = original.points.map(({ id }) => id);

  document.beginHistoryGroup("Move selected stroke");
  document.replaceStrokePoints(strokeId, [sample(10), sample(11)]);
  document.replaceStrokePoints(strokeId, [sample(20), sample(21)]);
  document.commitHistoryGroup();

  assert.deepEqual(document.snapshot.strokes[0].points.map(({ id }) => id), originalPointIds);
  assert.deepEqual(document.snapshot.strokes[0].points[0].targetPosition, [20, 21, 22]);

  assert.equal(document.undo(), true);
  assert.deepEqual(document.snapshot.strokes[0].points, original.points);

  // The preceding history item is the original Add stroke command, proving
  // both pointer-move updates were coalesced into one edit entry.
  assert.equal(document.undo(), true);
  assert.deepEqual(document.snapshot.strokes, []);
});

test("cancelling a history group rolls its edits back without adding undo history", () => {
  const document = new SurfaceDocument();
  const strokeId = addStroke(document);
  const original = document.snapshot.strokes[0];

  document.beginHistoryGroup("Cancelled drag");
  document.replaceStrokePoints(strokeId, [sample(50), sample(51)]);
  document.cancelHistoryGroup();
  assert.deepEqual(document.snapshot.strokes[0].points, original.points);

  assert.equal(document.undo(), true);
  assert.deepEqual(document.snapshot.strokes, []);
});

test("clear is undoable and a discarded short stroke never enters history", () => {
  const document = new SurfaceDocument();
  const strokeId = addStroke(document);
  document.clearStrokes();
  assert.deepEqual(document.snapshot.strokes, []);
  assert.equal(document.undo(), true);
  assert.equal(document.snapshot.strokes[0].id, strokeId);

  document.beginStroke("ivy", 99);
  document.appendPoint(sample(4));
  assert.equal(document.commitStroke(), null);
  assert.equal(document.undo(), true);
  assert.deepEqual(document.snapshot.strokes, []);
});

test("reproject target policy preserves area and stroke source records", () => {
  const document = new SurfaceDocument();
  document.setProjectionTarget({ kind: "mesh", targetId: "mesh-a" });
  document.setDrawingArea(drawingArea());
  addStroke(document);
  const strokes = document.snapshot.strokes;
  const area = document.snapshot.drawingArea;

  document.setProjectionTarget({ kind: "all" }, "reproject");
  assert.deepEqual(document.snapshot.target, { kind: "all" });
  assert.deepEqual(document.snapshot.strokes, strokes);
  assert.equal(document.snapshot.drawingArea, area);
});
