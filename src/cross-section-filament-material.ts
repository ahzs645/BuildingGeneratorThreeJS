import * as THREE from "three";
import type { Dump } from "./gnvm";

type RawSocket = { identifier?: string; name?: string; value?: unknown; default?: unknown };
type RawNode = { name: string; type: string; props?: Record<string, unknown>; inputs?: RawSocket[]; outputs?: RawSocket[] };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };

export type CrossSectionFilamentConfig = {
  colorAttribute: string;
  roughnessAttribute: string | null;
  roughnessFallback: number;
  layerAttribute: string;
  blackBackfaceEmission: boolean;
  mappingScale: number;
  waveDistortion: number;
  bumpMin: number;
  bumpMax: number;
};

function input(node: RawNode | undefined, name: string, fallback: number): number {
  const raw = node?.inputs?.find((socket) => socket.identifier === name || socket.name === name)?.value;
  if (raw === null || raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function output(node: RawNode | undefined, name: string, fallback: number): number {
  const raw = node?.outputs?.find((socket) => socket.identifier === name || socket.name === name)?.default;
  if (raw === null || raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function attribute(nodes: RawNode[], name: string): RawNode | undefined {
  return nodes.find((node) => node.type === "ShaderNodeAttribute" && node.props?.attribute_name === name);
}

function colorInput(node: RawNode | undefined, identifier: string): number[] | null {
  const raw = node?.inputs?.find((socket) => socket.identifier === identifier)?.value;
  return Array.isArray(raw) ? raw.map(Number) : null;
}

/** Recognize the joint library's filament + cross-section material contract. */
export function extractCrossSectionFilamentConfig(dump: Dump, materialName: string): CrossSectionFilamentConfig | null {
  const tree = dump.materials?.[materialName] as RawMaterial | undefined;
  const nodes = tree?.nodes ?? [];
  const links = tree?.links ?? [];
  const outputNode = nodes.find((node) => node.type === "ShaderNodeOutputMaterial" && node.props?.is_active_output === true)
    ?? nodes.find((node) => node.type === "ShaderNodeOutputMaterial");
  const surface = outputNode ? links.find((link) => link.to_node === outputNode.name && link.to_socket === "Surface") : undefined;
  const surfaceMix = nodes.find((node) => node.name === surface?.from_node && node.type === "ShaderNodeMixShader");
  const principled = nodes.find((node) => node.type === "ShaderNodeBsdfPrincipled");
  const colorNode = attribute(nodes, "col");
  const roughnessNode = attribute(nodes, "rough");
  const layerNode = attribute(nodes, "layer");
  const wave = nodes.find((node) => node.type === "ShaderNodeTexWave" && node.props?.wave_type === "BANDS" && node.props?.bands_direction === "Z");
  const mapping = wave ? links.find((link) => link.to_node === wave.name && link.to_socket === "Vector") : undefined;
  const mappingNode = nodes.find((node) => node.name === mapping?.from_node && node.type === "ShaderNodeMapping");
  const scaleLink = mappingNode ? links.find((link) => link.to_node === mappingNode.name && link.to_socket === "Scale") : undefined;
  const scaleNode = nodes.find((node) => node.name === scaleLink?.from_node && node.type === "ShaderNodeValue");
  const mapRange = nodes.find((node) => node.type === "ShaderNodeMapRange"
    && links.some((link) => link.from_node === node.name && links.some((next) => next.from_node === link.to_node && next.to_node === principled?.name && next.to_socket === "Normal")));
  const colorLink = principled ? links.find((link) => link.from_node === colorNode?.name && link.to_node === principled.name && link.to_socket === "Base Color") : undefined;
  const roughnessLink = principled ? links.find((link) => link.from_node === roughnessNode?.name && link.to_node === principled.name && link.to_socket === "Roughness") : undefined;
  const layerLink = wave ? links.find((link) => link.from_node === layerNode?.name && link.to_node === wave.name && link.to_socket === "Scale") : undefined;
  const backfaceMix = nodes.find((node) => node.type === "ShaderNodeMixShader" && links.some((link) => {
    if (link.to_node !== node.name || link.to_socket !== "Fac" || link.from_socket !== "Backfacing") return false;
    return nodes.some((candidate) => candidate.name === link.from_node && candidate.type === "ShaderNodeNewGeometry");
  }));
  const frontShader = backfaceMix ? links.find((link) => link.to_node === backfaceMix.name && link.to_socket === "Shader") : undefined;
  const backShader = backfaceMix ? links.find((link) => link.to_node === backfaceMix.name && link.to_socket === "Shader_001") : undefined;
  const backEmission = nodes.find((node) => node.name === backShader?.from_node && node.type === "ShaderNodeEmission");
  const emissionColor = backEmission ? links.find((link) => link.to_node === backEmission.name && link.to_socket === "Color") : undefined;
  const emissionMix = nodes.find((node) => node.name === emissionColor?.from_node && node.type === "ShaderNodeMix");
  const blackColor = colorInput(emissionMix, "B_Color");
  const blackBackfaceEmission = frontShader?.from_node === principled?.name
    && blackColor !== null
    && blackColor.slice(0, 3).every((component) => component === 0);
  if (!surfaceMix || !principled || !colorLink || !layerLink || !mappingNode || !scaleNode || !blackBackfaceEmission) return null;

  return {
    colorAttribute: "col",
    roughnessAttribute: roughnessLink ? "rough" : null,
    roughnessFallback: input(principled, "Roughness", 0.5),
    layerAttribute: "layer",
    blackBackfaceEmission,
    mappingScale: output(scaleNode, "Value", 85),
    waveDistortion: input(wave, "Distortion", 0),
    bumpMin: input(mapRange, "To Min", 0.99),
    bumpMax: input(mapRange, "To Max", 1.13),
  };
}

function glsl(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

export function makeCrossSectionFilamentMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  materialName: string,
): THREE.MeshPhysicalMaterial | null {
  const config = extractCrossSectionFilamentConfig(dump, materialName);
  if (!config) return null;
  const color = geometry.getAttribute(config.colorAttribute);
  const roughness = config.roughnessAttribute ? geometry.getAttribute(config.roughnessAttribute) : null;
  const layer = geometry.getAttribute(config.layerAttribute);
  if (!color || color.itemSize !== 3 || (config.roughnessAttribute && (!roughness || roughness.itemSize !== 1)) || !layer || layer.itemSize !== 1) return null;

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: THREE.MathUtils.clamp(config.roughnessFallback, 0, 1),
    envMapIntensity: 0.8,
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · joint filament reconstruction`;
  material.userData.crossSectionFilamentContract = config;
  material.onBeforeCompile = (shader) => {
    const roughnessDeclaration = config.roughnessAttribute ? `attribute float ${config.roughnessAttribute};` : "";
    const roughnessValue = config.roughnessAttribute ?? glsl(config.roughnessFallback);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute vec3 ${config.colorAttribute};\n${roughnessDeclaration}\nvarying vec3 vJointColor;\nvarying float vJointRoughness;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvJointColor=${config.colorAttribute};\nvJointRoughness=${roughnessValue};`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vJointColor;\nvarying float vJointRoughness;")
      .replace("#include <color_fragment>", `#include <color_fragment>
diffuseColor.rgb=gl_FrontFacing?max(vJointColor,vec3(0.0)):vec3(0.0);`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor=clamp(vJointRoughness,0.0,1.0);")
      .replace("#include <opaque_fragment>", "if(!gl_FrontFacing)outgoingLight=vec3(0.0);\n#include <opaque_fragment>");
  };
  material.customProgramCacheKey = () => `joint-filament-${materialName}-v2`;
  return material;
}
