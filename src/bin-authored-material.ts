import * as THREE from "three";
import {
  filamentBumpGlsl,
  filamentNoiseGlsl,
  filamentSignedNoise3,
  type FilamentBounds,
} from "./filament-material";
import type { Dump } from "./gnvm";

type RawSocket = { identifier?: string; name?: string; linked?: boolean; value?: unknown };
type RawNode = { name: string; type: string; props?: Record<string, unknown>; inputs?: RawSocket[] };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawTree = { nodes?: RawNode[]; links?: RawLink[] };

export type BinAuthoredMaterialConfig = {
  baseColor: [number, number, number];
  metallic: number;
  roughness: number;
  ior: number;
  objectMappingRotation: [number, number, number];
  waveScale: number;
  waveDistortion: number;
  waveDetail: number;
  waveDetailScale: number;
  waveDetailRoughness: number;
  wavePhaseOffset: number;
  noiseScale: number;
  noiseDetail: number;
  noiseRoughness: number;
  noiseLacunarity: number;
  mixFactor: number;
  bumpStrength: number;
  bumpDistance: number;
  bumpFilterWidth: number;
  bumpInvert: boolean;
};

const SHARED = {
  metallic: 0,
  roughness: 0.5,
  ior: 1.4500000476837158,
  objectMappingRotation: [0, 1.5707963705062866, 0] as [number, number, number],
  waveScale: 236.75997924804688,
  waveDistortion: 0.05000000447034836,
  waveDetail: 4.699999809265137,
  waveDetailScale: 1,
  waveDetailRoughness: 0.5,
  wavePhaseOffset: 3.1999998092651367,
  noiseScale: 2000,
  noiseDetail: 2,
  noiseRoughness: 0.5,
  noiseLacunarity: 2,
  mixFactor: 0.9431818127632141,
  bumpStrength: 0.3588068187236786,
  bumpDistance: 1.0700000524520874,
  bumpFilterWidth: 1,
  bumpInvert: false,
};

const MATERIAL_COLORS: Record<string, [number, number, number]> = {
  "3D": [0, 0.030982598662376404, 1],
  "3D.004": [1, 0, 0.002402153331786394],
};

const PRINCIPLED_DEFAULTS: Record<string, unknown> = {
  Weight: 0,
  "Diffuse Roughness": 0,
  "Subsurface Weight": 0,
  "Subsurface Radius": [1, 0.20000000298023224, 0.10000000149011612],
  "Subsurface Scale": 0.05000000074505806,
  "Subsurface IOR": 1.399999976158142,
  "Subsurface Anisotropy": 0,
  "Specular IOR Level": 0.5,
  "Specular Tint": [1, 1, 1, 1],
  Anisotropic: 0,
  "Anisotropic Rotation": 0,
  Tangent: [0, 0, 0],
  "Transmission Weight": 0,
  "Coat Weight": 0,
  "Coat Roughness": 0.029999999329447746,
  "Coat IOR": 1.5,
  "Coat Tint": [1, 1, 1, 1],
  "Coat Normal": [0, 0, 0],
  "Sheen Weight": 0,
  "Sheen Roughness": 0.5,
  "Sheen Tint": [1, 1, 1, 1],
  "Emission Color": [1, 1, 1, 1],
  "Emission Strength": 0,
  "Thin Film Thickness": 0,
  "Thin Film IOR": 1.3300000429153442,
};

const REQUIRED_NODES: [string, string][] = [
  ["Wave Texture", "ShaderNodeTexWave"],
  ["Noise Texture", "ShaderNodeTexNoise"],
  ["Mapping.001", "ShaderNodeMapping"],
  ["Material Output", "ShaderNodeOutputMaterial"],
  ["Texture Coordinate.001", "ShaderNodeTexCoord"],
  ["Mapping", "ShaderNodeMapping"],
  ["Texture Coordinate", "ShaderNodeTexCoord"],
  ["Principled BSDF", "ShaderNodeBsdfPrincipled"],
  ["Attribute", "ShaderNodeAttribute"],
  ["Bump", "ShaderNodeBump"],
  ["Mix", "ShaderNodeMix"],
  ["Attribute.001", "ShaderNodeAttribute"],
  ["Group", "ShaderNodeGroup"],
];

