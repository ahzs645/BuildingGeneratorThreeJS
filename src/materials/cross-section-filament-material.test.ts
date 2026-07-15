import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { extractCrossSectionFilamentConfig, makeCrossSectionFilamentMaterial } from "../cross-section-filament-material";
import { runGenerator, type Dump } from "../gnvm";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/joints/three-way-pipe/dump.json",
  import.meta.url,
)), "utf8")) as Dump;
const mathDump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/math-clay/dump.json",
  import.meta.url,
)), "utf8")) as Dump;
const materialName = "Filament and Cross Section 1OCT2024";

test("reconstructs the joint library's evaluated filament fields", async () => {
  assert.deepEqual(extractCrossSectionFilamentConfig(dump, materialName), {
    colorAttribute: "col",
    roughnessAttribute: "rough",
    roughnessFallback: 0.5,
    layerAttribute: "layer",
    blackBackfaceEmission: true,
    mappingScale: 85.09765625,
    waveDistortion: 0.8557739853858948,
    bumpMin: 0.98974609375,
    bumpMax: 1.126708984375,
  });
  const result = await runGenerator(dump, { object: "old pipe" });
  assert.deepEqual(result.soup.stats, { verts: 48708, faces: 48318, tris: 97008 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 291024, material: materialName }]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  for (const [name, attribute] of Object.entries(result.soup.attributes)) geometry.setAttribute(name, new THREE.BufferAttribute(attribute.data, attribute.itemSize));
  const material = makeCrossSectionFilamentMaterial(dump, geometry, materialName);
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material?.name, `${materialName} · joint filament reconstruction`);
  const shader = { vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <opaque_fragment>" };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /attribute vec3 col/);
  assert.match(shader.fragmentShader, /gl_FrontFacing\?max\(vJointColor/);
  assert.match(shader.fragmentShader, /if\(!gl_FrontFacing\)outgoingLight=vec3\(0\.0\)/);
  assert.match(shader.fragmentShader, /vJointRoughness/);
  assert.doesNotMatch(shader.fragmentShader, /jointBand|mix\(0\.94,1\.04/);
  material?.dispose();
  geometry.dispose();
});

test("uses a constant roughness fallback when a variant omits the rough field", () => {
  const source = dump.materials?.[materialName] as any;
  const roughNode = source.nodes.find((node: any) => node.type === "ShaderNodeAttribute" && node.props?.attribute_name === "rough");
  const variant = {
    node_groups: {},
    materials: {
      [materialName]: {
        nodes: source.nodes.filter((node: any) => node !== roughNode),
        links: source.links.filter((link: any) => link.from_node !== roughNode.name),
      },
    },
  } as Dump;
  assert.equal(extractCrossSectionFilamentConfig(variant, materialName)?.roughnessAttribute, null);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 1], 3));
  geometry.setAttribute("col", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3));
  geometry.setAttribute("layer", new THREE.Float32BufferAttribute([1.2, 1.2, 1.2], 1));
  const material = makeCrossSectionFilamentMaterial(variant, geometry, materialName);
  assert.ok(material?.isMeshPhysicalMaterial);
  const shader = { vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <opaque_fragment>" };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.doesNotMatch(shader.vertexShader, /attribute float rough/);
  assert.match(shader.vertexShader, /vJointRoughness=0.5/);
  material?.dispose();
  geometry.dispose();
});

test("reconstructs Math Clay's authored black backface emission branch", async () => {
  const config = extractCrossSectionFilamentConfig(mathDump, materialName);
  assert.equal(config?.blackBackfaceEmission, true);
  assert.equal(config?.roughnessAttribute, null);
  assert.equal(config?.roughnessFallback, 0.5);

  const result = await runGenerator(mathDump, { object: "Math Clay Study.002" });
  assert.deepEqual(result.soup.stats, { verts: 30644, faces: 30642, tris: 61284 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 183852, material: materialName }]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(result.soup.positions, 3));
  for (const [name, attribute] of Object.entries(result.soup.attributes)) geometry.setAttribute(name, new THREE.BufferAttribute(attribute.data, attribute.itemSize));
  const material = makeCrossSectionFilamentMaterial(mathDump, geometry, materialName);
  assert.ok(material?.isMeshPhysicalMaterial);
  const shader = { vertexShader: "#include <common>\n#include <begin_vertex>", fragmentShader: "#include <common>\n#include <color_fragment>\n#include <roughnessmap_fragment>\n#include <opaque_fragment>" };
  material?.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.fragmentShader, /diffuseColor\.rgb=gl_FrontFacing\?max\(vJointColor,vec3\(0\.0\)\):vec3\(0\.0\)/);
  assert.match(shader.fragmentShader, /roughnessFactor=clamp\(vJointRoughness,0\.0,1\.0\)/);
  assert.doesNotMatch(shader.fragmentShader, /jointBand|vJointGenerated|vJointLayer/);

  const physicalShader = {
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  };
  material?.onBeforeCompile(physicalShader as never, {} as never);
  assert.equal((physicalShader.fragmentShader.match(/if\(!gl_FrontFacing\)outgoingLight=vec3\(0\.0\)/g) ?? []).length, 1);
  assert.match(physicalShader.fragmentShader, /if\(!gl_FrontFacing\)outgoingLight=vec3\(0\.0\);\n#include <opaque_fragment>/);
  material?.dispose();
  geometry.dispose();
});
