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

test("Bake restores portable curves, instances, volumes, and literal values", () => {
  const node: RawNode = {
    name: "Bake",
    type: "GeometryNodeBake",
    inputs: [],
    outputs: [
      { name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry" },
      { name: "Volume", identifier: "Volume", type: "NodeSocketVolume" },
      { name: "Value", identifier: "Value", type: "NodeSocketFloat" },
    ],
    bake_snapshot: {
      schema_version: 2,
      source: "blender-evaluated",
      frame: 3,
      items: {
        Geometry: {
          socket_type: "NodeSocketGeometry",
          value_contract: "geometry-set",
          geometry: {
            curves: [{
              points: [[0, 0, 0], [1, 0, 0]],
              cyclic: false,
              spline_type: "POLY",
            }],
            instances: [{
              geometry: {
                mesh: {
                  positions: [[0, 0, 0], [0, 1, 0], [0, 0, 1]],
                  edges: [],
                  faces: [[0, 1, 2]],
                },
              },
              position: [2, 3, 4],
              rotation: [0, 0, 0],
              scale: [1, 1, 1],
            }],
          },
        },
        Volume: {
          socket_type: "NodeSocketVolume",
          value_contract: "volume-grid",
          volume_grid: {
            background: 1,
            min: [0, 0, 0],
            max: [1, 1, 1],
            resolution: [2, 1, 1],
            origin: [0, 0, 0],
            voxel_size: [0.5, 1, 1],
            values: [0.25, 0.75],
            requested_voxel_size: 0.5,
            requested_sample_count: 2,
            budget_adjusted: false,
            sample_budget: 100,
          },
        },
        Value: {
          socket_type: "NodeSocketFloat",
          value_contract: "literal",
          value: 42.5,
        },
      },
    },
  };
  const api: EvalAPI = {
    node,
    input: () => undefined,
    inputs: () => [],
    geoInputs: () => [],
    geo: () => new Geometry(),
    field: () => Field.of(0),
    num: () => 0,
    vec: () => [0, 0, 0],
    bool: () => false,
    str: () => "",
    ref: () => null,
    prop: (_name, fallback) => fallback as never,
    resolve: () => [],
  };
  const result = REGISTRY.get("GeometryNodeBake")!(api);
  assert.ok(result.Geometry instanceof Geometry);
  const geometry = result.Geometry as Geometry;
  assert.equal(geometry.curves.length, 1);
  assert.deepEqual(geometry.instances[0]?.position, [2, 3, 4]);
  assert.deepEqual(geometry.instances[0]?.geometry.mesh?.faces, [[0, 1, 2]]);
  assert.deepEqual(Array.from((result.Volume as { values: Float32Array }).values), [0.25, 0.75]);
  assert.equal((result.Value as Field).value, 42.5);
});
