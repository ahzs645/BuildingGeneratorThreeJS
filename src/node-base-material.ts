import * as THREE from "three";
import {
  filamentBumpGlsl,
  filamentGroupBounds,
  filamentNoiseGlsl,
  filamentSignedNoise3,
  type FilamentBounds,
} from "./filament-material";
import type { Dump } from "./gnvm";

type RawSocket = { identifier?: string; name?: string; linked?: boolean; value?: unknown };
type RawNode = {
  name: string;
  type: string;
  props?: Record<string, unknown>;
  inputs?: RawSocket[];
};
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawTree = { nodes?: RawNode[]; links?: RawLink[] };
type IndexGroup = { start: number; count: number; material: string | null };

export type NodeBaseMaterialConfig = {
  baseColor: [number, number, number];
  metallic: number;
  roughness: number;
  ior: number;
  specularIorLevel: number;
  noiseScale: number;
  noiseDetail: number;
  noiseRoughness: number;
  noiseLacunarity: number;
  noiseNormalize: boolean;
  bumpStrength: number;
  bumpDistance: number;
  bumpFilterWidth: number;
  bumpInvert: boolean;
};

export type SimpleNoiseBumpMaterialConfig = NodeBaseMaterialConfig;

const CONTRACT: NodeBaseMaterialConfig = {
  baseColor: [0, 0, 0],
  metallic: 0,
  roughness: 1,
  ior: 1.4500000476837158,
  specularIorLevel: 0.3062015771865845,
  noiseScale: 500,
  noiseDetail: 2,
  noiseRoughness: 0.5,
  noiseLacunarity: 2,
  noiseNormalize: true,
  bumpStrength: 0.10000000149011612,
  bumpDistance: 1,
  bumpFilterWidth: 1,
  bumpInvert: false,
};

const REQUIRED_NODES: [string, string][] = [
  ["Principled BSDF", "ShaderNodeBsdfPrincipled"],
  ["Material Output", "ShaderNodeOutputMaterial"],
  ["Bump", "ShaderNodeBump"],
  ["Noise Texture", "ShaderNodeTexNoise"],
];

const REQUIRED_LINKS: [string, string, string, string][] = [
  ["Principled BSDF", "BSDF", "Material Output", "Surface"],
  ["Bump", "Normal", "Principled BSDF", "Normal"],
  ["Noise Texture", "Fac", "Bump", "Height"],
];

function input(node: RawNode | undefined, identifier: string): RawSocket | undefined {
  return node?.inputs?.find((socket) => socket.identifier === identifier || socket.name === identifier);
}

function exactNumber(socket: RawSocket | undefined, value: number, linked = false): boolean {
  return socket?.linked === linked && Number(socket.value) === value;
}

function exactVector(socket: RawSocket | undefined, value: readonly number[], linked = false): boolean {
  if (socket?.linked !== linked || !Array.isArray(socket.value)) return false;
  const actual = socket.value as unknown[];
  return value.every((component, axis) => Number(actual[axis]) === component);
}

function exactProps(node: RawNode | undefined, props: Record<string, unknown>): boolean {
  return !!node && Object.entries(props).every(([key, value]) => node.props?.[key] === value);
}

function hasLink(tree: RawTree, [fromNode, fromSocket, toNode, toSocket]: [string, string, string, string]): boolean {
  return (tree.links ?? []).some((link) => link.from_node === fromNode && link.from_socket === fromSocket
    && link.to_node === toNode && link.to_socket === toSocket);
}

