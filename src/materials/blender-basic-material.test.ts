import assert from "node:assert/strict";
import test from "node:test";
import { extractBasicBlenderMaterialConfig, makeBasicBlenderMaterial } from "../blender-basic-material";
import type { Dump } from "../gnvm";

function dumpWith(nodes: unknown[], links: unknown[]): Dump {
  return { node_groups: {}, materials: { Test: { nodes, links } } } as Dump;
}

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
