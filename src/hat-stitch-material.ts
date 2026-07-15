import * as THREE from "three";
import {
  filamentBumpGlsl,
  filamentGroupBounds,
  filamentNoiseGlsl,
  filamentWaveFunctionGlsl,
  filamentWaveHeightAtCoordinate,
  type FilamentBounds,
  type FilamentWaveConfig,
} from "./filament-material";
import type { Dump } from "./gnvm";

type RawSocket = { identifier?: string; name?: string; value?: unknown };
type RawNode = { name: string; type: string; props?: Record<string, unknown>; inputs?: RawSocket[] };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };
type IndexGroup = { start: number; count: number; material: string | null };

export type HatStitchMaterialConfig = {
  colorAttribute: string;
  metalness: number;
  roughness: number;
  ior: number;
  transmission: number;
  mappingLocation: [number, number, number];
  mappingRotation: [number, number, number];
  mappingScale: [number, number, number];
  waveScale: number;
  waveDistortion: number;
  waveDetail: number;
  waveDetailScale: number;
  waveDetailRoughness: number;
  bumpStrength: number;
  bumpDistance: number;
  bumpFilterWidth: number;
  bumpInvert: boolean;
};

function input(node: RawNode | undefined, name: string, fallback: number): number {
  const value = Number(node?.inputs?.find((socket) => socket.identifier === name || socket.name === name)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function vectorInput(node: RawNode | undefined, name: string, fallback: [number, number, number]): [number, number, number] {
  const value = node?.inputs?.find((socket) => socket.identifier === name || socket.name === name)?.value;
  if (!Array.isArray(value) || value.length < 3) return fallback;
  const vector = value.slice(0, 3).map(Number);
  return vector.every(Number.isFinite) ? vector as [number, number, number] : fallback;
}

function linkedNode(nodes: RawNode[], links: RawLink[], target: RawNode | undefined, socket: string, type: string): RawNode | undefined {
  if (!target) return undefined;
  const link = links.find((candidate) => candidate.to_node === target.name && candidate.to_socket === socket);
  return nodes.find((node) => node.name === link?.from_node && node.type === type);
}

/** Recognize the authored Send Nodes Hat `sitch.001` FACE-color filament material. */
export function extractHatStitchMaterialConfig(dump: Dump, materialName: string): HatStitchMaterialConfig | null {
  const tree = dump.materials?.[materialName] as RawMaterial | undefined;
  const nodes = tree?.nodes ?? [];
  const links = tree?.links ?? [];
  const output = nodes.find((node) => node.type === "ShaderNodeOutputMaterial" && node.props?.is_active_output === true)
    ?? nodes.find((node) => node.type === "ShaderNodeOutputMaterial");
  const principled = linkedNode(nodes, links, output, "Surface", "ShaderNodeBsdfPrincipled");
  const bump = linkedNode(nodes, links, principled, "Normal", "ShaderNodeBump");
  const wave = linkedNode(nodes, links, bump, "Height", "ShaderNodeTexWave");
  const mapping = linkedNode(nodes, links, wave, "Vector", "ShaderNodeMapping");
  const texcoord = linkedNode(nodes, links, mapping, "Vector", "ShaderNodeTexCoord");
  const attribute = linkedNode(nodes, links, principled, "Base Color", "ShaderNodeAttribute");
  const colorAttribute = String(attribute?.props?.attribute_name ?? "");
  const generatedLink = mapping ? links.find((link) => link.to_node === mapping.name && link.to_socket === "Vector") : undefined;
  if (
    !principled || !bump || !wave || !mapping || !texcoord || !attribute
    || generatedLink?.from_socket !== "Generated"
    || wave.props?.wave_type !== "BANDS"
    || wave.props?.bands_direction !== "DIAGONAL"
    || wave.props?.wave_profile !== "SIN"
    || mapping.props?.vector_type !== "POINT"
    || !/^[A-Za-z_]\w*$/.test(colorAttribute)
  ) return null;

  return {
    colorAttribute,
    metalness: input(principled, "Metallic", 0),
    roughness: input(principled, "Roughness", 0.5),
    ior: input(principled, "IOR", 1.5),
    transmission: input(principled, "Transmission Weight", 0),
    mappingLocation: vectorInput(mapping, "Location", [0, 0, 0]),
    mappingRotation: vectorInput(mapping, "Rotation", [0, 0, 0]),
    mappingScale: vectorInput(mapping, "Scale", [1, 1, 1]),
    waveScale: input(wave, "Scale", 1),
    waveDistortion: input(wave, "Distortion", 0),
    waveDetail: input(wave, "Detail", 2),
    waveDetailScale: input(wave, "Detail Scale", 1),
    waveDetailRoughness: input(wave, "Detail Roughness", 0.5),
    bumpStrength: input(bump, "Strength", 1),
    bumpDistance: input(bump, "Distance", 1),
    bumpFilterWidth: input(bump, "Filter Width", 1),
    bumpInvert: bump.props?.invert === true,
  };
}

/** Blender Mapping POINT applies component scale, XYZ Euler rotation, then translation. */
export function mapHatStitchGenerated(generated: readonly number[], config: HatStitchMaterialConfig): [number, number, number] {
  const [rx, ry, rz] = config.mappingRotation;
  const sx = Math.sin(rx), cx = Math.cos(rx);
  const sy = Math.sin(ry), cy = Math.cos(ry);
  const sz = Math.sin(rz), cz = Math.cos(rz);
  const x = generated[0] * config.mappingScale[0];
  const y = generated[1] * config.mappingScale[1];
  const z = generated[2] * config.mappingScale[2];
  const yx = cx * y - sx * z;
  const zx = sx * y + cx * z;
  const xy = cy * x + sy * zx;
  const zy = -sy * x + cy * zx;
  return [
    cz * xy - sz * yx + config.mappingLocation[0],
    sz * xy + cz * yx + config.mappingLocation[1],
    zy + config.mappingLocation[2],
  ];
}

export function hatStitchWaveHeightAtGenerated(generated: readonly number[], config: HatStitchMaterialConfig): number {
  return filamentWaveHeightAtCoordinate(mapHatStitchGenerated(generated, config), config.waveScale, {
    distortion: config.waveDistortion,
    detail: config.waveDetail,
    detailScale: config.waveDetailScale,
    detailRoughness: config.waveDetailRoughness,
    direction: "DIAGONAL",
  });
}

function glsl(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

function glslVector(vector: readonly number[]): string {
  return `vec3(${vector.map(glsl).join(", ")})`;
}

function mappingMatrix(config: HatStitchMaterialConfig): THREE.Matrix3 {
  const euler = new THREE.Euler(...config.mappingRotation, "XYZ");
  const matrix4 = new THREE.Matrix4().makeRotationFromEuler(euler);
  const rotation = new THREE.Matrix3().setFromMatrix4(matrix4);
  const scale = new THREE.Matrix3().set(
    config.mappingScale[0], 0, 0,
    0, config.mappingScale[1], 0,
    0, 0, config.mappingScale[2],
  );
  return rotation.multiply(scale);
}

/** Reconstruct the authored sitch.001 transmission, FACE color, and diagonal Wave/Bump branches. */
export function makeHatStitchMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  group: IndexGroup,
  materialName: string,
): THREE.MeshPhysicalMaterial | null {
  const config = extractHatStitchMaterialConfig(dump, materialName);
  if (!config) return null;
  const color = geometry.getAttribute(config.colorAttribute);
  const position = geometry.getAttribute("position");
  const bounds = filamentGroupBounds(geometry, group);
  if (!color || color.itemSize !== 3 || color.count !== position?.count || !bounds) return null;
  const extent = bounds.max.map((value, axis) => Math.max(value - bounds.min[axis], 1e-20));
  const matrix = mappingMatrix(config).elements;
  const wave: FilamentWaveConfig = {
    distortion: config.waveDistortion,
    detail: config.waveDetail,
    detailScale: config.waveDetailScale,
    detailRoughness: config.waveDetailRoughness,
    direction: "DIAGONAL",
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: THREE.MathUtils.clamp(config.metalness, 0, 1),
    roughness: THREE.MathUtils.clamp(config.roughness, 0, 1),
    ior: THREE.MathUtils.clamp(config.ior, 1, 2.333),
    transmission: THREE.MathUtils.clamp(config.transmission, 0, 1),
    thickness: 0,
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · authored Send Nodes Hat stitch reconstruction`;
  material.userData.hatStitchContract = config;
  material.userData.hatStitchBounds = bounds satisfies FilamentBounds;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute vec3 ${config.colorAttribute};\nvarying vec3 vHatStitchColor;\nvarying vec3 vHatStitchGenerated;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
vHatStitchColor = ${config.colorAttribute};
vec3 hatStitchGenerated = (position - ${glslVector(bounds.min)}) / ${glslVector(extent)};
vHatStitchGenerated = mat3(${matrix.map(glsl).join(", ")}) * hatStitchGenerated + ${glslVector(config.mappingLocation)};`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vHatStitchColor;
varying vec3 vHatStitchGenerated;

${filamentNoiseGlsl("hatStitch")}
${filamentWaveFunctionGlsl("hatStitch", "hatStitchWaveHeight", wave)}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
diffuseColor.rgb = max(vHatStitchColor, vec3(0.0));`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
${filamentBumpGlsl({
    prefix: "hatStitch",
    coordinate: "vHatStitchGenerated",
    heightFunction: (coordinate) => `hatStitchWaveHeight(${coordinate}, ${glsl(config.waveScale)})`,
    strength: config.bumpStrength,
    distance: config.bumpDistance,
    filterWidth: config.bumpFilterWidth,
    invert: config.bumpInvert,
  })}`);
  };
  material.customProgramCacheKey = () => `hat-stitch-${materialName}-${bounds.min.join(",")}-${bounds.max.join(",")}-v1`;
  return material;
}
