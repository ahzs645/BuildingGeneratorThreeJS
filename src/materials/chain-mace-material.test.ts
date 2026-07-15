import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { attachChainMaceRoughnessAttribute, extractChainMaceMaterialConfig, makeChainMaceMaterial } from "../chain-mace-material";
import { runGenerator, type Dump } from "../gnvm";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/chain-and-mace/dump.json",
  import.meta.url,
)), "utf8")) as Dump;

test("extracts Chain & Mace's authored chrome.002 contract", () => {
  assert.deepEqual(extractChainMaceMaterialConfig(dump, "chrome.002"), {
    material: "chrome.002",
    baseColor: [0.800000011920929, 0.800000011920929, 0.800000011920929],
    metallic: 1,
    roughnessAttribute: "rough",
    generatedScale: [131.2701416015625, 131.2701416015625, 1875.470870733261],
    noise: {
      dimensions: "3D",
      detail: 2,
      roughness: 0.5,
      lacunarity: 2,
      distortion: 31.20849609375,
      fromMin: 0,
      fromMax: 1,
      toMin: -1,
      toMax: 1,
    },
    hasEmission: false,
    hasBump: false,
    missingRoughnessResolvesTo: 0,
  });
  assert.equal(extractChainMaceMaterialConfig(dump, "grainy test"), null);
});

test("resolves both exact soup ranges to the evaluated chrome material", async () => {
  const result = await runGenerator(dump, { object: "spikey chain and mace.005", overrides: {} });
  assert.deepEqual(result.soup.stats, { verts: 120727, faces: 214718, tris: 225148 });
  assert.deepEqual(result.soup.groups, [
    { start: 0, count: 55860, material: "chrome.002" },
    { start: 55860, count: 619584, material: null },
  ]);
  assert.deepEqual(Object.keys(result.soup.attributes), ["1"]);
  assert.equal(result.soup.attributes["1"].itemSize, 1);
  assert.equal(result.soup.attributes["1"].data.filter((value) => value === 0).length, 11781);
  assert.equal(result.soup.attributes["1"].data.filter((value) => value === 1).length, 108946);
  assert.equal(result.soup.attributes.rough, undefined);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(result.soup.indices, 1));
  geometry.setAttribute("1", new THREE.BufferAttribute(result.soup.attributes["1"].data, 1));
  const roughness = attachChainMaceRoughnessAttribute(geometry, result.soup.groups);
  assert.equal(roughness?.count, 120727);
  assert.equal(Array.from(roughness?.array ?? []).filter((value) => value === 2).length, 10629);
  assert.equal(Array.from(roughness?.array ?? []).filter((value) => value === 0).length, 110098);
  const material = makeChainMaceMaterial(dump, geometry, "chrome.002");
  assert.equal(material?.name, "chrome.002 · authored Chain & Mace chrome reconstruction");
  assert.equal(material?.metalness, 1);
  assert.equal(material?.roughness, 0);
  assert.equal(material?.envMapIntensity, 1);
  assert.match(String(material?.customProgramCacheKey()), /chain-mace-chrome/);
  assert.match(String(material?.onBeforeCompile), /1\.0 \/ 15\.0/);
  assert.doesNotMatch(String(material?.onBeforeCompile), /chainMaceNoise/);
  geometry.dispose();
  material?.dispose();
});
