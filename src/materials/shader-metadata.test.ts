import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const metadata = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/joints/shader-metadata.json",
  import.meta.url,
)), "utf8"));
const chromeMetadata = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/shader-metadata.json",
  import.meta.url,
)), "utf8"));
const n03dMetadata = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/n03d/shader-metadata.json",
  import.meta.url,
)), "utf8"));
const nodesNodeMetadata = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/nodes-node/shader-metadata.json",
  import.meta.url,
)), "utf8"));
const mathClayMetadata = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/math-clay/shader-metadata.json",
  import.meta.url,
)), "utf8"));
const sendNodesHatMetadata = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/send-nodes-hat/shader-metadata.json",
  import.meta.url,
)), "utf8"));
const introCourseMetadata = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/course-modules/intro-shader-metadata.json",
  import.meta.url,
)), "utf8"));
const module3CourseMetadata = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/course-modules/module3-shader-metadata.json",
  import.meta.url,
)), "utf8"));
const module4CourseMetadata = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/course-modules/module4-shader-metadata.json",
  import.meta.url,
)), "utf8"));
const catalog = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/catalog.json",
  import.meta.url,
)), "utf8"));

test("joint shader sidecar preserves ramps and internal shader groups", () => {
  assert.equal(Object.keys(metadata.materials).length, 48);
  assert.equal(Object.keys(metadata.shader_node_groups).length, 15);
  const mahogany = metadata.materials["proc_ mahogany.001"];
  const ramp = mahogany.nodes.find((node: any) => node.name === "Color Ramp.001")?.props?.color_ramp;
  assert.deepEqual(ramp.elements.map((element: any) => element.position), [0, 0.9937888383865356]);
  assert.deepEqual(ramp.elements[0].color.slice(0, 3), [0.5449315309524536, 0.5449315309524536, 0.5449315309524536]);
  assert.ok(metadata.shader_node_groups["npr glass"].nodes.length > 0);
});

test("every joint catalog entry loads the shared shader sidecar", () => {
  const ids = ["joint-three-way-pipe", "joint-modern-pipe", "joint-bubble-putty", "joint-pipe-icon"];
  for (const id of ids) {
    assert.equal(catalog.find((asset: any) => asset.id === id)?.shaderMetadata, "dojo/joints/shader-metadata.json");
  }
});

test("Chrome Asset shader sidecar preserves procedural group internals", () => {
  assert.equal(Object.keys(chromeMetadata.materials).length, 35);
  assert.equal(Object.keys(chromeMetadata.shader_node_groups).length, 11);
  assert.ok(chromeMetadata.shader_node_groups["chrome spectrum"].nodes.length > 0);
  const ramp = chromeMetadata.shader_node_groups["chrome spectrum"].nodes
    .find((node: any) => node.type === "ShaderNodeValToRGB")?.props?.color_ramp;
  assert.ok(ramp?.elements.length >= 2);
});

test("every Chrome Asset catalog entry loads its shared shader sidecar", () => {
  const assets = catalog.filter((asset: any) => asset.dump.startsWith("dojo/chrome-assets/"));
  assert.equal(assets.length, 26);
  for (const asset of assets) {
    assert.equal(asset.shaderMetadata, "dojo/chrome-assets/shader-metadata.json");
  }
  assert.equal(catalog.find((asset: any) => asset.id === "periodic-brush")?.shaderMetadata,
    "dojo/chrome-assets/shader-metadata.json");
});

test("N03D shader sidecar preserves internal material groups", () => {
  assert.equal(Object.keys(n03dMetadata.materials).length, 46);
  assert.equal(Object.keys(n03dMetadata.shader_node_groups).length, 11);
  assert.ok(n03dMetadata.shader_node_groups["MatCap Material II.002"].nodes.length > 0);
});

test("every N03D catalog entry loads its shared shader sidecar", () => {
  const assets = catalog.filter((asset: any) => asset.dump.startsWith("dojo/n03d/"));
  assert.equal(assets.length, 28);
  for (const asset of assets) {
    assert.equal(asset.shaderMetadata, "dojo/n03d/shader-metadata.json");
  }
});

test("Nodes Node sidecar preserves its shared text shader groups", () => {
  assert.equal(Object.keys(nodesNodeMetadata.materials).length, 22);
  assert.equal(Object.keys(nodesNodeMetadata.shader_node_groups).length, 7);
  assert.ok(nodesNodeMetadata.shader_node_groups["vtext.001"].nodes.length > 0);
});

test("every Nodes Node root loads its shared shader sidecar", () => {
  const assets = catalog.filter((asset: any) => asset.dump.startsWith("dojo/nodes-node/"));
  assert.equal(assets.length, 12);
  for (const asset of assets) {
    assert.equal(asset.shaderMetadata, "dojo/nodes-node/shader-metadata.json");
  }
});

test("Math Clay sidecar preserves its authored toon group", () => {
  assert.equal(Object.keys(mathClayMetadata.materials).length, 12);
  assert.equal(Object.keys(mathClayMetadata.shader_node_groups).length, 2);
  assert.ok(mathClayMetadata.shader_node_groups["_Toon Cycles ShaderA"].nodes.length > 0);
});

test("every Math Clay root loads its shared shader sidecar", () => {
  const assets = catalog.filter((asset: any) => asset.dump.startsWith("dojo/math-clay/"));
  assert.equal(assets.length, 13);
  for (const asset of assets) {
    assert.equal(asset.shaderMetadata, "dojo/math-clay/shader-metadata.json");
  }
});

test("Send Nodes Hat sidecar preserves its viewport shader groups", () => {
  assert.equal(Object.keys(sendNodesHatMetadata.materials).length, 11);
  assert.equal(Object.keys(sendNodesHatMetadata.shader_node_groups).length, 4);
  assert.ok(sendNodesHatMetadata.shader_node_groups["MatCap Material II"].nodes.length > 0);
});

test("every Send Nodes Hat root loads its shared shader sidecar", () => {
  const assets = catalog.filter((asset: any) => asset.dump.startsWith("dojo/send-nodes-hat/"));
  assert.equal(assets.length, 4);
  for (const asset of assets) {
    assert.equal(asset.shaderMetadata, "dojo/send-nodes-hat/shader-metadata.json");
  }
});

test("course sidecars preserve the authored material libraries", () => {
  assert.deepEqual([
    [Object.keys(introCourseMetadata.materials).length, Object.keys(introCourseMetadata.shader_node_groups).length],
    [Object.keys(module3CourseMetadata.materials).length, Object.keys(module3CourseMetadata.shader_node_groups).length],
    [Object.keys(module4CourseMetadata.materials).length, Object.keys(module4CourseMetadata.shader_node_groups).length],
  ], [[74, 11], [83, 10], [77, 12]]);
});

test("all 101 catalog assets now load portable shader metadata", () => {
  assert.equal(catalog.length, 101);
  assert.equal(catalog.filter((asset: any) => typeof asset.shaderMetadata === "string").length, 101);
});
