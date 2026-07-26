import assert from "node:assert/strict";
import test from "node:test";
import type { Dump, DumpNodeGroup, RawNode } from "../gnvm";
import {
  applyViewerPreview,
  viewerPreviewsForBlendStudioTarget,
} from "./viewer-previews";

function outputNode(): RawNode {
  return {
    name: "Group Output",
    type: "NodeGroupOutput",
    label: null,
    inputs: [{
      name: "Geometry",
      identifier: "Geometry",
      type: "NodeSocketGeometry",
      linked: true,
      value: null,
    }],
    outputs: [],
  };
}

function group(name: string, nodes: RawNode[]): DumpNodeGroup {
  return {
    name,
    type: "GeometryNodeTree",
    interface: [{
      name: "Geometry",
      item_type: "SOCKET",
      identifier: "Geometry",
      in_out: "OUTPUT",
      socket_type: "NodeSocketGeometry",
    }],
    nodes: [outputNode(), ...nodes],
    links: [],
  };
}

test("Viewer previews route a nested linked geometry socket to the root output", () => {
  const source: RawNode = {
    name: "Cube",
    type: "GeometryNodeMeshCube",
    label: null,
    inputs: [],
    outputs: [{
      name: "Mesh",
      identifier: "Mesh",
      type: "NodeSocketGeometry",
      linked: true,
    }],
  };
  const viewer: RawNode = {
    name: "Viewer",
    type: "GeometryNodeViewer",
    label: "Body preview",
    inputs: [{
      name: "Geometry",
      identifier: "Geometry",
      type: "NodeSocketGeometry",
      linked: true,
      value: null,
    }],
    outputs: [],
  };
  const child = group("Child", [source, viewer]);
  child.links.push({
    from_node: "Cube",
    from_socket: "Mesh",
    to_node: "Viewer",
    to_socket: "Geometry",
  });
  const childNode: RawNode = {
    name: "Child node",
    type: "GeometryNodeGroup",
    group: "Child",
    label: null,
    inputs: [],
    outputs: [],
  };
  const root = group("Root", [childNode]);
  const dump = {
    node_groups: { Root: root, Child: child },
    objects: [],
    collections: [],
    images: [],
    materials: {},
  } as unknown as Dump;

  const previews = viewerPreviewsForBlendStudioTarget(dump, "Root");
  assert.equal(previews.length, 1);
  assert.match(previews[0].label, /Child node.*Body preview/);
  const applied = applyViewerPreview(dump, previews[0]);
  assert.ok(applied);
  assert.equal(root.interface.length, 1, "source graph stays untouched");
  assert.ok(applied.dump.node_groups.Root.interface.some((item) =>
    item.identifier === applied.outputIdentifier));
  assert.ok(applied.dump.node_groups.Root.links.some((link) =>
    link.from_node === "Child node"
    && link.to_socket === applied.outputIdentifier));
  assert.ok(applied.dump.node_groups.Child.links.some((link) =>
    link.from_node === "Cube"
    && link.to_socket === applied.outputIdentifier));
});
