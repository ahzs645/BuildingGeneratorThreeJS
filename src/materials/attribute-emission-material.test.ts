import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { extractAttributeEmissionConfig, makeAttributeEmissionMaterial } from "../attribute-emission-material";
import { runGenerator, type Dump } from "../gnvm";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/outline-sticker/dump.json",
  import.meta.url,
)), "utf8")) as Dump;
const textDump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/string-to-text/dump.json",
  import.meta.url,
)), "utf8")) as Dump;

test("extracts the authored flat sticker emission contract", () => {
  assert.deepEqual(extractAttributeEmissionConfig(dump, "flat.nodes"), {
    colorAttribute: "col",
    strengthAttribute: "power",
  });
  assert.equal(extractAttributeEmissionConfig(dump, "chrome.002"), null);
});

test("wires Outline Sticker color and power attributes into its browser material", async () => {
  const result = await runGenerator(dump, { object: "outline sticker.001", overrides: {} });
  assert.deepEqual(result.soup.stats, { verts: 1056, faces: 1025, tris: 2078 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 6234, material: "flat.nodes" }]);
  assert.deepEqual(Object.fromEntries(Object.entries(result.soup.attributes).map(([name, attribute]) => [name, attribute.itemSize])), {
    col: 3,
    power: 1,
  });
  assert.ok(result.soup.attributes.col.data.some((value) => value > 0.99));
  assert.ok(result.soup.attributes.col.data.some((value) => value > 0.04 && value < 0.5));
  assert.ok(result.soup.attributes.power.data.every((value) => value === 1));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  for (const [name, attribute] of Object.entries(result.soup.attributes)) {
    geometry.setAttribute(name, new THREE.BufferAttribute(attribute.data, attribute.itemSize));
  }
  const material = makeAttributeEmissionMaterial(dump, geometry, "flat.nodes");
  assert.ok(material?.isShaderMaterial);
  assert.equal(material?.name, "flat.nodes · attribute emission reconstruction");
  assert.equal(material?.toneMapped, true);
  assert.match(material?.vertexShader ?? "", /attribute vec3 col/);
  assert.match(material?.vertexShader ?? "", /attribute float power/);
  assert.match(material?.fragmentShader ?? "", /tonemapping_fragment/);
  geometry.dispose();
  material?.dispose();
});

test("reconstructs String to Text's independently extracted emission material", async () => {
  assert.deepEqual(extractAttributeEmissionConfig(textDump, "flat.nodes.001"), {
    colorAttribute: "col",
    strengthAttribute: "power",
  });
  const result = await runGenerator(textDump, { object: "Vert.001", overrides: {} });
  assert.deepEqual(result.soup.stats, { verts: 246, faces: 20, tris: 206 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 618, material: "flat.nodes.001" }]);
  assert.equal(result.soup.attributes.col.itemSize, 3);
  assert.equal(result.soup.attributes.power.itemSize, 1);
  assert.ok(result.soup.attributes.col.data.some((value) => value > 0.8));
  assert.ok(result.soup.attributes.col.data.some((value) => value === 0));
  assert.ok(result.soup.attributes.power.data.every((value) => value === 1));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  for (const [name, attribute] of Object.entries(result.soup.attributes)) {
    geometry.setAttribute(name, new THREE.BufferAttribute(attribute.data, attribute.itemSize));
  }
  const material = makeAttributeEmissionMaterial(textDump, geometry, "flat.nodes.001");
  assert.equal(material?.name, "flat.nodes.001 · attribute emission reconstruction");
  assert.equal(material?.toneMapped, true);
  geometry.dispose();
  material?.dispose();
});
