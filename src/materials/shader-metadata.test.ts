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
});
