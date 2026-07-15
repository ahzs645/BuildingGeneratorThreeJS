import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import type { Dump } from "../gnvm";
import { extractGreyUiMaterialConfig, makeGreyUiMaterial } from "../grey-ui-material";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/shader-metadata.json",
  import.meta.url,
)), "utf8")) as Dump;

test("extracts the UI normal bands and geometry color contract", () => {
  const config = extractGreyUiMaterialConfig(dump, "grey ui");
  assert.ok(config);
  assert.equal(config.colorAttribute, "col");
  assert.equal(config.mixFactor, 0.6647727489471436);
  assert.equal(config.ramp.length, 4);
  assert.equal(config.ramp[3].position, 0.43944212794303894);
  assert.equal(extractGreyUiMaterialConfig(dump, "chrome"), null);
});

test("builds the UI shader only when the authored color attribute exists", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([0,0,1, 0,0,1, 0,0,1], 3));
  assert.equal(makeGreyUiMaterial(dump, geometry, "grey ui"), null);
  geometry.setAttribute("col", new THREE.Float32BufferAttribute([1,0,0, 0,1,0, 0,0,1], 3));
  const material = makeGreyUiMaterial(dump, geometry, "grey ui");
  assert.ok(material?.isShaderMaterial);
  assert.match(material?.fragmentShader ?? "", /0\.43944212794303894/);
  material?.dispose();
  geometry.dispose();
});
