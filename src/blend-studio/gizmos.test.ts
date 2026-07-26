import assert from "node:assert/strict";
import test from "node:test";
import type { Dump } from "../gnvm";
import { discoverBlendStudioTargets } from "./model";
import {
  gizmoContractsForBlendStudioTarget,
  setGizmoValue,
} from "./gizmos";

function fixture(): Dump {
  return {
    objects: [{
      name: "Controller",
      modifiers: [{
        type: "NODES",
        node_group: "Root",
        input_values: {
          Size: 2,
          Rotation: [0, 0, .5],
        },
      }],
    }],
    node_groups: {
      Root: {
        name: "Root",
        type: "GeometryNodeTree",
        interface: [
          { name: "Geometry", item_type: "SOCKET", identifier: "Geometry", in_out: "OUTPUT", socket_type: "NodeSocketGeometry" },
          { name: "Size", item_type: "SOCKET", identifier: "Size", in_out: "INPUT", socket_type: "NodeSocketFloat", default: 1, min_value: 0, max_value: 10 },
          { name: "Rotation", item_type: "SOCKET", identifier: "Rotation", in_out: "INPUT", socket_type: "NodeSocketRotation", default: [0, 0, 0] },
        ],
        nodes: [
          { name: "Input", type: "NodeGroupInput", label: null, inputs: [], outputs: [] },
          {
            name: "Linear",
            type: "GeometryNodeGizmoLinear",
            label: null,
            inputs: [
              { name: "Value", identifier: "Value", type: "NodeSocketFloat", linked: true, value: null },
              { name: "Direction", identifier: "Direction", type: "NodeSocketVector", linked: false, value: [1, 0, 0] },
              { name: "Position", identifier: "Position", type: "NodeSocketVector", linked: false, value: [1, 2, 3] },
            ],
            outputs: [],
          },
          {
            name: "Nested",
            type: "GeometryNodeGroup",
            group: "Dial Group",
            label: null,
            inputs: [{ name: "Rotation", identifier: "Rotation", type: "NodeSocketRotation", linked: true, value: null }],
            outputs: [],
          },
        ],
        links: [
          { from_node: "Input", from_socket: "Size", to_node: "Linear", to_socket: "Value" },
          { from_node: "Input", from_socket: "Rotation", to_node: "Nested", to_socket: "Rotation" },
        ],
      },
      "Dial Group": {
        name: "Dial Group",
        type: "GeometryNodeTree",
        interface: [
          { name: "Rotation", item_type: "SOCKET", identifier: "Rotation", in_out: "INPUT", socket_type: "NodeSocketRotation", default: [0, 0, 0] },
        ],
        nodes: [
          { name: "Input", type: "NodeGroupInput", label: null, inputs: [], outputs: [] },
          { name: "Separate", type: "ShaderNodeSeparateXYZ", label: null, inputs: [{ name: "Vector", identifier: "Vector", type: "NodeSocketVector", linked: true, value: null }], outputs: [] },
          { name: "Combine", type: "ShaderNodeCombineXYZ", label: null, inputs: [
            { name: "X", identifier: "X", type: "NodeSocketFloat", linked: false, value: 0 },
            { name: "Y", identifier: "Y", type: "NodeSocketFloat", linked: false, value: 0 },
            { name: "Z", identifier: "Z", type: "NodeSocketFloat", linked: true, value: null },
          ], outputs: [] },
          { name: "Dial", type: "GeometryNodeGizmoDial", label: null, inputs: [{ name: "Value", identifier: "Value", type: "NodeSocketFloat", linked: true, value: null }], outputs: [] },
        ],
        links: [
          { from_node: "Input", from_socket: "Rotation", to_node: "Separate", to_socket: "Vector" },
          { from_node: "Separate", from_socket: "Z", to_node: "Combine", to_socket: "Z" },
          { from_node: "Combine", from_socket: "Vector", to_node: "Dial", to_socket: "Value" },
        ],
      },
    },
  };
}

test("discovers root and nested linear/dial gizmo bindings", () => {
  const dump = fixture();
  const target = discoverBlendStudioTargets(dump)[0];
  const contracts = gizmoContractsForBlendStudioTarget(dump, target);
  assert.deepEqual(
    contracts.map(({ kind, rootInputIdentifier, component, value }) =>
      ({ kind, rootInputIdentifier, component, value })),
    [
      { kind: "dial", rootInputIdentifier: "Rotation", component: 2, value: .5 },
      { kind: "linear", rootInputIdentifier: "Size", component: undefined, value: 2 },
    ],
  );
  assert.deepEqual(setGizmoValue({}, contracts[0], 1), {
    Rotation: [0, 0, 1],
  });
  assert.deepEqual(contracts.find((contract) => contract.kind === "linear")?.position, [1, 2, 3]);
});
