import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { extractBasicBlenderMaterialConfig, makeBasicBlenderMaterial, makeBlenderDefaultSurfaceMaterial } from "../blender-basic-material";
import { runGenerator, type Dump } from "../gnvm";

function dumpWith(nodes: unknown[], links: unknown[]): Dump {
  return { node_groups: {}, materials: { Test: { nodes, links } } } as Dump;
}

test("uses Blender's neutral default surface for an unassigned slot", () => {
  const material = makeBlenderDefaultSurfaceMaterial();
  assert.equal(material.name, "Blender unassigned material surface");
  assert.deepEqual(material.color.toArray(), [0.8, 0.8, 0.8]);
  assert.equal(material.metalness, 0);
  assert.equal(material.roughness, 0.5);
  material.dispose();
});

test("follows the active Material Output to a direct Principled shader", () => {
  const dump = dumpWith([
    { name: "Unused", type: "ShaderNodeBsdfPrincipled", inputs: [{ name: "Base Color", value: [1, 0, 0, 1] }] },
    { name: "Principled", type: "ShaderNodeBsdfPrincipled", inputs: [
      { name: "Base Color", value: [0.1, 0.2, 0.3, 1], linked: false },
      { name: "Metallic", value: 0.75, linked: false },
      { name: "Roughness", value: 0.2, linked: true },
      { name: "Alpha", value: 0.6, linked: false },
      { name: "IOR", value: 1.33, linked: false },
      { name: "Transmission Weight", value: 0.4, linked: false },
      { name: "Coat Weight", value: 0.25, linked: false },
      { name: "Coat Roughness", value: 0.1, linked: false },
      { name: "Emission Color", value: [0.4, 0.1, 0, 1], linked: false },
      { name: "Emission Strength", value: 2, linked: false },
    ] },
    { name: "Inactive Output", type: "ShaderNodeOutputMaterial", props: { is_active_output: false } },
    { name: "Output", type: "ShaderNodeOutputMaterial", props: { is_active_output: true } },
  ], [
    { from_node: "Unused", from_socket: "BSDF", from_type: "NodeSocketShader", to_node: "Inactive Output", to_socket: "Surface" },
    { from_node: "Principled", from_socket: "BSDF", from_type: "NodeSocketShader", to_node: "Output", to_socket: "Surface" },
  ]);

  assert.deepEqual(extractBasicBlenderMaterialConfig(dump, "Test"), {
    kind: "principled",
    baseColor: [0.1, 0.2, 0.3],
    metalness: 0.75,
    roughness: 0.2,
    emissive: [0.4, 0.1, 0],
    emissiveIntensity: 2,
    opacity: 0.6,
    ior: 1.33,
    transmission: 0.4,
    clearcoat: 0.25,
    clearcoatRoughness: 0.1,
    linkedInputs: ["Roughness"],
  });

  const material = makeBasicBlenderMaterial(dump, "Test");
  assert.ok(material?.isMeshPhysicalMaterial);
  assert.equal(material?.name, "Test · Blender principled constant approximation");
  assert.equal(material?.metalness, 0.75);
  assert.equal(material?.roughness, 0.2);
  assert.equal(material?.opacity, 0.6);
  assert.equal(material?.transparent, true);
  assert.equal(material?.transmission, 0.4);
  assert.deepEqual(material?.userData.blenderMaterialContract.linkedInputs, ["Roughness"]);
  material?.dispose();
});

test("supports direct Emission and rejects unsupported shader mixes", () => {
  const emission = dumpWith([
    { name: "Emission", type: "ShaderNodeEmission", inputs: [
      { name: "Color", value: [0.2, 0.5, 0.9, 1], linked: false },
      { name: "Strength", value: 3, linked: false },
    ] },
    { name: "Output", type: "ShaderNodeOutputMaterial", props: { is_active_output: true } },
  ], [{ from_node: "Emission", from_socket: "Emission", from_type: "NodeSocketShader", to_node: "Output", to_socket: "Surface" }]);
  assert.equal(extractBasicBlenderMaterialConfig(emission, "Test")?.kind, "emission");
  assert.deepEqual(extractBasicBlenderMaterialConfig(emission, "Test")?.emissive, [0.2, 0.5, 0.9]);

  const mixed = dumpWith([
    { name: "Mix", type: "ShaderNodeMixShader" },
    { name: "Output", type: "ShaderNodeOutputMaterial", props: { is_active_output: true } },
  ], [{ from_node: "Mix", from_socket: "Shader", from_type: "NodeSocketShader", to_node: "Output", to_socket: "Surface" }]);
  assert.equal(extractBasicBlenderMaterialConfig(mixed, "Test"), null);
  assert.equal(makeBasicBlenderMaterial(mixed, "Test"), null);
});

