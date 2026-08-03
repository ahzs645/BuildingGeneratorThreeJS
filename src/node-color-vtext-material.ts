import * as THREE from "three";
import {
  blenderPcg3d,
  filamentBumpGlsl,
  filamentGroupBounds,
  generatedCoordinateGlsl,
  voronoiDistance3,
  voronoiGlsl,
  type FilamentBounds,
} from "./materials/blender-glsl";
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

export type NodeColorVtextMaterialConfig = {
  baseColor: [number, number, number];
  metallic: number;
  roughness: number;
  ior: number;
  specularIorLevel: number;
  mappingLocation: [number, number, number];
  mappingRotation: [number, number, number];
  mappingScale: [number, number, number];
  voronoiScale: number;
  voronoiSmoothness: number;
  voronoiRandomness: number;
  threshold: number;
  bumpStrength: number;
  bumpDistance: number;
  bumpFilterWidth: number;
  bumpInvert: boolean;
};

const CONTRACT: NodeColorVtextMaterialConfig = {
  baseColor: [0, 0.11227122694253922, 0.06201505288481712],
  metallic: 0,
  roughness: 0.8012232780456543,
  ior: 1.4500000476837158,
  specularIorLevel: 0.377675861120224,
  mappingLocation: [0, 0, 0],
  mappingRotation: [1.5707963705062866, 0.7853981852531433, 0],
  mappingScale: [1, 1, 1.440000057220459],
  voronoiScale: 791.2999267578125,
  voronoiSmoothness: 1,
  voronoiRandomness: 0.7094972133636475,
  threshold: 0.5,
  bumpStrength: 0.3284916281700134,
  bumpDistance: 1,
  bumpFilterWidth: 1,
  bumpInvert: false,
};

const MATERIAL_LINKS: [string, string, string, string][] = [
  ["Group", "Output_0", "Principled BSDF", "Normal"],
  ["Principled BSDF", "BSDF", "Material Output", "Surface"],
];

const GROUP_LINKS: [string, string, string, string][] = [
  ["Bump", "Normal", "Group Output", "Output_0"],
  ["Math", "Value", "Bump", "Height"],
  ["Texture Coordinate", "Generated", "Mapping", "Vector"],
  ["Mapping", "Vector", "Voronoi Texture", "Vector"],
  ["Voronoi Texture", "Distance", "Map Range", "Value"],
  ["Map Range", "Result", "Math", "Value"],
];

function input(node: RawNode | undefined, identifier: string): unknown {
  return node?.inputs?.find((socket) => socket.identifier === identifier || socket.name === identifier)?.value;
}

function exactNumber(value: unknown, expected: number): boolean {
  return Number(value) === expected;
}

function exactVector(value: unknown, expected: readonly number[]): boolean {
  return Array.isArray(value) && value.length >= expected.length
    && expected.every((component, axis) => Number(value[axis]) === component);
}

function nodeMap(tree: RawTree): Map<string, RawNode> {
  return new Map((tree.nodes ?? []).map((node) => [node.name, node]));
}

function exactNode(nodes: Map<string, RawNode>, name: string, type: string): RawNode | undefined {
  const node = nodes.get(name);
  return node?.type === type ? node : undefined;
}

function hasExactLinks(tree: RawTree, expected: [string, string, string, string][]): boolean {
  const links = tree.links ?? [];
  return links.length === expected.length && expected.every(([fromNode, fromSocket, toNode, toSocket]) =>
    links.some((link) => link.from_node === fromNode && link.from_socket === fromSocket
      && link.to_node === toNode && link.to_socket === toSocket));
}

function exactProps(node: RawNode | undefined, expected: Record<string, unknown>): boolean {
  return !!node && Object.entries(expected).every(([name, value]) => node.props?.[name] === value);
}

