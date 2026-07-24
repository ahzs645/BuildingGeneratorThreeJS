import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Dump } from "../gnvm";
import {
  areSocketTypesCompatible,
  dumpGroupToEditorGraph,
  graphGroupPath,
  graphNodeTemplates,
  graphWorkingSetNodeIds,
  searchEditorGraphs,
} from "./graph-model";

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

test("search spans every group and retains navigation context", () => {
  const nestedMatches = searchEditorGraphs(dump, "bounding box");
  assert.ok(nestedMatches.some((match) => match.groupName === root && match.node.nestedGroup === "_Bounding Box.002"));

  const internalMatches = searchEditorGraphs(dump, "vector math");
  assert.ok(internalMatches.some((match) => match.groupName === "_Bounding Box.002"));
  assert.ok(internalMatches.every((match) => match.node.kind !== "frame"));
  assert.deepEqual(searchEditorGraphs(dump, "   "), []);
});

test("initial working set is deterministic and walks upstream from Group Output", () => {
  const graph = dumpGroupToEditorGraph(dump, root);
  const first = graphWorkingSetNodeIds(graph, 12);
  const second = graphWorkingSetNodeIds(graph, 12);
  const output = graph.nodes.find((node) => node.sourceType === "NodeGroupOutput");

  assert.deepEqual(first, second);
  assert.equal(first[0], output?.id);
  assert.ok(first.length > 1 && first.length <= 12);
  assert.ok(first.every((id) => graph.nodes.some((node) => node.id === id && node.kind !== "frame")));
  assert.ok(first.slice(1).every((id) => graph.links.some((link) => link.source === id && first.includes(link.target))));
  assert.deepEqual(graphWorkingSetNodeIds(graph, 0), []);
});

test("socket compatibility is conservative across Blender socket families", () => {
  assert.equal(areSocketTypesCompatible("NodeSocketGeometry", "NodeSocketGeometry"), true);
  assert.equal(areSocketTypesCompatible("NodeSocketFloat", "NodeSocketInt"), true);
  assert.equal(areSocketTypesCompatible("NodeSocketVectorTranslation", "NodeSocketVector"), true);
  assert.equal(areSocketTypesCompatible("NodeSocketColor", "NodeSocketFloat"), false);
  assert.equal(areSocketTypesCompatible("NodeSocketGeometry", "NodeSocketFloat"), false);
  assert.equal(areSocketTypesCompatible("NodeSocketVirtual", "NodeSocketMaterial"), true);
});

test("add-node templates are deterministic and omit structural group endpoints", () => {
  const first = graphNodeTemplates(dump);
  const second = graphNodeTemplates(dump);
  assert.deepEqual(first, second);
  assert.ok(first.length > 0);
  assert.ok(first.every((template) => template.type !== "NodeFrame" && template.type !== "NodeGroupInput" && template.type !== "NodeGroupOutput"));
  assert.ok(first.some((template) => template.inputTypes.length > 0 || template.outputTypes.length > 0));
});