/** Recognize only the authored four-node material on the Nodes Node base plate. */
export function extractNodeBaseMaterialConfig(dump: Dump, materialName: string): NodeBaseMaterialConfig | null {
  if (materialName !== "node base.001") return null;
  const tree = dump.materials?.[materialName] as RawTree | undefined;
  if (!tree || tree.nodes?.length !== REQUIRED_NODES.length || tree.links?.length !== REQUIRED_LINKS.length) return null;
  const nodes = new Map(tree.nodes.map((node) => [node.name, node]));
  if (REQUIRED_NODES.some(([name, type]) => nodes.get(name)?.type !== type)
    || REQUIRED_LINKS.some((link) => !hasLink(tree, link))) return null;

  const output = nodes.get("Material Output");
  const principled = nodes.get("Principled BSDF");
  const bump = nodes.get("Bump");
  const noise = nodes.get("Noise Texture");
  if (!exactProps(output, { is_active_output: true })
    || !exactProps(principled, { distribution: "GGX", subsurface_method: "RANDOM_WALK_SKIN" })
    || !exactVector(input(principled, "Base Color"), [...CONTRACT.baseColor, 1])
    || !exactNumber(input(principled, "Metallic"), CONTRACT.metallic)
    || !exactNumber(input(principled, "Roughness"), CONTRACT.roughness)
    || !exactNumber(input(principled, "IOR"), CONTRACT.ior)
    || !exactNumber(input(principled, "Alpha"), 1)
    || input(principled, "Normal")?.linked !== true
    || !exactNumber(input(principled, "Specular IOR Level"), CONTRACT.specularIorLevel)
    || !exactNumber(input(principled, "Transmission Weight"), 0)
    || !exactNumber(input(principled, "Coat Weight"), 0)
    || !exactVector(input(principled, "Emission Color"), [0, 0, 0, 1])
    || !exactNumber(input(principled, "Emission Strength"), 1)
    || !exactProps(noise, { noise_dimensions: "3D", noise_type: "FBM", normalize: CONTRACT.noiseNormalize })
    || !exactVector(input(noise, "Vector"), [0, 0, 0])
    || !exactNumber(input(noise, "W"), 0)
    || !exactNumber(input(noise, "Scale"), CONTRACT.noiseScale)
    || !exactNumber(input(noise, "Detail"), CONTRACT.noiseDetail)
    || !exactNumber(input(noise, "Roughness"), CONTRACT.noiseRoughness)
    || !exactNumber(input(noise, "Lacunarity"), CONTRACT.noiseLacunarity)
    || !exactNumber(input(noise, "Offset"), 0)
    || !exactNumber(input(noise, "Gain"), 1)
    || !exactNumber(input(noise, "Distortion"), 0)
    || !exactProps(bump, { invert: CONTRACT.bumpInvert })
    || !exactNumber(input(bump, "Strength"), CONTRACT.bumpStrength)
    || !exactNumber(input(bump, "Distance"), CONTRACT.bumpDistance)
    || !exactNumber(input(bump, "Filter Width"), CONTRACT.bumpFilterWidth)
    || input(bump, "Height")?.linked !== true
    || !exactVector(input(bump, "Normal"), [0, 0, 0])) return null;

  return structuredClone(CONTRACT);
}

/** CPU oracle for Blender's normalized 3D FBM Noise Texture Factor output. */
export function nodeBaseHeightAtGenerated(
  generated: readonly number[],
  config: NodeBaseMaterialConfig,
): number {
  const detail = Math.max(0, Math.min(15, config.noiseDetail));
  const whole = Math.floor(detail);
  const point = generated.map((component) => component * config.noiseScale);
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let maximum = 0;
  for (let octave = 0; octave <= whole; octave++) {
    sum += amplitude * filamentSignedNoise3(point.map((component) => component * frequency));
    maximum += amplitude;
    amplitude *= config.noiseRoughness;
    frequency *= config.noiseLacunarity;
  }
  const normalized = (value: number, weight: number) => config.noiseNormalize ? 0.5 * value / weight + 0.5 : value;
  const remainder = detail - whole;
  if (remainder === 0) return normalized(sum, maximum);
  const next = sum + amplitude * filamentSignedNoise3(point.map((component) => component * frequency));
  return THREE.MathUtils.lerp(normalized(sum, maximum), normalized(next, maximum + amplitude), remainder);
}

