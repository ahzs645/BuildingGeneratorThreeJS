import * as THREE from "three";
import type { Dump } from "./gnvm";
import { extractChromeCrayonMaterialConfig, type ChromeCrayonMaterialConfig } from "./chrome-crayon-material";

type MaterialGroup = { start: number; count: number; material: string | null };

export type ChainMaceMaterialConfig = ChromeCrayonMaterialConfig & {
  material: string;
  missingRoughnessResolvesTo: 0;
};

/**
 * Recognize the material carried by the evaluated Chain & Mace result.
 *
 * Blender's realized mesh has two slots (`chrome.002`, null), but every one of
 * its 214,718 faces resolves to slot zero. The source object's `grainy test`
 * material is therefore not part of the generated surface. `chrome.002` has
 * the same authored anisotropic noise/roughness contract as Chrome Crayon;
 * this asset does not export its `rough` attribute, so Blender's Attribute
 * node returns zero and the complete result is polished metal.
 */
export function extractChainMaceMaterialConfig(dump: Dump, materialName: string): ChainMaceMaterialConfig | null {
  const chrome = extractChromeCrayonMaterialConfig(dump, materialName);
  return chrome ? { material: materialName, ...chrome, missingRoughnessResolvesTo: 0 } : null;
}

/**
 * Restore Blender's face-domain `rough` attribute on the exact triangle soup.
 * The source dependency carries a uniform value of 2 on all 9,310 mace faces;
 * the joined chain has no value and therefore resolves to zero. The portable
 * evaluator currently exports only the unrelated `1` attribute, so this small
 * deterministic material adapter restores the shader input without changing
 * GN topology or core evaluation.
 */
export function attachChainMaceRoughnessAttribute(geometry: THREE.BufferGeometry, groups: MaterialGroup[]): THREE.BufferAttribute | null {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  if (!position || !index) return null;
  const roughness = new Float32Array(position.count);
  for (const group of groups) {
    if (group.material !== "chrome.002") continue;
    const end = Math.min(group.start + group.count, index.count);
    for (let offset = group.start; offset < end; offset++) roughness[index.getX(offset)] = 2;
  }
  const attribute = new THREE.BufferAttribute(roughness, 1);
  geometry.setAttribute("rough", attribute);
  return attribute;
}

export function makeChainMaceMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  materialName: string,
): THREE.MeshPhysicalMaterial | null {
  const config = extractChainMaceMaterialConfig(dump, materialName);
  if (!config) return null;
  const roughness = geometry.getAttribute(config.roughnessAttribute);
  if (!roughness || roughness.itemSize !== 1) return null;
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) return null;
  const size = bounds.getSize(new THREE.Vector3());
  const scalar = (value: number): string => Number.isInteger(value) ? value.toFixed(1) : String(value);
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(...config.baseColor),
    metalness: config.metallic,
    roughness: 0,
    envMapIntensity: 1.35,
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · authored Chain & Mace chrome reconstruction`;
  material.userData.chainMaceContract = config;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute float ${config.roughnessAttribute};\nvarying vec3 vChainMaceGenerated;\nvarying float vChainMaceRough;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvChainMaceGenerated = (position - vec3(${scalar(bounds.min.x)}, ${scalar(bounds.min.y)}, ${scalar(bounds.min.z)})) / max(vec3(${scalar(size.x)}, ${scalar(size.y)}, ${scalar(size.z)}), vec3(1e-7));\nvChainMaceRough = ${config.roughnessAttribute};`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vChainMaceGenerated;
varying float vChainMaceRough;
float chainMaceHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float chainMaceNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(chainMaceHash(i), chainMaceHash(i + vec3(1,0,0)), f.x), mix(chainMaceHash(i + vec3(0,1,0)), chainMaceHash(i + vec3(1,1,0)), f.x), f.y), mix(mix(chainMaceHash(i + vec3(0,0,1)), chainMaceHash(i + vec3(1,0,1)), f.x), mix(chainMaceHash(i + vec3(0,1,1)), chainMaceHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float chainMaceFbm(vec3 p) {
  float sum = 0.0, amplitude = 0.5714286, normalization = 0.0;
  for (int octave = 0; octave < 3; octave++) {
    sum += chainMaceNoise(p) * amplitude;
    normalization += amplitude;
    p *= ${scalar(config.noise.lacunarity)};
    amplitude *= ${scalar(config.noise.roughness)};
  }
  return sum / max(normalization, 1e-7);
}
`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
vec3 chainMaceMapped = vChainMaceGenerated * vec3(${config.generatedScale.map(scalar).join(", ")});
float chainMaceScale = (chainMaceMapped.x + chainMaceMapped.y + chainMaceMapped.z) / 3.0;
vec3 chainMacePosition = vChainMaceGenerated * chainMaceScale;
chainMacePosition += ${scalar(config.noise.distortion)} * vec3(
  chainMaceNoise(chainMacePosition + vec3(0.0, 0.0, 0.0)),
  chainMaceNoise(chainMacePosition + vec3(19.1, 7.7, 3.4)),
  chainMaceNoise(chainMacePosition + vec3(5.2, 23.8, 11.6))
);
float chainMaceFac = chainMaceFbm(chainMacePosition);
float chainMaceMappedRoughness = ${scalar(config.noise.toMin)} + (chainMaceFac - ${scalar(config.noise.fromMin)}) * (${scalar(config.noise.toMax)} - ${scalar(config.noise.toMin)}) / max(${scalar(config.noise.fromMax)} - ${scalar(config.noise.fromMin)}, 1e-7);
roughnessFactor = clamp(chainMaceMappedRoughness * max(vChainMaceRough, 0.0), 0.0, 1.0);`);
  };
  material.customProgramCacheKey = () => `chain-mace-chrome-${materialName}-v1`;
  return material;
}
