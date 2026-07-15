import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { extractFilamentMaterialConfig, filamentGroupBounds, filamentWaveHeightAtGenerated, makeFilamentMaterial } from "../filament-material";
import { runGenerator, type Dump } from "../gnvm";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/n03d/clevis-pin/dump.json",
  import.meta.url,
)), "utf8")) as Dump;
const materialName = "Filament PLA .02 mm layer height";

test("extracts and renders the shared N03D filament shader contract", async () => {
  assert.deepEqual(extractFilamentMaterialConfig(dump, materialName), {
    colorAttribute: "col",
    roughness: 0.7732919454574585,
    layerScale: -56.31793212890625,
    layerDistortion: 0.8557739853858948,
    layerDetail: 2,
    layerDetailScale: 1,
    layerDetailRoughness: 0.5,
    bumpStrength: 0.7392045855522156,
    bumpDistance: 0.9663976430892944,
    bumpFilterWidth: 1,
    bumpInvert: false,
    darkValue: 0.16399909555912018,
    brightValue: 0.8679997324943542,
  });

  const result = await runGenerator(dump, { object: "CLEVIS PIN" });
  assert.deepEqual(result.soup.stats, { verts: 36390, faces: 34198, tris: 70824 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 212472, material: materialName }]);
  assert.equal(result.soup.attributes.col.itemSize, 3);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  geometry.setAttribute("col", new THREE.BufferAttribute(result.soup.attributes.col.data, 3));
  const material = makeFilamentMaterial(dump, geometry, result.soup.groups[0], materialName);
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material?.name, `${materialName} · N03D filament reconstruction`);
  assert.equal(material?.roughness, 0.7732919454574585);

  const shader = {
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader: "#include <common>\n#include <normal_fragment_maps>\n#include <color_fragment>\n#include <roughnessmap_fragment>",
  };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /attribute vec3 col/);
  assert.match(shader.fragmentShader, /max\(max\(filamentFront\.r/);
  assert.match(shader.fragmentShader, /gl_FrontFacing \? filamentFront : filamentBack/);
  assert.match(shader.fragmentShader, /filamentHash/);
  assert.match(shader.fragmentShader, /dFdx\(vFilamentGenerated\)/);
  assert.match(shader.fragmentShader, /filamentPerturbed/);
  assert.doesNotMatch(shader.fragmentShader, /filamentBand|filamentCross|roughnessFactor = clamp/);
  material?.dispose();
  geometry.dispose();
});

test("uses the current material group's bounds and matches stable Blender wave probes", async () => {
  const [geometryDump, shaderMetadata] = await Promise.all([
    readFile(fileURLToPath(new URL("../../public/dojo/n03d/print-test-mesh/dump.json", import.meta.url)), "utf8"),
    readFile(fileURLToPath(new URL("../../public/dojo/n03d/shader-metadata.json", import.meta.url)), "utf8"),
  ]);
  const printDump = Object.assign(JSON.parse(geometryDump), JSON.parse(shaderMetadata)) as Dump;
  const result = await runGenerator(printDump, { object: "print test mesh" });
  const group = result.soup.groups.find((candidate) => candidate.material === "filament .02 mm.002");
  assert.ok(group);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  geometry.setAttribute("col", new THREE.BufferAttribute(result.soup.attributes.col.data, 3));
  geometry.setIndex(new THREE.BufferAttribute(result.soup.indices, 1));
  assert.deepEqual(filamentGroupBounds(geometry, group), {
    min: [-5.5, -5.5, -5.5],
    max: [5.5, 8.757233619689941, 5.5],
  });
  const config = extractFilamentMaterialConfig(printDump, group.material);
  assert.ok(config);
  assert.equal(config.layerScale, -82.73394775390625);
  assert.equal(config.bumpDistance, 0.5083978176116943);
  const probes: [number[], number][] = [
    [[0.5, 0, 0.5], 0.80078125],
    [[0.74609375, 0, 0.5], 0.787109375],
  ];
  for (const [generated, expected] of probes) {
    assert.ok(Math.abs(filamentWaveHeightAtGenerated(generated, config) - expected) <= 2e-3);
  }
  const material = makeFilamentMaterial(printDump, geometry, group, group.material);
  assert.ok(material);
  assert.deepEqual(material.userData.filamentBounds, filamentGroupBounds(geometry, group));
  material.dispose();
  geometry.dispose();
});
