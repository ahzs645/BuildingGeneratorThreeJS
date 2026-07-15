import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Dump } from "../gnvm";
import { dumpGroupToEditorGraph, graphGroupPath } from "./graph-model";

const dumpPath = fileURLToPath(new URL("../../public/dojo/chrome-assets/type-pixel-brush/dump.json", import.meta.url));
const dump = JSON.parse(await readFile(dumpPath, "utf8")) as Dump;
const root = "soft pixel marker.001";

test("conversion is deterministic and preserves source order", () => {
  const first = dumpGroupToEditorGraph(dump, root);
  const second = dumpGroupToEditorGraph(dump, root);
  assert.deepEqual(first, second);
  assert.equal(first.nodes.length, 38);
  assert.equal(first.links.length, 46);
  assert.deepEqual(first.unresolvedLinks, []);
});

test("socket handles preserve exact identifiers and every link maps", () => {
  const graph = dumpGroupToEditorGraph(dump, root);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const link of graph.links) {
    const source = nodes.get(link.source);
    const target = nodes.get(link.target);
    assert.ok(source?.outputs.some((socket) => socket.id === link.sourceHandle && socket.identifier === link.sourceSocketIdentifier));
    assert.ok(target?.inputs.some((socket) => socket.id === link.targetHandle && socket.identifier === link.targetSocketIdentifier));
  }
  const gridLink = graph.links.find((link) => link.sourceSocketIdentifier === "Mesh" && link.targetSocketIdentifier === "Geometry");
  assert.ok(gridLink);
  assert.equal(gridLink.socketType, "NodeSocketGeometry");
});

test("frames and reroutes retain authored relationships", () => {
  const graph = dumpGroupToEditorGraph(dump, root);
  const frames = graph.nodes.filter((node) => node.kind === "frame");
  const reroutes = graph.nodes.filter((node) => node.kind === "reroute");
  assert.equal(frames.length, 3);
  assert.equal(reroutes.length, 1);
  const grid = graph.nodes.find((node) => node.sourceName === "Grid");
  assert.equal(grid?.parentId, frames.find((node) => node.sourceName === "Frame.003")?.id);
  assert.equal(reroutes[0].inputs[0].identifier, "Input");
  assert.equal(reroutes[0].outputs[0].identifier, "Output");
});

test("nested group traversal produces Blender-style breadcrumbs", () => {
  assert.deepEqual(graphGroupPath(dump, root, ["Group"]), [root, "_Bounding Box.002"]);
  assert.deepEqual(graphGroupPath(dump, root, ["Group.001"]), [root, "_autosmooth"]);
  assert.deepEqual(graphGroupPath(dump, root, ["missing"]), [root]);
});