test("reconstructs literal Background material outputs as unlit colors", () => {
  const sidecar = JSON.parse(readFileSync("public/dojo/n03d/shader-metadata.json", "utf8")) as Dump;
  const white = extractBasicBlenderMaterialConfig(sidecar, "flat.w");
  assert.deepEqual(white, {
    kind: "background",
    baseColor: [0.800000011920929, 0.800000011920929, 0.800000011920929],
    metalness: 0,
    roughness: 1,
    emissive: [0.800000011920929, 0.800000011920929, 0.800000011920929],
    emissiveIntensity: 1,
    opacity: 1,
    ior: 1.5,
    transmission: 0,
    clearcoat: 0,
    clearcoatRoughness: 0,
    linkedInputs: [],
  });
  const whiteMaterial = makeBasicBlenderMaterial(sidecar, "flat.w");
  assert.ok(whiteMaterial?.isMeshBasicMaterial);
  assert.equal(whiteMaterial?.side, THREE.DoubleSide);
  assert.equal(whiteMaterial?.toneMapped, true);
  assert.equal(whiteMaterial?.color.r, 0.800000011920929);
  assert.equal(whiteMaterial?.name, "flat.w · Blender background constants");
  whiteMaterial?.dispose();

  const blackMaterial = makeBasicBlenderMaterial(sidecar, "flat.b.001");
  assert.ok(blackMaterial?.isMeshBasicMaterial);
  assert.equal(blackMaterial?.color.getHex(), 0x000000);
  blackMaterial?.dispose();

  const linked = dumpWith([
    { name: "Background", type: "ShaderNodeBackground", inputs: [
      { name: "Color", value: [0.8, 0.8, 0.8, 1], linked: true },
      { name: "Strength", value: 1, linked: false },
    ] },
    { name: "Output", type: "ShaderNodeOutputMaterial", props: { is_active_output: true } },
  ], [{ from_node: "Background", from_socket: "Background", from_type: "NodeSocketShader", to_node: "Output", to_socket: "Surface" }]);
  assert.equal(extractBasicBlenderMaterialConfig(linked, "Test"), null);
  assert.equal(makeBasicBlenderMaterial(linked, "Test"), null);
});

test("reconstructs Print Bed Previewer's supplied missing-image Color surface as black", () => {
  const dump = JSON.parse(readFileSync("public/dojo/n03d/print-bed-previewer/dump.json", "utf8")) as Dump;
  assert.deepEqual(extractBasicBlenderMaterialConfig(dump, "build plate"), {
    kind: "color-surface",
    baseColor: [0, 0, 0],
    metalness: 0,
    roughness: 1,
    emissive: [0, 0, 0],
    emissiveIntensity: 1,
    opacity: 1,
    ior: 1.5,
    transmission: 0,
    clearcoat: 0,
    clearcoatRoughness: 0,
    linkedInputs: ["Image Texture:logo_600x600_crop_center.webp (missing 0x0)"],
  });
  const material = makeBasicBlenderMaterial(dump, "build plate");
  assert.ok(material?.isMeshBasicMaterial);
  assert.equal(material?.color.getHex(), 0x000000);
  assert.equal(material?.name, "build plate · Blender missing-image color surface");
  material?.dispose();
});

test("reconstructs 3D Chrome Grill Crayon's direct Principled metal", () => {
  const dump = JSON.parse(readFileSync("public/dojo/chrome-assets/geometry-nodes-001/dump.json", "utf8")) as Dump;
  assert.deepEqual(extractBasicBlenderMaterialConfig(dump, "chrome"), {
    kind: "principled",
    baseColor: [0.2508697211742401, 0.2508697211742401, 0.2508697211742401],
    metalness: 1,
    roughness: 0.26104414463043213,
    emissive: [1, 1, 1],
    emissiveIntensity: 0,
    opacity: 1,
    ior: 1.5,
    transmission: 0,
    clearcoat: 0,
    clearcoatRoughness: 0.029999999329447746,
    linkedInputs: [],
  });
  const material = makeBasicBlenderMaterial(dump, "chrome");
  assert.equal(material?.name, "chrome · Blender principled constants");
  assert.equal(material?.metalness, 1);
  assert.equal(material?.roughness, 0.26104414463043213);
  assert.deepEqual(material?.color.toArray(), [0.2508697211742401, 0.2508697211742401, 0.2508697211742401]);
  material?.dispose();
});

test("renders Spikey Chain Link with Blender's unassigned default surface", async () => {
  const dump = JSON.parse(readFileSync("public/dojo/chrome-assets/chain-link-spikey/dump.json", "utf8")) as Dump;
  const result = await runGenerator(dump, { object: "spikey link" });
  assert.deepEqual(result.soup.stats, { verts: 2867, faces: 5376, tris: 5376 });
  assert.deepEqual(result.soup.groups, [{ start: 0, count: 16128, material: null }]);
  assert.deepEqual(result.soup.attributes, {});

  const material = makeBlenderDefaultSurfaceMaterial();
  assert.equal(material.name, "Blender unassigned material surface");
  assert.deepEqual(material.color.toArray(), [0.8, 0.8, 0.8]);
  assert.equal(material.metalness, 0);
  assert.equal(material.roughness, 0.5);
  material.dispose();
});

test("routes the exact N03D print-test surface through flat.w", async () => {
  const dump = JSON.parse(readFileSync("public/dojo/n03d/print-test-mesh/dump.json", "utf8")) as Dump;
  const result = await runGenerator(dump, { object: "print test mesh" });
  assert.equal(result.soup.stats.verts, 16751);
  assert.equal(result.soup.stats.faces, 9065);
  assert.deepEqual(result.soup.groups.map((group) => ({ material: group.material, count: group.count })), [
    { material: "flat.w", count: 53760 },
    { material: "filament .02 mm.002", count: 600 },
  ]);
});
