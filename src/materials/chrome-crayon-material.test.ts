import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { extractChromeCrayonMaterialConfig, makeChromeCrayonMaterial } from "../chrome-crayon-material";
import type { Dump } from "../gnvm";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/25d-chrome-crayon/dump.json",
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

test("builds the Chrome Crayon authored material only when rough is present", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -1, -2, 0,
    2, -2, 0,
    -1, 3, 1,
  ], 3));
  assert.equal(makeChromeCrayonMaterial(dump, geometry, "chrome.003"), null);
  geometry.setAttribute("rough", new THREE.Float32BufferAttribute([0, 0, 0], 1));

  const material = makeChromeCrayonMaterial(dump, geometry, "chrome.003");
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material?.name, "chrome.003 · authored Chrome Crayon reconstruction");
  assert.equal(material?.metalness, 1);
  assert.equal(material?.roughness, 0);
  assert.deepEqual(material?.color.toArray(), [0.800000011920929, 0.800000011920929, 0.800000011920929]);
  assert.equal(material?.userData.chromeCrayonContract.roughnessAttribute, "rough");

  const shader = {
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader: "#include <common>\n#include <roughnessmap_fragment>",
  };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /attribute float rough/);
  assert.match(shader.vertexShader, /vCrayonGenerated/);
  assert.match(shader.fragmentShader, /crayonMappedRoughness/);
  assert.match(shader.fragmentShader, /roughnessFactor = clamp\(crayonMappedRoughness \* max\(vCrayonRough/);

  material?.dispose();
  geometry.dispose();
});
