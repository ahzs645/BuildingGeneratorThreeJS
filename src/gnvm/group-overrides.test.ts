import assert from "node:assert/strict";
import test from "node:test";
import { Field } from "./core";
import { Evaluator, type Program, type RawGroup } from "./evaluator";
import type { RawNode, RawOutput, RawSocket } from "./registry";

function input(identifier: string, type: string, value: unknown): RawSocket {
  return { name: identifier, identifier, type, linked: false, value };
}

function output(identifier: string, type: string): RawOutput {
  return { name: identifier, identifier, type };
}

function groupNode(group: string, inputs: RawSocket[], outputs: RawOutput[]): RawNode {
  return { name: "Nested", type: "GeometryNodeGroup", label: null, group, inputs, outputs };
}

function passthroughGroup(name: string, inputId: string, outputId: string): RawGroup {
  return {
    name,
    type: "GeometryNodeTree",
    interface: [
      { item_type: "SOCKET", in_out: "OUTPUT", identifier: outputId, name: outputId, socket_type: "NodeSocketFloat" },
      { item_type: "SOCKET", in_out: "INPUT", identifier: inputId, name: inputId, socket_type: "NodeSocketFloat", default: 0 },
    ],
    nodes: [
      {
        name: "Group Input",
        type: "NodeGroupInput",
        label: null,
        inputs: [],
        outputs: [output(inputId, "NodeSocketFloat")],
      },
      {
        name: "Group Output",
        type: "NodeGroupOutput",
        label: null,
        inputs: [input(outputId, "NodeSocketFloat", 0)],
        outputs: [],
      },
    ],
    links: [{
      from_node: "Group Input",
      from_socket: inputId,
      to_node: "Group Output",
      to_socket: outputId,
    }],
  };
}

function rootCalling(groupName: string, inputId: string, outputId: string, value: unknown, type = "NodeSocketFloat"): RawGroup {
  return {
    name: "Root",
    type: "GeometryNodeTree",
    interface: [
      { item_type: "SOCKET", in_out: "OUTPUT", identifier: "Result", name: "Result", socket_type: type },
    ],
    nodes: [
      groupNode(groupName, [input(inputId, type, value)], [output(outputId, type)]),
      {
        name: "Group Output",
        type: "NodeGroupOutput",
        label: null,
        inputs: [input("Result", type, type === "NodeSocketColor" ? [0, 0, 0] : 0)],
        outputs: [],
      },
    ],
    links: [{
      from_node: "Nested",
      from_socket: outputId,
      to_node: "Group Output",
      to_socket: "Result",
    }],
  };
}

function constantResult(program: Program) {
  const result = new Evaluator(program).evalModifierGroup("Root").outputs.Result;
  assert.ok(result instanceof Field);
  assert.equal(result.isConst, true);
  return result.value;
}

test("an unrecognized nested group uses generic group evaluation", () => {
  const program: Program = {
    Root: rootCalling("Future Group", "Value", "Value", 11),
    "Future Group": passthroughGroup("Future Group", "Value", "Value"),
  };

  assert.equal(constantResult(program), 11);
});

test("a same-name group with a different contract does not trigger an override", () => {
  const program: Program = {
    Root: rootCalling("Gradient Direction", "Value", "Value", 7),
    "Gradient Direction": passthroughGroup("Gradient Direction", "Value", "Value"),
  };

  assert.equal(constantResult(program), 7);
});

test("a matching named-group contract still uses its compatibility override", () => {
  const name = "Hue Saturation Value N++";
  const hsvDefinition: RawGroup = {
    name,
    type: "GeometryNodeTree",
    interface: [
      { item_type: "SOCKET", in_out: "OUTPUT", identifier: "Output_1", name: "Color", socket_type: "NodeSocketColor" },
      { item_type: "SOCKET", in_out: "INPUT", identifier: "Input_0", name: "Color", socket_type: "NodeSocketColor" },
      { item_type: "SOCKET", in_out: "INPUT", identifier: "Input_2", name: "Hue", socket_type: "NodeSocketFloat" },
      { item_type: "SOCKET", in_out: "INPUT", identifier: "Input_3", name: "Saturation", socket_type: "NodeSocketFloat" },
      { item_type: "SOCKET", in_out: "INPUT", identifier: "Input_4", name: "Value", socket_type: "NodeSocketFloat" },
      { item_type: "SOCKET", in_out: "INPUT", identifier: "Input_5", name: "Factor", socket_type: "NodeSocketFloat" },
    ],
    nodes: [],
    links: [],
  };
  const root = rootCalling(name, "Input_0", "Output_1", [1, 0, 0], "NodeSocketColor");
  const nested = root.nodes[0];
  nested.inputs.push(
    input("Input_2", "NodeSocketFloat", 0.5),
    input("Input_3", "NodeSocketFloat", 1),
    input("Input_4", "NodeSocketFloat", 1),
    input("Input_5", "NodeSocketFloat", 1),
  );
  const program: Program = { Root: root, [name]: hsvDefinition };

  assert.deepEqual(constantResult(program), [1, 0, 0]);
});