/** Strictly recognize Point.001's authored node-color material and `vtext` group. */
export function extractNodeColorVtextMaterialConfig(
  dump: Dump,
  materialName: string,
): NodeColorVtextMaterialConfig | null {
  if (materialName !== "node color.geometry") return null;
  const material = dump.materials?.[materialName] as RawTree | undefined;
  const group = dump.shader_node_groups?.vtext as RawTree | undefined;
  if (!material || !group || material.nodes?.length !== 3 || group.nodes?.length !== 7
    || !hasExactLinks(material, MATERIAL_LINKS) || !hasExactLinks(group, GROUP_LINKS)) return null;

  const materialNodes = nodeMap(material);
  const output = exactNode(materialNodes, "Material Output", "ShaderNodeOutputMaterial");
  const principled = exactNode(materialNodes, "Principled BSDF", "ShaderNodeBsdfPrincipled");
  const groupInstance = exactNode(materialNodes, "Group", "ShaderNodeGroup");
  if (!output || !principled || !groupInstance || output.props?.is_active_output !== true
    || (groupInstance.props?.node_tree as { name?: string } | undefined)?.name !== "vtext"
    || !exactVector(input(principled, "Base Color"), [...CONTRACT.baseColor, 1])
    || !exactNumber(input(principled, "Metallic"), CONTRACT.metallic)
    || !exactNumber(input(principled, "Roughness"), CONTRACT.roughness)
    || !exactNumber(input(principled, "IOR"), CONTRACT.ior)
    || !exactNumber(input(principled, "Specular IOR Level"), CONTRACT.specularIorLevel)
    || !exactNumber(input(principled, "Alpha"), 1)
    || !exactNumber(input(principled, "Transmission Weight"), 0)
    || !exactNumber(input(principled, "Coat Weight"), 0)) return null;

  const nodes = nodeMap(group);
  const voronoi = exactNode(nodes, "Voronoi Texture", "ShaderNodeTexVoronoi");
  const mapRange = exactNode(nodes, "Map Range", "ShaderNodeMapRange");
  const threshold = exactNode(nodes, "Math", "ShaderNodeMath");
  const bump = exactNode(nodes, "Bump", "ShaderNodeBump");
  const mapping = exactNode(nodes, "Mapping", "ShaderNodeMapping");
  const texCoord = exactNode(nodes, "Texture Coordinate", "ShaderNodeTexCoord");
  const groupOutput = exactNode(nodes, "Group Output", "NodeGroupOutput");
  if (!voronoi || !mapRange || !threshold || !bump || !mapping || !texCoord || !groupOutput
    || !exactProps(voronoi, { voronoi_dimensions: "3D", distance: "EUCLIDEAN", feature: "SMOOTH_F1", normalize: false })
    || !exactNumber(input(voronoi, "Scale"), CONTRACT.voronoiScale)
    || !exactNumber(input(voronoi, "Detail"), 0)
    || !exactNumber(input(voronoi, "Roughness"), 0.5)
    || !exactNumber(input(voronoi, "Lacunarity"), 2)
    || !exactNumber(input(voronoi, "Smoothness"), CONTRACT.voronoiSmoothness)
    || !exactNumber(input(voronoi, "Exponent"), 0.5)
    || !exactNumber(input(voronoi, "Randomness"), CONTRACT.voronoiRandomness)
    || !exactProps(mapRange, { clamp: true, interpolation_type: "LINEAR", data_type: "FLOAT" })
    || !exactNumber(input(mapRange, "From Min"), 0)
    || !exactNumber(input(mapRange, "From Max"), 1)
    || !exactNumber(input(mapRange, "To Min"), 0)
    || !exactNumber(input(mapRange, "To Max"), 1)
    || !exactProps(threshold, { operation: "GREATER_THAN", use_clamp: false })
    || !exactNumber(input(threshold, "Value_001"), CONTRACT.threshold)
    || !exactProps(bump, { invert: CONTRACT.bumpInvert })
    || !exactNumber(input(bump, "Strength"), CONTRACT.bumpStrength)
    || !exactNumber(input(bump, "Distance"), CONTRACT.bumpDistance)
    || !exactNumber(input(bump, "Filter Width"), CONTRACT.bumpFilterWidth)
    || !exactProps(mapping, { vector_type: "POINT" })
    || !exactVector(input(mapping, "Location"), CONTRACT.mappingLocation)
    || !exactVector(input(mapping, "Rotation"), CONTRACT.mappingRotation)
    || !exactVector(input(mapping, "Scale"), CONTRACT.mappingScale)
    || texCoord.props?.object !== null || texCoord.props?.from_instancer !== false
    || groupOutput.props?.is_active_output !== true) return null;

  return structuredClone(CONTRACT);
}