function glsl(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

function glslVector(vector: readonly number[]): string {
  return `vec3(${vector.map(glsl).join(", ")})`;
}

function heightGlsl(config: NodeBaseMaterialConfig): string {
  let amplitude = 1;
  let frequency = 1;
  let maximum = 0;
  const terms: string[] = [];
  for (let octave = 0; octave <= Math.floor(config.noiseDetail); octave++) {
    terms.push(`${glsl(amplitude)} * nodeBaseNoise(point * ${glsl(frequency)})`);
    maximum += amplitude;
    amplitude *= config.noiseRoughness;
    frequency *= config.noiseLacunarity;
  }
  return `float nodeBaseHeight(vec3 generated) {
  vec3 point = generated * ${glsl(config.noiseScale)};
  float signedFbm = ${terms.join("\n    + ")};
  return ${config.noiseNormalize ? `0.5 * signedFbm / ${glsl(maximum)} + 0.5` : "signedFbm"};
}`;
}

function finiteNumber(socket: RawSocket | undefined): number | null {
  if (!socket || socket.linked || !Number.isFinite(Number(socket.value))) return null;
  return Number(socket.value);
}

function finiteColor(socket: RawSocket | undefined): [number, number, number] | null {
  if (!socket || socket.linked || !Array.isArray(socket.value) || socket.value.length < 3) return null;
  const value = socket.value.slice(0, 3).map(Number);
  return value.every(Number.isFinite) ? value as [number, number, number] : null;
}

/**
 * Recognize the reusable Blender contract
 * Generated coordinates -> normalized 3D FBM Noise -> Bump -> Principled.
 *
 * The Nodes Node pack uses this second four-node material for the raised input
 * panels. Keep the recognizer structural and parameter-driven so other exact
 * copies do not silently fall through to the constant-material approximation.
 */
export function extractSimpleNoiseBumpMaterialConfig(
  dump: Dump,
  materialName: string,
): SimpleNoiseBumpMaterialConfig | null {
  const tree = dump.materials?.[materialName] as RawTree | undefined;
  if (!tree || tree.nodes?.length !== REQUIRED_NODES.length || tree.links?.length !== REQUIRED_LINKS.length) return null;
  const nodes = new Map(tree.nodes.map((node) => [node.name, node]));
  if (REQUIRED_NODES.some(([name, type]) => nodes.get(name)?.type !== type)
    || REQUIRED_LINKS.some((link) => !hasLink(tree, link))) return null;

  const output = nodes.get("Material Output");
  const principled = nodes.get("Principled BSDF");
  const bump = nodes.get("Bump");
  const noise = nodes.get("Noise Texture");
  const baseColor = finiteColor(input(principled, "Base Color"));
  const metallic = finiteNumber(input(principled, "Metallic"));
  const roughness = finiteNumber(input(principled, "Roughness"));
  const ior = finiteNumber(input(principled, "IOR"));
  const specularIorLevel = finiteNumber(input(principled, "Specular IOR Level"));
  const noiseScale = finiteNumber(input(noise, "Scale"));
  const noiseDetail = finiteNumber(input(noise, "Detail"));
  const noiseRoughness = finiteNumber(input(noise, "Roughness"));
  const noiseLacunarity = finiteNumber(input(noise, "Lacunarity"));
  const bumpStrength = finiteNumber(input(bump, "Strength"));
  const bumpDistance = finiteNumber(input(bump, "Distance"));
  const bumpFilterWidth = finiteNumber(input(bump, "Filter Width"));
  if (!baseColor || metallic === null || roughness === null || ior === null || specularIorLevel === null
    || noiseScale === null || noiseDetail === null || noiseRoughness === null || noiseLacunarity === null
    || bumpStrength === null || bumpDistance === null || bumpFilterWidth === null
    || !exactProps(output, { is_active_output: true })
    || !exactProps(principled, { distribution: "GGX", subsurface_method: "RANDOM_WALK_SKIN" })
    || input(principled, "Normal")?.linked !== true
    || !exactNumber(input(principled, "Alpha"), 1)
    || !exactNumber(input(principled, "Transmission Weight"), 0)
    || !exactNumber(input(principled, "Coat Weight"), 0)
    || !exactVector(input(principled, "Emission Color"), [0, 0, 0, 1])
    || !exactNumber(input(principled, "Emission Strength"), 1)
    || !exactProps(noise, { noise_dimensions: "3D", noise_type: "FBM" })
    || typeof noise?.props?.normalize !== "boolean"
    || !exactVector(input(noise, "Vector"), [0, 0, 0])
    || !exactNumber(input(noise, "W"), 0)
    || !exactNumber(input(noise, "Offset"), 0)
    || !exactNumber(input(noise, "Gain"), 1)
    || !exactNumber(input(noise, "Distortion"), 0)
    || noiseDetail < 0 || noiseDetail > 15
    || noiseRoughness < 0 || noiseRoughness > 1
    || noiseLacunarity <= 0
    || !exactProps(bump, { invert: false })
    || input(bump, "Height")?.linked !== true
    || !exactVector(input(bump, "Normal"), [0, 0, 0])) return null;

  return {
    baseColor,
    metallic,
    roughness,
    ior,
    specularIorLevel,
    noiseScale,
    noiseDetail,
    noiseRoughness,
    noiseLacunarity,
    noiseNormalize: noise.props.normalize,
    bumpStrength,
    bumpDistance,
    bumpFilterWidth,
    bumpInvert: false,
  };
}

/** Reconstruct any exact four-node Generated Noise/Bump material contract. */
export function makeSimpleNoiseBumpMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  group: IndexGroup,
  materialName: string,
): THREE.MeshPhysicalMaterial | null {
  const config = extractSimpleNoiseBumpMaterialConfig(dump, materialName);
  const bounds = config ? filamentGroupBounds(geometry, group) : null;
  if (!config || !bounds) return null;
  const extent = bounds.max.map((value, axis) => Math.max(value - bounds.min[axis], 1e-20));
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(...config.baseColor),
    metalness: config.metallic,
    roughness: config.roughness,
    ior: config.ior,
    specularIntensity: config.specularIorLevel,
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · authored normalized Noise/Bump reconstruction`;
  material.userData.simpleNoiseBumpContract = config;
  material.userData.simpleNoiseBumpGeneratedBounds = bounds satisfies FilamentBounds;
  material.userData.rendererApproximation = "Exact extracted scalar graph and parameters; Three.js PBR lighting and WebGL screen derivatives approximate Blender's renderer.";
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSimpleNoiseBumpGenerated;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvSimpleNoiseBumpGenerated = (position - ${glslVector(bounds.min)}) / ${glslVector(extent)};`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vSimpleNoiseBumpGenerated;

${filamentNoiseGlsl("nodeBase")}
${heightGlsl(config)}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
${filamentBumpGlsl({
    prefix: "simpleNoiseBump",
    coordinate: "vSimpleNoiseBumpGenerated",
    heightFunction: (coordinate) => `nodeBaseHeight(${coordinate})`,
    strength: config.bumpStrength,
    distance: config.bumpDistance,
    filterWidth: config.bumpFilterWidth,
    invert: config.bumpInvert,
  })}`);
  };
  material.customProgramCacheKey = () => `simple-noise-bump-${materialName}-${JSON.stringify(config)}-${bounds.min.join(",")}-${bounds.max.join(",")}-v1`;
  return material;
}

/** Reconstruct the base plate's authored Generated-Noise micro-bump in Three.js PBR. */
export function makeNodeBaseMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  group: IndexGroup,
  materialName: string,
): THREE.MeshPhysicalMaterial | null {
  const config = extractNodeBaseMaterialConfig(dump, materialName);
  const bounds = config ? filamentGroupBounds(geometry, group) : null;
  if (!config || !bounds) return null;
  const extent = bounds.max.map((value, axis) => Math.max(value - bounds.min[axis], 1e-20));
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(...config.baseColor),
    metalness: config.metallic,
    roughness: config.roughness,
    ior: config.ior,
    specularIntensity: config.specularIorLevel,
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · authored normalized Noise/Bump reconstruction`;
  material.userData.nodeBaseContract = config;
  material.userData.nodeBaseGeneratedBounds = bounds satisfies FilamentBounds;
  material.userData.rendererApproximation = "Exact extracted scalar graph and parameters; Three.js PBR lighting and WebGL screen derivatives approximate Blender's renderer.";
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vNodeBaseGenerated;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvNodeBaseGenerated = (position - ${glslVector(bounds.min)}) / ${glslVector(extent)};`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vNodeBaseGenerated;

${filamentNoiseGlsl("nodeBase")}
${heightGlsl(config)}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
${filamentBumpGlsl({
    prefix: "nodeBase",
    coordinate: "vNodeBaseGenerated",
    heightFunction: (coordinate) => `nodeBaseHeight(${coordinate})`,
    strength: config.bumpStrength,
    distance: config.bumpDistance,
    filterWidth: config.bumpFilterWidth,
    invert: config.bumpInvert,
  })}`);
  };
  material.customProgramCacheKey = () => `nodes-node-base-${bounds.min.join(",")}-${bounds.max.join(",")}-v1`;
  return material;
}
