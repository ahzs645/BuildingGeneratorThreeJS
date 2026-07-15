import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { runGenerator, type Dump } from "../gnvm";
import {
  expandFaceDomainMaterialAttributes,
  extractImagePixelStipplerConfig,
  makeImagePixelStipplerMaterial,
} from "../image-pixel-stippler-material";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/img-pixel-stippler/dump.json",
  import.meta.url,
)), "utf8")) as Dump;

test("extracts the authored Image Pixel Stippler shader contract", () => {
  assert.deepEqual(extractImagePixelStipplerConfig(dump, "img stippler shader.001"), {
    imageAttribute: "img",
    densityAttribute: "dens",
    randomnessAttribute: "grid",
    rotation: [0, 0, 2.159372329711914],
    scale: [1, 1.414306640625, 1],
    thresholdMin: 0.9615478515625,
    thresholdMax: -0.2576904296875,
    clampThreshold: true,
  });
  assert.equal(extractImagePixelStipplerConfig(dump, "img"), null);
});

test("exports and wires img, dens, and grid attributes on the exact authored mesh", async () => {
  const result = await runGenerator(dump, { object: "IMG PIXEL STIPPLER", overrides: {} });
  assert.deepEqual(result.soup.stats, { verts: 72094, faces: 71550, tris: 143100 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 429300, material: "img stippler shader.001" }]);
  assert.deepEqual(Object.fromEntries(Object.entries(result.soup.attributes).map(([name, attribute]) => [name, attribute.itemSize])), {
    grid: 1,
    dens: 1,
    img: 3,
  });
  assert.equal(result.soup.attributes.dens.data[0], 333);
  assert.ok(Math.abs(result.soup.attributes.grid.data[0] - 0.4826087951660156) < 1e-7);
  assert.ok(result.soup.attributes.img.data.some((value) => value > 0.99));
  assert.equal(result.soup.attributes.img.domain, "FACE");
  assert.equal(result.soup.attributes.img.domainData?.length, result.soup.stats.faces * 3);
  assert.equal(result.soup.triangleFaces?.length, result.soup.stats.tris);

  let geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  for (const [name, attribute] of Object.entries(result.soup.attributes)) {
    geometry.setAttribute(name, new THREE.BufferAttribute(attribute.data, attribute.itemSize));
  }
  geometry.setIndex(new THREE.BufferAttribute(result.soup.indices, 1));
  const expanded = expandFaceDomainMaterialAttributes(geometry, result.soup);
  assert.notEqual(expanded, geometry);
  geometry.dispose();
  geometry = expanded;
  assert.equal(geometry.index, null);
  assert.equal(geometry.getAttribute("img").count, result.soup.indices.length);
  const flatImage = geometry.getAttribute("img");
  for (let triangle = 0; triangle < Math.min(result.soup.stats.tris, 100); triangle++) {
    for (let component = 0; component < 3; component++) {
      assert.equal(flatImage.array[triangle * 9 + component], flatImage.array[triangle * 9 + 3 + component]);
      assert.equal(flatImage.array[triangle * 9 + component], flatImage.array[triangle * 9 + 6 + component]);
    }
  }
  const material = makeImagePixelStipplerMaterial(dump, geometry, "img stippler shader.001");
  assert.ok(material?.isShaderMaterial);
  assert.equal(material?.name, "Image Pixel Stippler · WebGL reconstruction");
  assert.equal(material?.glslVersion, THREE.GLSL3);
  assert.match(material?.fragmentShader ?? "", /1664525u/);
  assert.match(material?.fragmentShader ?? "", /cell \+ hash3\(base \+ cell\) \* clamp\(randomness/);
  assert.match(material?.vertexShader ?? "", /generatedSize\.z < 1e-8\) vGenerated\.z = 0\.5/);
  assert.deepEqual(material?.uniforms.mappingScale.value.toArray(), [1, 1.414306640625, 1]);
  geometry.dispose();
  material?.dispose();
});
