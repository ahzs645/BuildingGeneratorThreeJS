import * as THREE from "three";
import type { Dump } from "./gnvm";
import {
  filamentBumpGlsl,
  filamentGroupBounds,
  filamentNoiseGlsl,
  filamentWaveFunctionGlsl,
} from "./filament-material";

type RawSocket = { identifier?: string; name?: string; linked?: boolean; value?: unknown };
type RawOutput = { identifier?: string; name?: string; default?: unknown };
type RawNode = {
  name: string;
  type: string;
  props?: Record<string, unknown>;
  inputs?: RawSocket[];
  outputs?: RawOutput[];
};
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };
type IndexGroup = { start: number; count: number; material: string | null };

export type KnitThreadWaveConfig = {
  direction: "X" | "DIAGONAL";
  mappingRotation: [number, number, number];
  mappingScale: number;
  scale: number;
  distortion: number;
  detail: number;
  detailScale: number;
  detailRoughness: number;
  phaseOffset: number;
};

export type KnitThreadMaterialConfig = {
  brightColor: [number, number, number];
  darkColor: [number, number, number];
  roughness: number;
  ior: number;
  waveMix: number;
  waves: [KnitThreadWaveConfig, KnitThreadWaveConfig];
  bumpStrength: number;
  bumpDistance: number;
  bumpFilterWidth: number;
  bumpInvert: boolean;
};

function socket(node: RawNode | undefined, ...names: string[]): RawSocket | undefined {
  return node?.inputs?.find((candidate) => names.includes(candidate.identifier ?? "") || names.includes(candidate.name ?? ""));
}

function numberInput(node: RawNode | undefined, name: string, fallback: number): number {
  const value = Number(socket(node, name)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function vectorInput(node: RawNode | undefined, name: string): [number, number, number] | null {
  const value = socket(node, name)?.value;
  if (!Array.isArray(value) || value.length < 3) return null;
  const result = value.slice(0, 3).map(Number);
  return result.every(Number.isFinite) ? result as [number, number, number] : null;
}

function outputNumber(node: RawNode | undefined, name: string): number | null {
  const value = Number(node?.outputs?.find((candidate) => candidate.identifier === name || candidate.name === name)?.default);
  return Number.isFinite(value) ? value : null;
}

function linkTo(links: RawLink[], node: RawNode | undefined, socketName: string): RawLink | undefined {
  return node ? links.find((candidate) => candidate.to_node === node.name && candidate.to_socket === socketName) : undefined;
}

function sourceNode(nodes: RawNode[], link: RawLink | undefined, type?: string): RawNode | undefined {
  const node = nodes.find((candidate) => candidate.name === link?.from_node);
  return !type || node?.type === type ? node : undefined;
}

function rgbToHsv(color: [number, number, number]): [number, number, number] {
  const max = Math.max(...color);
  const min = Math.min(...color);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === color[0]) hue = ((color[1] - color[2]) / delta) % 6;
    else if (max === color[1]) hue = (color[2] - color[0]) / delta + 2;
    else hue = (color[0] - color[1]) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }
  return [hue, max === 0 ? 0 : delta / max, max];
}

function hsvToRgb([hue, saturation, value]: [number, number, number]): [number, number, number] {
  const wrapped = ((hue % 1) + 1) % 1;
  const sector = wrapped * 6;
  const index = Math.floor(sector);
  const fraction = sector - index;
  const p = value * (1 - saturation);
  const q = value * (1 - fraction * saturation);
  const t = value * (1 - (1 - fraction) * saturation);
  return ([
    [value, t, p],
    [q, value, p],
    [p, value, t],
    [p, q, value],
    [t, p, value],
    [value, p, q],
  ][index % 6] ?? [value, p, q]) as [number, number, number];
}

