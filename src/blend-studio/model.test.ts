import assert from "node:assert/strict";
import test from "node:test";
import type { Dump } from "../gnvm";
import {
  compatibilityForBlendStudioTarget,
  controlsForBlendStudioTarget,
  discoverBlendStudioTargets,
  seedableObjectNames,
} from "./model";

const socket = (name: string, identifier: string, inOut: "INPUT" | "OUTPUT", socketType: string, extra = {}) => ({
  name,
  identifier,
  item_type: "SOCKET",
  in_out: inOut,
  socket_type: socketType,
  ...extra,
});

function fixture(): Dump {
  return {
    objects: [
      {
        name: "Generator",
        mesh: { verts: [[0, 0, 0]], faces: [] },
        modifiers: [{
          type: "NODES",
          node_group: "Assigned",
          input_values: { Count: 4, Socket_2: .25 },
        }],
      },
      { name: "Curve Seed", curves: [{ points: [[0, 0, 0], [1, 0, 0]], cyclic: false }] },
    ],
    node_groups: {
      Assigned: {
        name: "Assigned",
        type: "GeometryNodeTree",
        interface: [
          socket("Geometry", "Socket_0", "OUTPUT", "NodeSocketGeometry"),
          socket("Count", "Socket_1", "INPUT", "NodeSocketInt", { default: 2, min_value: 1, max_value: 12 }),
          socket("Scale", "Socket_2", "INPUT", "NodeSocketFloatFactor", { default: .5 }),
        ],
        nodes: [
          { name: "Input", type: "NodeGroupInput", label: null, inputs: [], outputs: [] },
          { name: "Output", type: "NodeGroupOutput", label: null, inputs: [], outputs: [] },
        ],
        links: [],
      },
      "Asset Root": {
        name: "Asset Root",
        type: "GeometryNodeTree",
        interface: [
          socket("Geometry", "Socket_0", "OUTPUT", "NodeSocketGeometry"),
          socket("Input", "Socket_1", "INPUT", "NodeSocketGeometry"),
        ],
        nodes: [
          { name: "Nested", type: "GeometryNodeGroup", group: "Helper", label: null, inputs: [], outputs: [] },
        ],
        links: [],
      },
      Helper: {
        name: "Helper",
        type: "GeometryNodeTree",
        interface: [socket("Geometry", "Socket_0", "OUTPUT", "NodeSocketGeometry")],
        nodes: [],
        links: [],
      },
    },
  };
}

test("discovers every modifier and only unassigned top-level reusable groups", () => {
  const targets = discoverBlendStudioTargets(fixture());
  assert.deepEqual(targets.map(({ kind, label }) => [kind, label]), [
    ["object", "Generator"],
    ["group", "Asset Root"],
  ]);
});

test("builds numeric and boolean controls with identifier-first saved values", () => {
  const dump = fixture();
  const target = discoverBlendStudioTargets(dump)[0];
  const controls = controlsForBlendStudioTarget(dump, target);
  assert.deepEqual(controls.map(({ name, value, min, max, step }) => ({ name, value, min, max, step })), [
    { name: "Count", value: 4, min: 1, max: 12, step: 1 },
    { name: "Scale", value: .25, min: 0, max: 1, step: .001 },
  ]);
});

test("reports reachable support and seedable extracted objects", () => {
  const dump = fixture();
  const target = discoverBlendStudioTargets(dump)[0];
  const compatibility = compatibilityForBlendStudioTarget(dump, target);
  assert.equal(compatibility.score, 100);
  assert.deepEqual(seedableObjectNames(dump), ["Curve Seed", "Generator"]);
});
