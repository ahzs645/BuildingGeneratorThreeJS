import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { EditableCurveDocument } from "./editable-curves";

const sample = (x: number, y: number) => ({
  point: new THREE.Vector3(x, y, 0),
  normal: new THREE.Vector3(0, 0, 1),
  local: [x, y] as [number, number],
});

test("editable curves retain stable selection while a stroke moves", () => {
  const document = new EditableCurveDocument();
  const stroke = document.addStroke([sample(0, 0), sample(1, 0), sample(1, 1)]);
  assert.equal(document.selectStroke(stroke.id), true);

  document.translateSelection(new THREE.Vector3(2, 3, 0), (proposed) => ({
    point: proposed,
    normal: new THREE.Vector3(0, 0, 1),
    local: [proposed.x, proposed.y],
  }));

  assert.deepEqual(stroke.points.map(({ point }) => point.toArray()), [
    [2, 3, 0],
    [3, 3, 0],
    [3, 4, 0],
  ]);
  assert.deepEqual(document.selection, { strokeId: stroke.id });
});

test("a selected control point moves without changing the rest of its stroke", () => {
  const document = new EditableCurveDocument();
  const stroke = document.addStroke([sample(0, 0), sample(1, 0), sample(2, 0)]);
  const middle = stroke.points[1];
  assert.equal(document.selectPoint(stroke.id, middle.id), true);

  document.moveSelectedPoint(new THREE.Vector3(1, 2, 0), (proposed) => ({
    point: proposed,
    normal: new THREE.Vector3(0, 0, 1),
    local: [proposed.x, proposed.y],
  }));

  assert.deepEqual(stroke.points.map(({ point }) => point.toArray()), [
    [0, 0, 0],
    [1, 2, 0],
    [2, 0, 0],
  ]);
});

test("toCurves keeps multiple splines in one shared coordinate system", () => {
  const document = new EditableCurveDocument();
  document.addStroke([sample(-1, 0), sample(1, 0)]);
  document.addStroke([sample(0, -1), sample(0, 1)]);

  assert.deepEqual(document.toCurves((point) => [point.local![0] * 20, point.local![1] * 20, 0]), [
    { cyclic: false, points: [[-20, 0, 0], [20, 0, 0]] },
    { cyclic: false, points: [[0, -20, 0], [0, 20, 0]] },
  ]);
});
