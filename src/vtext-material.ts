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

export type VtextMaterialConfig = {
  baseColor: [number, number, number];
  metallic: number;
  roughness: number;
  ior: number;
  specularIorLevel: number;
  bumpStrength: number;
  bumpDistance: number;
  bumpFilterWidth: number;
  bumpInvert: boolean;
  noiseScale: number;
  waveScaleNoise: number;
  noiseDetail: number;
  noiseRoughness: number;
  noiseLacunarity: number;
  waveDistortion: number;
  waveDetail: number;
  waveDetailScale: number;
  waveDetailRoughness: number;
  heightFromMin: number;
  heightFromMax: number;
  heightToMin: number;
  heightToMax: number;
};

const CONTRACT: VtextMaterialConfig = {
  baseColor: [0.01800565980374813, 0.01800565980374813, 0.01800565980374813],
  metallic: 0,
  roughness: 0.7461773753166199,
  ior: 1.4500000476837158,
  specularIorLevel: 0.11926604062318802,
  bumpStrength: 0.25698322057724,
  bumpDistance: 1,
  bumpFilterWidth: 1,
  bumpInvert: false,
  noiseScale: 26.03999900817871,
  waveScaleNoise: 34.19999694824219,
  noiseDetail: 5.84999942779541,
  noiseRoughness: 0.7208346724510193,
  noiseLacunarity: 1.899999976158142,
  waveDistortion: -13.269996643066406,
  waveDetail: 0,
  waveDetailScale: 1,
  waveDetailRoughness: 0.5,
  heightFromMin: 0,
  heightFromMax: 1,
  heightToMin: -0.059999942779541016,
  heightToMax: 0.8700000047683716,
};

const GROUP_LINKS: [string, string, string, string][] = [
  ["Bump", "Normal", "Group Output", "Output_0"],
  ["Texture Coordinate", "Generated", "Mapping", "Vector"],
  ["Mapping", "Vector", "Voronoi Texture", "Vector"],
  ["Voronoi Texture", "Distance", "Map Range", "Value"],
  ["Map Range", "Result", "Math", "Value"],
  ["Group Input", "Input_2", "Bump", "Strength"],
  ["Mix (Legacy)", "Result_Color", "Bump", "Height"],
  ["Math", "Value", "Mix (Legacy)", "A_Color"],
  ["Noise Texture.001", "Fac", "Map Range.002", "Value"],
  ["Map Range.002", "Result", "Math.002", "Value"],
  ["Musgrave Texture", "Fac", "Map Range.002", "To Max"],
  ["Musgrave Texture.001", "Fac", "Math.003", "Value"],
  ["Math.003", "Value", "Map Range.003", "Value"],
  ["Wave Texture", "Fac", "Math.003", "Value_001"],
  ["Musgrave Texture.002", "Fac", "Wave Texture", "Scale"],
  ["Map Range.003", "Result", "Mix (Legacy)", "B_Color"],
  ["Group Input", "Input_3", "Musgrave Texture.002", "Scale"],
  ["Group Input", "Input_4", "Musgrave Texture.001", "Scale"],
];

function input(node: RawNode | undefined, identifier: string): unknown {
  return node?.inputs?.find((socket) => socket.identifier === identifier || socket.name === identifier)?.value;
}

function exactNumber(value: unknown, expected: number): boolean {
  return Number(value) === expected;
}

function exactVector(value: unknown, expected: readonly number[]): boolean {
  return Array.isArray(value) && expected.every((component, axis) => Number(value[axis]) === component);
}

function exactProps(node: RawNode | undefined, expected: Record<string, unknown>): boolean {
  return !!node && Object.entries(expected).every(([key, value]) => node.props?.[key] === value);
}

function nodeMap(tree: RawTree): Map<string, RawNode> {
  return new Map((tree.nodes ?? []).map((node) => [node.name, node]));
}

function hasLink(tree: RawTree, fromNode: string, fromSocket: string, toNode: string, toSocket: string): boolean {
  return (tree.links ?? []).some((link) => link.from_node === fromNode && link.from_socket === fromSocket
    && link.to_node === toNode && link.to_socket === toSocket);
}

function exactNode(nodes: Map<string, RawNode>, name: string, type: string): RawNode | undefined {
  const node = nodes.get(name);
  return node?.type === type ? node : undefined;
}

