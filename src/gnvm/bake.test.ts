import assert from "node:assert/strict";
import test from "node:test";
import { Field } from "./core";
import { Geometry } from "./geometry";
import {
  BOUNDED_APPROXIMATION_NODE_TYPES,
  analyzeProgramCapabilities,
} from "./capabilities";
import type { Program } from "./evaluator";
import { runGenerator } from "./index";
import {
  APPROXIMATIONS,
  DUMP_CONTEXT,
  REGISTRY,
  type EvalAPI,
  type RawNode,
  type SockVal,
} from "./registry";
test("Bake passes every dynamic item through without collapsing to Item_0", () => {
  APPROXIMATIONS.clear();
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
    group: "Root",
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
  DUMP_CONTEXT.activeModifier = {
    type: "NODES",
    node_group: "Root",
    bake_states: [{
      bake_id: 1,
      node_group: "Root",
      node: "Bake",
      status: "unbaked",
    }],
  };
  try {
    assert.deepEqual(handler(api), {
      Item_0: corners,
      Item_1: bolt,
    });
    assert.equal(
      BOUNDED_APPROXIMATION_NODE_TYPES.has("GeometryNodeBake"),
      true,
    );
    assert.equal(APPROXIMATIONS.has("GeometryNodeBake"), false);
  } finally {
    DUMP_CONTEXT.activeModifier = undefined;
  }
});

