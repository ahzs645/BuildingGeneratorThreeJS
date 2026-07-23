import assert from "node:assert/strict";
import test from "node:test";
import {
  DumpValidationError,
  normalizeDump,
  validateDump,
  type Dump,
} from "./dump-schema";

test("normalization supplies legacy arrays without discarding opaque data", () => {
  const source = {
    node_groups: {
      Root: {
        custom_group_data: { future: true },
        nodes: [{
          name: "Future",
          type: "GeometryNodeFuture",
          future_payload: { untouched: [1, 2, 3] },
        }],
      },
    },
    future_top_level: { revision: 7 },
  };

  const dump = normalizeDump(source);
  const group = dump.node_groups.Root;
  const node = group.nodes[0];

  assert.notEqual(dump, source);
  assert.equal(group.name, "Root");
  assert.equal(group.type, "GeometryNodeTree");
  assert.deepEqual(group.links, []);
  assert.deepEqual(group.interface, []);
  assert.equal(node.label, null);
  assert.deepEqual(node.inputs, []);
  assert.deepEqual(node.outputs, []);
  assert.deepEqual(group.custom_group_data, { future: true });
  assert.deepEqual(node.future_payload, { untouched: [1, 2, 3] });
  assert.deepEqual(dump.future_top_level, { revision: 7 });
  assert.equal("links" in source.node_groups.Root, false, "normalization must not mutate the input JSON");
});

test("valid current-shape dumps pass through the canonical boundary", () => {
  const source = {
    blender_version: "5.1.0",
    node_groups: {
      Root: {
        name: "Root",
        type: "GeometryNodeTree",
        interface: [],
        nodes: [{
          name: "Group Output",
          type: "NodeGroupOutput",
          label: null,
          inputs: [{
            name: "Geometry",
            identifier: "Geometry",
            type: "NodeSocketGeometry",
            linked: false,
            value: null,
          }],
          outputs: [],
        }],
        links: [],
      },
    },
    objects: [{ name: "Cube", modifiers: [{ type: "NODES", node_group: "Root" }] }],
  };

  assert.deepEqual(validateDump(source), []);
  const dump: Dump = normalizeDump(source);
  assert.equal(dump.objects?.[0].modifiers?.[0].node_group, "Root");
  assert.equal(dump.node_groups.Root.nodes[0].inputs[0].type, "NodeSocketGeometry");
});

test("validation reports precise structural paths and normalization rejects them", () => {
  const invalid = {
    node_groups: {
      Broken: {
        nodes: [{
          name: 42,
          type: "GeometryNodeFuture",
          inputs: [{
            name: "Geometry",
            identifier: "Geometry",
            type: "NodeSocketGeometry",
            linked: "yes",
          }],
          outputs: "not-an-array",
        }],
        links: [{ from_node: "A", from_socket: "Out", to_node: "B" }],
      },
    },
    objects: "not-an-array",
  };

  const issues = validateDump(invalid);
  assert.ok(issues.some((issue) => issue.path === '$.node_groups["Broken"].nodes[0].name'));
  assert.ok(issues.some((issue) => issue.path === '$.node_groups["Broken"].nodes[0].inputs[0].linked'));
  assert.ok(issues.some((issue) => issue.path === '$.node_groups["Broken"].nodes[0].outputs'));
  assert.ok(issues.some((issue) => issue.path === '$.node_groups["Broken"].links[0].to_socket'));
  assert.ok(issues.some((issue) => issue.path === "$.objects"));

  assert.throws(
    () => normalizeDump(invalid),
    (error: unknown) => error instanceof DumpValidationError
      && error.issues.length === issues.length
      && error.message.includes('$.node_groups["Broken"].nodes[0].name'),
  );
});

test("non-object and missing-node-group inputs fail with stable issue codes", () => {
  assert.deepEqual(validateDump(null), [{
    code: "EXPECTED_OBJECT",
    path: "$",
    message: "expected a Geometry Nodes dump object",
  }]);
  assert.deepEqual(validateDump({}), [{
    code: "MISSING_NODE_GROUPS",
    path: "$.node_groups",
    message: "expected an object",
  }]);
});
