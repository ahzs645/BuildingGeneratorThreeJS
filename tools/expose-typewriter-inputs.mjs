// One-shot port transform for public/dojo/typewriter/dump.json.
//
// The authored file keeps every user-facing setting ("Text input", typography,
// playback) as sockets on the nested "_Typewriter Nodes" group node, with
// nothing exposed on the GN modifier interface — so neither the asset library
// nor the studio could show a single control. This script performs the same
// "expose input" operation Blender offers, directly on the extracted dump:
//
//  - mirrors the chosen group-node sockets onto the GN interface (defaults =
//    the authored socket values) and links them through Group Input;
//  - replaces the hard link that joins the authored presentation board with a
//    Geometry Switch driven by a new exposed "Show presentation board" bool,
//    defaulting to hidden — matching the checked-in Blender reference
//    (references/frame-240-blender.json, captured board-off at frame 240);
//  - sets the default text to the parity sample text and frame_current to 240
//    so a default evaluation reproduces the reference exactly (4,743 / 33).
//
// Idempotent: re-running against a transformed dump is a no-op.
import { readFileSync, writeFileSync } from "node:fs";

const DUMP_PATH = new URL("../public/dojo/typewriter/dump.json", import.meta.url);
const PAGE_TEXT = "NODE DOJO TYPEWRITER — now running entirely in the browser.";
const EXPOSED = [
  "Text input",
  "Type Speed",
  "Keyframe to Backspace",
  "Size",
  "Character Spacing",
  "Word Spacing",
  "Line Spacing",
  "Text Box Width",
];
const BOARD_INPUT = "Show presentation board";

const dump = JSON.parse(readFileSync(DUMP_PATH, "utf8"));
const gn = dump.node_groups.GN;
const tw = dump.node_groups["_Typewriter Nodes"];
if (gn.interface.some((item) => item.name === "Text input")) {
  console.log("dump already transformed; nothing to do");
  process.exit(0);
}

const groupInput = gn.nodes.find((node) => node.type === "NodeGroupInput");
const groupNode = gn.nodes.find((node) => node.type === "GeometryNodeGroup" && node.group === "_Typewriter Nodes");
const extendIndex = groupInput.outputs.findIndex((socket) => socket.identifier === "__extend__");

let serial = Math.max(0, ...gn.interface.map((item) => Number(/^(?:Input|Output)_(\d+)$/.exec(item.identifier)?.[1] ?? 0))) + 1;
const socketEntry = (name, identifier, type) => ({
  name,
  identifier,
  type,
  linked: true,
  enabled: true,
  hide: false,
  hide_value: false,
  display_shape: "CIRCLE",
  default: null,
});

for (const name of EXPOSED) {
  const declared = tw.interface.find((item) =>
    item.item_type === "SOCKET" && item.in_out === "INPUT" && item.name === name);
  const nodeSocket = groupNode.inputs.find((socket) => socket.name === name);
  const identifier = `Input_${serial++}`;
  gn.interface.push({
    name,
    item_type: "SOCKET",
    identifier,
    in_out: "INPUT",
    socket_type: declared.socket_type,
    default: name === "Text input" ? PAGE_TEXT : nodeSocket.value,
    subtype: declared.subtype ?? "NONE",
    ...(declared.min_value !== undefined ? { min_value: declared.min_value } : {}),
    ...(declared.max_value !== undefined ? { max_value: declared.max_value } : {}),
  });
  groupInput.outputs.splice(extendIndex >= 0 ? groupInput.outputs.length - 1 : groupInput.outputs.length, 0,
    socketEntry(name, identifier, declared.socket_type));
  gn.links.push({
    from_node: groupInput.name,
    from_socket: identifier,
    to_node: groupNode.name,
    to_socket: nodeSocket.identifier,
    to_idx: null,
    from_type: declared.socket_type,
    to_type: declared.socket_type,
  });
  nodeSocket.linked = true;
}

// Presentation-board switch: authored graph hard-joins the demo board mesh
// (the object's base geometry) into the output. Route it through a Switch so
// it becomes an exposed choice, defaulting to hidden like the reference.
const boardId = `Input_${serial++}`;
gn.interface.push({
  name: BOARD_INPUT,
  item_type: "SOCKET",
  identifier: boardId,
  in_out: "INPUT",
  socket_type: "NodeSocketBool",
  default: false,
  subtype: "NONE",
});
groupInput.outputs.splice(extendIndex >= 0 ? groupInput.outputs.length - 1 : groupInput.outputs.length, 0,
  socketEntry(BOARD_INPUT, boardId, "NodeSocketBool"));

const boardLinkIndex = gn.links.findIndex((link) =>
  link.from_node === groupInput.name && link.from_socket === "Input_0" && link.to_node === "Join Geometry");
const boardLink = gn.links[boardLinkIndex];
const switchSocket = (name, type, idx) => ({
  name,
  identifier: name,
  type,
  linked: false,
  enabled: true,
  hide: false,
  hide_value: false,
  display_shape: "CIRCLE",
  idx,
  value: null,
});
gn.nodes.push({
  name: "Board Switch",
  type: "GeometryNodeSwitch",
  label: null,
  ui: { location: [-380, -220], location_absolute: [-380, -220], width: 140, height: 100, dimensions: [0, 0], hide: false, mute: false, use_custom_color: false, color: [0.608, 0.608, 0.608], parent: null },
  inputs: [
    { ...switchSocket("Switch", "NodeSocketBool", 0), linked: true },
    switchSocket("False", "NodeSocketGeometry", 1),
    { ...switchSocket("True", "NodeSocketGeometry", 2), linked: true },
  ],
  outputs: [{
    name: "Output",
    identifier: "Output",
    type: "NodeSocketGeometry",
    linked: true,
    enabled: true,
    hide: false,
    hide_value: false,
    display_shape: "CIRCLE",
    default: null,
  }],
  props: { bl_idname: "GeometryNodeSwitch", bl_label: "Switch", input_type: "GEOMETRY" },
  data: null,
});
gn.links.splice(boardLinkIndex, 1,
  { from_node: groupInput.name, from_socket: "Input_0", to_node: "Board Switch", to_socket: "True", to_idx: null, from_type: "NodeSocketGeometry", to_type: "NodeSocketGeometry" },
  { from_node: groupInput.name, from_socket: boardId, to_node: "Board Switch", to_socket: "Switch", to_idx: null, from_type: "NodeSocketBool", to_type: "NodeSocketBool" },
  { from_node: "Board Switch", from_socket: "Output", to_node: boardLink.to_node, to_socket: boardLink.to_socket, to_idx: boardLink.to_idx ?? null, from_type: "NodeSocketGeometry", to_type: "NodeSocketGeometry", ...(boardLink.multi_input_sort_id !== undefined ? { multi_input_sort_id: boardLink.multi_input_sort_id } : {}) },
);

// Reference frame: both UIs default-evaluate at scene frame_current.
dump.scene.frame_current = 240;

writeFileSync(DUMP_PATH, JSON.stringify(dump));
console.log("transformed:", EXPOSED.length, "inputs exposed +", BOARD_INPUT);