function hueSaturationColor(node: RawNode, inputColor: [number, number, number]): [number, number, number] {
  const [hue, saturation, value] = rgbToHsv(inputColor);
  const adjusted = hsvToRgb([
    hue + numberInput(node, "Hue", 0.5) - 0.5,
    Math.max(0, saturation * numberInput(node, "Saturation", 1)),
    Math.max(0, value * numberInput(node, "Value", 1)),
  ]);
  const factor = THREE.MathUtils.clamp(numberInput(node, "Fac", 1), 0, 1);
  return inputColor.map((component, axis) => component + (adjusted[axis] - component) * factor) as [number, number, number];
}

function extractWave(
  nodes: RawNode[],
  links: RawLink[],
  wave: RawNode,
  valueNode: RawNode,
): KnitThreadWaveConfig | null {
  const mapping = sourceNode(nodes, linkTo(links, wave, "Vector"), "ShaderNodeMapping");
  const coordinate = sourceNode(nodes, linkTo(links, mapping, "Vector"), "ShaderNodeTexCoord");
  const scaleLink = linkTo(links, mapping, "Scale");
  if (
    !mapping
    || !coordinate
    || scaleLink?.from_node !== valueNode.name
    || scaleLink.from_socket !== "Value"
    || wave.props?.wave_type !== "BANDS"
    || (wave.props?.bands_direction !== "X" && wave.props?.bands_direction !== "DIAGONAL")
  ) return null;
  const rotation = vectorInput(mapping, "Rotation");
  const mappingScale = outputNumber(valueNode, "Value");
  if (!rotation || mappingScale === null) return null;
  return {
    direction: wave.props.bands_direction,
    mappingRotation: rotation,
    mappingScale,
    scale: numberInput(wave, "Scale", 1),
    distortion: numberInput(wave, "Distortion", 0),
    detail: numberInput(wave, "Detail", 2),
    detailScale: numberInput(wave, "Detail Scale", 1),
    detailRoughness: numberInput(wave, "Detail Roughness", 0.5),
    phaseOffset: numberInput(wave, "Phase Offset", 0),
  };
}

/** Recognize the supplied two-wave procedural thread shader by graph wiring. */
export function extractKnitThreadMaterialConfig(dump: Dump, materialName: string): KnitThreadMaterialConfig | null {
  const tree = dump.materials?.[materialName] as RawMaterial | undefined;
  const nodes = tree?.nodes ?? [];
  const links = tree?.links ?? [];
  const output = nodes.find((node) => node.type === "ShaderNodeOutputMaterial" && node.props?.is_active_output === true)
    ?? nodes.find((node) => node.type === "ShaderNodeOutputMaterial");
  const principled = sourceNode(nodes, linkTo(links, output, "Surface"), "ShaderNodeBsdfPrincipled");
  const colorMix = sourceNode(nodes, linkTo(links, principled, "Base Color"), "ShaderNodeMix");
  const bump = sourceNode(nodes, linkTo(links, principled, "Normal"), "ShaderNodeBump");
  const waveMixFromColor = sourceNode(nodes, linkTo(links, colorMix, "Factor_Float"), "ShaderNodeMix");
  const waveMixFromHeight = sourceNode(nodes, linkTo(links, bump, "Height"), "ShaderNodeMix");
  if (!principled || !colorMix || !bump || !waveMixFromColor || waveMixFromColor !== waveMixFromHeight) return null;

  const waveA = sourceNode(nodes, linkTo(links, waveMixFromColor, "A_Color"), "ShaderNodeTexWave");
  const waveB = sourceNode(nodes, linkTo(links, waveMixFromColor, "B_Color"), "ShaderNodeTexWave");
  const valueNode = nodes.find((node) => node.type === "ShaderNodeValue");
  const brightHsv = sourceNode(nodes, linkTo(links, colorMix, "A_Color"), "ShaderNodeHueSaturation");
  const darkHsv = sourceNode(nodes, linkTo(links, colorMix, "B_Color"), "ShaderNodeHueSaturation");
  const darkInput = linkTo(links, darkHsv, "Color");
  const baseColor = vectorInput(brightHsv, "Color");
  if (
    !waveA
    || !waveB
    || !valueNode
    || !brightHsv
    || !darkHsv
    || darkInput?.from_node !== brightHsv.name
    || !baseColor
  ) return null;

  const firstWave = extractWave(nodes, links, waveA, valueNode);
  const secondWave = extractWave(nodes, links, waveB, valueNode);
  if (!firstWave || !secondWave) return null;
  const brightColor = hueSaturationColor(brightHsv, baseColor);
  const darkColor = hueSaturationColor(darkHsv, brightColor);
  return {
    brightColor,
    darkColor,
    roughness: numberInput(principled, "Roughness", 0.5),
    ior: numberInput(principled, "IOR", 1.45),
    waveMix: numberInput(waveMixFromColor, "Factor_Float", 0.5),
    waves: [firstWave, secondWave],
    bumpStrength: numberInput(bump, "Strength", 1),
    bumpDistance: numberInput(bump, "Distance", 1),
    bumpFilterWidth: numberInput(bump, "Filter Width", 1),
    bumpInvert: bump.props?.invert === true,
  };
}

