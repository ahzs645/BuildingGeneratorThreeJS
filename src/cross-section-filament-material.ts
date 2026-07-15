import * as THREE from "three";
import type { Dump } from "./gnvm";

type RawSocket = { identifier?: string; name?: string; value?: unknown; default?: unknown };
type RawNode = { name: string; type: string; props?: Record<string, unknown>; inputs?: RawSocket[]; outputs?: RawSocket[] };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };

export type CrossSectionFilamentConfig = {
  colorAttribute: string;
  roughnessAttribute: string;
  layerAttribute: string;
  mappingScale: number;
  waveDistortion: number;
  bumpMin: number;
  bumpMax: number;
};

function input(node: RawNode | undefined, name: string, fallback: number): number {
  const value = Number(node?.inputs?.find((socket) => socket.identifier === name || socket.name === name)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function output(node: RawNode | undefined, name: string, fallback: number): number {
  const value = Number(node?.outputs?.find((socket) => socket.identifier === name || socket.name === name)?.default);
  return Number.isFinite(value) ? value : fallback;
}

function attribute(nodes: RawNode[], name: string): RawNode | undefined {
  return nodes.find((node) => node.type === "ShaderNodeAttribute" && node.props?.attribute_name === name);
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
  if (!surfaceMix || !principled || !colorLink || !roughnessLink || !layerLink || !mappingNode || !scaleNode) return null;

  return {
    colorAttribute: "col",
    roughnessAttribute: "rough",
    layerAttribute: "layer",
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
  const roughness = geometry.getAttribute(config.roughnessAttribute);
  const layer = geometry.getAttribute(config.layerAttribute);
  if (!color || color.itemSize !== 3 || !roughness || roughness.itemSize !== 1 || !layer || layer.itemSize !== 1) return null;
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) return null;
  const size = bounds.getSize(new THREE.Vector3());

  const material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.5, envMapIntensity: 0.8, side: THREE.DoubleSide });
  material.name = `${materialName} · joint filament reconstruction`;
  material.userData.crossSectionFilamentContract = config;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute vec3 ${config.colorAttribute};\nattribute float ${config.roughnessAttribute};\nattribute float ${config.layerAttribute};\nvarying vec3 vJointColor;\nvarying float vJointRoughness;\nvarying float vJointLayer;\nvarying vec3 vJointGenerated;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvJointColor=${config.colorAttribute};\nvJointRoughness=${config.roughnessAttribute};\nvJointLayer=${config.layerAttribute};\nvJointGenerated=(position-vec3(${glsl(bounds.min.x)},${glsl(bounds.min.y)},${glsl(bounds.min.z)}))/max(vec3(${glsl(size.x)},${glsl(size.y)},${glsl(size.z)}),vec3(1e-7));`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vJointColor;\nvarying float vJointRoughness;\nvarying float vJointLayer;\nvarying vec3 vJointGenerated;")
      .replace("#include <color_fragment>", `#include <color_fragment>
float jointBand=0.5+0.5*sin(vJointGenerated.z*max(vJointLayer,0.0)*${glsl(config.mappingScale)}*6.28318530718);
diffuseColor.rgb=max(vJointColor,vec3(0.0))*mix(0.94,1.04,jointBand);`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\nroughnessFactor=clamp(vJointRoughness+(jointBand-0.5)*${glsl((config.bumpMax - config.bumpMin) * 0.2)},0.0,1.0);`);
  };
  material.customProgramCacheKey = () => `joint-filament-${materialName}-v1`;
  return material;
}