const REQUIRED_LINKS: [string, string, string, string][] = [
  ["Bump", "Normal", "Principled BSDF", "Normal"],
  ["Mapping", "Vector", "Wave Texture", "Vector"],
  ["Texture Coordinate.001", "Generated", "Mapping.001", "Vector"],
  ["Mapping.001", "Vector", "Noise Texture", "Vector"],
  ["Mix", "Result_Color", "Bump", "Height"],
  ["Noise Texture", "Fac", "Mix", "A_Color"],
  ["Wave Texture", "Color", "Mix", "B_Color"],
  ["Texture Coordinate", "Object", "Mapping", "Vector"],
  ["Principled BSDF", "BSDF", "Material Output", "Surface"],
  ["Attribute.001", "Color", "Group", "Socket_2"],
];

function input(node: RawNode | undefined, identifier: string): unknown {
  return node?.inputs?.find((candidate) => candidate.identifier === identifier || candidate.name === identifier)?.value;
}

function exactNumber(value: unknown, expected: number): boolean {
  return Number(value) === expected;
}

function exactVector(value: unknown, expected: readonly number[]): boolean {
  return Array.isArray(value) && value.length >= expected.length
    && expected.every((component, axis) => Number(value[axis]) === component);
}

function exactUnlinkedInputs(node: RawNode | undefined, expected: Record<string, unknown>): boolean {
  return !!node && Object.entries(expected).every(([identifier, value]) => {
    const socket = node.inputs?.find((candidate) => candidate.identifier === identifier || candidate.name === identifier);
    if (!socket || socket.linked) return false;
    return Array.isArray(value) ? exactVector(socket.value, value) : exactNumber(socket.value, Number(value));
  });
}

function exactProps(node: RawNode | undefined, expected: Record<string, unknown>): boolean {
  return !!node && Object.entries(expected).every(([key, value]) => node.props?.[key] === value);
}

function hasLink(tree: RawTree, [fromNode, fromSocket, toNode, toSocket]: [string, string, string, string]): boolean {
  return (tree.links ?? []).some((link) => link.from_node === fromNode && link.from_socket === fromSocket
    && link.to_node === toNode && link.to_socket === toSocket);
}

/** Recognize only the complete authored 3D/3D.004 graph extracted from the bin blend. */
export function extractBinAuthoredMaterialConfig(dump: Dump, materialName: string): BinAuthoredMaterialConfig | null {
  const sourceColor = MATERIAL_COLORS[materialName];
  const tree = dump.materials?.[materialName] as RawTree | undefined;
  if (!sourceColor || !tree || tree.nodes?.length !== REQUIRED_NODES.length || tree.links?.length !== REQUIRED_LINKS.length) return null;
  const nodes = new Map(tree.nodes.map((node) => [node.name, node]));
  if (REQUIRED_NODES.some(([name, type]) => nodes.get(name)?.type !== type)
    || REQUIRED_LINKS.some((link) => !hasLink(tree, link))) return null;

  const output = nodes.get("Material Output");
  const principled = nodes.get("Principled BSDF");
  const objectMapping = nodes.get("Mapping");
  const generatedMapping = nodes.get("Mapping.001");
  const wave = nodes.get("Wave Texture");
  const noise = nodes.get("Noise Texture");
  const mix = nodes.get("Mix");
  const bump = nodes.get("Bump");
  const attribute = nodes.get("Attribute");
  const domainAttribute = nodes.get("Attribute.001");
  const group = nodes.get("Group");
  if (!exactProps(output, { is_active_output: true })
    || !exactVector(input(principled, "Base Color"), [...sourceColor, 1])
    || !exactNumber(input(principled, "Metallic"), SHARED.metallic)
    || !exactNumber(input(principled, "Roughness"), SHARED.roughness)
    || !exactNumber(input(principled, "IOR"), SHARED.ior)
    || !exactNumber(input(principled, "Alpha"), 1)
    || !exactUnlinkedInputs(principled, PRINCIPLED_DEFAULTS)
    || principled?.inputs?.find((socket) => socket.identifier === "Normal")?.linked !== true
    || !exactProps(objectMapping, { vector_type: "POINT" })
    || !exactVector(input(objectMapping, "Location"), [0, 0, 0])
    || !exactVector(input(objectMapping, "Rotation"), SHARED.objectMappingRotation)
    || !exactVector(input(objectMapping, "Scale"), [1, 1, 1])
    || !exactProps(generatedMapping, { vector_type: "POINT" })
    || !exactVector(input(generatedMapping, "Location"), [0, 0, 0])
    || !exactVector(input(generatedMapping, "Rotation"), [0, 0, 0])
    || !exactVector(input(generatedMapping, "Scale"), [1, 1, 1])
    || !exactProps(wave, { wave_type: "BANDS", bands_direction: "X", wave_profile: "SIN" })
    || !exactNumber(input(wave, "Scale"), SHARED.waveScale)
    || !exactNumber(input(wave, "Distortion"), SHARED.waveDistortion)
    || !exactNumber(input(wave, "Detail"), SHARED.waveDetail)
    || !exactNumber(input(wave, "Detail Scale"), SHARED.waveDetailScale)
    || !exactNumber(input(wave, "Detail Roughness"), SHARED.waveDetailRoughness)
    || !exactNumber(input(wave, "Phase Offset"), SHARED.wavePhaseOffset)
    || !exactProps(noise, { noise_dimensions: "3D", noise_type: "FBM", normalize: true })
    || !exactNumber(input(noise, "Scale"), SHARED.noiseScale)
    || !exactNumber(input(noise, "Detail"), SHARED.noiseDetail)
    || !exactNumber(input(noise, "Roughness"), SHARED.noiseRoughness)
    || !exactNumber(input(noise, "Lacunarity"), SHARED.noiseLacunarity)
    || !exactNumber(input(noise, "Distortion"), 0)
    || !exactProps(mix, { data_type: "RGBA", factor_mode: "UNIFORM", blend_type: "MIX", clamp_factor: true, clamp_result: false })
    || !exactNumber(input(mix, "Factor_Float"), SHARED.mixFactor)
    || !exactProps(bump, { invert: SHARED.bumpInvert })
    || !exactNumber(input(bump, "Strength"), SHARED.bumpStrength)
    || !exactNumber(input(bump, "Distance"), SHARED.bumpDistance)
    || !exactNumber(input(bump, "Filter Width"), SHARED.bumpFilterWidth)
    || attribute?.props?.attribute_name !== "ins"
    || domainAttribute?.props?.attribute_name !== "dom"
    || (group?.props?.node_tree as { name?: string } | undefined)?.name !== "_rainbow ramp") return null;

  return { baseColor: [...sourceColor], ...SHARED };
}

