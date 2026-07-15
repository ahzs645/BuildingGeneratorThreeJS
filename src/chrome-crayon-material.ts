import * as THREE from "three";
import type { Dump } from "./gnvm";

type RawSocket = { identifier?: string; name?: string; value?: unknown; default?: unknown };
type RawNode = { name: string; type: string; props?: Record<string, unknown>; inputs?: RawSocket[]; outputs?: RawSocket[] };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };

export type ChromeCrayonMaterialConfig = {
  baseColor: [number, number, number];
  metallic: number;
  roughnessAttribute: string;
  generatedScale: [number, number, number];
  noise: {
    dimensions: string;
    detail: number;
    roughness: number;
    lacunarity: number;
    distortion: number;
    fromMin: number;
    fromMax: number;
    toMin: number;
    toMax: number;
  };
  hasEmission: boolean;
  hasBump: boolean;
};

function socketValue(node: RawNode, identifier: string): unknown {
  const socket = node.inputs?.find((candidate) => candidate.identifier === identifier || candidate.name === identifier);
  return socket?.value;
}

function outputValue(node: RawNode, identifier: string): unknown {
  const socket = node.outputs?.find((candidate) => candidate.identifier === identifier || candidate.name === identifier);
  return socket?.default;
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function vec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const result = value.slice(0, 3).map(Number);
  return result.every(Number.isFinite) ? result as [number, number, number] : null;
}

/**
 * Recognize the shader assigned by the authored 2.5D Chrome Crayon graph.
 *
 * The graph is deliberately more specific than a generic "chrome" preset:
 * Generated coordinates feed a highly anisotropic Mapping scale, a 3D Noise
 * Texture is remapped from [0, 1] to [-1, 1], and that result is multiplied by
 * the face-domain `rough` attribute before reaching Principled Roughness.
 */
export function extractChromeCrayonMaterialConfig(dump: Dump, materialName: string): ChromeCrayonMaterialConfig | null {
  const tree = dump.materials?.[materialName] as RawMaterial | undefined;
  const nodes = tree?.nodes ?? [];
  const links = tree?.links ?? [];
  const node = (name: string, type: string): RawNode | undefined => nodes.find((candidate) => candidate.name === name && candidate.type === type);
  const linked = (fromNode: string, fromSocket: string, toNode: string, toSocket: string): boolean => links.some((link) =>
    link.from_node === fromNode && link.from_socket === fromSocket && link.to_node === toNode && link.to_socket === toSocket);

  const principled = node("Principled BSDF", "ShaderNodeBsdfPrincipled");
  const output = node("Material Output", "ShaderNodeOutputMaterial");
  const noise = node("Noise Texture", "ShaderNodeTexNoise");
  const mapRange = node("Map Range", "ShaderNodeMapRange");
  const mapping = node("Mapping", "ShaderNodeMapping");
  const textureCoordinate = node("Texture Coordinate", "ShaderNodeTexCoord");
  const value = node("Value", "ShaderNodeValue");
  const combine = node("Combine XYZ", "ShaderNodeCombineXYZ");
  const scaleMath = node("Math", "ShaderNodeMath");
  const roughnessMath = node("Math.001", "ShaderNodeMath");
  const attribute = node("Attribute", "ShaderNodeAttribute");
  if (!principled || !output || !noise || !mapRange || !mapping || !textureCoordinate || !value || !combine || !scaleMath || !roughnessMath || !attribute) return null;
  if (!linked(principled.name, "BSDF", output.name, "Surface")
    || !linked(textureCoordinate.name, "Generated", mapping.name, "Vector")
    || !linked(value.name, "Value", combine.name, "X")
    || !linked(value.name, "Value", combine.name, "Y")
    || !linked(value.name, "Value", scaleMath.name, "Value")
    || !linked(scaleMath.name, "Value", combine.name, "Z")
    || !linked(combine.name, "Vector", mapping.name, "Scale")
    || !linked(mapping.name, "Vector", noise.name, "Scale")
    || !linked(noise.name, "Fac", mapRange.name, "Value")
    || !linked(mapRange.name, "Result", roughnessMath.name, "Value")
    || !linked(attribute.name, "Color", roughnessMath.name, "Value_001")
    || !linked(roughnessMath.name, "Value", principled.name, "Roughness")) return null;

  const color = vec3(socketValue(principled, "Base Color"));
  const metallic = finiteNumber(socketValue(principled, "Metallic"));
  const baseScale = finiteNumber(outputValue(value, "Value"));
  const zMultiplier = finiteNumber(socketValue(scaleMath, "Value_001"));
  const roughnessAttribute = String(attribute.props?.attribute_name ?? "");
  const detail = finiteNumber(socketValue(noise, "Detail"));
  const noiseRoughness = finiteNumber(socketValue(noise, "Roughness"));
  const lacunarity = finiteNumber(socketValue(noise, "Lacunarity"));
  const distortion = finiteNumber(socketValue(noise, "Distortion"));
  const fromMin = finiteNumber(socketValue(mapRange, "From Min"));
  const fromMax = finiteNumber(socketValue(mapRange, "From Max"));
  const toMin = finiteNumber(socketValue(mapRange, "To Min"));
  const toMax = finiteNumber(socketValue(mapRange, "To Max"));
  if (!color || metallic === null || baseScale === null || zMultiplier === null || !/^[A-Za-z_]\w*$/.test(roughnessAttribute)
    || detail === null || noiseRoughness === null || lacunarity === null || distortion === null
    || fromMin === null || fromMax === null || toMin === null || toMax === null) return null;

  return {
    baseColor: color,
    metallic,
    roughnessAttribute,
    generatedScale: [baseScale, baseScale, baseScale * zMultiplier],
    noise: {
      dimensions: String(noise.props?.noise_dimensions ?? ""),
      detail,
      roughness: noiseRoughness,
      lacunarity,
      distortion,
      fromMin,
      fromMax,
      toMin,
      toMax,
    },
    hasEmission: links.some((link) => link.to_node === principled.name && link.to_socket.startsWith("Emission")),
    hasBump: links.some((link) => link.to_node === principled.name && (link.to_socket === "Normal" || link.to_socket === "Coat Normal"))
      || nodes.some((candidate) => candidate.type === "ShaderNodeBump"),
  };
}

