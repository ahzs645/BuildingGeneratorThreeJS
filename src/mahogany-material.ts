import * as THREE from "three";
import type { Dump } from "./gnvm";
import {
  filamentBumpGlsl,
  filamentNoiseGlsl,
  filamentWaveFunctionGlsl,
} from "./filament-material";

type RawSocket = { identifier?: string; name?: string; value?: unknown; default?: unknown };
type RawNode = { name: string; type: string; props?: Record<string, any>; inputs?: RawSocket[]; outputs?: RawSocket[] };
type RawLink = { from_node: string; from_socket: string; to_node: string; to_socket: string };
type RawMaterial = { nodes?: RawNode[]; links?: RawLink[] };

type MahoganyCommonConfig = {
  variant: "attributes" | "n03d";
  waveScale: number;
  waveDistortion: number;
  waveDetail: number;
  waveDetailScale: number;
  waveDetailRoughness: number;
  wavePhase: number;
  noiseScale: number;
  noiseDetail: number;
  noiseRoughness: number;
  noiseLacunarity: number;
  noiseDistortion: number;
  noiseNormalize: boolean;
  mapToMin: number;
  transmission: number;
  clearcoat: number;
  clearcoatRoughness: number;
};

export type AttributeMahoganyMaterialConfig = MahoganyCommonConfig & {
  variant: "attributes";
  colorAAttribute: string;
  colorBAttribute: string;
  scaleAttribute: string;
  rotationAttribute: string;
  colorFallback: [number, number, number];
  roughnessRamp: { position: number; color: number }[];
};

export type N03dMahoganyMaterialConfig = MahoganyCommonConfig & {
  variant: "n03d";
  colorA: [number, number, number];
  colorB: [number, number, number];
  mappingScale: number;
  mappingRotation: [number, number, number];
  noiseConstant: number;
  bumpHeightMin: number;
  bumpHeightMax: number;
  bumpStrength: number;
  bumpDistance: number;
  bumpFilterWidth: number;
  bumpInvert: boolean;
  roughnessRemap: { min: number; max: number };
};

export type MahoganyMaterialConfig = AttributeMahoganyMaterialConfig | N03dMahoganyMaterialConfig;

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

function vectorInput(node: RawNode | undefined, name: string): [number, number, number] | null {
  const socket = node?.inputs?.find((candidate) => candidate.identifier === name || candidate.name === name);
  const raw = socket?.value ?? socket?.default;
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const result = raw.slice(0, 3).map(Number);
  return result.every(Number.isFinite) ? result as [number, number, number] : null;
}

function linkedSource(nodes: RawNode[], links: RawLink[], target: RawNode, socket: string): {
  node: RawNode;
  socket: string;
} | null {
  const link = links.find((candidate) => candidate.to_node === target.name && candidate.to_socket === socket);
  const node = nodes.find((candidate) => candidate.name === link?.from_node);
  return link && node ? { node, socket: link.from_socket } : null;
}

function scalarOutput(nodes: RawNode[], links: RawLink[], node: RawNode, socket: string, depth = 0): number | null {
  if (depth > 8) return null;
  if (node.type === "ShaderNodeValue") {
    const output = node.outputs?.find((candidate) => candidate.identifier === socket || candidate.name === socket)
      ?? node.outputs?.[0];
    const value = Number(output?.default ?? output?.value);
    return Number.isFinite(value) ? value : null;
  }
  if (node.type === "ShaderNodeMath" && node.props?.operation === "SUBTRACT") {
    const first = scalarInput(nodes, links, node, "Value", depth + 1);
    const second = scalarInput(nodes, links, node, "Value_001", depth + 1);
    return first === null || second === null ? null : first - second;
  }
  return null;
}

function scalarInput(nodes: RawNode[], links: RawLink[], node: RawNode, socket: string, depth = 0): number | null {
  const source = linkedSource(nodes, links, node, socket);
  if (source) return scalarOutput(nodes, links, source.node, source.socket, depth + 1);
  const raw = node.inputs?.find((candidate) => candidate.identifier === socket || candidate.name === socket);
  const value = Number(raw?.value ?? raw?.default);
  return Number.isFinite(value) ? value : null;
}

