import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decodeBlend } from "./index";

const FIXTURE = fileURLToPath(new URL("../../Chrome Crayon Surface Draw Test.blend", import.meta.url));

type Tree = {
  name: string;
  type: string;
  nodes: { name: string; type: string; inputs: { identifier: string; linked: boolean; value: unknown }[] }[];
  links: { from_node: string; to_node: string; to_socket: string }[];
  interface: { name: string; item_type: string; in_out?: string; socket_type?: string; default?: unknown }[];
};
type Decoded = {
  blender_version: string;
  extraction_source: Record<string, unknown>;
  node_groups: Record<string, Tree>;
  materials: Record<string, Tree>;
  objects: {
    name: string;
    type: string;
    modifiers: { name: string; type: string; node_group?: string; input_values?: Record<string, unknown> }[];
  }[];
};

const decoded = await decodeBlend(new Uint8Array(await readFile(FIXTURE)), { filename: "chrome-crayon.blend" });
const dump = decoded.dump as unknown as Decoded;

test("reads the authoring Blender build from the file itself", () => {
  assert.equal(dump.blender_version, "5.1");
  assert.equal(dump.extraction_source.file_format, 1);
  assert.equal(dump.extraction_source.pointer_size, 8);
  assert.equal(dump.extraction_source.authored_by, "5.1.30");
});

test("recovers every geometry node group with its links and interface", () => {
  const names = Object.keys(dump.node_groups);
  assert.equal(names.length, 22);
  const root = dump.node_groups["CHROME CRAYON 3D _4.3_DEC2024"];
  assert.ok(root, "the modifier's root group is present");
  assert.equal(root.type, "GeometryNodeTree");
  assert.ok(root.nodes.length > 40);
  assert.ok(root.links.length > 40);
  for (const link of root.links) {
    assert.ok(root.nodes.some((node) => node.name === link.from_node), `${link.from_node} exists`);
    assert.ok(root.nodes.some((node) => node.name === link.to_node), `${link.to_node} exists`);
  }
  const inputs = root.interface.filter((item) => item.item_type === "SOCKET" && item.in_out === "INPUT");
  assert.ok(inputs.length > 5);
  assert.ok(inputs.every((item) => typeof item.socket_type === "string" && item.socket_type.startsWith("NodeSocket")));
});

test("binds modifier values by socket identifier and friendly name", () => {
  const object = dump.objects.find((entry) => entry.name === "CHROME CRAYON — DRAW HERE");
  assert.ok(object, "the UTF-8 object name survives decoding");
  assert.equal(object.type, "CURVE");
  const modifier = object.modifiers.find((entry) => entry.type === "NODES");
  assert.ok(modifier);
  assert.equal(modifier.node_group, "CHROME CRAYON 3D _4.3_DEC2024");
  const values = modifier.input_values ?? {};
  assert.equal(values.Socket_2, false, "a boolean socket stays boolean");
  assert.deepEqual(values["3D material"], { datablock: "Material", name: "chrome.003" });
  assert.equal(values.Socket_11, values["3D material"] as unknown);
  assert.deepEqual(object.modifiers.map((entry) => entry.type), ["NODES", "SHRINKWRAP"]);
});

test("keeps material node trees separate from geometry programs", () => {
  assert.ok(dump.materials["chrome.003"], "material graphs are decoded");
  assert.ok(dump.materials["chrome.003"].nodes.some((node) => node.type.startsWith("ShaderNode")));
  assert.ok(!Object.keys(dump.node_groups).includes("chrome.003"));
});

test("declares the capabilities it cannot supply instead of guessing", () => {
  const codes = new Set(decoded.gaps.map((gap) => gap.code));
  for (const expected of [
    "NODE_PROPERTIES_NOT_DECODED",
    "BASE_MESH_NOT_EMBEDDED",
    "IMAGE_PIXELS_NOT_EMBEDDED",
    "FONT_OUTLINES_NOT_EMBEDDED",
    "VERSION_UPGRADE_NOT_APPLIED",
    "WORLD_MATRIX_RECOMPOSED",
  ]) {
    assert.ok(codes.has(expected), `${expected} is reported`);
  }
  assert.ok(!codes.has("SOCKET_VALUE_TYPE_UNKNOWN"), "every socket value struct in the fixture decodes");
  assert.ok(!codes.has("LINK_ENDPOINT_UNRESOLVED"), "every link resolves to sockets inside its tree");
  assert.ok(!codes.has("SOCKET_SUBTYPE_UNKNOWN"), "every socket subtype maps to a calibrated identifier");
});
