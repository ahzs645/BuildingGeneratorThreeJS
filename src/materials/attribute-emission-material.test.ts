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
const noodleBrushDump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/sticker-noodle-brush/dump.json",
  import.meta.url,
)), "utf8")) as Dump;
const noodleStarDump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/sticker-noodle-star/dump.json",
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

test("preserves Periodic Brush's evaluated collection color and emission attributes", async () => {
  assert.deepEqual(extractAttributeEmissionConfig(periodicDump, "flat.nodes"), {
    colorAttribute: "col",
    strengthAttribute: "power",
  });
  const result = await runGenerator(periodicDump, { object: "PERIODIC BRUSH", overrides: {} });
  assert.deepEqual(result.soup.stats, { verts: 7840, faces: 280, tris: 7280 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 21840, material: "flat.nodes" }]);
  assert.equal(result.soup.attributes.col.itemSize, 3);
  assert.equal(result.soup.attributes.power.itemSize, 1);
  assert.ok(result.soup.attributes.power.data.every((value) => value === 1));
  const palette = new Map<string, number>();
  const colors = result.soup.attributes.col.data;
  for (let offset = 0; offset < colors.length; offset += 3) {
    const key = [colors[offset], colors[offset + 1], colors[offset + 2]].join(",");
    palette.set(key, (palette.get(key) ?? 0) + 1);
  }
  assert.deepEqual([...palette.entries()], [
    ["0,0,0", 896],
    ["0.1058368980884552,0,0.056901805102825165", 868],
    ["0.3586804270744324,0.08141867071390152,0.023261388763785362", 868],
    ["0.6156654953956604,0.5280506014823914,0.018772436305880547", 868],
    ["0.7196669578552246,0.7196669578552246,0.7196669578552246", 868],
    ["0.15079794824123383,0.532523512840271,0.726936399936676", 868],
    ["0,0.12474649399518967,0.7568728923797607", 868],
    ["0,0.02234806679189205,0.11821123957633972", 868],
    ["0.013796394690871239,0,0.02550373412668705", 868],
  ]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  geometry.setAttribute("col", new THREE.BufferAttribute(result.soup.attributes.col.data, 3));
  geometry.setAttribute("power", new THREE.BufferAttribute(result.soup.attributes.power.data, 1));
  const material = makeAttributeEmissionMaterial(periodicDump, geometry, "flat.nodes");
  assert.ok(material?.isShaderMaterial);
  assert.deepEqual(material?.userData.attributeResolution, {
    color: "geometry-color",
    strength: "geometry-vector",
  });

  const missingGeometry = new THREE.BufferGeometry();
  missingGeometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  const bothMissing = makeAttributeEmissionMaterial(periodicDump, missingGeometry, "flat.nodes");
  assert.ok(bothMissing?.isMeshBasicMaterial);
  assert.equal((bothMissing as THREE.MeshBasicMaterial).color.getHex(), 0x000000);
  assert.deepEqual(bothMissing?.userData.attributeResolution, { color: "missing-zero", strength: "missing-zero" });

  missingGeometry.setAttribute("col", new THREE.Float32BufferAttribute(new Array(result.soup.stats.verts * 3).fill(1), 3));
  const missingStrength = makeAttributeEmissionMaterial(periodicDump, missingGeometry, "flat.nodes");
  assert.ok(missingStrength?.isMeshBasicMaterial);
  assert.deepEqual(missingStrength?.userData.attributeResolution, { color: "geometry-color", strength: "missing-zero" });

  missingGeometry.deleteAttribute("col");
  missingGeometry.setAttribute("power", new THREE.Float32BufferAttribute(new Array(result.soup.stats.verts).fill(1), 1));
  const missingColor = makeAttributeEmissionMaterial(periodicDump, missingGeometry, "flat.nodes");
  assert.ok(missingColor?.isMeshBasicMaterial);
  assert.deepEqual(missingColor?.userData.attributeResolution, { color: "missing-zero", strength: "geometry-vector" });

  material?.dispose();
  bothMissing?.dispose();
  missingStrength?.dispose();
  missingColor?.dispose();
  geometry.dispose();
  missingGeometry.dispose();
});

test("preserves Sticker Noodle Brush's evaluated black-and-white emission field", async () => {
  const result = await runGenerator(noodleBrushDump, { object: "Sticker Noodle Brush.001", overrides: {} });
  assert.deepEqual(result.soup.stats, { verts: 16252, faces: 956, tris: 14340 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 43020, material: "flat.nodes" }]);
  assert.equal(result.soup.attributes.col.itemSize, 3);
  assert.equal(result.soup.attributes.power.itemSize, 1);
  assert.ok(result.soup.attributes.power.data.every((value) => value === 1));

  const palette = new Map<string, number>();
  const colors = result.soup.attributes.col.data;
  for (let offset = 0; offset < colors.length; offset += 3) {
    const key = [colors[offset], colors[offset + 1], colors[offset + 2]].join(",");
    palette.set(key, (palette.get(key) ?? 0) + 1);
  }
  assert.deepEqual([...palette.entries()], [
    ["1,1,1", 8126],
    ["0,0,0", 8126],
  ]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  geometry.setAttribute("col", new THREE.BufferAttribute(result.soup.attributes.col.data, 3));
  geometry.setAttribute("power", new THREE.BufferAttribute(result.soup.attributes.power.data, 1));
  const material = makeAttributeEmissionMaterial(noodleBrushDump, geometry, "flat.nodes");
  assert.ok(material?.isShaderMaterial);
  assert.deepEqual(material?.userData.attributeResolution, {
    color: "geometry-color",
    strength: "geometry-vector",
  });
  geometry.dispose();
  material?.dispose();
});

test("preserves Sticker Noodle Star's emission fields in a non-degenerate authored preview", async () => {
  assert.deepEqual(extractAttributeEmissionConfig(noodleStarDump, "flat.nodes"), {
    colorAttribute: "col",
    strengthAttribute: "power",
  });
  const result = await runGenerator(noodleStarDump, {
    object: "Sticker Noodle Brush",
    overrides: {
      outer: 1,
      inner: 0.45,
      color: [0.8, 0.8, 0.8],
    },
  });
  assert.deepEqual(result.soup.stats, { verts: 737880, faces: 736762, tris: 1452282 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 4356846, material: "flat.nodes" }]);
  assert.equal(result.soup.attributes.col.itemSize, 3);
  assert.equal(result.soup.attributes.power.itemSize, 1);
  assert.ok(result.soup.attributes.col.data.every((value) => value === 0.800000011920929));
  assert.ok(result.soup.attributes.power.data.every((value) => value === 1));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  geometry.setAttribute("col", new THREE.BufferAttribute(result.soup.attributes.col.data, 3));
  geometry.setAttribute("power", new THREE.BufferAttribute(result.soup.attributes.power.data, 1));
  const material = makeAttributeEmissionMaterial(noodleStarDump, geometry, "flat.nodes");
  assert.ok(material?.isShaderMaterial);
  assert.deepEqual(material?.userData.attributeResolution, {
    color: "geometry-color",
    strength: "geometry-vector",
  });
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
