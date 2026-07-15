import * as THREE from "three";
import {
  filamentBumpGlsl,
  filamentNoiseGlsl,
  filamentWaveFunctionGlsl,
  filamentWaveHeightAtCoordinate,
  filamentWhiteNoise3,
  type FilamentBounds,
  type FilamentWaveConfig,
} from "./filament-material";
import type { Dump } from "./gnvm";

type RawSocket = { identifier?: string; name?: string; value?: unknown; default?: unknown };
type RawNode = { name: string; type: string; props?: Record<string, unknown>; inputs?: RawSocket[]; outputs?: RawSocket[] };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };

type Range = { min: number; max: number };

export type MathClayFilamentConfig = {
  fieldMix: number;
  waveDetail: number;
  waveDetailScale: number;
  waveDetailRoughness: number;
  height: Range;
  roughness: Range;
  coatWeight: Range;
  coatRoughness: Range;
  coatIor: number;
  bumpStrength: number;
  bumpDistance: number;
  bumpFilterWidth: number;
  bumpInvert: boolean;
  backHue: number;
  backSaturation: number;
  backValue: number;
  backWaveScale: number;
  backWaveThreshold: number;
  bevelRadius: number;
};

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
  mathClay: MathClayFilamentConfig | null;
};

export type MathClayFilamentField = {
  mapped: [number, number, number];
  white: [number, number, number];
  wave: number;
  scalar: number;
  height: number;
  roughness: number;
  coatWeight: number;
  coatRoughness: number;
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

function linkedNode(nodes: RawNode[], links: RawLink[], to: RawNode | undefined, socket: string): RawNode | undefined {
  const link = to ? links.find((candidate) => candidate.to_node === to.name && candidate.to_socket === socket) : undefined;
  return nodes.find((node) => node.name === link?.from_node);
}

function range(node: RawNode | undefined, fallbackMin: number, fallbackMax: number): Range {
  return { min: input(node, "To Min", fallbackMin), max: input(node, "To Max", fallbackMax) };
}

function isLinkedFrom(links: RawLink[], from: RawNode | undefined, to: RawNode | undefined, socket: string): boolean {
  return Boolean(from && to && links.some((link) => link.from_node === from.name && link.to_node === to.name && link.to_socket === socket));
}

/** Recognize the joint/Math filament + cross-section material contract. */
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
  const bump = linkedNode(nodes, links, principled, "Normal");
  const heightMap = linkedNode(nodes, links, bump, "Height");
  const fieldMix = heightMap ? linkedNode(nodes, links, heightMap, "Value") : undefined;
  const wave = fieldMix ? linkedNode(nodes, links, fieldMix, "B_Color") : undefined;
  const whiteNoise = fieldMix ? linkedNode(nodes, links, fieldMix, "A_Color") : undefined;
  const mappingNode = wave ? linkedNode(nodes, links, wave, "Vector") : undefined;
  const scaleNode = mappingNode ? linkedNode(nodes, links, mappingNode, "Scale") : undefined;
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
  const emissionMix = linkedNode(nodes, links, backEmission, "Color");
  const blackColor = colorInput(emissionMix, "B_Color");
  const blackBackfaceEmission = frontShader?.from_node === principled?.name
    && blackColor !== null
    && blackColor.slice(0, 3).every((component) => component === 0);
  if (!surfaceMix || !principled || !bump || bump.type !== "ShaderNodeBump" || !heightMap || heightMap.type !== "ShaderNodeMapRange"
    || !fieldMix || fieldMix.type !== "ShaderNodeMix" || !wave || wave.type !== "ShaderNodeTexWave"
    || !whiteNoise || whiteNoise.type !== "ShaderNodeTexWhiteNoise" || !colorLink || !layerLink
    || !mappingNode || mappingNode.type !== "ShaderNodeMapping" || !scaleNode || !blackBackfaceEmission) return null;

  const roughnessMap = linkedNode(nodes, links, principled, "Roughness");
  const coatWeightMap = linkedNode(nodes, links, principled, "Coat Weight");
  const coatRoughnessMap = linkedNode(nodes, links, principled, "Coat Roughness");
  const mathTopology = roughnessMap?.type === "ShaderNodeMapRange"
    && coatWeightMap?.type === "ShaderNodeMapRange"
    && coatRoughnessMap?.type === "ShaderNodeMapRange"
    && isLinkedFrom(links, fieldMix, roughnessMap, "Value")
    && isLinkedFrom(links, fieldMix, coatWeightMap, "Value")
    && isLinkedFrom(links, fieldMix, coatRoughnessMap, "Value")
    && !roughnessLink;

  let mathClay: MathClayFilamentConfig | null = null;
  if (mathTopology) {
    const hue = nodes.find((node) => node.type === "ShaderNodeHueSaturation" && isLinkedFrom(links, colorNode, node, "Color"));
    const backWave = nodes.find((node) => node.type === "ShaderNodeTexWave" && node.props?.bands_direction === "DIAGONAL");
    const backThreshold = nodes.find((node) => node.type === "ShaderNodeMath" && node.props?.operation === "LESS_THAN"
      && isLinkedFrom(links, backWave, node, "Value"));
    const bevel = linkedNode(nodes, links, bump, "Normal");
    mathClay = {
      fieldMix: input(fieldMix, "Factor_Float", 0.8409091234207153),
      waveDetail: input(wave, "Detail", 2),
      waveDetailScale: input(wave, "Detail Scale", 1),
      waveDetailRoughness: input(wave, "Detail Roughness", 0.5),
      height: range(heightMap, 0.98974609375, 1.126708984375),
      roughness: range(roughnessMap, 1, 0.50048828125),
      coatWeight: range(coatWeightMap, -2.08837890625, 1.2119140625),
      coatRoughness: range(coatRoughnessMap, 0.7176513671875, 0.10000000149011612),
      coatIor: input(principled, "Coat IOR", 1.5),
      bumpStrength: input(bump, "Strength", 1),
      bumpDistance: input(bump, "Distance", 1),
      bumpFilterWidth: input(bump, "Filter Width", 1),
      bumpInvert: bump.props?.invert === true,
      backHue: input(hue, "Hue", 0.5),
      backSaturation: input(hue, "Saturation", 0.6),
      backValue: input(hue, "Value", 0.128),
      backWaveScale: input(backWave, "Scale", 51.1998291015625),
      backWaveThreshold: input(backThreshold, "Value_001", 0.05),
      bevelRadius: input(bevel, "Input_1", 0.5),
    };
  }

  return {
    colorAttribute: "col",
    roughnessAttribute: roughnessLink ? "rough" : null,
    roughnessFallback: input(principled, "Roughness", 0.5),
    layerAttribute: "layer",
    blackBackfaceEmission,
    mappingScale: output(scaleNode, "Value", 85),
    waveDistortion: input(wave, "Distortion", 0),
    bumpMin: input(heightMap, "To Min", 0.99),
    bumpMax: input(heightMap, "To Max", 1.13),
    mathClay,
  };
}

