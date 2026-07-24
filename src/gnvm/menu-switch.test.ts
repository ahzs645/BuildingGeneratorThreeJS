import assert from "node:assert/strict";
import test from "node:test";
import { Field } from "./core";
import { Geometry } from "./geometry";
import { REGISTRY, type EvalAPI, type RawNode } from "./registry";
import "./index";

function menuNode(dataType = "VECTOR"): RawNode {
  return {
    name: "Menu Switch",
    type: "GeometryNodeMenuSwitch",
    label: null,
    inputs: [
      { name: "Menu", identifier: "Menu", type: "NodeSocketMenu", linked: true, value: null },
      { name: "x", identifier: "Item_0", type: "NodeSocketVector", linked: true, value: null },
      { name: "y", identifier: "Item_1", type: "NodeSocketVector", linked: true, value: null },
      { name: "z", identifier: "Item_2", type: "NodeSocketVector", linked: true, value: null },
    ],
    outputs: [
      { name: "Output", identifier: "Output", type: "NodeSocketVector" },
      { name: "x", identifier: "Item_0", type: "NodeSocketBool" },
      { name: "y", identifier: "Item_1", type: "NodeSocketBool" },
      { name: "z", identifier: "Item_2", type: "NodeSocketBool" },
    ],
    props: { data_type: dataType, active_index: 0, active_item: { name: "x" } },
  };
}

function menuApi(menu: string, node = menuNode()): EvalAPI {
  const fields: Record<string, Field> = {
    Item_0: Field.of([1, 0, 0]),
    Item_1: Field.of([0, 1, 0]),
    Item_2: Field.of([0, 0, 1]),
  };
  return {
    node,
    input: (name) => name === "Menu" ? menu : fields[name],
    inputs: () => [],
    geoInputs: () => [],
    geo: () => new Geometry(),
    field: (name) => fields[name] ?? Field.of(0),
    num: () => 0,
    vec: () => [0, 0, 0],
    bool: () => false,
    str: () => "",
    ref: () => null,
    prop: (name, fallback) => (node.props?.[name] ?? fallback) as never,
    resolve: () => [],
  };
}

test("Menu Switch exposes mutually-exclusive named outputs beside the selected value", () => {
  const handler = REGISTRY.get("GeometryNodeMenuSwitch");
  assert.ok(handler);
  const result = handler(menuApi("y"));
  assert.deepEqual((result.Output as Field).value, [0, 1, 0]);
  assert.equal((result.Item_0 as Field).value, 0);
  assert.equal((result.Item_1 as Field).value, 1);
  assert.equal((result.Item_2 as Field).value, 0);
});

test("Menu Switch leaves every named output false when the linked enum has no item", () => {
  const handler = REGISTRY.get("GeometryNodeMenuSwitch");
  assert.ok(handler);
  const result = handler(menuApi("missing"));
  assert.equal((result.Output as Field).value, 0);
  assert.equal((result.Item_0 as Field).value, 0);
  assert.equal((result.Item_1 as Field).value, 0);
  assert.equal((result.Item_2 as Field).value, 0);
});

test("Menu Switch preserves raw strings instead of coercing them to numeric fields", () => {
  const handler = REGISTRY.get("GeometryNodeMenuSwitch");
  assert.ok(handler);
  const node = menuNode("STRING");
  node.inputs[1].type = "NodeSocketString";
  node.inputs[2].type = "NodeSocketString";
  node.inputs[3].type = "NodeSocketString";
  const api = menuApi("z", node);
  const originalInput = api.input;
  api.input = (name) => {
    if (name === "Item_0") return "alpha";
    if (name === "Item_1") return "beta";
    if (name === "Item_2") return "gamma";
    return originalInput(name);
  };
  assert.equal(handler(api).Output, "gamma");
});

test("Menu Switch preserves datablock identity values", () => {
  const handler = REGISTRY.get("GeometryNodeMenuSwitch");
  assert.ok(handler);
  const node = menuNode("MATERIAL");
  const material = { datablock: "Material", name: "Anodized Aluminum" };
  const api = menuApi("y", node);
  const originalInput = api.input;
  api.input = (name) => name === "Item_1" ? material : originalInput(name);
  assert.equal(handler(api).Output, material);
});