function hsvAdjust(
  color: [number, number, number],
  hue: number,
  saturation: number,
  value: number,
): [number, number, number] {
  const maximum = Math.max(...color);
  const minimum = Math.min(...color);
  const range = maximum - minimum;
  let sourceHue = 0;
  if (range !== 0) {
    sourceHue = maximum === color[0]
      ? (color[1] - color[2]) / range
      : maximum === color[1]
        ? 2 + (color[2] - color[0]) / range
        : 4 + (color[0] - color[1]) / range;
    sourceHue = ((sourceHue / 6) % 1 + 1) % 1;
  }
  const adjustedHue = ((sourceHue + hue - 0.5) % 1 + 1) % 1;
  const adjustedSaturation = THREE.MathUtils.clamp(
    maximum === 0 ? 0 : range / maximum * saturation,
    0,
    1,
  );
  const adjustedValue = THREE.MathUtils.clamp(maximum * value, 0, 1);
  const sector = adjustedHue * 6;
  const index = Math.floor(sector);
  const fraction = sector - index;
  const p = adjustedValue * (1 - adjustedSaturation);
  const q = adjustedValue * (1 - adjustedSaturation * fraction);
  const t = adjustedValue * (1 - adjustedSaturation * (1 - fraction));
  return ([
    [adjustedValue, t, p], [q, adjustedValue, p], [p, adjustedValue, t],
    [p, q, adjustedValue], [t, p, adjustedValue], [adjustedValue, p, q],
  ][index % 6] ?? [adjustedValue, p, q]) as [number, number, number];
}

function n03dNoiseConstant(noise: RawNode | undefined): number | null {
  const exact = noise?.type === "ShaderNodeTexNoise"
    && noise.props?.noise_dimensions === "3D"
    && input(noise, "Scale", 0) === 1000
    && input(noise, "Detail", 0) === 2
    && input(noise, "Roughness", 0) === 0.5
    && input(noise, "Lacunarity", 0) === 2
    && input(noise, "Distortion", 0) === 0.5699999928474426
    && vectorInput(noise, "Vector")?.every((value) => value === 0);
  // The socket is unlinked, so this is a single deterministic value. It was
  // probed from Blender 5.1's float render result rather than inferred from the
  // display transform.
  return exact ? 0.49755859375 : null;
}

