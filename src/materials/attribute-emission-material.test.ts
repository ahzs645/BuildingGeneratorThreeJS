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
const periodicDump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/periodic-brush/dump.json",
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
  assert.match((material as THREE.ShaderMaterial).vertexShader, /attribute vec3 col/);
  assert.match((material as THREE.ShaderMaterial).vertexShader, /attribute float power/);
  assert.match((material as THREE.ShaderMaterial).fragmentShader, /tonemapping_fragment/);
  geometry.dispose();
  material?.dispose();
});

test("resolves Periodic Brush's missing flat.nodes attributes independently to zero", async () => {
  assert.deepEqual(extractAttributeEmissionConfig(periodicDump, "flat.nodes"), {
    colorAttribute: "col",
    strengthAttribute: "power",
  });
  const result = await runGenerator(periodicDump, { object: "PERIODIC BRUSH", overrides: {} });
  assert.deepEqual(result.soup.stats, { verts: 7840, faces: 280, tris: 7280 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 21840, material: "flat.nodes" }]);
  assert.deepEqual(Object.keys(result.soup.attributes), []);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  const bothMissing = makeAttributeEmissionMaterial(periodicDump, geometry, "flat.nodes");
  assert.ok(bothMissing?.isMeshBasicMaterial);
  assert.equal((bothMissing as THREE.MeshBasicMaterial).color.getHex(), 0x000000);
  assert.deepEqual(bothMissing?.userData.attributeResolution, { color: "missing-zero", strength: "missing-zero" });

  geometry.setAttribute("col", new THREE.Float32BufferAttribute(new Array(result.soup.stats.verts * 3).fill(1), 3));
  const missingStrength = makeAttributeEmissionMaterial(periodicDump, geometry, "flat.nodes");
  assert.ok(missingStrength?.isMeshBasicMaterial);
  assert.deepEqual(missingStrength?.userData.attributeResolution, { color: "geometry-color", strength: "missing-zero" });

  geometry.deleteAttribute("col");
  geometry.setAttribute("power", new THREE.Float32BufferAttribute(new Array(result.soup.stats.verts).fill(1), 1));
  const missingColor = makeAttributeEmissionMaterial(periodicDump, geometry, "flat.nodes");
  assert.ok(missingColor?.isMeshBasicMaterial);
  assert.deepEqual(missingColor?.userData.attributeResolution, { color: "missing-zero", strength: "geometry-vector" });

  bothMissing?.dispose();
  missingStrength?.dispose();
  missingColor?.dispose();
  geometry.dispose();
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
