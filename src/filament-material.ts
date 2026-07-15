import * as THREE from "three";
import type { Dump } from "./gnvm";

type RawSocket = { identifier?: string; name?: string; value?: unknown };
type RawNode = { name: string; type: string; props?: Record<string, unknown>; inputs?: RawSocket[] };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };

export type FilamentMaterialConfig = {
  colorAttribute: string;
  roughness: number;
  layerScale: number;
  layerDistortion: number;
  layerDetail: number;
  bumpStrength: number;
  bumpDistance: number;
  darkValue: number;
  brightValue: number;
};

function input(node: RawNode | undefined, name: string, fallback: number): number {
  const value = Number(node?.inputs?.find((socket) => socket.identifier === name || socket.name === name)?.value);
  return Number.isFinite(value) ? value : fallback;
}

/** Recognize the shared N03D generated-coordinate layer-line filament shader. */
export function extractFilamentMaterialConfig(dump: Dump, materialName: string): FilamentMaterialConfig | null {
  const tree = dump.materials?.[materialName] as RawMaterial | undefined;
  const nodes = tree?.nodes ?? [];
  const links = tree?.links ?? [];
  const output = nodes.find((node) => node.type === "ShaderNodeOutputMaterial" && node.props?.is_active_output === true)
    ?? nodes.find((node) => node.type === "ShaderNodeOutputMaterial");
  const surface = output ? links.find((link) => link.to_node === output.name && link.to_socket === "Surface") : undefined;
  const mixShader = nodes.find((node) => node.name === surface?.from_node && node.type === "ShaderNodeMixShader");
  if (!mixShader) return null;

  const facing = links.find((link) => link.to_node === mixShader.name && link.to_socket === "Fac");
  const geometry = nodes.find((node) => node.name === facing?.from_node && node.type === "ShaderNodeNewGeometry");
  const frontLink = links.find((link) => link.to_node === mixShader.name && link.to_socket === "Shader");
  const front = nodes.find((node) => node.name === frontLink?.from_node && node.type === "ShaderNodeBsdfPrincipled");
  const backLink = links.find((link) => link.to_node === mixShader.name && link.to_socket === "Shader_001");
  const back = nodes.find((node) => node.name === backLink?.from_node && node.type === "ShaderNodeBsdfPrincipled");
  const bumpLink = front ? links.find((link) => link.to_node === front.name && link.to_socket === "Normal") : undefined;
  const bump = nodes.find((node) => node.name === bumpLink?.from_node && node.type === "ShaderNodeBump");
  const heightLink = bump ? links.find((link) => link.to_node === bump.name && link.to_socket === "Height") : undefined;
  const wave = nodes.find((node) => node.name === heightLink?.from_node && node.type === "ShaderNodeTexWave"
    && node.props?.wave_type === "BANDS" && node.props?.bands_direction === "Z");
  const attribute = nodes.find((node) => node.type === "ShaderNodeAttribute" && node.props?.attribute_name === "col")
    ?? nodes.find((node) => node.type === "ShaderNodeAttribute");
  const colorAttribute = String(attribute?.props?.attribute_name ?? "");
  const values = nodes.filter((node) => node.type === "ShaderNodeHueSaturation").map((node) => input(node, "Value", 1));
  if (!geometry || facing?.from_socket !== "Backfacing" || !front || !back || !bump || !wave || !/^[A-Za-z_]\w*$/.test(colorAttribute)) return null;

  return {
    colorAttribute,
    roughness: input(front, "Roughness", 0.77),
    layerScale: input(wave, "Scale", -56),
    layerDistortion: input(wave, "Distortion", 0),
    layerDetail: input(wave, "Detail", 2),
    bumpStrength: input(bump, "Strength", 0.7),
    bumpDistance: input(bump, "Distance", 1),
    darkValue: values.length ? Math.min(...values) : 0.164,
    brightValue: values.length ? Math.max(...values) : 0.868,
  };
}

function glsl(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

/**
 * Reconstruct the shared N03D filament color branches in WebGL. Blender's
 * COLOR blend keeps the front-side `col` value unchanged: both inputs have the
 * same hue/saturation, so the Wave factor only blends identical HSV color.
 * The back branch desaturates that color and scales its HSV value. Wave/Bump
 * normal perturbation remains a separate renderer-parity target.
 */
export function makeFilamentMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  materialName: string,
): THREE.MeshPhysicalMaterial | null {
  const config = extractFilamentMaterialConfig(dump, materialName);
  if (!config) return null;
  const color = geometry.getAttribute(config.colorAttribute);
  if (!color || color.itemSize !== 3) return null;

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: THREE.MathUtils.clamp(config.roughness, 0, 1),
    envMapIntensity: 0.8,
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · N03D filament reconstruction`;
  material.userData.filamentContract = config;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute vec3 ${config.colorAttribute};\nvarying vec3 vFilamentColor;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvFilamentColor = ${config.colorAttribute};`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vFilamentColor;`)
      .replace("#include <color_fragment>", `#include <color_fragment>
vec3 filamentFront = max(vFilamentColor, vec3(0.0));
float filamentValue = max(max(filamentFront.r, filamentFront.g), filamentFront.b);
vec3 filamentBack = vec3(filamentValue * ${glsl(config.darkValue)});
diffuseColor.rgb = gl_FrontFacing ? filamentFront : filamentBack;`);
  };
  material.customProgramCacheKey = () => `n03d-filament-${materialName}-${config.colorAttribute}-v2`;
  return material;
}