function lerp(range: Range, value: number): number {
  return range.min + (range.max - range.min) * value;
}

/** CPU oracle for the Math-only Generated/White Noise/Wave material field. */
export function mathClayFilamentFieldAtGenerated(
  generated: readonly number[],
  layer: number,
  config: CrossSectionFilamentConfig,
): MathClayFilamentField | null {
  const math = config.mathClay;
  if (!math) return null;
  const mapped = generated.map((value) => Math.fround(Math.fround(value) * Math.fround(config.mappingScale))) as [number, number, number];
  const waveConfig: FilamentWaveConfig = {
    distortion: config.waveDistortion,
    detail: math.waveDetail,
    detailScale: math.waveDetailScale,
    detailRoughness: math.waveDetailRoughness,
    direction: "Z",
  };
  const wave = filamentWaveHeightAtCoordinate(mapped, Math.fround(layer), waveConfig);
  const white = filamentWhiteNoise3(mapped);
  const mixed = white.map((value) => value + (wave - value) * math.fieldMix);
  const scalar = 0.2126 * mixed[0] + 0.7152 * mixed[1] + 0.0722 * mixed[2];
  return {
    mapped,
    white,
    wave,
    scalar,
    height: lerp(math.height, scalar),
    roughness: lerp(math.roughness, scalar),
    coatWeight: lerp(math.coatWeight, scalar),
    coatRoughness: lerp(math.coatRoughness, scalar),
  };
}

