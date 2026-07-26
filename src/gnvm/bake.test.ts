import assert from "node:assert/strict";
import test from "node:test";
import { Field } from "./core";
import { Geometry } from "./geometry";
import {
  BOUNDED_APPROXIMATION_NODE_TYPES,
} from "./capabilities";
import { REGISTRY, type EvalAPI, type RawNode, type SockVal } from "./registry";
import "./index";

test("Bake passes every dynamic item through without collapsing to Item_0", () => {
  const node: RawNode = {
    name: "Bake",
    type: "GeometryNodeBake",
    inputs: [
      { name: "4 corners", identifier: "Item_0", type: "NodeSocketGeometry", linked: true },
      { name: "corner bolt", identifier: "Item_1", type: "NodeSocketGeometry", linked: true },
      { name: "", identifier: "__extend__", type: "NodeSocketGeometry", linked: false },
    ],
    outputs: [
      { name: "4 corners", identifier: "Item_0", type: "NodeSocketGeometry" },
      { name: "corner bolt", identifier: "Item_1", type: "NodeSocketGeometry" },
      { name: "", identifier: "__extend__", type: "NodeSocketGeometry" },
    ],
  };
  const corners = new Geometry();
  const bolt = Field.of(17);
  const values: Record<string, SockVal> = { Item_0: corners, Item_1: bolt };
  const api: EvalAPI = {
    node,
    input: (name) => values[name],
    inputs: () => [],
    geoInputs: () => [],
    geo: () => new Geometry(),
    field: (name) => values[name] instanceof Field ? values[name] as Field : Field.of(0),
    num: () => 0,
    vec: () => [0, 0, 0],
    bool: () => false,
    str: () => "",
    ref: () => null,
    prop: (_name, fallback) => fallback as never,
    resolve: () => [],
  };
  const handler = REGISTRY.get("GeometryNodeBake");
  assert.ok(handler);
  assert.deepEqual(handler(api), {
    Item_0: corners,
    Item_1: bolt,
  });
  assert.equal(
    BOUNDED_APPROXIMATION_NODE_TYPES.has("GeometryNodeBake"),
    true,
  );
});

test("Bake prefers an embedded portable evaluated snapshot over the live input", () => {
  const node: RawNode = {
    name: "Bake",
    type: "GeometryNodeBake",
    inputs: [
      { name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry", linked: true },
    ],
    outputs: [
      { name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry" },
    ],
    bake_snapshot: {
      schema_version: 1,
      source: "blender-evaluated",
      frame: 12,
      items: {
        Item_0: {
          socket_type: "NodeSocketGeometry",
          component_contract: "realized-mesh",
          geometry: {
            positions: [[0, 0, 0], [2, 0, 0], [0, 2, 0]],
            edges: [[0, 1], [1, 2], [2, 0]],
            faces: [[0, 1, 2]],
          },
        },
      },
    },
  };
  const live = new Geometry();
  const api: EvalAPI = {
    node,
    input: () => live,
    inputs: () => [],
    geoInputs: () => [],
    geo: () => live,
    field: () => Field.of(0),
    num: () => 0,
    vec: () => [0, 0, 0],
    bool: () => false,
    str: () => "",
    ref: () => null,
    prop: (_name, fallback) => fallback as never,
    resolve: () => [],
  };
  const result = REGISTRY.get("GeometryNodeBake")!(api).Item_0;
  assert.ok(result instanceof Geometry);
  assert.deepEqual(result.mesh?.positions, [[0, 0, 0], [2, 0, 0], [0, 2, 0]]);
  assert.notEqual(result, live);
});
