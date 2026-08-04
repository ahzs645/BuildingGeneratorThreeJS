import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { runNodeGroup } from "./gnvm/group-runner";
import type { Dump, DumpNodeGroup, RawNode } from "./gnvm/dump-schema";
import { toTriSoup } from "./gnvm/geometry";
import { createPrimitiveGeometry } from "./gnvm/group-runner";
import { inlineMeshSeedFromObject, inlineMeshSeedFromTriSoup } from "./inline-mesh-conversion";

test("inlineMeshSeedFromObject bakes world transforms and merges meshes", () => {
  const root = new THREE.Group();
  const triangle = new THREE.BufferGeometry();
  triangle.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  const first = new THREE.Mesh(triangle);
  const second = new THREE.Mesh(triangle.clone());
  second.position.set(0, 0, 5);
  second.scale.setScalar(2);
  root.add(first, second);

  const seed = inlineMeshSeedFromObject(root, "pair");
  assert.equal(seed.positions.length, 18);
  assert.equal(seed.indices!.length, 6);
  // Second triangle's second vertex: (1,0,0) * 2 + (0,0,5).
  assert.deepEqual([...(seed.positions as Float32Array).slice(12, 15)], [2, 0, 5]);
});

test("inlineMeshSeedFromObject rejects meshless scenes", () => {
  assert.throws(() => inlineMeshSeedFromObject(new THREE.Group()), /no triangle meshes/);
});

test("indexed THREE geometry keeps shared vertices through the seed", () => {
  const quad = new THREE.PlaneGeometry(2, 2); // indexed: 4 verts, 2 triangles
  const seed = inlineMeshSeedFromObject(new THREE.Mesh(quad), "quad");
  assert.equal(seed.positions.length / 3, 4);
  assert.equal(seed.indices!.length, 6);
});

test("a TriSoup round-trips into a seed that the group runner accepts", async () => {
  const soup = toTriSoup(createPrimitiveGeometry({ kind: "cube", size: 2 }));
  const seed = inlineMeshSeedFromTriSoup(soup, "cube", "test:cube");

  const geometryInput = {
    item_type: "SOCKET", in_out: "INPUT", identifier: "InputGeometry",
    name: "Geometry", socket_type: "NodeSocketGeometry", default: null,
  };
  const geometryOutput = {
    item_type: "SOCKET", in_out: "OUTPUT", identifier: "OutputGeometry",
    name: "Geometry", socket_type: "NodeSocketGeometry",
  };
  const groupInput: RawNode = {
    name: "Group Input", type: "NodeGroupInput", label: null, inputs: [],
    outputs: [{ name: "Geometry", identifier: "InputGeometry", type: "NodeSocketGeometry" }],
  };
  const groupOutput: RawNode = {
    name: "Group Output", type: "NodeGroupOutput", label: null,
    inputs: [{ name: "Geometry", identifier: "OutputGeometry", type: "NodeSocketGeometry", value: null, linked: true }],
    outputs: [],
  };
  const passthrough: DumpNodeGroup = {
    name: "Passthrough", type: "GeometryNodeTree",
    interface: [geometryOutput, geometryInput],
    nodes: [groupInput, groupOutput],
    links: [{ from_node: "Group Input", from_socket: "InputGeometry", to_node: "Group Output", to_socket: "OutputGeometry" }],
  };
  const dump: Dump = { node_groups: { Passthrough: passthrough }, objects: [] };

  const result = await runNodeGroup(dump, { group: "Passthrough", seed });
  assert.equal(result.soup.positions.length, soup.positions.length);
  assert.equal(result.soup.indices.length, soup.indices.length);
});
