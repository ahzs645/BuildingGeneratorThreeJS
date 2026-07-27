import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Dump, DumpNodeGroup, RawNode } from "./dump-schema";
import { GEOMETRY_PROBE } from "./evaluator";
import { runNodeGroup } from "./group-runner";
import { runGenerator } from "./index";

// The cross-evaluation cache must be observationally invisible: re-running
// the same dump object with changed overrides has to produce bit-identical
// output to a from-scratch evaluation of a fresh dump copy.

const dumpSource = await readFile(fileURLToPath(new URL(
  "../../public/dojo/joints/bubble-putty/dump.json",
  import.meta.url,
)), "utf8");

function hash(view: ArrayBufferView): string {
  return createHash("sha256")
    .update(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
    .digest("hex");
}

test("changed-override re-evaluation matches a cold evaluation exactly", async () => {
  const dump = JSON.parse(dumpSource) as Dump;
  // Warm the persistent cache with the default bindings.
  const warmup = await runGenerator(dump, { object: "PUTTY.002" });
  // Re-evaluate the SAME dump object with one changed override.
  const cached = await runGenerator(dump, {
    object: "PUTTY.002",
    overrides: { "finalize for export": true },
  });
  // Cold reference: fresh dump object, same override — cache cannot apply.
  const cold = await runGenerator(JSON.parse(dumpSource) as Dump, {
    object: "PUTTY.002",
    overrides: { "finalize for export": true },
  });
  assert.deepEqual(cached.soup.stats, cold.soup.stats);
  assert.equal(hash(cached.soup.positions), hash(cold.soup.positions));
  assert.equal(hash(cached.soup.indices), hash(cold.soup.indices));
  assert.deepEqual(
    Object.keys(cached.soup.attributes).sort(),
    Object.keys(cold.soup.attributes).sort(),
  );
  // And the override actually changed the result relative to the warmup.
  assert.notEqual(hash(cached.soup.positions), hash(warmup.soup.positions));
});

test("unchanged-override re-evaluation is bit-identical to the first run", async () => {
  const dump = JSON.parse(dumpSource) as Dump;
  const first = await runGenerator(dump, { object: "PUTTY.002" });
  const second = await runGenerator(dump, { object: "PUTTY.002" });
  assert.deepEqual(second.soup.stats, first.soup.stats);
  assert.equal(hash(second.soup.positions), hash(first.soup.positions));
  assert.equal(hash(second.soup.indices), hash(first.soup.indices));
});

// ---- synthetic fixtures -----------------------------------------------------

function socket(name: string, identifier: string, type: string, value: unknown, linked = false) {
  return { name, identifier, type, value, linked };
}

const geometryOutputItem = {
  item_type: "SOCKET",
  in_out: "OUTPUT",
  identifier: "OutputGeometry",
  name: "Geometry",
  socket_type: "NodeSocketGeometry",
};

function seedGroup(): DumpNodeGroup {
  const groupInput: RawNode = {
    name: "Group Input",
    type: "NodeGroupInput",
    label: null,
    inputs: [],
    outputs: [{ name: "Seed", identifier: "InputSeed", type: "NodeSocketInt" }],
  };
  const line: RawNode = {
    name: "Mesh Line",
    type: "GeometryNodeMeshLine",
    label: null,
    props: { mode: "OFFSET" },
    inputs: [
      socket("Count", "Count", "NodeSocketInt", 6),
      socket("Start Location", "Start Location", "NodeSocketVector", [0, 0, 0]),
      socket("Offset", "Offset", "NodeSocketVector", [1, 0, 0]),
    ],
    outputs: [{ name: "Mesh", identifier: "Mesh", type: "NodeSocketGeometry" }],
  };
  const random: RawNode = {
    name: "Random Value",
    type: "FunctionNodeRandomValue",
    label: null,
    props: { data_type: "FLOAT" },
    inputs: [
      socket("Min", "Min_001", "NodeSocketFloat", 0),
      socket("Max", "Max_001", "NodeSocketFloat", 1),
      socket("ID", "ID", "NodeSocketInt", 0),
      socket("Seed", "Seed", "NodeSocketInt", 0, true),
    ],
    outputs: [{ name: "Value", identifier: "Value", type: "NodeSocketFloat" }],
  };
  const combine: RawNode = {
    name: "Combine XYZ",
    type: "ShaderNodeCombineXYZ",
    label: null,
    inputs: [
      socket("X", "X", "NodeSocketFloat", 0),
      socket("Y", "Y", "NodeSocketFloat", 0),
      socket("Z", "Z", "NodeSocketFloat", 0, true),
    ],
    outputs: [{ name: "Vector", identifier: "Vector", type: "NodeSocketVector" }],
  };
  const setPosition: RawNode = {
    name: "Set Position",
    type: "GeometryNodeSetPosition",
    label: null,
    inputs: [
      socket("Geometry", "Geometry", "NodeSocketGeometry", null, true),
      socket("Selection", "Selection", "NodeSocketBool", true),
      socket("Position", "Position", "NodeSocketVector", null),
      socket("Offset", "Offset", "NodeSocketVector", [0, 0, 0], true),
    ],
    outputs: [{ name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry" }],
  };
  const groupOutput: RawNode = {
    name: "Group Output",
    type: "NodeGroupOutput",
    label: null,
    inputs: [socket("Geometry", "OutputGeometry", "NodeSocketGeometry", null, true)],
    outputs: [],
  };
  return {
    name: "Seeded Scatter",
    type: "GeometryNodeTree",
    interface: [
      geometryOutputItem,
      {
        item_type: "SOCKET",
        in_out: "INPUT",
        identifier: "InputSeed",
        name: "Seed",
        socket_type: "NodeSocketInt",
        default: 0,
      },
    ],
    nodes: [groupInput, line, random, combine, setPosition, groupOutput],
    links: [
      { from_node: "Group Input", from_socket: "InputSeed", to_node: "Random Value", to_socket: "Seed" },
      { from_node: "Random Value", from_socket: "Value", to_node: "Combine XYZ", to_socket: "Z" },
      { from_node: "Mesh Line", from_socket: "Mesh", to_node: "Set Position", to_socket: "Geometry" },
      { from_node: "Combine XYZ", from_socket: "Vector", to_node: "Set Position", to_socket: "Offset" },
      { from_node: "Set Position", from_socket: "Geometry", to_node: "Group Output", to_socket: "OutputGeometry" },
    ],
  } as unknown as DumpNodeGroup;
}

function frameGroup(): DumpNodeGroup {
  const sceneTime: RawNode = {
    name: "Scene Time",
    type: "GeometryNodeInputSceneTime",
    label: null,
    inputs: [],
    outputs: [
      { name: "Seconds", identifier: "Seconds", type: "NodeSocketFloat" },
      { name: "Frame", identifier: "Frame", type: "NodeSocketFloat" },
    ],
  };
  const line: RawNode = {
    name: "Mesh Line",
    type: "GeometryNodeMeshLine",
    label: null,
    props: { mode: "OFFSET" },
    inputs: [
      socket("Count", "Count", "NodeSocketInt", 3),
      socket("Start Location", "Start Location", "NodeSocketVector", [0, 0, 0]),
      socket("Offset", "Offset", "NodeSocketVector", [1, 0, 0]),
    ],
    outputs: [{ name: "Mesh", identifier: "Mesh", type: "NodeSocketGeometry" }],
  };
  const combine: RawNode = {
    name: "Combine XYZ",
    type: "ShaderNodeCombineXYZ",
    label: null,
    inputs: [
      socket("X", "X", "NodeSocketFloat", 0),
      socket("Y", "Y", "NodeSocketFloat", 0),
      socket("Z", "Z", "NodeSocketFloat", 0, true),
    ],
    outputs: [{ name: "Vector", identifier: "Vector", type: "NodeSocketVector" }],
  };
  const transform: RawNode = {
    name: "Transform Geometry",
    type: "GeometryNodeTransform",
    label: null,
    inputs: [
      socket("Geometry", "Geometry", "NodeSocketGeometry", null, true),
      socket("Translation", "Translation", "NodeSocketVector", [0, 0, 0], true),
      socket("Rotation", "Rotation", "NodeSocketVector", [0, 0, 0]),
      socket("Scale", "Scale", "NodeSocketVector", [1, 1, 1]),
    ],
    outputs: [{ name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry" }],
  };
  const groupOutput: RawNode = {
    name: "Group Output",
    type: "NodeGroupOutput",
    label: null,
    inputs: [socket("Geometry", "OutputGeometry", "NodeSocketGeometry", null, true)],
    outputs: [],
  };
  return {
    name: "Frame Shift",
    type: "GeometryNodeTree",
    interface: [geometryOutputItem],
    nodes: [sceneTime, line, combine, transform, groupOutput],
    links: [
      { from_node: "Scene Time", from_socket: "Frame", to_node: "Combine XYZ", to_socket: "Z" },
      { from_node: "Mesh Line", from_socket: "Mesh", to_node: "Transform Geometry", to_socket: "Geometry" },
      { from_node: "Combine XYZ", from_socket: "Vector", to_node: "Transform Geometry", to_socket: "Translation" },
      { from_node: "Transform Geometry", from_socket: "Geometry", to_node: "Group Output", to_socket: "OutputGeometry" },
    ],
  } as unknown as DumpNodeGroup;
}

function syntheticDump(group: DumpNodeGroup): Dump {
  return { node_groups: { [group.name]: group }, objects: [] } as unknown as Dump;
}

test("seed-style group input participates in the cache fingerprint", async () => {
  const dump = syntheticDump(seedGroup());
  const seed0 = await runNodeGroup(dump, { group: "Seeded Scatter", inputs: { Seed: 0 } });
  const seed1 = await runNodeGroup(dump, { group: "Seeded Scatter", inputs: { Seed: 1 } });
  const seed0Again = await runNodeGroup(dump, { group: "Seeded Scatter", inputs: { Seed: 0 } });
  // Cold references from fresh dump objects.
  const cold0 = await runNodeGroup(syntheticDump(seedGroup()), { group: "Seeded Scatter", inputs: { Seed: 0 } });
  const cold1 = await runNodeGroup(syntheticDump(seedGroup()), { group: "Seeded Scatter", inputs: { Seed: 1 } });
  assert.equal(hash(seed0.soup.positions), hash(cold0.soup.positions));
  assert.equal(hash(seed1.soup.positions), hash(cold1.soup.positions));
  assert.equal(hash(seed0Again.soup.positions), hash(cold0.soup.positions));
  assert.notEqual(hash(seed0.soup.positions), hash(seed1.soup.positions));
});

test("frame-dependent evaluation is never served stale from the cache", async () => {
  const dump = syntheticDump(frameGroup());
  const frame1 = await runNodeGroup(dump, { group: "Frame Shift", frame: 1 });
  const frame5 = await runNodeGroup(dump, { group: "Frame Shift", frame: 5 });
  const frame1Again = await runNodeGroup(dump, { group: "Frame Shift", frame: 1 });
  const cold5 = await runNodeGroup(syntheticDump(frameGroup()), { group: "Frame Shift", frame: 5 });
  assert.notEqual(hash(frame1.soup.positions), hash(frame5.soup.positions));
  assert.equal(hash(frame5.soup.positions), hash(cold5.soup.positions));
  assert.equal(hash(frame1Again.soup.positions), hash(frame1.soup.positions));
});

test("geometry probes observe live evaluation even after a cached run", async () => {
  const dump = syntheticDump(seedGroup());
  await runNodeGroup(dump, { group: "Seeded Scatter", inputs: { Seed: 0 } });
  GEOMETRY_PROBE.group = "Seeded Scatter";
  GEOMETRY_PROBE.node = "Set Position";
  GEOMETRY_PROBE.socket = "Geometry";
  GEOMETRY_PROBE.geometry = null;
  try {
    await runNodeGroup(dump, { group: "Seeded Scatter", inputs: { Seed: 0 } });
    assert.ok(GEOMETRY_PROBE.geometry, "probe should capture the node output");
    assert.equal(GEOMETRY_PROBE.geometry!.mesh?.positions.length, 6);
  } finally {
    GEOMETRY_PROBE.group = null;
    GEOMETRY_PROBE.node = null;
    GEOMETRY_PROBE.socket = null;
    GEOMETRY_PROBE.geometry = null;
  }
});
