import assert from "node:assert/strict";
import test from "node:test";
import { runGenerator, type Dump } from "./index";
import { DUMP_CONTEXT } from "./registry";

const geometryOutput = {
  item_type: "SOCKET", identifier: "Geometry", name: "Geometry",
  in_out: "OUTPUT", socket_type: "NodeSocketGeometry",
};
const geometryInput = {
  item_type: "SOCKET", identifier: "InputGeometry", name: "Geometry",
  in_out: "INPUT", socket_type: "NodeSocketGeometry",
};

function objectInfo(name: string, target: string) {
  return {
    name, type: "GeometryNodeObjectInfo", label: null,
    inputs: [
      { name: "Object", identifier: "Object", type: "NodeSocketObject", linked: false, idx: 0, value: { datablock: "Object", name: target } },
      { name: "As Instance", identifier: "As Instance", type: "NodeSocketBool", linked: false, idx: 1, value: false },
    ],
    outputs: [{ name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry", default: null }],
  };
}

function objectInfoGroup(name: string, target: string) {
  return {
    name, type: "GeometryNodeTree", interface: [geometryOutput],
    nodes: [
      objectInfo("Object Info", target),
      {
        name: "Group Output", type: "NodeGroupOutput", label: null, outputs: [],
        inputs: [{ name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry", linked: true, idx: 0, value: null }],
      },
    ],
    links: [{ from_node: "Object Info", from_socket: "Geometry", to_node: "Group Output", to_socket: "Geometry" }],
  };
}

function dependencyCycleGroup() {
  return {
    name: "DependencyTree", type: "GeometryNodeTree", interface: [geometryOutput, geometryInput],
    nodes: [
      {
        name: "Group Input", type: "NodeGroupInput", label: null, inputs: [],
        outputs: [{ name: "Geometry", identifier: "InputGeometry", type: "NodeSocketGeometry", default: null }],
      },
      objectInfo("Object Info", "Main"),
      {
        name: "Join Geometry", type: "GeometryNodeJoinGeometry", label: null,
        inputs: [{ name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry", linked: true, idx: 0, value: null }],
        outputs: [{ name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry", default: null }],
      },
      {
        name: "Group Output", type: "NodeGroupOutput", label: null, outputs: [],
        inputs: [{ name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry", linked: true, idx: 0, value: null }],
      },
    ],
    links: [
      { from_node: "Group Input", from_socket: "InputGeometry", to_node: "Join Geometry", to_socket: "Geometry" },
      { from_node: "Object Info", from_socket: "Geometry", to_node: "Join Geometry", to_socket: "Geometry" },
      { from_node: "Join Geometry", from_socket: "Geometry", to_node: "Group Output", to_socket: "Geometry" },
    ],
  };
}

test("Object Info exposes a pending evaluated-cycle back-edge as empty", async () => {
  const dump = {
    node_groups: {
      MainTree: objectInfoGroup("MainTree", "Dependency"),
      DependencyTree: dependencyCycleGroup(),
    },
    objects: [
      {
        name: "Main", type: "MESH",
        mesh: { verts: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]], edges: [[0, 1], [1, 2], [2, 0]] },
        modifiers: [{ type: "NODES", node_group: "MainTree", input_values: {} }],
      },
      {
        name: "Dependency", type: "MESH",
        mesh: { verts: [[0, 0, 1], [1, 0, 1], [0, 1, 1]], faces: [[0, 1, 2]], edges: [[0, 1], [1, 2], [2, 0]] },
        modifiers: [{ type: "NODES", node_group: "DependencyTree", input_values: {} }],
      },
    ],
  } as unknown as Dump;

  const result = await runGenerator(dump, { object: "Main" });
  // The dependency's own triangle is prepared and visible to the main root;
  // the pending main-object back-edge does not append a second triangle.
  assert.deepEqual(result.soup.stats, { verts: 3, faces: 1, tris: 1 });
  assert.equal(DUMP_CONTEXT.evaluatingObjects.size, 0, "pending-object state is cleaned after evaluation");
});