/** Recognize the joint and N03D packs' extracted `proc_ mahogany` graphs. */
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
  if (!principled || !wave || !noise || !mapRange) return null;
  const common: Omit<MahoganyCommonConfig, "variant"> = {
    waveScale: input(wave, "Scale", 1.38),
    waveDistortion: input(wave, "Distortion", 13.3),
    waveDetail: input(wave, "Detail", 10.23),
    waveDetailScale: input(wave, "Detail Scale", 1),
    waveDetailRoughness: input(wave, "Detail Roughness", 0.5),
    wavePhase: input(wave, "Phase Offset", 4.35),
    noiseScale: input(noise, "Scale", 1000),
    noiseDetail: input(noise, "Detail", 2),
    noiseRoughness: input(noise, "Roughness", 0.5),
    noiseLacunarity: input(noise, "Lacunarity", 2),
    noiseDistortion: input(noise, "Distortion", 0.57),
    noiseNormalize: noise.props?.normalize === true,
    mapToMin: input(mapRange, "To Min", -1.6521),
    transmission: input(principled, "Transmission Weight", 0),
    clearcoat: input(principled, "Coat Weight", 0),
    clearcoatRoughness: input(principled, "Coat Roughness", 0.03),
  };

  if (colorAAttribute && colorBAttribute && scaleAttribute && rotationAttribute
    && baseLink?.from_node === "Mix" && roughLink?.from_node === "Mix.001"
    && Array.isArray(rampElements) && rampElements.length >= 2
    && Array.isArray(baseElements) && baseElements.length >= 2) {
    return {
      variant: "attributes",
      ...common,
      colorAAttribute,
      colorBAttribute,
      scaleAttribute,
      rotationAttribute,
      // Blender's Attribute shader node returns zero when a named geometry
      // attribute is absent. Its UI output preview remains 0.8 gray, but that
      // display default is not the evaluated missing-attribute value.
      colorFallback: [0, 0, 0],
      roughnessRamp: rampElements.slice(0, 2).map((element: any) => ({
        position: Number(element.position),
        color: Number(element.color?.[0]),
      })),
    };
  }

  const mix = nodes.find((node) => node.name === baseLink?.from_node && node.type === "ShaderNodeMix");
  const bumpLink = links.find((link) => link.to_node === principled.name && link.to_socket === "Normal");
  const bump = nodes.find((node) => node.name === bumpLink?.from_node && node.type === "ShaderNodeBump");
  const heightLink = bump ? links.find((link) => link.to_node === bump.name && link.to_socket === "Height") : undefined;
  const bumpRange = nodes.find((node) => node.name === heightLink?.from_node && node.type === "ShaderNodeMapRange");
  const mappingLink = links.find((link) => link.to_node === wave.name && link.to_socket === "Vector");
  const mapping = nodes.find((node) => node.name === mappingLink?.from_node && node.type === "ShaderNodeMapping");
  const group = nodes.find((node) => node.name === roughLink?.from_node && node.type === "ShaderNodeGroup");
  const sourceColorNode = nodes.find((node) => node.type === "ShaderNodeRGB");
  const sourceColor = outputColor(sourceColorNode);
  const colorBNode = nodes.find((node) => node.name === "Hue/Saturation/Value.001" && node.type === "ShaderNodeHueSaturation");
  const colorANode = nodes.find((node) => node.name === "Hue/Saturation/Value" && node.type === "ShaderNodeHueSaturation");
  const n03dColorB = sourceColor && colorBNode ? hsvAdjust(
    sourceColor,
    scalarInput(nodes, links, colorBNode, "Hue") ?? 0.5,
    scalarInput(nodes, links, colorBNode, "Saturation") ?? 1,
    scalarInput(nodes, links, colorBNode, "Value") ?? 1,
  ) : null;
  // The second HSV node does not read RGB directly: it reads the first HSV
  // result through Reroute. The first node's negative Value clamps that branch
  // to black, so the downstream saturation/value adjustment remains black too.
  const n03dColorA = n03dColorB && colorANode ? hsvAdjust(
    n03dColorB,
    scalarInput(nodes, links, colorANode, "Hue") ?? 0.5,
    scalarInput(nodes, links, colorANode, "Saturation") ?? 1,
    scalarInput(nodes, links, colorANode, "Value") ?? 1,
  ) : null;
  const mappingScale = mapping ? scalarInput(nodes, links, mapping, "Scale") : null;
  const mappingRotation = vectorInput(mapping, "Rotation");
  const noiseConstant = n03dNoiseConstant(noise);
  const bumpHeightMin = bumpRange ? scalarInput(nodes, links, bumpRange, "To_Min_FLOAT3") : null;
  const bumpHeightMax = bumpRange ? scalarInput(nodes, links, bumpRange, "To_Max_FLOAT3") : null;
  if (!mix || mix.props?.data_type !== "RGBA" || mix.props?.clamp_factor !== false
    || group?.props?.node_tree?.name !== "NodeGroup.015"
    || !bump || !bumpRange || !mapping || !n03dColorA || !n03dColorB
    || mappingScale === null || !mappingRotation || noiseConstant === null
    || bumpHeightMin === null || bumpHeightMax === null) return null;

  return {
    variant: "n03d",
    ...common,
    colorA: n03dColorA,
    colorB: n03dColorB,
    mappingScale,
    mappingRotation,
    noiseConstant,
    bumpHeightMin,
    bumpHeightMax,
    bumpStrength: input(bump, "Strength", 0.5),
    bumpDistance: input(bump, "Distance", 1),
    bumpFilterWidth: input(bump, "Filter Width", 1),
    bumpInvert: bump.props?.invert === true,
    roughnessRemap: { min: 0.3687744140625, max: 191.3863525390625 },
  };
}

