import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import type { Dump } from "../gnvm";
import {
  extractLightbulbMaterialConfig,
  makeLightbulbMaterial,
  type LightbulbTextureSet,
} from "../lightbulb-material";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/n03d/conveyor-mechanic/dump.json",
  import.meta.url,
)), "utf8")) as Dump;

test("recovers the packed Conveyor completion-marker PBR contract", () => {
  assert.deepEqual(extractLightbulbMaterialConfig(dump, "lightbulb_01_base"), {
    baseColorImage: "lightbulb_01_diff.png.001",
    metalnessImage: "lightbulb_01_metal.png.001",
    roughnessImage: "lightbulb_01_rough.png.001",
    normalImage: "lightbulb_01_nor_gl.png.001",
    emissiveImage: "lightbulb_01_emissive.jpg",
    normalStrength: 1,
    emissionStrength: 66.41999816894531,
  });
  assert.equal(extractLightbulbMaterialConfig(dump, "lightbulb_01_glass"), null);
});

test("binds all five packed maps with Blender's scalar controls", () => {
  const texture = () => new THREE.Texture();
  const textures: LightbulbTextureSet = {
    baseColor: texture(),
    metalness: texture(),
    roughness: texture(),
    normal: texture(),
    emissive: texture(),
  };
  const material = makeLightbulbMaterial(dump, "lightbulb_01_base", textures);
  assert.ok(material);
  assert.equal(material.map, textures.baseColor);
  assert.equal(material.metalnessMap, textures.metalness);
  assert.equal(material.roughnessMap, textures.roughness);
  assert.equal(material.normalMap, textures.normal);
  assert.equal(material.emissiveMap, textures.emissive);
  assert.equal(material.metalness, 1);
  assert.equal(material.roughness, 1);
  assert.deepEqual(material.normalScale.toArray(), [1, 1]);
  assert.equal(material.emissiveIntensity, 66.41999816894531);
  material.dispose();
  Object.values(textures).forEach((item) => item.dispose());
});