/** Recognize the exact Nodes Node `node base` material and authored `vtext.001` group. */
export function extractVtextMaterialConfig(dump: Dump, materialName: string): VtextMaterialConfig | null {
  if (materialName !== "node base") return null;
  const material = dump.materials?.[materialName] as RawTree | undefined;
  const group = dump.shader_node_groups?.["vtext.001"] as RawTree | undefined;
  if (!material || !group) return null;

  const materialNodes = nodeMap(material);
  const output = exactNode(materialNodes, "Material Output", "ShaderNodeOutputMaterial");
  const principled = exactNode(materialNodes, "Principled BSDF", "ShaderNodeBsdfPrincipled");
  const groupInstance = exactNode(materialNodes, "Group", "ShaderNodeGroup");
  if (!output || !principled || !groupInstance
    || output.props?.is_active_output !== true
    || (groupInstance.props?.node_tree as { name?: string } | undefined)?.name !== "vtext.001"
    || !hasLink(material, "Principled BSDF", "BSDF", "Material Output", "Surface")
    || !hasLink(material, "Group", "Output_0", "Principled BSDF", "Normal")
    || !exactVector(input(principled, "Base Color"), [...CONTRACT.baseColor, 1])
    || !exactNumber(input(principled, "Metallic"), CONTRACT.metallic)
    || !exactNumber(input(principled, "Roughness"), CONTRACT.roughness)
    || !exactNumber(input(principled, "IOR"), CONTRACT.ior)
    || !exactNumber(input(principled, "Alpha"), 1)
    || !exactNumber(input(principled, "Specular IOR Level"), CONTRACT.specularIorLevel)
    || !exactNumber(input(principled, "Transmission Weight"), 0)
    || !exactNumber(input(principled, "Coat Weight"), 0)
    || !exactNumber(input(groupInstance, "Input_2"), CONTRACT.bumpStrength)
    || !exactNumber(input(groupInstance, "Input_3"), CONTRACT.waveScaleNoise)
    || !exactNumber(input(groupInstance, "Input_4"), CONTRACT.noiseScale)) return null;

  const nodes = nodeMap(group);
  const types: [string, string][] = [
    ["Mapping", "ShaderNodeMapping"], ["Texture Coordinate", "ShaderNodeTexCoord"],
    ["Group Output", "NodeGroupOutput"], ["Bump", "ShaderNodeBump"],
    ["Mix (Legacy)", "ShaderNodeMix"], ["Voronoi Texture", "ShaderNodeTexVoronoi"],
    ["Math", "ShaderNodeMath"], ["Map Range", "ShaderNodeMapRange"],
    ["Noise Texture.001", "ShaderNodeTexNoise"], ["Math.002", "ShaderNodeMath"],
    ["Map Range.002", "ShaderNodeMapRange"], ["Musgrave Texture", "ShaderNodeTexNoise"],
    ["Musgrave Texture.001", "ShaderNodeTexNoise"], ["Musgrave Texture.002", "ShaderNodeTexNoise"],
    ["Math.003", "ShaderNodeMath"], ["Map Range.003", "ShaderNodeMapRange"],
    ["Wave Texture", "ShaderNodeTexWave"], ["Group Input", "NodeGroupInput"],
  ];
  if (types.some(([name, type]) => !exactNode(nodes, name, type))
    || GROUP_LINKS.some((link) => !hasLink(group, ...link))) return null;

  const mapping = nodes.get("Mapping");
  const mix = nodes.get("Mix (Legacy)");
  const voronoi = nodes.get("Voronoi Texture");
  const threshold = nodes.get("Math");
  const mapRange = nodes.get("Map Range");
  const deadNoise = nodes.get("Noise Texture.001");
  const deadThreshold = nodes.get("Math.002");
  const deadMapRange = nodes.get("Map Range.002");
  const deadMusgrave = nodes.get("Musgrave Texture");
  const noise = nodes.get("Musgrave Texture.001");
  const waveScaleNoise = nodes.get("Musgrave Texture.002");
  const pingPong = nodes.get("Math.003");
  const heightRange = nodes.get("Map Range.003");
  const wave = nodes.get("Wave Texture");
  const bump = nodes.get("Bump");
  const noiseProps = { noise_dimensions: "3D", noise_type: "FBM", normalize: false };
  const rangeProps = { clamp: true, interpolation_type: "LINEAR", data_type: "FLOAT" };
  if (!exactProps(mapping, { vector_type: "POINT" })
    || !exactVector(input(mapping, "Location"), [0, 0, 0])
    || !exactVector(input(mapping, "Rotation"), [1.5707963705062866, 0.7853981852531433, 0])
    || !exactVector(input(mapping, "Scale"), [1, 1, 1.440000057220459])
    || !exactProps(mix, { data_type: "RGBA", factor_mode: "UNIFORM", blend_type: "MIX", clamp_factor: true, clamp_result: false })
    || !exactNumber(input(mix, "Factor_Float"), 1)
    || !exactProps(voronoi, { voronoi_dimensions: "3D", distance: "EUCLIDEAN", feature: "SMOOTH_F1", normalize: false })
    || !exactNumber(input(voronoi, "Scale"), 791.2999267578125)
    || !exactProps(threshold, { operation: "GREATER_THAN", use_clamp: false })
    || !exactNumber(input(threshold, "Value_001"), 0.5699999928474426)
    || !exactProps(mapRange, rangeProps)
    || !exactNumber(input(mapRange, "To Min"), 0.09999999403953552)
    || !exactNumber(input(mapRange, "To Max"), 1.2000000476837158)
    || !exactProps(deadNoise, { noise_dimensions: "3D", noise_type: "FBM", normalize: true })
    || !exactNumber(input(deadNoise, "Scale"), 3.379999876022339)
    || !exactNumber(input(deadNoise, "Detail"), 4.470000267028809)
    || !exactNumber(input(deadNoise, "Roughness"), 1)
    || !exactNumber(input(deadNoise, "Lacunarity"), 2)
    || !exactNumber(input(deadNoise, "Distortion"), -0.07999999821186066)
    || !exactProps(deadThreshold, { operation: "GREATER_THAN", use_clamp: false })
    || !exactNumber(input(deadThreshold, "Value_001"), -0.33000001311302185)
    || !exactProps(deadMapRange, rangeProps)
    || !exactNumber(input(deadMapRange, "To Min"), -1.0799999237060547)
    || !exactProps(deadMusgrave, noiseProps)
    || !exactNumber(input(deadMusgrave, "Scale"), 2.940000534057617)
    || !exactProps(noise, noiseProps)
    || !exactProps(waveScaleNoise, noiseProps)
    || !exactNumber(input(noise, "Detail"), CONTRACT.noiseDetail)
    || !exactNumber(input(noise, "Roughness"), CONTRACT.noiseRoughness)
    || !exactNumber(input(noise, "Lacunarity"), CONTRACT.noiseLacunarity)
    || !exactNumber(input(noise, "Distortion"), 0)
    || !exactNumber(input(waveScaleNoise, "Detail"), CONTRACT.noiseDetail)
    || !exactNumber(input(waveScaleNoise, "Roughness"), CONTRACT.noiseRoughness)
    || !exactNumber(input(waveScaleNoise, "Lacunarity"), CONTRACT.noiseLacunarity)
    || !exactNumber(input(waveScaleNoise, "Distortion"), 0)
    || !exactProps(pingPong, { operation: "PINGPONG", use_clamp: false })
    || !exactProps(heightRange, rangeProps)
    || !exactNumber(input(heightRange, "From Min"), CONTRACT.heightFromMin)
    || !exactNumber(input(heightRange, "From Max"), CONTRACT.heightFromMax)
    || !exactNumber(input(heightRange, "To Min"), CONTRACT.heightToMin)
    || !exactNumber(input(heightRange, "To Max"), CONTRACT.heightToMax)
    || !exactProps(wave, { wave_type: "BANDS", bands_direction: "X", wave_profile: "SIN" })
    || !exactNumber(input(wave, "Distortion"), CONTRACT.waveDistortion)
    || !exactNumber(input(wave, "Detail"), CONTRACT.waveDetail)
    || !exactNumber(input(wave, "Detail Scale"), CONTRACT.waveDetailScale)
    || !exactNumber(input(wave, "Detail Roughness"), CONTRACT.waveDetailRoughness)
    || !exactNumber(input(wave, "Phase Offset"), 0)
    || !exactProps(bump, { invert: CONTRACT.bumpInvert })
    || !exactNumber(input(bump, "Distance"), CONTRACT.bumpDistance)
    || !exactNumber(input(bump, "Filter Width"), CONTRACT.bumpFilterWidth)) return null;

  return structuredClone(CONTRACT);
}