function glsl(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

function mahoganyNoiseTextureGlsl(config: MahoganyCommonConfig): string {
  const completedOctaves = Math.max(1, Math.floor(config.noiseDetail) + 1);
  const amplitudes = Array.from(
    { length: completedOctaves },
    (_, octave) => config.noiseRoughness ** octave,
  );
  const frequencies = Array.from(
    { length: completedOctaves },
    (_, octave) => config.noiseLacunarity ** octave,
  );
  const sum = amplitudes.map(
    (amplitude, octave) => `${glsl(amplitude)} * mahoganyNoise(p * ${glsl(frequencies[octave])})`,
  ).join("\n    + ");
  const maxAmplitude = amplitudes.reduce((total, amplitude) => total + amplitude, 0);
  const remainder = config.noiseDetail - Math.floor(config.noiseDetail);
  const normalized = config.noiseNormalize
    ? `0.5 * (${sum}) / ${glsl(maxAmplitude)} + 0.5`
    : `(${sum})`;
  const nextAmplitude = config.noiseRoughness ** completedOctaves;
  const nextFrequency = config.noiseLacunarity ** completedOctaves;
  const withRemainder = remainder === 0
    ? normalized
    : config.noiseNormalize
      ? `mix(${normalized}, 0.5 * ((${sum}) + ${glsl(nextAmplitude)} * mahoganyNoise(p * ${glsl(nextFrequency)})) / ${glsl(maxAmplitude + nextAmplitude)} + 0.5, ${glsl(remainder)})`
      : `mix(${normalized}, ((${sum}) + ${glsl(nextAmplitude)} * mahoganyNoise(p * ${glsl(nextFrequency)})), ${glsl(remainder)})`;
  // Blender's random_vector3_offset(seed) uses hash_float2_to_float and
  // maps each component into [100, 200]. These lookup3-derived values are the
  // seed 0/1/2 offsets used by the 3D Noise Texture distortion branch.
  const offsets = [
    [186.03127584467438, 114.9559537682114, 154.44750347045425],
    [199.8400018782914, 162.2925926843408, 154.048234399885],
    [111.63384265071569, 157.36939531224067, 199.0881114730351],
  ];
  return `float mahoganyTextureNoise(vec3 generated) {
  vec3 p = generated * ${glsl(config.noiseScale)};
  p += vec3(
    mahoganyNoise(p + vec3(${offsets[0].map(glsl).join(",")})),
    mahoganyNoise(p + vec3(${offsets[1].map(glsl).join(",")})),
    mahoganyNoise(p + vec3(${offsets[2].map(glsl).join(",")}))) * ${glsl(config.noiseDistortion)};
  return ${withRemainder};
}`;
}

export function makeMahoganyMaterial(dump: Dump, geometry: THREE.BufferGeometry, materialName: string): THREE.MeshPhysicalMaterial | null {
  const config = extractMahoganyMaterialConfig(dump, materialName);
  if (!config) return null;
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) return null;
  const size = bounds.getSize(new THREE.Vector3());
  if (config.variant === "n03d") {
    const material = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: THREE.MathUtils.clamp(config.roughnessRemap.min, 0, 1),
      metalness: 0,
      transmission: THREE.MathUtils.clamp(config.transmission, 0, 1),
      clearcoat: THREE.MathUtils.clamp(config.clearcoat, 0, 1),
      clearcoatRoughness: THREE.MathUtils.clamp(config.clearcoatRoughness, 0, 1),
      transparent: config.transmission > 0,
      envMapIntensity: 0.8,
      side: THREE.DoubleSide,
    });
    material.name = `${materialName} · N03D procedural mahogany reconstruction`;
    material.userData.mahoganyContract = config;
    material.onBeforeCompile = (shader) => {
      const rotation = config.mappingRotation.map(glsl).join(",");
      const colorA = config.colorA.map(glsl).join(",");
      const colorB = config.colorB.map(glsl).join(",");
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vMahoganyGenerated;")
        .replace("#include <begin_vertex>", `#include <begin_vertex>
vMahoganyGenerated=(position-vec3(${glsl(bounds.min.x)},${glsl(bounds.min.y)},${glsl(bounds.min.z)}))/max(vec3(${glsl(size.x)},${glsl(size.y)},${glsl(size.z)}),vec3(1e-7));`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
varying vec3 vMahoganyGenerated;
vec3 mahoganyN03dRotate(vec3 p,vec3 r){vec3 c=cos(r),s=sin(r);p=vec3(p.x,p.y*c.x-p.z*s.x,p.y*s.x+p.z*c.x);p=vec3(p.x*c.y+p.z*s.y,p.y,-p.x*s.y+p.z*c.y);return vec3(p.x*c.z-p.y*s.z,p.x*s.z+p.y*c.z,p.z);}
${filamentNoiseGlsl("mahoganyN03d")}
${filamentWaveFunctionGlsl("mahoganyN03d", "mahoganyN03dWave", {
    distortion: config.waveDistortion,
    detail: config.waveDetail,
    detailScale: config.waveDetailScale,
    detailRoughness: config.waveDetailRoughness,
    direction: "X",
    phaseOffset: config.wavePhase,
  })}
float mahoganyN03dFactor(vec3 generated){
  vec3 mapped=mahoganyN03dRotate(generated*${glsl(config.mappingScale)},vec3(${rotation}));
  float wave=mahoganyN03dWave(mapped,${glsl(config.waveScale)});
  return mix(${glsl(config.mapToMin)},${glsl(config.noiseConstant)},wave);
}
float mahoganyN03dHeight(vec3 generated){
  return mix(${glsl(config.bumpHeightMin)},${glsl(config.bumpHeightMax)},mahoganyN03dFactor(generated));
}`)
        .replace("#include <color_fragment>", `#include <color_fragment>
float mahoganyN03dMapped=mahoganyN03dFactor(vMahoganyGenerated);
diffuseColor.rgb=mix(vec3(${colorA}),vec3(${colorB}),mahoganyN03dMapped);`)
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
${filamentBumpGlsl({
    prefix: "mahoganyN03dBump",
    coordinate: "vMahoganyGenerated",
    heightFunction: (coordinate) => `mahoganyN03dHeight(${coordinate})`,
    strength: config.bumpStrength,
    distance: config.bumpDistance,
    filterWidth: config.bumpFilterWidth,
    invert: config.bumpInvert,
  })}`);
    };
    material.customProgramCacheKey = () => `mahogany-n03d-${materialName}-${bounds.min.toArray().join(",")}-${bounds.max.toArray().join(",")}-v1`;
    return material;
  }

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
vec3 mahoganyRotate(vec3 p,vec3 r){vec3 c=cos(r),s=sin(r);p=vec3(p.x,p.y*c.x-p.z*s.x,p.y*s.x+p.z*c.x);p=vec3(p.x*c.y+p.z*s.y,p.y,-p.x*s.y+p.z*c.y);return vec3(p.x*c.z-p.y*s.z,p.x*s.z+p.y*c.z,p.z);}
${filamentNoiseGlsl("mahogany")}
${filamentWaveFunctionGlsl("mahogany", "mahoganyWave", {
    distortion: config.waveDistortion,
    detail: config.waveDetail,
    detailScale: config.waveDetailScale,
    detailRoughness: config.waveDetailRoughness,
    direction: "X",
    phaseOffset: config.wavePhase,
  })}
