import * as THREE from "three";
import type { Dump } from "./gnvm";

type RawSocket = { identifier?: string; name?: string; value?: unknown; default?: unknown };
type RawNode = { name: string; type: string; props?: Record<string, any>; inputs?: RawSocket[]; outputs?: RawSocket[] };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };

export type MahoganyMaterialConfig = {
  colorAAttribute: string;
  colorBAttribute: string;
  scaleAttribute: string;
  rotationAttribute: string;
  colorFallback: [number, number, number];
  waveScale: number;
  waveDistortion: number;
  waveDetail: number;
  wavePhase: number;
  noiseScale: number;
  noiseDistortion: number;
  mapToMin: number;
  roughnessRamp: { position: number; color: number }[];
  transmission: number;
  clearcoat: number;
  clearcoatRoughness: number;
};

function input(node: RawNode | undefined, name: string, fallback: number): number {
  const raw = node?.inputs?.find((socket) => socket.identifier === name || socket.name === name)?.value;
  if (raw === null || raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function attribute(nodes: RawNode[], name: string): RawNode | undefined {
  return nodes.find((node) => node.type === "ShaderNodeAttribute" && node.props?.attribute_name === name);
}

function attributeName(node: RawNode | undefined): string | null {
  const name = String(node?.props?.attribute_name ?? "");
  return /^[A-Za-z_]\w*$/.test(name) ? name : null;
}

function outputColor(node: RawNode | undefined): [number, number, number] | null {
  const raw = node?.outputs?.find((socket) => socket.identifier === "Color" || socket.name === "Color")?.default;
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const result = raw.slice(0, 3).map(Number);
  return result.every(Number.isFinite) ? result as [number, number, number] : null;
}

/** Recognize the joint pack's extracted `proc_ mahogany` shader graph. */
export function extractMahoganyMaterialConfig(dump: Dump, materialName: string): MahoganyMaterialConfig | null {
  const tree = dump.materials?.[materialName] as RawMaterial | undefined;
  const nodes = tree?.nodes ?? [];
  const links = tree?.links ?? [];
  const output = nodes.find((node) => node.type === "ShaderNodeOutputMaterial" && node.props?.is_active_output === true)
    ?? nodes.find((node) => node.type === "ShaderNodeOutputMaterial");
  const surface = output ? links.find((link) => link.to_node === output.name && link.to_socket === "Surface") : undefined;
  const principled = nodes.find((node) => node.name === surface?.from_node && node.type === "ShaderNodeBsdfPrincipled");
  const wave = nodes.find((node) => node.type === "ShaderNodeTexWave" && node.props?.wave_type === "BANDS" && node.props?.bands_direction === "X");
  const noise = nodes.find((node) => node.type === "ShaderNodeTexNoise" && node.props?.noise_dimensions === "3D");
  const mapRange = nodes.find((node) => node.name === "Map Range" && node.type === "ShaderNodeMapRange");
  const colorRamp = nodes.find((node) => node.name === "Color Ramp" && node.type === "ShaderNodeValToRGB");
  const roughnessRamp = nodes.find((node) => node.name === "Color Ramp.001" && node.type === "ShaderNodeValToRGB");
  const colorA = attribute(nodes, "col1"), colorB = attribute(nodes, "col2");
  const scale = attribute(nodes, "scale"), rotation = attribute(nodes, "rot");
  const colorAAttribute = attributeName(colorA), colorBAttribute = attributeName(colorB);
  const scaleAttribute = attributeName(scale), rotationAttribute = attributeName(rotation);
  const rampElements = roughnessRamp?.props?.color_ramp?.elements;
  const baseElements = colorRamp?.props?.color_ramp?.elements;
  const baseLink = principled ? links.find((link) => link.to_node === principled.name && link.to_socket === "Base Color") : undefined;
  const roughLink = principled ? links.find((link) => link.to_node === principled.name && link.to_socket === "Roughness") : undefined;
  if (!principled || !wave || !noise || !mapRange || !colorAAttribute || !colorBAttribute || !scaleAttribute || !rotationAttribute
    || baseLink?.from_node !== "Mix" || roughLink?.from_node !== "Mix.001"
    || !Array.isArray(rampElements) || rampElements.length < 2 || !Array.isArray(baseElements) || baseElements.length < 2) return null;
  const fallback = outputColor(colorA) ?? [0.8, 0.8, 0.8];
  return {
    colorAAttribute,
    colorBAttribute,
    scaleAttribute,
    rotationAttribute,
    colorFallback: fallback,
    waveScale: input(wave, "Scale", 1.38),
    waveDistortion: input(wave, "Distortion", 13.3),
    waveDetail: input(wave, "Detail", 10.23),
    wavePhase: input(wave, "Phase Offset", 4.35),
    noiseScale: input(noise, "Scale", 1000),
    noiseDistortion: input(noise, "Distortion", 0.57),
    mapToMin: input(mapRange, "To Min", -1.6521),
    roughnessRamp: rampElements.slice(0, 2).map((element: any) => ({
      position: Number(element.position),
      color: Number(element.color?.[0]),
    })),
    transmission: input(principled, "Transmission Weight", 0),
    clearcoat: input(principled, "Coat Weight", 0),
    clearcoatRoughness: input(principled, "Coat Roughness", 0.03),
  };
}

function glsl(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

export function makeMahoganyMaterial(dump: Dump, geometry: THREE.BufferGeometry, materialName: string): THREE.MeshPhysicalMaterial | null {
  const config = extractMahoganyMaterialConfig(dump, materialName);
  if (!config) return null;
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) return null;
  const size = bounds.getSize(new THREE.Vector3());
  const scale = geometry.getAttribute(config.scaleAttribute);
  const rotation = geometry.getAttribute(config.rotationAttribute);
  if (!scale || scale.itemSize !== 1 || !rotation || rotation.itemSize !== 3) return null;
  const colorA = geometry.getAttribute(config.colorAAttribute);
  const colorB = geometry.getAttribute(config.colorBAttribute);
  if ((colorA && colorA.itemSize !== 3) || (colorB && colorB.itemSize !== 3)) return null;

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.5,
    metalness: 0,
    transmission: THREE.MathUtils.clamp(config.transmission, 0, 1),
    clearcoat: THREE.MathUtils.clamp(config.clearcoat, 0, 1),
    clearcoatRoughness: THREE.MathUtils.clamp(config.clearcoatRoughness, 0, 1),
    transparent: config.transmission > 0,
    envMapIntensity: 0.8,
    side: THREE.DoubleSide,
  });
  material.name = `${materialName} · procedural mahogany reconstruction`;
  material.userData.mahoganyContract = config;
  material.onBeforeCompile = (shader) => {
    const fallback = config.colorFallback.map(glsl).join(",");
    const colorADeclaration = colorA ? `attribute vec3 ${config.colorAAttribute};` : "";
    const colorBDeclaration = colorB ? `attribute vec3 ${config.colorBAttribute};` : "";
    const colorAValue = colorA ? config.colorAAttribute : `vec3(${fallback})`;
    const colorBValue = colorB ? config.colorBAttribute : `vec3(${fallback})`;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${colorADeclaration}\n${colorBDeclaration}\nattribute float ${config.scaleAttribute};\nattribute vec3 ${config.rotationAttribute};\nvarying vec3 vMahoganyA;\nvarying vec3 vMahoganyB;\nvarying float vMahoganyScale;\nvarying vec3 vMahoganyRotation;\nvarying vec3 vMahoganyGenerated;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvMahoganyA=${colorAValue};\nvMahoganyB=${colorBValue};\nvMahoganyScale=${config.scaleAttribute};\nvMahoganyRotation=${config.rotationAttribute};\nvMahoganyGenerated=(position-vec3(${glsl(bounds.min.x)},${glsl(bounds.min.y)},${glsl(bounds.min.z)}))/max(vec3(${glsl(size.x)},${glsl(size.y)},${glsl(size.z)}),vec3(1e-7));`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vMahoganyA;varying vec3 vMahoganyB;varying float vMahoganyScale;varying vec3 vMahoganyRotation;varying vec3 vMahoganyGenerated;
float mahoganyHash(vec3 p){p=fract(p*0.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
vec3 mahoganyRotate(vec3 p,vec3 r){vec3 c=cos(r),s=sin(r);p=vec3(p.x,p.y*c.x-p.z*s.x,p.y*s.x+p.z*c.x);p=vec3(p.x*c.y+p.z*s.y,p.y,-p.x*s.y+p.z*c.y);return vec3(p.x*c.z-p.y*s.z,p.x*s.z+p.y*c.z,p.z);}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
vec3 mahoganyP=mahoganyRotate(vMahoganyGenerated*max(vMahoganyScale,1e-4),vMahoganyRotation);
float mahoganyNoise=mahoganyHash(mahoganyP*${glsl(config.noiseScale)}+${glsl(config.noiseDistortion)});
float mahoganyWarp=(mahoganyHash(mahoganyP*${glsl(config.waveDetail)})-0.5)*${glsl(config.waveDistortion)};
float mahoganyWave=0.5+0.5*sin((mahoganyP.x*${glsl(config.waveScale)}+mahoganyWarp+${glsl(config.wavePhase)})*6.28318530718);
float mahoganyMapped=mix(${glsl(config.mapToMin)},mahoganyNoise,mahoganyWave);
float mahoganyColorFactor=clamp(mahoganyMapped,0.0,1.0);
diffuseColor.rgb=mix(max(vMahoganyA,vec3(0.0)),max(vMahoganyB,vec3(0.0)),mahoganyColorFactor);`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
float mahoganyRamp=mix(${glsl(config.roughnessRamp[0].color)},${glsl(config.roughnessRamp[1].color)},clamp((mahoganyMapped-${glsl(config.roughnessRamp[0].position)})/max(${glsl(config.roughnessRamp[1].position - config.roughnessRamp[0].position)},1e-6),0.0,1.0));
roughnessFactor=clamp(mix(mahoganyMapped,mahoganyNoise,mahoganyRamp),0.0,1.0);`);
  };
  material.customProgramCacheKey = () => `mahogany-${materialName}-v1`;
  return material;
}
