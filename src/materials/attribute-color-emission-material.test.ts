import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import {
  extractAttributeColorEmissionConfig,
  makeAttributeColorEmissionMaterial,
} from "../attribute-color-emission-material";
import { runGenerator, type Dump } from "../gnvm";

const geometryDump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/course-modules/intro-node-panels/dump.json",
  import.meta.url,
)), "utf8")) as Dump;
const shaderMetadata = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/course-modules/intro-shader-metadata.json",
  import.meta.url,
)), "utf8")) as Dump;
const dump = Object.assign(geometryDump, shaderMetadata);
const materialName = "Attribute Viewer N++";

test("resolves Course Intro's missing Attribute Viewer vector to black emission", async () => {
  assert.deepEqual(extractAttributeColorEmissionConfig(dump, materialName), {
    colorAttribute: "attribute_viewer_n++_",
    attributeOutput: "Vector",
    strength: 1,
  });
  const result = await runGenerator(dump, { object: "Cube.014" });
  assert.deepEqual(result.soup.stats, { verts: 104454, faces: 44423, tris: 108526 });
  assert.ok(!Object.hasOwn(result.soup.attributes, "attribute_viewer_n++_"));
  assert.deepEqual(result.soup.groups.find((group) => group.material === materialName), {
    start: 62979,
    count: 21078,
    material: materialName,
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  const material = makeAttributeColorEmissionMaterial(dump, geometry, materialName);
  assert.ok(material?.isMeshBasicMaterial);
  assert.equal(material?.name, "Attribute Viewer N++ · missing attribute zero emission");
  assert.equal((material as THREE.MeshBasicMaterial).color.getHex(), 0x000000);
  assert.equal(material?.userData.attributeResolution, "missing-zero");
  material?.dispose();
  geometry.dispose();
});

test("renders a present safe Vector attribute and rejects broader emission graphs", () => {
  const source = structuredClone(shaderMetadata.materials?.[materialName]) as any;
  source.nodes.find((node: any) => node.type === "ShaderNodeAttribute").props.attribute_name = "viewer_color";
  const variant = { materials: { viewer: source } } as Dump;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute("viewer_color", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3));
  const material = makeAttributeColorEmissionMaterial(variant, geometry, "viewer");
  assert.ok(material?.isShaderMaterial);
  assert.match((material as THREE.ShaderMaterial).vertexShader, /attribute vec3 viewer_color/);
  assert.match((material as THREE.ShaderMaterial).fragmentShader, /vAttributeEmissionColor/);

  assert.equal(extractAttributeColorEmissionConfig(dump, "emit.002"), null);
  assert.equal(extractAttributeColorEmissionConfig(dump, "flat.nodes"), null);
  material?.dispose();
  geometry.dispose();
});
