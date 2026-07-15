import * as THREE from "three";
import type { Dump } from "./gnvm";

type RawNode = { name: string; type: string; props?: Record<string, unknown> };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };

export type AttributePrincipledConfig = {
  colorAttribute: string;
  roughnessAttribute: string;
  metalnessAttribute: string;
};

function attributeFor(nodes: RawNode[], links: RawLink[], principled: RawNode, socket: string): string | null {
  const link = links.find((candidate) => candidate.to_node === principled.name && candidate.to_socket === socket);
  if (!link) return null;
  const source = nodes.find((node) => node.name === link.from_node && node.type === "ShaderNodeAttribute");
  const name = String(source?.props?.attribute_name ?? "");
  return /^[A-Za-z_]\w*$/.test(name) ? name : null;
}

/** Recognize the Chrome Asset Library's named-attribute Principled contract. */
export function extractAttributePrincipledConfig(dump: Dump, materialName: string): AttributePrincipledConfig | null {
  const tree = dump.materials?.[materialName] as RawMaterial | undefined;
  const nodes = tree?.nodes ?? [];
  const links = tree?.links ?? [];
  const output = nodes.find((node) => node.type === "ShaderNodeOutputMaterial" && node.props?.is_active_output === true)
    ?? nodes.find((node) => node.type === "ShaderNodeOutputMaterial");
  const surface = output ? links.find((link) => link.to_node === output.name && link.to_socket === "Surface") : undefined;
  const principled = nodes.find((node) => node.name === surface?.from_node && node.type === "ShaderNodeBsdfPrincipled");
  if (!principled) return null;

  const colorAttribute = attributeFor(nodes, links, principled, "Base Color");
  const roughnessAttribute = attributeFor(nodes, links, principled, "Roughness");
  const metalnessAttribute = attributeFor(nodes, links, principled, "Metallic");
  if (!colorAttribute || !roughnessAttribute || !metalnessAttribute) return null;
  return { colorAttribute, roughnessAttribute, metalnessAttribute };
}

export function makeAttributePrincipledMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  materialName: string,
): THREE.MeshPhysicalMaterial | null {
  const config = extractAttributePrincipledConfig(dump, materialName);
  if (!config) return null;
  const color = geometry.getAttribute(config.colorAttribute);
  const roughness = geometry.getAttribute(config.roughnessAttribute);
  const metalness = geometry.getAttribute(config.metalnessAttribute);
  if (!color || color.itemSize !== 3 || !roughness || roughness.itemSize !== 1 || !metalness || metalness.itemSize !== 1) return null;

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.5,
    envMapIntensity: 1,
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · attribute Principled reconstruction`;
  material.userData.attributePrincipledContract = config;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute vec3 ${config.colorAttribute};\nattribute float ${config.roughnessAttribute};\nattribute float ${config.metalnessAttribute};\nvarying vec3 vDojoColor;\nvarying float vDojoRoughness;\nvarying float vDojoMetalness;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvDojoColor = ${config.colorAttribute};\nvDojoRoughness = ${config.roughnessAttribute};\nvDojoMetalness = ${config.metalnessAttribute};`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vDojoColor;\nvarying float vDojoRoughness;\nvarying float vDojoMetalness;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = max(vDojoColor, vec3(0.0));")
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = clamp(vDojoRoughness, 0.0, 1.0);")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor = clamp(vDojoMetalness, 0.0, 1.0);");
  };
  material.customProgramCacheKey = () => `attribute-principled-${materialName}-${config.colorAttribute}-${config.roughnessAttribute}-${config.metalnessAttribute}-v1`;
  return material;
}
