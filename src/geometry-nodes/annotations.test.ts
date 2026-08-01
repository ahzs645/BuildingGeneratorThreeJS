import assert from "node:assert/strict";
import test from "node:test";
import type { Dump, DumpAnnotationLayer } from "../gnvm";
import {
  activeAnnotationLayers,
  annotationBounds,
  annotationPointToFlow,
  documentBounds,
  projectFlowPoint,
  resolveAnnotationFrame,
} from "./annotations";

const layer: DumpAnnotationLayer = {
  name: "Note",
  color: [0.7, 0.78, 0],
  opacity: 1,
  thickness: 3,
  active_frame: 235,
  frames: [
    { number: 10, strokes: [] },
    { number: 235, strokes: [{
      flags: 2,
      space: "VIEW2D",
      cyclic: false,
      thickness: 3,
      points: [[-10, 20, 0, 1, 1], [30, -40, 0, 0.5, 1]],
    }] },
    { number: 300, strokes: [] },
  ],
};

test("frame-locked annotations use the active frame while ordinary layers hold previous frames", () => {
  assert.equal(resolveAnnotationFrame({ ...layer, frame_locked: true }, 1405)?.number, 235);
  assert.equal(resolveAnnotationFrame({ ...layer, frame_locked: false }, 250)?.number, 235);
  assert.equal(resolveAnnotationFrame({ ...layer, frame_locked: false }, 5)?.number, 10);
});

test("active layers resolve shared tree annotations and skip hidden layers", () => {
  const dump: Dump = {
    scene: { frame_current: 1405 },
    node_groups: {
      Lesson: { name: "Lesson", type: "GeometryNodeTree", nodes: [], links: [], interface: [], annotation: "Ink" },
    },
    annotations: {
      Ink: { name: "Ink", layers: [{ ...layer, frame_locked: true }, { ...layer, name: "Hidden", hidden: true }] },
    },
  };
  const active = activeAnnotationLayers(dump, "Lesson");
  assert.equal(active.length, 1);
  assert.equal(active[0].frame.number, 235);
});

test("annotation coordinates, bounds, and viewport projection match React Flow", () => {
  const active = [{ annotation: "Ink", layer, frame: layer.frames[1] }];
  assert.deepEqual(annotationPointToFlow([-10, 20, 0, 1, 1]), { x: -10, y: -20 });
  assert.deepEqual(annotationBounds(active), { x: -10, y: -20, width: 40, height: 60 });
  assert.deepEqual(projectFlowPoint({ x: 30, y: 40 }, { x: 5, y: 7, zoom: 2 }), { x: 65, y: 87 });
  assert.deepEqual(documentBounds([
    { absolutePosition: { x: -20, y: -10 }, width: 5, height: 5 },
  ], active), { x: -20, y: -20, width: 50, height: 60 });
});