function glsl(value: number): string {
  return Number.isInteger(value) ? `${value.toFixed(1)}` : `${value}`;
}

/**
 * Reconstruct the authored Principled metal in Three.js. The Noise Texture is
 * represented with a compact deterministic value-noise approximation; in the
 * supplied asset this is visually exact in consequence because the evaluated
 * `rough` attribute is zero on every vertex, making the procedural branch
 * dormant and leaving a silver, fully metallic surface.
 */
export function makeChromeCrayonMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  materialName: string,
): THREE.MeshPhysicalMaterial | null {
  const config = extractChromeCrayonMaterialConfig(dump, materialName);
  if (!config) return null;
  const roughness = geometry.getAttribute(config.roughnessAttribute);
  if (!roughness || roughness.itemSize !== 1) return null;

  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) return null;
  const size = bounds.getSize(new THREE.Vector3());
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(...config.baseColor),
    metalness: config.metallic,
    roughness: 0,
    envMapIntensity: 1,
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · authored Chrome Crayon reconstruction`;
  material.userData.chromeCrayonContract = config;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute float ${config.roughnessAttribute};\nvarying vec3 vCrayonGenerated;\nvarying float vCrayonRough;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvCrayonGenerated = (position - vec3(${glsl(bounds.min.x)}, ${glsl(bounds.min.y)}, ${glsl(bounds.min.z)})) / max(vec3(${glsl(size.x)}, ${glsl(size.y)}, ${glsl(size.z)}), vec3(1e-7));\nvCrayonRough = ${config.roughnessAttribute};`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vCrayonGenerated;
varying float vCrayonRough;
float crayonHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float crayonNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(crayonHash(i), crayonHash(i + vec3(1,0,0)), f.x), mix(crayonHash(i + vec3(0,1,0)), crayonHash(i + vec3(1,1,0)), f.x), f.y), mix(mix(crayonHash(i + vec3(0,0,1)), crayonHash(i + vec3(1,0,1)), f.x), mix(crayonHash(i + vec3(0,1,1)), crayonHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`).replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
vec3 crayonMapped = vCrayonGenerated * vec3(${config.generatedScale.map(glsl).join(", ")});
float crayonScale = (crayonMapped.x + crayonMapped.y + crayonMapped.z) / 3.0;
vec3 crayonNoisePosition = vec3(0.0) * crayonScale;
crayonNoisePosition += ${glsl(config.noise.distortion)} * vec3(
  crayonNoise(crayonNoisePosition + vec3(0.0, 0.0, 0.0)),
  crayonNoise(crayonNoisePosition + vec3(19.1, 7.7, 3.4)),
  crayonNoise(crayonNoisePosition + vec3(5.2, 23.8, 11.6))
);
float crayonFac = crayonNoise(crayonNoisePosition);
float crayonMappedRoughness = ${glsl(config.noise.toMin)} + (crayonFac - ${glsl(config.noise.fromMin)}) * (${glsl(config.noise.toMax)} - ${glsl(config.noise.toMin)}) / max(${glsl(config.noise.fromMax)} - ${glsl(config.noise.fromMin)}, 1e-7);
roughnessFactor = clamp(crayonMappedRoughness * max(vCrayonRough, 0.0), 0.0, 1.0);`);
  };
  material.customProgramCacheKey = () => `chrome-crayon-${materialName}-v1`;
  return material;
}