/** Blender's non-normalized 3D Noise Texture FBM used by the live vtext branch. */
export function vtextFbmAtGenerated(generated: readonly number[], scale: number, config: VtextMaterialConfig): number {
  const point = generated.map((value) => value * scale);
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  for (let octave = 0; octave <= Math.floor(config.noiseDetail); octave++) {
    sum += amplitude * filamentSignedNoise3(point.map((value) => value * frequency));
    amplitude *= config.noiseRoughness;
    frequency *= config.noiseLacunarity;
  }
  const remainder = config.noiseDetail - Math.floor(config.noiseDetail);
  if (remainder === 0) return sum;
  const sum2 = sum + amplitude * filamentSignedNoise3(point.map((value) => value * frequency));
  return sum + (sum2 - sum) * remainder;
}

function pingPong(value: number, scale: number): number {
  if (scale === 0) return 0;
  const period = scale * 2;
  const fract = (value - scale) / period - Math.floor((value - scale) / period);
  return Math.abs(fract * period - scale);
}

/** CPU oracle for the exact live B branch: FBM -> dynamic X Wave -> Ping-Pong -> Map Range. */
export function vtextHeightAtGenerated(generated: readonly number[], config: VtextMaterialConfig): number {
  const value = vtextFbmAtGenerated(generated, config.noiseScale, config);
  const dynamicScale = vtextFbmAtGenerated(generated, config.waveScaleNoise, config);
  const point = generated.map((component) => (component * dynamicScale + 0.000001) * 0.999999);
  const distortion = filamentSignedNoise3(point.map((component) => component * config.waveDetailScale));
  const phase = point[0] * 20 + config.waveDistortion * distortion;
  const wave = 0.5 + 0.5 * Math.sin(phase - Math.PI / 2);
  const amount = THREE.MathUtils.clamp((pingPong(value, wave) - config.heightFromMin)
    / (config.heightFromMax - config.heightFromMin), 0, 1);
  return config.heightToMin + amount * (config.heightToMax - config.heightToMin);
}