test("runGenerator uses cache state from the selected modifier instance", async () => {
  const group = {
    name: "Shared Bake",
    type: "GeometryNodeTree",
    interface: [
      {
        item_type: "SOCKET" as const,
        in_out: "INPUT" as const,
        identifier: "InputGeometry",
        name: "Geometry",
        socket_type: "NodeSocketGeometry",
      },
      {
        item_type: "SOCKET" as const,
        in_out: "OUTPUT" as const,
        identifier: "OutputGeometry",
        name: "Geometry",
        socket_type: "NodeSocketGeometry",
      },
    ],
    nodes: [
      {
        name: "Group Input",
        type: "NodeGroupInput",
        label: null,
        inputs: [],
        outputs: [{ name: "Geometry", identifier: "InputGeometry", type: "NodeSocketGeometry" }],
      },
      {
        name: "Bake",
        type: "GeometryNodeBake",
        label: null,
        inputs: [{ name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry", linked: true }],
        outputs: [{ name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry" }],
      },
      {
        name: "Group Output",
        type: "NodeGroupOutput",
        label: null,
        inputs: [{ name: "Geometry", identifier: "OutputGeometry", type: "NodeSocketGeometry", linked: true }],
        outputs: [],
      },
    ],
    links: [
      {
        from_node: "Group Input",
        from_socket: "InputGeometry",
        to_node: "Bake",
        to_socket: "Item_0",
      },
      {
        from_node: "Bake",
        from_socket: "Item_0",
        to_node: "Group Output",
        to_socket: "OutputGeometry",
      },
    ],
  };
  const object = (name: string, status: "unbaked" | "packed") => ({
    name,
    type: "MESH",
    mesh: {
      verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      edges: [[0, 1], [1, 2], [2, 0]] as [number, number][],
      faces: [[0, 1, 2]],
    },
    modifiers: [{
      type: "NODES",
      node_group: "Shared Bake",
      bake_states: [{
        bake_id: 1,
        node_group: "Shared Bake",
        node: "Bake",
        status,
      }],
    }],
  });
  const dump = {
    node_groups: { "Shared Bake": group },
    objects: [object("Live", "unbaked"), object("Cached", "packed")],
  };

  const live = await runGenerator(dump, { object: "Live" });
  const cached = await runGenerator(dump, { object: "Cached" });
  assert.deepEqual(live.soup.stats, { verts: 3, faces: 1, tris: 1 });
  assert.deepEqual(live.coverage.approximateTypes, []);
  assert.deepEqual(cached.coverage.approximateTypes, [
    { type: "GeometryNodeBake", count: 1 },
  ]);
});

test("Bake capability support is exact only for confirmed live pass-through or complete snapshots", () => {
  const makeProgram = (bake: RawNode): Program => ({
    Root: {
      name: "Root",
      type: "GeometryNodeTree",
      nodes: [bake],
      links: [],
      interface: [],
    },
  });
  const bake: RawNode = {
    name: "Bake",
    type: "GeometryNodeBake",
    inputs: [{ name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry", linked: true }],
    outputs: [{ name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry" }],
  };
  const completeSnapshot = {
    schema_version: 1,
    source: "blender-evaluated" as const,
    frame: 1,
    items: {
      Item_0: {
        socket_type: "NodeSocketGeometry",
        component_contract: "realized-mesh",
        geometry: { positions: [], edges: [], faces: [] },
      },
    },
  };
  const unbaked = analyzeProgramCapabilities(makeProgram(bake), "Root", REGISTRY, {
    bakeStates: [{ bake_id: 1, node_group: "Root", node: "Bake", status: "unbaked" }],
  });
  const snapshotted = analyzeProgramCapabilities(makeProgram(bake), "Root", REGISTRY, {
    bakeStates: [{
      bake_id: 1,
      node_group: "Root",
      node: "Bake",
      status: "packed",
      snapshot: completeSnapshot,
    }],
  });
  for (const report of [unbaked, snapshotted]) {
    assert.equal(report.exact, true);
    assert.deepEqual(report.approximatedNodeTypes, []);
  }
});

test("Bake capability stays bounded for missing, packed, disk-backed, and unknown cache state", () => {
  const bake: RawNode = {
    name: "Bake",
    type: "GeometryNodeBake",
    inputs: [{ name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry", linked: true }],
    outputs: [{ name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry" }],
  };
  const program: Program = {
    Root: { name: "Root", type: "GeometryNodeTree", nodes: [bake], links: [], interface: [] },
  };
  const contexts = [
    undefined,
    [],
    [{ bake_id: 1, node_group: "Root", node: "Bake", status: "packed" as const }],
    [{ bake_id: 1, node_group: "Root", node: "Bake", status: "disk-backed" as const }],
    [{ bake_id: 1, node_group: "Root", node: "Bake", status: "unknown" as const }],
  ];
  for (const bakeStates of contexts) {
    const report = analyzeProgramCapabilities(program, "Root", REGISTRY,
      bakeStates === undefined ? {} : { bakeStates });
    assert.equal(report.exact, false);
    assert.deepEqual(report.approximatedNodeTypes, [
      { type: "GeometryNodeBake", count: 1 },
    ]);
  }
});

test("Bake cache-state matching rejects invalid modifier bake ids", () => {
  const bake: RawNode = {
    name: "Bake",
    type: "GeometryNodeBake",
    inputs: [{ name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry", linked: true }],
    outputs: [{ name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry" }],
  };
  const program: Program = {
    Root: { name: "Root", type: "GeometryNodeTree", nodes: [bake], links: [], interface: [] },
  };
  for (const bake_id of [-1, 1.5, Number.NaN]) {
    const report = analyzeProgramCapabilities(program, "Root", REGISTRY, {
      bakeStates: [{
        bake_id,
        node_group: "Root",
        node: "Bake",
        status: "unbaked",
      }],
    });
    assert.equal(report.exact, false);
    assert.deepEqual(report.approximatedNodeTypes, [{
      type: "GeometryNodeBake",
      count: 1,
    }]);
  }
});

test("Bake color snapshots fail closed when Blender RGBA exceeds the VM RGB contract", () => {
  const bake: RawNode = {
    name: "Bake",
    type: "GeometryNodeBake",
    inputs: [{ name: "Color", identifier: "Color", type: "NodeSocketColor", linked: true }],
    outputs: [{ name: "Color", identifier: "Color", type: "NodeSocketColor" }],
  };
  const program: Program = {
    Root: { name: "Root", type: "GeometryNodeTree", nodes: [bake], links: [], interface: [] },
  };
  const reportFor = (value: number[]) => analyzeProgramCapabilities(
    program,
    "Root",
    REGISTRY,
    {
      bakeStates: [{
        bake_id: 1,
        node_group: "Root",
        node: "Bake",
        status: "packed",
        snapshot: {
          schema_version: 2,
          source: "blender-evaluated",
          frame: 1,
          items: {
            Color: {
              socket_type: "NodeSocketColor",
              value_contract: "literal",
              value,
            },
          },
        },
      }],
    },
  );
  assert.equal(reportFor([0.1, 0.2, 0.3]).exact, true);
  assert.equal(reportFor([0.1, 0.2, 0.3, 0.4]).exact, false);
});

test("Bake reports a bounded approximation for an incomplete snapshot", () => {
  APPROXIMATIONS.clear();
  const node: RawNode = {
    name: "Bake",
    type: "GeometryNodeBake",
    inputs: [
      { name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry", linked: true },
      { name: "Value", identifier: "Item_1", type: "NodeSocketFloat", linked: true },
    ],
    outputs: [
      { name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry" },
      { name: "Value", identifier: "Item_1", type: "NodeSocketFloat" },
    ],
    bake_snapshot: {
      schema_version: 1,
      source: "blender-evaluated",
      frame: 1,
      items: {
        Item_0: {
          socket_type: "NodeSocketGeometry",
          component_contract: "realized-mesh",
          geometry: { positions: [], edges: [], faces: [] },
        },
      },
    },
  };
  const program: Program = {
    Root: { name: "Root", type: "GeometryNodeTree", nodes: [node], links: [], interface: [] },
  };
  const report = analyzeProgramCapabilities(program, "Root");
  assert.equal(report.exact, false);
  assert.deepEqual(report.approximatedNodeTypes, [
    { type: "GeometryNodeBake", count: 1 },
  ]);

  const liveValue = Field.of(7);
  const api: EvalAPI = {
    node,
    input: (identifier) => identifier === "Item_1" ? liveValue : new Geometry(),
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
  assert.equal(REGISTRY.get("GeometryNodeBake")!(api).Item_1, liveValue);
  assert.equal(APPROXIMATIONS.get("GeometryNodeBake"), 1);
});

test("Bake ignores an unsafe shared-node snapshot for a packed modifier without its own snapshot", () => {
  APPROXIMATIONS.clear();
  const node: RawNode = {
    name: "Bake",
    type: "GeometryNodeBake",
    inputs: [{ name: "Value", identifier: "Value", type: "NodeSocketFloat", linked: true }],
    outputs: [{ name: "Value", identifier: "Value", type: "NodeSocketFloat" }],
    bake_snapshot: {
      schema_version: 2,
      source: "blender-evaluated",
      frame: 1,
      items: {
        Value: { socket_type: "NodeSocketFloat", value_contract: "literal", value: 99 },
      },
    },
  };
  const live = Field.of(7);
  const api: EvalAPI = {
    node,
    group: "Shared",
    input: () => live,
    inputs: () => [],
    geoInputs: () => [],
    geo: () => new Geometry(),
    field: () => live,
    num: () => 7,
    vec: () => [7, 7, 7],
    bool: () => true,
    str: () => "",
    ref: () => null,
    prop: (_name, fallback) => fallback as never,
    resolve: () => [],
  };
  DUMP_CONTEXT.activeModifier = {
    type: "NODES",
    node_group: "Shared",
    bake_states: [{
      bake_id: 4,
      node_group: "Shared",
      node: "Bake",
      status: "packed",
    }],
  };
  try {
    assert.equal(REGISTRY.get("GeometryNodeBake")!(api).Value, live);
    assert.equal(APPROXIMATIONS.get("GeometryNodeBake"), 1);
  } finally {
    DUMP_CONTEXT.activeModifier = undefined;
  }
});

test("Bake restores a complete modifier-instance snapshot without approximation", () => {
  APPROXIMATIONS.clear();
  const node: RawNode = {
    name: "Bake",
    type: "GeometryNodeBake",
    inputs: [{ name: "Value", identifier: "Value", type: "NodeSocketFloat", linked: true }],
    outputs: [{ name: "Value", identifier: "Value", type: "NodeSocketFloat" }],
  };
  const api: EvalAPI = {
    node,
    group: "Root",
    input: () => Field.of(7),
    inputs: () => [],
    geoInputs: () => [],
    geo: () => new Geometry(),
    field: () => Field.of(7),
    num: () => 7,
    vec: () => [7, 7, 7],
    bool: () => true,
    str: () => "",
    ref: () => null,
    prop: (_name, fallback) => fallback as never,
    resolve: () => [],
  };
  DUMP_CONTEXT.activeModifier = {
    type: "NODES",
    node_group: "Root",
    bake_states: [{
      bake_id: 8,
      node_group: "Root",
      node: "Bake",
      status: "packed",
      snapshot: {
        schema_version: 2,
        source: "blender-evaluated",
        frame: 3,
        items: {
          Value: { socket_type: "NodeSocketFloat", value_contract: "literal", value: 42 },
        },
      },
    }],
  };
  try {
    assert.equal((REGISTRY.get("GeometryNodeBake")!(api).Value as Field).value, 42);
    assert.equal(APPROXIMATIONS.has("GeometryNodeBake"), false);
  } finally {
    DUMP_CONTEXT.activeModifier = undefined;
  }
});

test("Bake selects animation snapshots by frame and fails closed outside complete coverage", () => {
  APPROXIMATIONS.clear();
  const node: RawNode = {
    name: "Bake",
    type: "GeometryNodeBake",
    inputs: [{ name: "Value", identifier: "Value", type: "NodeSocketFloat", linked: true }],
    outputs: [{ name: "Value", identifier: "Value", type: "NodeSocketFloat" }],
  };
  const snapshots = [1, 2, 3].map((frame) => ({
    schema_version: 2 as const,
    source: "blender-evaluated" as const,
    frame,
    items: {
      Value: { socket_type: "NodeSocketFloat", value_contract: "literal" as const, value: frame * 10 },
    },
  }));
  const state = {
    bake_id: 9,
    node_group: "Root",
    node: "Bake",
    status: "packed" as const,
    bake_mode: "ANIMATION",
    frame_start: 1,
    frame_end: 3,
    snapshots,
  };
  const program: Program = {
    Root: { name: "Root", type: "GeometryNodeTree", nodes: [node], links: [], interface: [] },
  };
  assert.equal(analyzeProgramCapabilities(program, "Root", REGISTRY, { bakeStates: [state] }).exact, true);
  assert.equal(analyzeProgramCapabilities(program, "Root", REGISTRY, {
    bakeStates: [{ ...state, snapshots: snapshots.slice(0, 2) }],
  }).exact, false);

  const live = Field.of(99);
  const api: EvalAPI = {
    node,
    group: "Root",
    input: () => live,
    inputs: () => [],
    geoInputs: () => [],
    geo: () => new Geometry(),
    field: () => live,
    num: () => 99,
    vec: () => [99, 99, 99],
    bool: () => true,
    str: () => "",
    ref: () => null,
    prop: (_name, fallback) => fallback as never,
    resolve: () => [],
  };
  const previousFrame = DUMP_CONTEXT.frame;
  DUMP_CONTEXT.activeModifier = {
    type: "NODES",
    node_group: "Root",
    bake_states: [state],
  };
  try {
    DUMP_CONTEXT.frame = 2;
    assert.equal((REGISTRY.get("GeometryNodeBake")!(api).Value as Field).value, 20);
    assert.equal(APPROXIMATIONS.has("GeometryNodeBake"), false);
    DUMP_CONTEXT.frame = 4;
    assert.equal(REGISTRY.get("GeometryNodeBake")!(api).Value, live);
    assert.equal(APPROXIMATIONS.get("GeometryNodeBake"), 1);
  } finally {
    DUMP_CONTEXT.frame = previousFrame;
    DUMP_CONTEXT.activeModifier = undefined;
  }
});

test("Bake rejects snapshots whose output socket contract does not match", () => {
  const node: RawNode = {
    name: "Bake",
    type: "GeometryNodeBake",
    inputs: [{ name: "Value", identifier: "Value", type: "NodeSocketFloat", linked: true }],
    outputs: [{ name: "Value", identifier: "Value", type: "NodeSocketFloat" }],
    bake_snapshot: {
      schema_version: 2,
      source: "blender-evaluated",
      frame: 1,
      items: {
        Value: { socket_type: "NodeSocketInt", value_contract: "literal", value: 4 },
      },
    },
  };
  const program: Program = {
    Root: { name: "Root", type: "GeometryNodeTree", nodes: [node], links: [], interface: [] },
  };
  assert.equal(analyzeProgramCapabilities(program, "Root").exact, false);
});

test("Bake rejects structurally invalid geometry snapshots instead of claiming exact parity", () => {
  const node: RawNode = {
    name: "Bake",
    type: "GeometryNodeBake",
    inputs: [{ name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry", linked: true }],
    outputs: [{ name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry" }],
  };
  const program: Program = {
    Root: { name: "Root", type: "GeometryNodeTree", nodes: [node], links: [], interface: [] },
  };
  const state = {
    bake_id: 1,
    node_group: "Root",
    node: "Bake",
    status: "packed" as const,
    snapshot: {
      schema_version: 2 as const,
      source: "blender-evaluated" as const,
      frame: 1,
      items: {
        Item_0: {
          socket_type: "NodeSocketGeometry" as const,
          value_contract: "geometry-set" as const,
          geometry: {
            mesh: {
              positions: [[0, 0, 0] as [number, number, number]],
              edges: [],
              // An out-of-range face index would otherwise materialize a
              // malformed cached mesh while the capability report said exact.
              faces: [[0, 1, 0]],
            },
          },
        },
      },
    },
  };
  const report = analyzeProgramCapabilities(program, "Root", REGISTRY, {
    bakeStates: [state],
  });
  assert.equal(report.exact, false);
  assert.deepEqual(report.approximatedNodeTypes, [
    { type: "GeometryNodeBake", count: 1 },
  ]);
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
