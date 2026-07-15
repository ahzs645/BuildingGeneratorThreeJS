import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { extractMahoganyMaterialConfig, makeMahoganyMaterial } from "../mahogany-material";
import type { Dump } from "../gnvm";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/joints/shader-metadata.json",
  import.meta.url,
)), "utf8")) as Dump;
const name = "proc_ mahogany.001";

test("extracts the authored procedural mahogany ramps and mapping", () => {
  const config = extractMahoganyMaterialConfig(dump, name);
  assert.ok(config);
  assert.equal(config.colorAAttribute, "col1");
  assert.equal(config.colorBAttribute, "col2");
  assert.equal(config.scaleAttribute, "scale");
  assert.equal(config.rotationAttribute, "rot");
  assert.deepEqual(config.roughnessRamp, [
    { position: 0, color: 0.5449315309524536 },
    { position: 0.9937888383865356, color: 0.4111188054084778 },
  ]);
  assert.equal(config.waveScale, 1.380000114440918);
  assert.equal(config.noiseScale, 1000);
  assert.equal(config.transmission, 0.0535714291036129);
});

test("builds the shader with geometry scale/rotation and missing-color fallbacks", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,1], 3));
  geometry.setAttribute("scale", new THREE.Float32BufferAttribute([1,1,1], 1));
  geometry.setAttribute("rot", new THREE.Float32BufferAttribute([0,0,0, 0,0,0, 0,0,0], 3));
  const material = makeMahoganyMaterial(dump, geometry, name);
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material?.name, `${name} · procedural mahogany reconstruction`);
  const shader = { vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>" };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /vMahoganyA=vec3\(0.800000011920929/);
  assert.match(shader.vertexShader, /attribute float scale/);
  assert.match(shader.fragmentShader, /mahoganyWave/);
  assert.match(shader.fragmentShader, /mahoganyRamp/);
  material?.dispose();
  geometry.dispose();
});