function fbm(point: readonly number[], detail: number, roughness: number, lacunarity: number, normalize: boolean): number {
  const whole = Math.floor(Math.max(0, Math.min(15, detail)));
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let maximum = 0;
  for (let octave = 0; octave <= whole; octave++) {
    sum += amplitude * filamentSignedNoise3(point.map((component) => component * frequency));
    maximum += amplitude;
    amplitude *= roughness;
    frequency *= lacunarity;
  }
  const fraction = Math.max(0, Math.min(15, detail)) - whole;
  const normalized = (value: number, weight: number): number => normalize ? 0.5 * value / weight + 0.5 : value;
  if (fraction === 0) return normalized(sum, maximum);
  const sum2 = sum + amplitude * filamentSignedNoise3(point.map((component) => component * frequency));
  return THREE.MathUtils.lerp(normalized(sum, maximum), normalized(sum2, maximum + amplitude), fraction);
}

function mappedObjectCoordinate(objectCoordinate: readonly number[], config: BinAuthoredMaterialConfig): [number, number, number] {
  const angle = config.objectMappingRotation[1];
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [
    cosine * objectCoordinate[0] + sine * objectCoordinate[2],
    objectCoordinate[1],
    -sine * objectCoordinate[0] + cosine * objectCoordinate[2],
  ];
}

/** CPU oracle for the extracted Object-Wave + Generated-Noise + RGBA Mix height branch. */
export function binAuthoredHeight(
  objectCoordinate: readonly number[],
  generatedCoordinate: readonly number[],
  config: BinAuthoredMaterialConfig,
): number {
  const mapped = mappedObjectCoordinate(objectCoordinate, config);
  const waveDistortion = fbm(
    mapped.map((component) => component * config.waveDetailScale),
    config.waveDetail,
    config.waveDetailRoughness,
    2,
    false,
  );
  const phase = mapped[0] * config.waveScale * 20 + config.waveDistortion * waveDistortion + config.wavePhaseOffset;
  const wave = 0.5 - 0.5 * Math.cos(phase);
  const generatedNoise = fbm(
    generatedCoordinate.map((component) => component * config.noiseScale),
    config.noiseDetail,
    config.noiseRoughness,
    config.noiseLacunarity,
    true,
  );
  return THREE.MathUtils.lerp(generatedNoise, wave, config.mixFactor);
}

