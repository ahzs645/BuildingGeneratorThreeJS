import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { runGenerator, type Dump } from "../gnvm";
import { extractKnitThreadMaterialConfig, makeKnitThreadMaterial } from "../knit-thread-material";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/n03d/print-test-sphere/dump.json",
  import.meta.url,
)), "utf8")) as Dump;
const materialName = "knit thread";

test("extracts the patterned sphere's authored two-wave knit shader", () => {
  const config = extractKnitThreadMaterialConfig(dump, materialName);
  assert.ok(config);
  assert.deepEqual(config.brightColor, [
    0.7999996542930603,
    0.01635864190757272,
    0.05221215263009099,
  ]);
  assert.deepEqual(config.darkColor, [
    0.15999996900556823,
    0.0032717291615553742,
    0.010442433015687647,
  ]);
  assert.equal(config.waveMix, 0.7556818127632141);
  assert.deepEqual(config.waves.map((wave) => wave.direction), ["DIAGONAL", "X"]);
  assert.deepEqual(config.waves.map((wave) => wave.mappingRotation), [
    [0, -0.1500983089208603, 0],
    [0, -0.1500983089208603, -0.9267697930335999],
  ]);
  assert.deepEqual(config.waves.map((wave) => wave.mappingScale), [
    19.510000228881836,
    19.510000228881836,
  ]);
  assert.deepEqual(config.waves.map((wave) => wave.scale), [
    1.3400001525878906,
    1.8600001335144043,
  ]);
  assert.equal(config.bumpStrength, 1);
  assert.equal(config.bumpDistance, 1);
  assert.equal(config.bumpFilterWidth, 1);
  assert.equal(config.bumpInvert, false);
});

test("builds the authored knit shader on the exact GN-VM sphere material group", async () => {
  const result = await runGenerator(dump, { object: "Cube" });
  assert.deepEqual(result.soup.stats, { verts: 32190, faces: 58917, tris: 60369 });
  const group = result.soup.groups.find((candidate) => candidate.material === materialName);
  assert.deepEqual(group, { start: 0, count: 176751, material: materialName });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(result.soup.indices, 1));
  const material = makeKnitThreadMaterial(dump, geometry, group!, materialName);
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material?.name, `${materialName} · procedural knit thread reconstruction`);
  assert.equal(material?.roughness, 0.5);

  const shader = {
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader: "#include <common>\n#include <color_fragment>\n#include <normal_fragment_maps>",
  };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /varying vec3 vKnitGenerated/);
  assert.match(shader.fragmentShader, /knitWave0/);
  assert.match(shader.fragmentShader, /knitWave1/);
  assert.match(shader.fragmentShader, /knitMap/);
  assert.match(shader.fragmentShader, /0\.7556818127632141/);
  assert.match(shader.fragmentShader, /knitPerturbed/);
  material?.dispose();
  geometry.dispose();
});
