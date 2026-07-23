import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { extractChromeCrayonMaterialConfig, makeChromeCrayonMaterial } from "../chrome-crayon-material";
import { runGenerator, type Dump } from "../gnvm";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/25d-chrome-crayon/dump.json",
  import.meta.url,
)), "utf8")) as Dump;
const bluntDump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/blunt-metal-marker/dump.json",
  import.meta.url,
)), "utf8")) as Dump;
const softPixelDump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/soft-pixel-marker/dump.json",
  import.meta.url,
)), "utf8")) as Dump;
const typePixelDump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/type-pixel-brush/dump.json",
  import.meta.url,
)), "utf8")) as Dump;

test("extracts the authored chrome.003 Principled/noise contract", () => {
  assert.deepEqual(extractChromeCrayonMaterialConfig(dump, "chrome.003"), {
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
  });
  assert.equal(extractChromeCrayonMaterialConfig(dump, "flat crayon.004"), null);
});

test("builds the Chrome Crayon authored material with present or missing rough", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -1, -2, 0,
    2, -2, 0,
    -1, 3, 1,
  ], 3));
  const missing = makeChromeCrayonMaterial(dump, geometry, "chrome.003");
  assert.ok(missing?.isMeshPhysicalMaterial);
  assert.equal(missing?.userData.chromeCrayonAttributeResolution, "missing-zero");
  const missingShader = {
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader: "#include <common>\n#include <roughnessmap_fragment>",
  };
  missing?.onBeforeCompile(missingShader as never, {} as never);
  assert.doesNotMatch(missingShader.vertexShader, /attribute float rough/);
  assert.match(missingShader.vertexShader, /vCrayonRough = 0\.0/);
  geometry.setAttribute("rough", new THREE.Float32BufferAttribute([0, 0, 0], 1));

  const material = makeChromeCrayonMaterial(dump, geometry, "chrome.003");
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material?.name, "chrome.003 · authored Chrome Crayon reconstruction");
  assert.equal(material?.metalness, 1);
  assert.equal(material?.roughness, 0);
  assert.deepEqual(material?.color.toArray(), [0.800000011920929, 0.800000011920929, 0.800000011920929]);
  assert.equal(material?.userData.chromeCrayonContract.roughnessAttribute, "rough");
  assert.equal(material?.userData.chromeCrayonAttributeResolution, "geometry-color");

  const shader = {
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader: "#include <common>\n#include <roughnessmap_fragment>",
  };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /attribute float rough/);
  assert.match(shader.vertexShader, /vCrayonGenerated/);
  assert.match(shader.fragmentShader, /crayonMappedRoughness/);
  assert.match(shader.fragmentShader, /roughnessFactor = clamp\(crayonMappedRoughness \* max\(vCrayonRough/);

  missing?.dispose();
  material?.dispose();
  geometry.dispose();
});

test("resolves Blunt Metal Marker's absent rough attribute to polished chrome", async () => {
  assert.deepEqual(extractChromeCrayonMaterialConfig(bluntDump, "chrome.002"), {
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
  });
  const result = await runGenerator(bluntDump, { object: "Chrome Marker Extruded", overrides: {} });
  assert.deepEqual(result.soup.stats, { verts: 97691, faces: 97669, tris: 195420 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 586260, material: "chrome.002" }]);
  assert.ok(!Object.hasOwn(result.soup.attributes, "rough"));
  assert.deepEqual(Object.fromEntries(Object.entries(result.soup.attributes).map(([name, attribute]) => [name, attribute.itemSize])), {
    col: 3,
    power: 1,
    sharp_face: 1,
  });
  assert.ok(result.soup.attributes.sharp_face.data.every((value) => value === 0));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  const material = makeChromeCrayonMaterial(bluntDump, geometry, "chrome.002");
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material?.metalness, 1);
  assert.equal(material?.roughness, 0);
  assert.equal(material?.userData.chromeCrayonAttributeResolution, "missing-zero");
  material?.dispose();
  geometry.dispose();
});

test("preserves Soft Pixel Marker's authored polished chrome branch", async () => {
  const result = await runGenerator(softPixelDump, { object: "PIXEL CRAYON.004", overrides: {} });
  assert.deepEqual(result.soup.stats, { verts: 8455, faces: 5664, tris: 11328 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 33984, material: "chrome.002" }]);
  assert.equal(result.soup.attributes.rough.itemSize, 1);
  assert.equal(result.soup.attributes.rough.domain, "FACE");
  assert.ok(result.soup.attributes.rough.data.every((value) => value === 0));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  geometry.setAttribute("rough", new THREE.BufferAttribute(result.soup.attributes.rough.data, 1));
  const material = makeChromeCrayonMaterial(softPixelDump, geometry, "chrome.002");
  assert.equal(material?.name, "chrome.002 · authored Chrome Crayon reconstruction");
  assert.equal(material?.metalness, 1);
  assert.equal(material?.roughness, 0);
  assert.equal(material?.userData.chromeCrayonAttributeResolution, "geometry-color");
  material?.dispose();
  geometry.dispose();
});

test("preserves Type Pixel Brush's authored polished chrome branch", async () => {
  const result = await runGenerator(typePixelDump, { object: "Type Pixel Brush Chrome", overrides: {} });
  assert.deepEqual(result.soup.stats, { verts: 17860, faces: 11296, tris: 22592 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 67776, material: "chrome.002" }]);
  assert.equal(result.soup.attributes.rough.itemSize, 1);
  assert.equal(result.soup.attributes.rough.domain, "FACE");
  assert.ok(result.soup.attributes.rough.data.every((value) => value === 0));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  geometry.setAttribute("rough", new THREE.BufferAttribute(result.soup.attributes.rough.data, 1));
  const material = makeChromeCrayonMaterial(typePixelDump, geometry, "chrome.002");
  assert.equal(material?.name, "chrome.002 · authored Chrome Crayon reconstruction");
  assert.equal(material?.metalness, 1);
  assert.equal(material?.roughness, 0);
  assert.equal(material?.userData.chromeCrayonAttributeResolution, "geometry-color");
  material?.dispose();
  geometry.dispose();
});