function glsl(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

function vec3(value: readonly number[]): string {
  return `vec3(${value.map(glsl).join(", ")})`;
}

function mappingGlsl(): string {
  return `vec3 knitMap(vec3 point, vec3 rotation, float scale) {
  point *= scale;
  float cx = cos(rotation.x), sx = sin(rotation.x);
  point.yz = mat2(cx, sx, -sx, cx) * point.yz;
  float cy = cos(rotation.y), sy = sin(rotation.y);
  point.xz = mat2(cy, -sy, sy, cy) * point.xz;
  float cz = cos(rotation.z), sz = sin(rotation.z);
  point.xy = mat2(cz, sz, -sz, cz) * point.xy;
  return point;
}`;
}

export function makeKnitThreadMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  group: IndexGroup,
  materialName: string,
): THREE.MeshPhysicalMaterial | null {
  const config = extractKnitThreadMaterialConfig(dump, materialName);
  const bounds = filamentGroupBounds(geometry, group);
  if (!config || !bounds) return null;
  const extent = bounds.max.map((value, axis) => Math.max(value - bounds.min[axis], 1e-20));

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: THREE.MathUtils.clamp(config.roughness, 0, 1),
    ior: THREE.MathUtils.clamp(config.ior, 1, 2.333),
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · procedural knit thread reconstruction`;
  material.userData.knitThreadContract = config;
  material.userData.knitThreadBounds = bounds;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vKnitGenerated;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
vKnitGenerated = (position - ${vec3(bounds.min)}) / ${vec3(extent)};`);
    const waveFunctions = config.waves.map((wave, index) => filamentWaveFunctionGlsl("knit", `knitWave${index}`, {
      distortion: wave.distortion,
      detail: wave.detail,
      detailScale: wave.detailScale,
      detailRoughness: wave.detailRoughness,
      direction: wave.direction,
      phaseOffset: wave.phaseOffset,
    })).join("\n");
    const waveSamples = config.waves.map((wave, index) =>
      `knitWave${index}(knitMap(vKnitGenerated, ${vec3(wave.mappingRotation)}, ${glsl(wave.mappingScale)}), ${glsl(wave.scale)})`);
    const height = `mix(${waveSamples[0]}, ${waveSamples[1]}, ${glsl(config.waveMix)})`;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vKnitGenerated;
${filamentNoiseGlsl("knit")}
${mappingGlsl()}
${waveFunctions}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
float knitColorHeight = ${height};
diffuseColor.rgb = mix(${vec3(config.brightColor)}, ${vec3(config.darkColor)}, clamp(knitColorHeight, 0.0, 1.0));`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
${filamentBumpGlsl({
    prefix: "knit",
    coordinate: "vKnitGenerated",
    heightFunction: () => height,
    strength: config.bumpStrength,
    distance: config.bumpDistance,
    filterWidth: config.bumpFilterWidth,
    invert: config.bumpInvert,
  })}`);
  };
  material.customProgramCacheKey = () =>
    `knit-thread-${materialName}-${bounds.min.join(",")}-${bounds.max.join(",")}-v1`;
  return material;
}
