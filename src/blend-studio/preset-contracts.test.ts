import assert from "node:assert/strict";
import test from "node:test";
import type { Dump, DumpInterfaceItem } from "../gnvm";
import type { BlendStudioTarget } from "./model";
import { presetContractForBlendStudioTarget } from "./preset-contracts";

const socket = (
  name: string,
  identifier: string,
  inOut: "INPUT" | "OUTPUT",
  socketType: string,
  extra: Partial<DumpInterfaceItem> = {},
): DumpInterfaceItem => ({
  name,
  identifier,
  item_type: "SOCKET",
  in_out: inOut,
  socket_type: socketType,
  ...extra,
});

function fixture(input = socket("Geometry", "Socket_0", "INPUT", "NodeSocketGeometry")): Dump {
  return {
    objects: [],
    node_groups: {
      Root: {
        name: "Root",
        type: "GeometryNodeTree",
        interface: [
          socket("Geometry", "Socket_1", "OUTPUT", "NodeSocketGeometry"),
          input,
        ],
        nodes: [
          {
            name: "Group Input",
            type: "NodeGroupInput",
            label: null,
            inputs: [],
            outputs: [{ name: input.name, identifier: input.identifier!, type: "NodeSocketGeometry" }],
          },
          { name: "Group Output", type: "NodeGroupOutput", label: null, inputs: [], outputs: [] },
        ],
        links: [{
          from_node: "Group Input",
          from_socket: input.identifier!,
          to_node: "Group Output",
          to_socket: "Socket_1",
        }],
      },
    },
  };
}

const groupTarget = (): BlendStudioTarget => ({
  id: "group:Root",
  kind: "group",
  label: "Root",
  detail: "Reusable node group",
  groupName: "Root",
  savedInputs: {},
});

const objectTarget = (modifierIndex = 0): BlendStudioTarget => ({
  id: `object:Target:${modifierIndex}:Root`,
  kind: "object",
  label: "Target",
  detail: "Root",
  objectName: "Target",
  groupName: "Root",
  modifierIndex,
  savedInputs: {},
});

test("recommends a curve seed for an authored Curve input", () => {
  const dump = fixture(socket(
    "Curve",
    "Socket_0",
    "INPUT",
    "NodeSocketGeometry",
    { description: "Curves to generate rounded corners on" },
  ));
  assert.deepEqual(presetContractForBlendStudioTarget(dump, groupTarget()), {
    mode: "seed",
    geometryInput: "Socket_0",
    output: "Geometry",
    recommendedSeed: { kind: "curve-line" },
    unboundDatablockInputs: [],
    reason: "The connected Curve input requires a curve-line preview seed.",
  });
});

test("recommends a cube for a generic reusable geometry input", () => {
  assert.equal(
    presetContractForBlendStudioTarget(fixture(), groupTarget()).recommendedSeed?.kind,
    "cube",
  );
});

test("keeps an extracted object base as the authored modifier input", () => {
  const dump = fixture();
  dump.objects = [{
    name: "Target",
    mesh: { verts: [[0, 0, 0]], faces: [] },
    modifiers: [{ type: "NODES", node_group: "Root" }],
  }];
  assert.equal(presetContractForBlendStudioTarget(dump, objectTarget()).mode, "authored");
});

test("detects a high-poly base omitted from a non-targeted dump", () => {
  const dump = fixture();
  dump.objects = [{
    name: "Target",
    mesh_stats: { verts: 99022, faces: 74781 },
    modifiers: [{ type: "NODES", node_group: "Root" }],
  }];
  const contract = presetContractForBlendStudioTarget(dump, objectTarget());
  assert.equal(contract.mode, "target-aware-extraction");
  assert.match(contract.reason, /99022/);
});

test("requires previous modifier output for later modifiers", () => {
  const dump = fixture();
  dump.node_groups.Earlier = {
    ...dump.node_groups.Root,
    name: "Earlier",
  };
  dump.objects = [{
    name: "Target",
    mesh: { verts: [[0, 0, 0]], faces: [] },
    modifiers: [
      { type: "NODES", node_group: "Earlier" },
      { type: "NODES", node_group: "Root" },
    ],
  }];
  assert.equal(presetContractForBlendStudioTarget(dump, objectTarget(1)).mode, "modifier-stack");
});

test("does not claim modifier-stack parity across an unsupported Blender modifier", () => {
  const dump = fixture();
  dump.objects = [{
    name: "Target",
    mesh: { verts: [[0, 0, 0]], faces: [] },
    modifiers: [
      { type: "NODES", node_group: "Root" },
      { name: "Bevel", type: "BEVEL" },
      { type: "NODES", node_group: "Root" },
    ],
  }];
  const contract = presetContractForBlendStudioTarget(dump, objectTarget(2));
  assert.equal(contract.mode, "target-aware-extraction");
  assert.match(contract.reason, /BEVEL/);
});

test("does not claim modifier-stack parity when an earlier node group is absent", () => {
  const dump = fixture();
  dump.objects = [{
    name: "Target",
    mesh: { verts: [[0, 0, 0]], faces: [] },
    modifiers: [
      { type: "NODES", node_group: "Missing Earlier" },
      { type: "NODES", node_group: "Root" },
    ],
  }];
  const contract = presetContractForBlendStudioTarget(dump, objectTarget(1));
  assert.equal(contract.mode, "target-aware-extraction");
  assert.match(contract.reason, /Missing Earlier/);
});

test("reports unbound datablocks without inventing a replacement", () => {
  const dump = fixture();
  dump.node_groups.Root.interface.push(
    socket("Object", "Socket_2", "INPUT", "NodeSocketObject", { default: null }),
  );
  dump.objects = [{
    name: "Target",
    mesh: { verts: [[0, 0, 0]], faces: [] },
    modifiers: [{
      type: "NODES",
      node_group: "Root",
      input_values: { Socket_2: null },
    }],
  }];
  const target = objectTarget();
  target.savedInputs.Socket_2 = null;
  const contract = presetContractForBlendStudioTarget(dump, target);
  assert.deepEqual(contract.unboundDatablockInputs, ["Object"]);
  assert.equal(contract.mode, "authored");
});