${mahoganyNoiseTextureGlsl(config)}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
vec3 mahoganyP=mahoganyRotate(vMahoganyGenerated*max(vMahoganyScale,1e-4),vMahoganyRotation);
float mahoganyNoiseValue=mahoganyTextureNoise(vMahoganyGenerated);
float mahoganyWaveValue=mahoganyWave(mahoganyP,${glsl(config.waveScale)});
float mahoganyMapped=mix(${glsl(config.mapToMin)},mahoganyNoiseValue,mahoganyWaveValue);
float mahoganyColorFactor=clamp(mahoganyMapped,0.0,1.0);
diffuseColor.rgb=mix(max(vMahoganyA,vec3(0.0)),max(vMahoganyB,vec3(0.0)),mahoganyColorFactor);`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
float mahoganyRamp=mix(${glsl(config.roughnessRamp[0].color)},${glsl(config.roughnessRamp[1].color)},clamp((mahoganyMapped-${glsl(config.roughnessRamp[0].position)})/max(${glsl(config.roughnessRamp[1].position - config.roughnessRamp[0].position)},1e-6),0.0,1.0));
roughnessFactor=clamp(mix(mahoganyMapped,mahoganyNoiseValue,mahoganyRamp),0.0,1.0);`);
  };
  material.customProgramCacheKey = () => `mahogany-attributes-${materialName}-v2`;
  return material;
}