function glsl(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

function glslVector(vector: readonly number[]): string {
  return `vec3(${vector.map(glsl).join(", ")})`;
}

function fbmGlsl(config: VtextMaterialConfig): string {
  let amplitude = 1;
  let frequency = 1;
  const terms: string[] = [];
  for (let octave = 0; octave <= Math.floor(config.noiseDetail); octave++) {
    terms.push(`${glsl(amplitude)} * vtextNoise(point * ${glsl(frequency)})`);
    amplitude *= config.noiseRoughness;
    frequency *= config.noiseLacunarity;
  }
  const remainder = config.noiseDetail - Math.floor(config.noiseDetail);
  return `float vtextFbm(vec3 coordinate, float scale) {
  vec3 point = coordinate * scale;
  float sum = ${terms.join("\n    + ")};
  float sum2 = sum + ${glsl(amplitude)} * vtextNoise(point * ${glsl(frequency)});
  return mix(sum, sum2, ${glsl(remainder)});
}
float vtextPingPong(float value, float scale) {
  if (scale == 0.0) return 0.0;
  float period = scale * 2.0;
  return abs(fract((value - scale) / period) * period - scale);
}
float vtextHeight(vec3 coordinate) {
  float value = vtextFbm(coordinate, ${glsl(config.noiseScale)});
  float dynamicScale = vtextFbm(coordinate, ${glsl(config.waveScaleNoise)});
  vec3 point = (coordinate * dynamicScale + vec3(0.000001)) * 0.999999;
  float waveNoise = vtextNoise(point * ${glsl(config.waveDetailScale)});
  float phase = point.x * 20.0 + ${glsl(config.waveDistortion)} * waveNoise;
  float wave = 0.5 + 0.5 * sin(phase - 1.5707963267948966);
  float ping = vtextPingPong(value, wave);
  float amount = clamp((ping - ${glsl(config.heightFromMin)}) / ${glsl(config.heightFromMax - config.heightFromMin)}, 0.0, 1.0);
  return mix(${glsl(config.heightToMin)}, ${glsl(config.heightToMax)}, amount);
}`;
}

/** Reconstruct the six Nodes Node base panels' authored vtext.001 micro-bump material. */
export function makeVtextMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  group: IndexGroup,
  materialName: string,
): THREE.MeshPhysicalMaterial | null {
  const config = extractVtextMaterialConfig(dump, materialName);
  if (!config) return null;
  const bounds = filamentGroupBounds(geometry, group);
  if (!bounds) return null;
  const extent = bounds.max.map((value, axis) => Math.max(value - bounds.min[axis], 1e-20));
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(...config.baseColor),
    metalness: config.metallic,
    roughness: config.roughness,
    ior: config.ior,
    specularIntensity: config.specularIorLevel,
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · authored Nodes Node vtext reconstruction`;
  material.userData.vtextContract = config;
  material.userData.vtextBounds = bounds satisfies FilamentBounds;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vVtextGenerated;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvVtextGenerated = (position - ${glslVector(bounds.min)}) / ${glslVector(extent)};`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vVtextGenerated;

${filamentNoiseGlsl("vtext")}
${fbmGlsl(config)}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
${filamentBumpGlsl({
    prefix: "vtext",
    coordinate: "vVtextGenerated",
    heightFunction: (coordinate) => `vtextHeight(${coordinate})`,
    strength: config.bumpStrength,
    distance: config.bumpDistance,
    filterWidth: config.bumpFilterWidth,
    invert: config.bumpInvert,
  })}`);
  };
  material.customProgramCacheKey = () => `nodes-node-vtext-${bounds.min.join(",")}-${bounds.max.join(",")}-v1`;
  return material;
}