function glsl(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

function glslVector(value: readonly number[]): string {
  return `vec3(${value.map(glsl).join(", ")})`;
}

const f32 = Math.fround;
export { blenderPcg3d as nodeColorPcg3d };

function rotateXYZ(point: readonly number[], rotation: readonly number[]): [number, number, number] {
  const cosine = rotation.map((value) => f32(Math.cos(f32(value))));
  const sine = rotation.map((value) => f32(Math.sin(f32(value))));
  const x = f32(point[0]);
  const y = f32(f32(cosine[0] * f32(point[1])) - f32(sine[0] * f32(point[2])));
  const z = f32(f32(sine[0] * f32(point[1])) + f32(cosine[0] * f32(point[2])));
  const x2 = f32(f32(cosine[1] * x) + f32(sine[1] * z));
  const z2 = f32(f32(-sine[1] * x) + f32(cosine[1] * z));
  return [
    f32(f32(cosine[2] * x2) - f32(sine[2] * y)),
    f32(f32(sine[2] * x2) + f32(cosine[2] * y)),
    z2,
  ];
}

/** Blender 5.1's 3D Euclidean Smooth F1 kernel, including its effective half-smoothness. */
export function nodeColorSmoothF1AtCoordinate(
  coordinate: readonly number[],
  randomness = CONTRACT.voronoiRandomness,
  smoothness = CONTRACT.voronoiSmoothness,
): number {
  return voronoiDistance3(coordinate, { feature: "SMOOTH_F1", randomness, smoothness });
}

export function nodeColorVtextSmoothF1AtGenerated(
  generated: readonly number[],
  config: NodeColorVtextMaterialConfig = CONTRACT,
): number {
  const scaled = generated.map((value, axis) => f32(value * config.mappingScale[axis]));
  const rotated = rotateXYZ(scaled, config.mappingRotation)
    .map((value, axis) => f32(f32(value + config.mappingLocation[axis]) * config.voronoiScale));
  return nodeColorSmoothF1AtCoordinate(rotated, config.voronoiRandomness, config.voronoiSmoothness);
}

export function nodeColorVtextHeightAtGenerated(
  generated: readonly number[],
  config: NodeColorVtextMaterialConfig = CONTRACT,
): number {
  const mapped = Math.max(0, Math.min(1, nodeColorVtextSmoothF1AtGenerated(generated, config)));
  return mapped > config.threshold ? 1 : 0;
}

function shaderFunctions(config: NodeColorVtextMaterialConfig): string {
  return `${voronoiGlsl({ prefix: "nodeColor", feature: "SMOOTH_F1", functionName: "nodeColorSmoothF1" })}
vec3 nodeColorRotateXYZ(vec3 point, vec3 rotation) {
  vec3 cosine = cos(rotation), sine = sin(rotation);
  point = vec3(point.x, cosine.x * point.y - sine.x * point.z,
               sine.x * point.y + cosine.x * point.z);
  point = vec3(cosine.y * point.x + sine.y * point.z, point.y,
               -sine.y * point.x + cosine.y * point.z);
  return vec3(cosine.z * point.x - sine.z * point.y,
              sine.z * point.x + cosine.z * point.y, point.z);
}
float nodeColorVtextHeight(vec3 generated) {
  vec3 mapped = nodeColorRotateXYZ(generated * ${glslVector(config.mappingScale)}, ${glslVector(config.mappingRotation)})
    + ${glslVector(config.mappingLocation)};
  float distanceValue = clamp(nodeColorSmoothF1(mapped * ${glsl(config.voronoiScale)}, ${glsl(config.voronoiRandomness)}, ${glsl(config.voronoiSmoothness)}), 0.0, 1.0);
  return distanceValue > ${glsl(config.threshold)} ? 1.0 : 0.0;
}`;
}

/** Reconstruct Point.001's authored `node color.geometry` micro-bump material. */
export function makeNodeColorVtextMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  group: IndexGroup,
  materialName: string,
): THREE.MeshPhysicalMaterial | null {
  const config = extractNodeColorVtextMaterialConfig(dump, materialName);
  if (!config) return null;
  const bounds = filamentGroupBounds(geometry, group);
  if (!bounds) return null;
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(...config.baseColor),
    metalness: config.metallic,
    roughness: config.roughness,
    ior: config.ior,
    specularIntensity: config.specularIorLevel,
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · authored Nodes Node vtext reconstruction`;
  material.userData.nodeColorVtextContract = config;
  material.userData.nodeColorVtextBounds = bounds satisfies FilamentBounds;
  material.userData.nodeColorVtextRenderer = {
    status: "Blender 5.1 Smooth F1 scalar semantics with renderer approximation",
    exact: ["strict graph contract", "Principled constants", "Generated bounds", "PCG3D cell jitter", "3D Smooth F1 kernel"],
    approximation: "Three.js screen derivatives and lighting replace Blender's Bump closure and Eevee raster pipeline.",
  };
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vNodeColorGenerated;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${generatedCoordinateGlsl("vNodeColor", bounds)}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vNodeColorGenerated;\n\n${shaderFunctions(config)}`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
${filamentBumpGlsl({
    prefix: "nodeColor",
    coordinate: "vNodeColorGenerated",
    heightFunction: (coordinate) => `nodeColorVtextHeight(${coordinate})`,
    strength: config.bumpStrength,
    distance: config.bumpDistance,
    filterWidth: config.bumpFilterWidth,
    invert: config.bumpInvert,
  })}`);
  };
  material.customProgramCacheKey = () =>
    `nodes-node-color-vtext-${bounds.min.join(",")}-${bounds.max.join(",")}-v2`;
  return material;
}
