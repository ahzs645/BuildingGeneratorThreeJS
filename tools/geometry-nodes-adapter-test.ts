import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  adaptDumpGraph,
  adaptGeometryNodesDump,
  editorNodeId,
  editorSocketId,
  refreshDumpLinkedFlags,
} from "../src/geometry-nodes/adapter";
import type { DumpGraph, GeometryNodesDump } from "../src/geometry-nodes/model";

let assertions = 0;
function check(condition: unknown, message: string): asserts condition {
  assertions++;
  assert.ok(condition, message);
}

const dump = JSON.parse(await readFile(new URL("../public/dojo/crayon/dump.json", import.meta.url), "utf8")) as GeometryNodesDump;
const first = adaptGeometryNodesDump(dump, "CHROME CRAYON OBJECT");
const second = adaptGeometryNodesDump(structuredClone(dump), "CHROME CRAYON OBJECT");

assertions++;
assert.equal(first.rootGroup, "CHROME CRAYON 3D _4.3_DEC2024", "preferred modifier object selects the authored root");
assertions++;
assert.deepEqual(
  Object.fromEntries(Object.entries(first.groups).map(([name, graph]) => [name, { nodes: graph.nodes.map((node) => node.id), edges: graph.edges.map((edge) => edge.id) }])),
  Object.fromEntries(Object.entries(second.groups).map(([name, graph]) => [name, { nodes: graph.nodes.map((node) => node.id), edges: graph.edges.map((edge) => edge.id) }])),
  "adapting the same dump twice produces identical stable identifiers",
);

const root = first.groups[first.rootGroup];
assertions++;
assert.equal(root.nodes.length, 69, "all authored root nodes are retained");
assertions++;
assert.equal(root.edges.length, 68, "all authored root links are retained");
assertions++;
assert.deepEqual(root.warnings, [], "the rich Chrome Crayon root has no unresolved sockets");
check(root.nodes.some((node) => node.kind === "frame" && node.title === "CREATE FLAT MESH"), "frames retain their labels");
check(root.nodes.some((node) => node.kind === "reroute"), "reroutes remain first-class editor nodes");
check(root.dependencies.includes("DOJO_marching square surface.002"), "nested group dependencies are explicit");

const link = root.edges.find((edge) => edge.sourceLink.from_node === "Geometry Proximity" && edge.sourceLink.to_node === "Map Range");
check(link, "known source link is present");
assertions++;
assert.equal(link.source, editorNodeId(first.rootGroup, "Geometry Proximity"), "link source maps to stable group-qualified node id");
assertions++;
assert.equal(link.sourceHandle, editorSocketId("output", "Distance"), "output handle preserves the dump socket identifier");
assertions++;
assert.equal(link.targetHandle, editorSocketId("input", "Value"), "input handle preserves the dump socket identifier");

const synthetic: DumpGraph = {
  nodes: [
    {
      name: "Frame", type: "NodeFrame", label: "Nested", inputs: [], outputs: [],
      ui: { location_absolute: [10, 20], width: 300, height: 180, use_custom_color: true, color: [0.2, 0.4, 0.6] },
    },
    {
      name: "Source", type: "GeometryNodeInputPosition", inputs: [],
      outputs: [{ name: "Position", identifier: "position-id", type: "NodeSocketVector", linked: false, idx: 0 }],
      ui: { location_absolute: [40, -60], parent: "Frame" },
    },
    {
      name: "Child", type: "GeometryNodeGroup", group: "Child Group",
      inputs: [{ name: "Vector", identifier: "vector-id", type: "NodeSocketVector", linked: false, idx: 0 }],
      outputs: [], ui: { location_absolute: [250, -60], parent: "Frame" },
    },
    {
      name: "Reroute", type: "NodeReroute",
      inputs: [{ name: "Input", identifier: "in", type: "NodeSocketVector", linked: false, idx: 0 }],
      outputs: [{ name: "Output", identifier: "out", type: "NodeSocketVector", linked: false, idx: 0 }],
      ui: { location_absolute: [170, -60], width: 16 },
    },
  ],
  links: [
    { from_node: "Source", from_socket: "Position", to_node: "Reroute", to_socket: "Input", from_type: "NodeSocketVector", to_type: "NodeSocketVector" },
    { from_node: "Reroute", from_socket: "out", to_node: "Child", to_socket: "missing legacy name", to_idx: 0, from_type: "NodeSocketVector", to_type: "NodeSocketVector" },
  ],
};
const adaptedSynthetic = adaptDumpGraph("Root Group", synthetic);
assertions++;
assert.equal(adaptedSynthetic.edges.length, 2, "links resolve by socket name, identifier, and index fallback");
assertions++;
assert.deepEqual(adaptedSynthetic.dependencies, ["Child Group"], "nested group dependency metadata is deterministic");
const frame = adaptedSynthetic.nodes.find((node) => node.kind === "frame");
check(frame, "synthetic frame is retained");
assertions++;
assert.deepEqual(frame.position, { x: 10, y: -20 }, "Blender Y-up coordinates map predictably into editor Y-down coordinates");
assertions++;
assert.equal(frame.customColor, "rgb(51 102 153)", "authored custom frame color is retained");

refreshDumpLinkedFlags(synthetic);
check(synthetic.nodes[1].outputs[0].linked, "output linked flag recognizes legacy socket-name links");
check(synthetic.nodes[2].inputs[0].linked === false, "index-only fallback does not invent a lossy dump socket key");
check(synthetic.nodes[3].inputs[0].linked && synthetic.nodes[3].outputs[0].linked, "reroute linked flags update in both directions");

console.log(`geometry-nodes adapter: ${assertions} assertions passed`);
