import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import {
  extractHatStitchMaterialConfig,
  hatStitchWaveHeightAtGenerated,
  makeHatStitchMaterial,
  mapHatStitchGenerated,
} from "../hat-stitch-material";
import { runGenerator, type Dump } from "../gnvm";

const geometryDump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/send-nodes-hat/dump.json",
  import.meta.url,
)), "utf8")) as Dump;
const shaderMetadata = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/send-nodes-hat/shader-metadata.json",
  import.meta.url,
)), "utf8")) as Dump;
const dump = Object.assign(geometryDump, shaderMetadata);
const materialName = "sitch.001";

test("extracts and renders the authored Send Nodes Hat stitch material", async () => {
  const config = extractHatStitchMaterialConfig(dump, materialName);
  assert.deepEqual(config, {
    colorAttribute: "col",
    metalness: 0.23291926085948944,
    roughness: 0.804347813129425,
    ior: 1.5,
    transmission: 1,
    mappingLocation: [0, 0, 0],
    mappingRotation: [0, -0.031415924429893494, 0],
    mappingScale: [1, 1, 1],
    waveScale: 1.5299999713897705,
    waveDistortion: 0,
    waveDetail: 2,
    waveDetailScale: 1,
    waveDetailRoughness: 0.5,
    bumpStrength: 0.3124999701976776,
    bumpDistance: 1,
    bumpFilterWidth: 1,
    bumpInvert: false,
  });
  assert.deepEqual(mapHatStitchGenerated([0.5, 0.5, 0.5], config!), [
    0.48404790172935985,
    0.5,
    0.5154586587025229,
  ]);
  assert.ok(Math.abs(hatStitchWaveHeightAtGenerated([0, 0, 0], config!) - 2.2499957452737362e-10) < 1e-16);
  assert.ok(Math.abs(hatStitchWaveHeightAtGenerated([0.5, 0.5, 0.5], config!) - 0.7903091481200278) < 1e-15);

  const result = await runGenerator(dump, { object: "embroidery crv" });
  assert.deepEqual(result.soup.stats, { verts: 188934, faces: 188160, tris: 376320 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 1128960, material: materialName }]);
  assert.equal(result.soup.attributes.col.domain, "FACE");
  assert.equal(result.soup.attributes.col.itemSize, 3);
  assert.equal(result.soup.attributes.col.data.length / 3, result.soup.stats.verts);
  assert.deepEqual(Array.from(result.soup.attributes.col.data.slice(0, 3)), [
    0.9770724773406982,
    1,
    0.9756893515586853,
  ]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(result.soup.normals, 3));
  for (const [name, attribute] of Object.entries(result.soup.attributes)) {
    geometry.setAttribute(name, new THREE.BufferAttribute(attribute.data, attribute.itemSize));
  }
  geometry.setIndex(new THREE.BufferAttribute(result.soup.indices, 1));
  const material = makeHatStitchMaterial(dump, geometry, result.soup.groups[0], materialName);
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material?.name, "sitch.001 · authored Send Nodes Hat stitch reconstruction");
  assert.equal(material?.metalness, config?.metalness);
  assert.equal(material?.roughness, config?.roughness);
  assert.equal(material?.ior, config?.ior);
  assert.equal(material?.transmission, config?.transmission);
  assert.deepEqual(material?.userData.hatStitchBounds, {
    min: [-0.04472097381949425, -0.009398020803928375, -0.029892880469560623],
    max: [0.04209489747881889, 0.005676466040313244, -0.017833180725574493],
  });

  const shader = {
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader: "#include <common>\n#include <color_fragment>\n#include <normal_fragment_maps>",
  };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /attribute vec3 col/);
  assert.match(shader.vertexShader, /vHatStitchColor = col/);
  assert.match(shader.vertexShader, /mat3\(/);
  assert.match(shader.fragmentShader, /diffuseColor\.rgb = max\(vHatStitchColor/);
  assert.match(shader.fragmentShader, /hatStitchWaveHeight/);
  assert.match(shader.fragmentShader, /dFdx\(vHatStitchGenerated\)/);
  assert.match(shader.fragmentShader, /hatStitchPerturbed/);

  material?.dispose();
  geometry.dispose();
});

test("does not claim the related sitch material without its authored FACE color branch", () => {
  assert.equal(extractHatStitchMaterialConfig(dump, "sitch"), null);
});
