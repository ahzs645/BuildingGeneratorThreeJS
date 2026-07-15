import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { extractFilamentMaterialConfig, makeFilamentMaterial } from "../filament-material";
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
    bumpStrength: 0.7392045855522156,
    bumpDistance: 0.9663976430892944,
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
  const material = makeFilamentMaterial(dump, geometry, materialName);
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material?.name, `${materialName} · N03D filament reconstruction`);
  assert.equal(material?.roughness, 0.7732919454574585);

  const shader = {
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader: "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>",
  };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /attribute vec3 col/);
  assert.match(shader.fragmentShader, /filamentBand/);
  assert.match(shader.fragmentShader, /gl_FrontFacing \? filamentFront : filamentBack/);
  assert.match(shader.fragmentShader, /roughnessFactor = clamp/);
  material?.dispose();
  geometry.dispose();
});
