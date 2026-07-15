import * as THREE from "three";
import type { Dump } from "./gnvm";
import { MATERIAL_MATCH_ATTRIBUTE } from "./gnvm/geometry";
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
  const materialMatch = geometry.getAttribute(MATERIAL_MATCH_ATTRIBUTE);
  if (materialMatch?.itemSize === 1 && materialMatch.count === position.count) {
    for (let vertex = 0; vertex < position.count; vertex++)
      if (materialMatch.getX(vertex) > 0.5) roughness[vertex] = 2;
    const attribute = new THREE.BufferAttribute(roughness, 1);
    geometry.setAttribute("rough", attribute);
    return attribute;
  }
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
  const material = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(...config.baseColor),
    metalness: config.metallic,
    roughness: 0,
    envMapIntensity: 1,
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · authored Chain & Mace chrome reconstruction`;
  material.userData.chainMaceContract = config;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nattribute float ${config.roughnessAttribute};\nvarying float vChainMaceRough;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvChainMaceRough = ${config.roughnessAttribute};`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying float vChainMaceRough;
`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
// The authored Mapping output is connected to Noise.Scale, not Noise.Vector.
// Blender therefore evaluates one constant noise sample. Its mapped value is
// 1/15, yielding roughness 2/15 on the mace (rough=2) and zero on the chain.
roughnessFactor = clamp((1.0 / 15.0) * max(vChainMaceRough, 0.0), 0.0, 1.0);`);
  };
  material.customProgramCacheKey = () => `chain-mace-chrome-${materialName}-v2`;
  return material;
}
