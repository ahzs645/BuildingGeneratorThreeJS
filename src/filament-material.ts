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
  layerDetailScale: number;
  layerDetailRoughness: number;
  bumpStrength: number;
  bumpDistance: number;
  bumpFilterWidth: number;
  bumpInvert: boolean;
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
    layerDetailScale: input(wave, "Detail Scale", 1),
    layerDetailRoughness: input(wave, "Detail Roughness", 0.5),
    bumpStrength: input(bump, "Strength", 0.7),
    bumpDistance: input(bump, "Distance", 1),
    bumpFilterWidth: input(bump, "Filter Width", 1),
    bumpInvert: bump.props?.invert === true,
    darkValue: values.length ? Math.min(...values) : 0.164,
    brightValue: values.length ? Math.max(...values) : 0.868,
  };
}

type IndexGroup = { start: number; count: number; material: string | null };
export type FilamentBounds = { min: [number, number, number]; max: [number, number, number] };

/** Blender's Generated coordinates use the bounds of the shaded geometry component. */
export function filamentGroupBounds(geometry: THREE.BufferGeometry, group: IndexGroup): FilamentBounds | null {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  if (!position || group.count <= 0) return null;
  const end = Math.min(group.start + group.count, index?.count ?? position.count);
  if (group.start < 0 || group.start >= end) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let offset = group.start; offset < end; offset++) {
    const vertex = index ? index.getX(offset) : offset;
    for (let axis = 0; axis < 3; axis++) {
      const value = position.getComponent(vertex, axis);
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return min.every(Number.isFinite) && max.every(Number.isFinite) ? { min, max } : null;
}

function rotateLeft32(value: number, amount: number): number {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

/** A compact lookup3-style integer mixer, independently expressed for the browser VM. */
function hashLattice3(x: number, y: number, z: number): number {
  let a = (0xdeadbeef + (3 << 2) + 13 + (x >>> 0)) >>> 0;
  let b = (0xdeadbeef + (3 << 2) + 13 + (y >>> 0)) >>> 0;
  let c = (0xdeadbeef + (3 << 2) + 13 + (z >>> 0)) >>> 0;
  c = ((c ^ b) - rotateLeft32(b, 14)) >>> 0;
  a = ((a ^ c) - rotateLeft32(c, 11)) >>> 0;
  b = ((b ^ a) - rotateLeft32(a, 25)) >>> 0;
  c = ((c ^ b) - rotateLeft32(b, 16)) >>> 0;
  a = ((a ^ c) - rotateLeft32(c, 4)) >>> 0;
  b = ((b ^ a) - rotateLeft32(a, 14)) >>> 0;
  return ((c ^ b) - rotateLeft32(b, 24)) >>> 0;
}

function fade(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function gradient(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return (h & 1 ? -u : u) + (h & 2 ? -v : v);
}

/** Blender-normalized signed 3D gradient noise, also used as the shader oracle in tests. */
export function filamentSignedNoise3(point: readonly number[]): number {
  const cell = point.map(Math.floor);
  const local = point.map((value, axis) => value - cell[axis]);
  const weight = local.map(fade);
  const sample = (dx: number, dy: number, dz: number): number => gradient(
    hashLattice3(cell[0] + dx, cell[1] + dy, cell[2] + dz),
    local[0] - dx, local[1] - dy, local[2] - dz,
  );
  const mix = (a: number, b: number, amount: number): number => a + (b - a) * amount;
  const z0 = mix(
    mix(sample(0, 0, 0), sample(1, 0, 0), weight[0]),
    mix(sample(0, 1, 0), sample(1, 1, 0), weight[0]),
    weight[1],
  );
  const z1 = mix(
    mix(sample(0, 0, 1), sample(1, 0, 1), weight[0]),
    mix(sample(0, 1, 1), sample(1, 1, 1), weight[0]),
    weight[1],
  );
  return 0.982 * mix(z0, z1, weight[2]);
}

export function filamentWaveHeightAtGenerated(generated: readonly number[], config: FilamentMaterialConfig): number {
  const point = generated.map((value) => (value * config.layerScale + 1e-6) * 0.999999);
  let amplitude = 1;
  let frequency = config.layerDetailScale;
  let noise = 0;
  let normalization = 0;
  for (let octave = 0; octave <= Math.floor(config.layerDetail); octave++) {
    noise += amplitude * filamentSignedNoise3(point.map((value) => value * frequency));
    normalization += amplitude;
    amplitude *= config.layerDetailRoughness;
    frequency *= 2;
  }
  const phase = 20 * point[2] + config.layerDistortion * noise / normalization;
  return 0.5 + 0.5 * Math.sin(phase - Math.PI / 2);
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
  group: IndexGroup,
  materialName: string,
): THREE.MeshPhysicalMaterial | null {
  const config = extractFilamentMaterialConfig(dump, materialName);
  if (!config) return null;
  const color = geometry.getAttribute(config.colorAttribute);
  const bounds = filamentGroupBounds(geometry, group);
  if (!color || color.itemSize !== 3 || !bounds) return null;
  const extent = bounds.max.map((value, axis) => Math.max(value - bounds.min[axis], 1e-20));

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: THREE.MathUtils.clamp(config.roughness, 0, 1),
    envMapIntensity: 0.8,
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · N03D filament reconstruction`;
  material.userData.filamentContract = config;
  material.userData.filamentBounds = bounds;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute vec3 ${config.colorAttribute};\nvarying vec3 vFilamentColor;\nvarying vec3 vFilamentGenerated;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
vFilamentColor = ${config.colorAttribute};
vFilamentGenerated = (position - vec3(${bounds.min.map(glsl).join(", ")})) / vec3(${extent.map(glsl).join(", ")});`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vFilamentColor;
varying vec3 vFilamentGenerated;

uint filamentRotl(uint value, uint amount) { return (value << amount) | (value >> (32u - amount)); }
uint filamentHash(uvec3 key) {
  uint a = 0xdeadbeefu + 12u + 13u + key.x;
  uint b = 0xdeadbeefu + 12u + 13u + key.y;
  uint c = 0xdeadbeefu + 12u + 13u + key.z;
  c = (c ^ b) - filamentRotl(b, 14u); a = (a ^ c) - filamentRotl(c, 11u);
  b = (b ^ a) - filamentRotl(a, 25u); c = (c ^ b) - filamentRotl(b, 16u);
  a = (a ^ c) - filamentRotl(c, 4u); b = (b ^ a) - filamentRotl(a, 14u);
  return (c ^ b) - filamentRotl(b, 24u);
}
float filamentFade(float value) { return value * value * value * (value * (value * 6.0 - 15.0) + 10.0); }
float filamentGradient(uint hash, vec3 point) {
  uint h = hash & 15u;
  float u = h < 8u ? point.x : point.y;
  float v = h < 4u ? point.y : ((h == 12u || h == 14u) ? point.x : point.z);
  return ((h & 1u) != 0u ? -u : u) + ((h & 2u) != 0u ? -v : v);
}
float filamentNoise(vec3 point) {
  ivec3 cell = ivec3(floor(point)); vec3 local = fract(point);
  vec3 w = vec3(filamentFade(local.x), filamentFade(local.y), filamentFade(local.z));
  float n000 = filamentGradient(filamentHash(uvec3(cell + ivec3(0, 0, 0))), local - vec3(0, 0, 0));
  float n100 = filamentGradient(filamentHash(uvec3(cell + ivec3(1, 0, 0))), local - vec3(1, 0, 0));
  float n010 = filamentGradient(filamentHash(uvec3(cell + ivec3(0, 1, 0))), local - vec3(0, 1, 0));
  float n110 = filamentGradient(filamentHash(uvec3(cell + ivec3(1, 1, 0))), local - vec3(1, 1, 0));
  float n001 = filamentGradient(filamentHash(uvec3(cell + ivec3(0, 0, 1))), local - vec3(0, 0, 1));
  float n101 = filamentGradient(filamentHash(uvec3(cell + ivec3(1, 0, 1))), local - vec3(1, 0, 1));
  float n011 = filamentGradient(filamentHash(uvec3(cell + ivec3(0, 1, 1))), local - vec3(0, 1, 1));
  float n111 = filamentGradient(filamentHash(uvec3(cell + ivec3(1, 1, 1))), local - vec3(1, 1, 1));
  return 0.982 * mix(mix(mix(n000, n100, w.x), mix(n010, n110, w.x), w.y),
                     mix(mix(n001, n101, w.x), mix(n011, n111, w.x), w.y), w.z);
}
float filamentWaveHeight(vec3 generated) {
  vec3 point = (generated * ${glsl(config.layerScale)} + vec3(0.000001)) * 0.999999;
  float noise = filamentNoise(point * ${glsl(config.layerDetailScale)})
    + ${glsl(config.layerDetailRoughness)} * filamentNoise(point * ${glsl(config.layerDetailScale * 2)})
    + ${glsl(config.layerDetailRoughness ** 2)} * filamentNoise(point * ${glsl(config.layerDetailScale * 4)});
  float normalization = 1.0 + ${glsl(config.layerDetailRoughness)} + ${glsl(config.layerDetailRoughness ** 2)};
  float phase = 20.0 * point.z + ${glsl(config.layerDistortion)} * noise / normalization;
  return 0.5 + 0.5 * sin(phase - 1.5707963267948966);
}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
vec3 filamentFront = max(vFilamentColor, vec3(0.0));
float filamentValue = max(max(filamentFront.r, filamentFront.g), filamentFront.b);
vec3 filamentBack = vec3(filamentValue * ${glsl(config.darkValue)});
diffuseColor.rgb = gl_FrontFacing ? filamentFront : filamentBack;`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
float filamentH0 = filamentWaveHeight(vFilamentGenerated);
float filamentHx = filamentWaveHeight(vFilamentGenerated + dFdx(vFilamentGenerated) * ${glsl(config.bumpFilterWidth)});
float filamentHy = filamentWaveHeight(vFilamentGenerated + dFdy(vFilamentGenerated) * ${glsl(config.bumpFilterWidth)});
vec3 filamentP = -vViewPosition;
vec3 filamentDPdx = dFdx(filamentP), filamentDPdy = dFdy(filamentP);
vec3 filamentRx = cross(filamentDPdy, normal), filamentRy = cross(normal, filamentDPdx);
float filamentDet = dot(filamentDPdx, filamentRx);
vec3 filamentSurfgrad = (filamentHx - filamentH0) * filamentRx + (filamentHy - filamentH0) * filamentRy;
float filamentDistance = ${config.bumpInvert ? "-" : ""}${glsl(config.bumpDistance)} * (gl_FrontFacing ? 1.0 : -1.0);
vec3 filamentPerturbed = normalize(${glsl(config.bumpFilterWidth)} * abs(filamentDet) * normal
  - filamentDistance * sign(filamentDet) * filamentSurfgrad);
normal = normalize(mix(normal, filamentPerturbed, max(${glsl(config.bumpStrength)}, 0.0)));`);
  };
  material.customProgramCacheKey = () => `n03d-filament-${materialName}-${config.colorAttribute}-${bounds.min.join(",")}-${bounds.max.join(",")}-v3`;
  return material;
}