function glsl(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

function geometryBounds(geometry: THREE.BufferGeometry): FilamentBounds | null {
  const position = geometry.getAttribute("position");
  if (!position?.count) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < position.count; index++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = position.getComponent(index, axis);
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return min.every(Number.isFinite) && max.every(Number.isFinite) ? { min, max } : null;
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
  const bounds = config.mathClay ? geometryBounds(geometry) : null;
  if (!color || color.itemSize !== 3 || (config.roughnessAttribute && (!roughness || roughness.itemSize !== 1))
    || !layer || layer.itemSize !== 1 || (config.mathClay && !bounds)) return null;

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: THREE.MathUtils.clamp(config.roughnessFallback, 0, 1),
    clearcoat: config.mathClay ? 1 : 0,
    envMapIntensity: 0.8,
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · joint filament reconstruction`;
  material.userData.crossSectionFilamentContract = config;
  if (bounds) material.userData.crossSectionFilamentBounds = bounds;
  const viewport = new THREE.Vector2(1, 1);
  material.onBeforeRender = (renderer) => {
    if (config.mathClay) renderer.getDrawingBufferSize(viewport);
  };
  material.onBeforeCompile = (shader) => {
    const roughnessDeclaration = config.roughnessAttribute ? `attribute float ${config.roughnessAttribute};` : "";
    const roughnessValue = config.roughnessAttribute ?? glsl(config.roughnessFallback);
    const mathVertexDeclaration = config.mathClay ? `\nattribute float ${config.layerAttribute};\nvarying vec3 vMathFilamentGenerated;\nvarying float vMathFilamentLayer;` : "";
    const mathVertexValue = config.mathClay && bounds ? `
vMathFilamentGenerated=(position-vec3(${bounds.min.map(glsl).join(",")}))/vec3(${bounds.max.map((value, axis) => glsl(Math.max(value - bounds.min[axis], 1e-20))).join(",")});
vMathFilamentLayer=${config.layerAttribute};` : "";
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute vec3 ${config.colorAttribute};\n${roughnessDeclaration}\nvarying vec3 vJointColor;\nvarying float vJointRoughness;${mathVertexDeclaration}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvJointColor=${config.colorAttribute};\nvJointRoughness=${roughnessValue};${mathVertexValue}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vJointColor;\nvarying float vJointRoughness;")
      .replace("#include <color_fragment>", `#include <color_fragment>
diffuseColor.rgb=gl_FrontFacing?max(vJointColor,vec3(0.0)):vec3(0.0);`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor=clamp(vJointRoughness,0.0,1.0);")
      .replace("#include <opaque_fragment>", "if(!gl_FrontFacing)outgoingLight=vec3(0.0);\n#include <opaque_fragment>");

    if (config.mathClay && bounds) {
      const math = config.mathClay;
      const waveConfig: FilamentWaveConfig = {
        distortion: config.waveDistortion,
        detail: math.waveDetail,
        detailScale: math.waveDetailScale,
        detailRoughness: math.waveDetailRoughness,
        direction: "Z",
      };
      shader.uniforms ??= {};
      shader.uniforms.mathFilamentViewport = { value: viewport };
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
uniform vec2 mathFilamentViewport;
varying vec3 vMathFilamentGenerated;
varying float vMathFilamentLayer;
${filamentNoiseGlsl("mathFilament", true)}
${filamentWaveFunctionGlsl("mathFilament", "mathFilamentWave", waveConfig)}
${filamentWaveFunctionGlsl("mathFilament", "mathFilamentBackWave", { ...waveConfig, direction: "DIAGONAL" })}
float mathFilamentField(vec3 generated) {
  vec3 mapped=generated*${glsl(config.mappingScale)};
  vec3 white=mathFilamentWhiteNoise3(mapped);
  float wave=mathFilamentWave(mapped,vMathFilamentLayer);
  vec3 mixed=mix(white,vec3(wave),${glsl(math.fieldMix)});
  return dot(mixed,vec3(0.2126,0.7152,0.0722));
}
float mathFilamentHeight(vec3 generated) {
  return mix(${glsl(math.height.min)},${glsl(math.height.max)},mathFilamentField(generated));
}
vec3 mathFilamentBackColor(vec3 jointColor) {
  vec3 front=max(jointColor,vec3(0.0));
  float value=max(max(front.r,front.g),front.b);
  vec3 color=mix(vec3(value),front,${glsl(math.backSaturation)})*${glsl(math.backValue)};
  vec2 windowCoordinate=gl_FragCoord.xy/max(mathFilamentViewport,vec2(1.0));
  float mask=mathFilamentBackWave(vec3(windowCoordinate,0.0),${glsl(math.backWaveScale)});
  return mask<${glsl(math.backWaveThreshold)}?vec3(0.0):color;
}`)
        .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
roughnessFactor=clamp(mix(${glsl(math.roughness.min)},${glsl(math.roughness.max)},mathFilamentField(vMathFilamentGenerated)),0.0,1.0);`)
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
${filamentBumpGlsl({
          prefix: "mathFilamentBump",
          coordinate: "vMathFilamentGenerated",
          heightFunction: (coordinate) => `mathFilamentHeight(${coordinate})`,
          strength: math.bumpStrength,
          distance: math.bumpDistance,
          filterWidth: math.bumpFilterWidth,
          invert: math.bumpInvert,
        })}`)
        .replace("#include <lights_physical_fragment>", THREE.ShaderChunk.lights_physical_fragment
          .replace("material.clearcoat = clearcoat;", `material.clearcoat = clamp(mix(${glsl(math.coatWeight.min)},${glsl(math.coatWeight.max)},mathFilamentField(vMathFilamentGenerated)),0.0,1.0);`)
          .replace("material.clearcoatRoughness = clearcoatRoughness;", `material.clearcoatRoughness = clamp(mix(${glsl(math.coatRoughness.min)},${glsl(math.coatRoughness.max)},mathFilamentField(vMathFilamentGenerated)),0.0,1.0);`))
        .replace("if(!gl_FrontFacing)outgoingLight=vec3(0.0);", "if(!gl_FrontFacing)outgoingLight=mathFilamentBackColor(vJointColor);");
    }
  };
  material.customProgramCacheKey = () => `joint-filament-${materialName}-${config.mathClay ? "math-v1" : "v2"}`;
  return material;
}
