import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { extractAttributePrincipledConfig, makeAttributePrincipledMaterial } from "../attribute-principled-material";
import { runGenerator, type Dump } from "../gnvm";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/pixel-marker-003/dump.json",
  import.meta.url,
)), "utf8")) as Dump;

test("reconstructs the 3D Pixel Marker's named-attribute Principled material", async () => {
  assert.deepEqual(extractAttributePrincipledConfig(dump, "gn.bdsf"), {
    colorAttribute: "col",
    roughnessAttribute: "rough",
    metalnessAttribute: "metal",
  });
  assert.equal(extractAttributePrincipledConfig(dump, "flat.nodes"), null);

  const result = await runGenerator(dump, { object: "PIXEL CRAYON.003" });
  assert.deepEqual(result.soup.stats, { verts: 412, faces: 428, tris: 856 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 2568, material: "gn.bdsf" }]);
  for (let offset = 0; offset < result.soup.attributes.col.data.length; offset += 3) {
    assert.deepEqual(Array.from(result.soup.attributes.col.data.slice(offset, offset + 3)), [
      0.9577709436416626,
      1,
      0,
    ]);
  }
  assert.ok(result.soup.attributes.rough.data.every((value) => value === 0.3693181872367859));
  assert.ok(result.soup.attributes.metal.data.every((value) => value === 0));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  for (const [name, attribute] of Object.entries(result.soup.attributes)) {
    geometry.setAttribute(name, new THREE.BufferAttribute(attribute.data, attribute.itemSize));
  }
  const material = makeAttributePrincipledMaterial(dump, geometry, "gn.bdsf");
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material?.name, "gn.bdsf · attribute Principled reconstruction");
  assert.deepEqual(material?.userData.attributePrincipledContract, {
    colorAttribute: "col",
    roughnessAttribute: "rough",
    metalnessAttribute: "metal",
  });

  const shader = {
    vertexShader: "#include <common>\n#include <begin_vertex>",
    fragmentShader: "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <metalnessmap_fragment>",
  };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /attribute vec3 col/);
  assert.match(shader.vertexShader, /attribute float rough/);
  assert.match(shader.fragmentShader, /diffuseColor\.rgb = max\(vDojoColor/);
  assert.match(shader.fragmentShader, /roughnessFactor = clamp\(vDojoRoughness/);
  assert.match(shader.fragmentShader, /metalnessFactor = clamp\(vDojoMetalness/);
  material?.dispose();
  geometry.dispose();
});