function glsl(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

function glslVector(value: readonly number[]): string {
  return `vec3(${value.map(glsl).join(", ")})`;
}

function shaderFunctions(config: BinAuthoredMaterialConfig, bounds: FilamentBounds): string {
  const extent = bounds.max.map((value, axis) => Math.max(value - bounds.min[axis], 1e-20));
  const angle = config.objectMappingRotation[1];
  let amplitude = 1;
  let frequency = 1;
  const waveTerms: string[] = [];
  for (let octave = 0; octave <= Math.floor(config.waveDetail); octave++) {
    waveTerms.push(`${glsl(amplitude)} * binNoise(mapped * ${glsl(frequency * config.waveDetailScale)})`);
    amplitude *= config.waveDetailRoughness;
    frequency *= 2;
  }
  const remainder = config.waveDetail - Math.floor(config.waveDetail);
  waveTerms.push(`${glsl(remainder * amplitude)} * binNoise(mapped * ${glsl(frequency * config.waveDetailScale)})`);
  const noiseWeights = [1, config.noiseRoughness, config.noiseRoughness ** 2];
  const noiseMaximum = noiseWeights.reduce((sum, value) => sum + value, 0);
  const noiseTerms = noiseWeights.map((weight, octave) =>
    `${glsl(weight)} * binNoise(generated * ${glsl(config.noiseScale * config.noiseLacunarity ** octave)})`);
  return `${filamentNoiseGlsl("bin")}
float binHeight(vec3 objectCoordinate) {
  float c = ${glsl(Math.cos(angle))}, s = ${glsl(Math.sin(angle))};
  vec3 mapped = vec3(c * objectCoordinate.x + s * objectCoordinate.z, objectCoordinate.y,
                     -s * objectCoordinate.x + c * objectCoordinate.z);
  vec3 generated = (objectCoordinate - ${glslVector(bounds.min)}) / ${glslVector(extent)};
  float waveDistortion = ${waveTerms.join("\n    + ")};
  float phase = mapped.x * ${glsl(config.waveScale)} * 20.0
    + ${glsl(config.waveDistortion)} * waveDistortion + ${glsl(config.wavePhaseOffset)};
  float wave = 0.5 - 0.5 * cos(phase);
  float noise = 0.5 + 0.5 * (${noiseTerms.join("\n    + ")}) / ${glsl(noiseMaximum)};
  return mix(noise, wave, ${glsl(config.mixFactor)});
}`;
}

/** Build the browser reconstruction while retaining renderer differences as explicit metadata. */
export function makeBinAuthoredMaterial(
  dump: Dump,
  bounds: FilamentBounds,
  materialName: string,
): THREE.MeshPhysicalMaterial | null {
  const config = extractBinAuthoredMaterialConfig(dump, materialName);
  if (!config) return null;
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(...config.baseColor),
    metalness: config.metallic,
    roughness: config.roughness,
    ior: config.ior,
    side: THREE.DoubleSide,
  });
  // Preserve the source name because /bin uses it to compare material-group
  // triangle counts between the Blender truth and GN-VM results.
  material.name = materialName;
  material.userData.authoredLabel = `${materialName} · authored bin Wave/Noise reconstruction`;
  material.userData.binAuthoredContract = config;
  material.userData.binGeneratedBounds = bounds;
  material.userData.rendererApproximation = "Three.js PBR lighting plus WebGL derivatives; extracted scalar graph and parameters are preserved.";
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vBinObjectPosition;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvBinObjectPosition = position;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vBinObjectPosition;\n${shaderFunctions(config, bounds)}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
${filamentBumpGlsl({
    prefix: "bin",
    coordinate: "vBinObjectPosition",
    heightFunction: (coordinate) => `binHeight(${coordinate})`,
    strength: config.bumpStrength,
    distance: config.bumpDistance,
    filterWidth: config.bumpFilterWidth,
    invert: config.bumpInvert,
  })}`);
  };
  material.customProgramCacheKey = () => `dojo-bin-authored-${materialName}-${bounds.min.join(",")}-${bounds.max.join(",")}-v2`;
  return material;
}
