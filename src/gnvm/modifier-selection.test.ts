import assert from "node:assert/strict";
import test from "node:test";
import type { Dump } from "./dump-schema";
import { findModifierGroup } from "./index";

const dump: Dump = {
  node_groups: {
    First: { name: "First", type: "GeometryNodeTree", interface: [], nodes: [], links: [] },
    Second: { name: "Second", type: "GeometryNodeTree", interface: [], nodes: [], links: [] },
  },
  objects: [{
    name: "Stacked",
    modifiers: [
      { type: "NODES", node_group: "First", input_values: { Value: 1 } },
      { type: "NODES", node_group: "Second", input_values: { Value: 2 } },
    ],
  }],
};

test("modifier selection can address a later Geometry Nodes modifier by group", () => {
  assert.deepEqual(findModifierGroup(dump, "Stacked", "Second"), {
    group: "Second",
    inputs: { Value: 2 },
    objectName: "Stacked",
  });
});

test("modifier selection retains first-modifier compatibility when group is omitted", () => {
  assert.equal(findModifierGroup(dump, "Stacked")?.group, "First");
  assert.equal(findModifierGroup(dump, "Stacked", "Missing"), null);
});
