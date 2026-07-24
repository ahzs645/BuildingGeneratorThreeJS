import assert from "node:assert/strict";
import test from "node:test";
import type { Dump, DumpNodeGroup, RawNode } from "./dump-schema";
import { Geometry } from "./geometry";
import { createPrimitiveGeometry, runNodeGroup } from "./group-runner";

const geometryInput = {
  item_type: "SOCKET",
  in_out: "INPUT",
  identifier: "InputGeometry",
  name: "Geometry",
  socket_type: "NodeSocketGeometry",
  default: null,
};
const offsetInput = {
  item_type: "SOCKET",
  in_out: "INPUT",
  identifier: "InputOffset",
  name: "Offset",
  socket_type: "NodeSocketVector",
  default: [0, 0, 0],
};
const geometryOutput = {
  item_type: "SOCKET",
  in_out: "OUTPUT",
  identifier: "OutputGeometry",
  name: "Geometry",
  socket_type: "NodeSocketGeometry",
};

function socket(name: string, identifier: string, type: string, value: unknown, linked = false) {
  return { name, identifier, type, value, linked };
}

function transformGroup(): DumpNodeGroup {
  const groupInput: RawNode = {
    name: "Group Input",
    type: "NodeGroupInput",
    label: null,
    inputs: [],
    outputs: [
      { name: "Geometry", identifier: "InputGeometry", type: "NodeSocketGeometry" },
      { name: "Offset", identifier: "InputOffset", type: "NodeSocketVector" },
    ],
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
    name: "Asset Group",
    type: "GeometryNodeTree",
    interface: [geometryOutput, geometryInput, offsetInput],
    nodes: [groupInput, transform, groupOutput],
    links: [
      {
        from_node: "Group Input",
        from_socket: "InputGeometry",
        to_node: "Transform Geometry",
        to_socket: "Geometry",
      },
      {
        from_node: "Group Input",
        from_socket: "InputOffset",
        to_node: "Transform Geometry",
        to_socket: "Translation",
      },
      {
        from_node: "Transform Geometry",
        from_socket: "Geometry",
        to_node: "Group Output",
        to_socket: "OutputGeometry",
      },
    ],
  };
}

function fixture(objects: Dump["objects"] = []): Dump {
  return {
    node_groups: { "Asset Group": transformGroup() },
    objects,
  };
}

test("direct group runner binds a generated primitive and friendly interface value", async () => {
  const result = await runNodeGroup(fixture(), {
    group: "Asset Group",
    seed: { kind: "cube", size: 2 },
    overrides: { Offset: [3, 0, 0] },
  });

  assert.deepEqual(result.soup.stats, { verts: 8, faces: 6, tris: 12 });
  assert.equal(Math.min(...result.geometry.mesh!.positions.map((point) => point[0])), 2);
  assert.equal(result.coverage.missingTypes.length, 0);
});

test("direct group runner can seed from an extracted object's base geometry", async () => {
  const dump = fixture([{
    name: "Seed",
    type: "MESH",
    mesh: {
      verts: [[0, 0, 0], [2, 0, 0], [0, 2, 0]],
      edges: [[0, 1], [1, 2], [2, 0]],
      faces: [[0, 1, 2]],
    },
    modifiers: [],
  }]);
  const result = await runNodeGroup(dump, {
    group: "Asset Group",
    seed: { kind: "object", objectName: "Seed" },
    overrides: { InputOffset: [0, 0, 4] },
  });

  assert.deepEqual(result.soup.stats, { verts: 3, faces: 1, tris: 1 });
  assert.deepEqual(result.geometry.mesh!.positions, [[0, 0, 4], [2, 0, 4], [0, 2, 4]]);
});

test("direct group runner clones an explicit Geometry seed", async () => {
  const seed = createPrimitiveGeometry({ kind: "line", count: 3, offset: [0, 1, 0] });
  const original = seed.mesh!.positions.map((point) => [...point]);
  const result = await runNodeGroup(fixture(), {
    group: "Asset Group",
    geometry: seed,
    inputs: { Offset: [1, 0, 0] },
  });

  assert.deepEqual(seed.mesh!.positions, original);
  assert.deepEqual(result.geometry.mesh!.positions, [[1, 0, 0], [1, 1, 0], [1, 2, 0]]);
});

test("direct group runner reports ambiguous geometry inputs instead of guessing", async () => {
  const dump = fixture();
  dump.node_groups["Asset Group"].interface.push({
    ...geometryInput,
    identifier: "SecondGeometry",
    name: "Target",
  });

  await assert.rejects(
    runNodeGroup(dump, { group: "Asset Group", geometry: { kind: "grid" } }),
    /multiple Geometry inputs/,
  );
});

test("worker-safe curve seeds create curve components", () => {
  const circle = createPrimitiveGeometry({ kind: "curve-circle", radius: 2, points: 8 });
  const line = createPrimitiveGeometry({ kind: "curve-line" });

  assert.equal(circle.curves.length, 1);
  assert.equal(circle.curves[0].cyclic, true);
  assert.equal(circle.curves[0].points.length, 8);
  assert.equal(line.curves.length, 1);
  assert.deepEqual(line.curves[0].points, [[-1, 0, 0], [1, 0, 0]]);
});
