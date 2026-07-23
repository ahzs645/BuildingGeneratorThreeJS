import * as THREE from "three";
import type { Dump } from "./gnvm";

export type LightbulbMaterialConfig = {
  baseColorImage: string;
  metalnessImage: string;
  roughnessImage: string;
  normalImage: string;
  emissiveImage: string;
  normalStrength: number;
  emissionStrength: number;
};

export type LightbulbTextureSet = {
  baseColor: THREE.Texture;
  metalness: THREE.Texture;
  roughness: THREE.Texture;
  normal: THREE.Texture;
  emissive: THREE.Texture;
};

const texturePaths = {
  baseColor: "dojo/n03d/conveyor-mechanic/textures/lightbulb-base-color.png",
  metalness: "dojo/n03d/conveyor-mechanic/textures/lightbulb-metalness.png",
  roughness: "dojo/n03d/conveyor-mechanic/textures/lightbulb-roughness.png",
  normal: "dojo/n03d/conveyor-mechanic/textures/lightbulb-normal.png",
  emissive: "dojo/n03d/conveyor-mechanic/textures/lightbulb-emissive.png",
} as const;

let loadedTextures: LightbulbTextureSet | null = null;
let loadingTextures: Promise<LightbulbTextureSet> | null = null;

function textureUrl(path: string): string {
  const configured = import.meta.env?.BASE_URL ?? "/";
  const base = configured.endsWith("/") ? configured : `${configured}/`;
  return `${base}${path.replace(/^\/+/, "")}`;
}

function inputValue(node: any, name: string, fallback: unknown): unknown {
  return node?.inputs?.find((input: any) => input.name === name)?.value ?? fallback;
}

/** Recover the exact packed PBR graph used by the Conveyor completion marker. */
export function extractLightbulbMaterialConfig(
  dump: Dump,
  materialName: string,
): LightbulbMaterialConfig | null {
  if (materialName !== "lightbulb_01_base") return null;
  const tree = (dump.materials as Record<string, any> | undefined)?.[materialName];
  const principled = tree?.nodes?.find((node: any) => node.name === "Principled BSDF");
  const normalMap = tree?.nodes?.find((node: any) => node.type === "ShaderNodeNormalMap");
  const image = (label: string) => tree?.nodes?.find(
    (node: any) => node.type === "ShaderNodeTexImage" && node.label === label,
  )?.props?.image?.name;
  const config = {
    baseColorImage: image("Base Color"),
    metalnessImage: image("Metallic"),
    roughnessImage: image("Roughness"),
    normalImage: image("Normal"),
    emissiveImage: image("Emission"),
    normalStrength: Number(inputValue(normalMap, "Strength", 1)),
    emissionStrength: Number(inputValue(principled, "Emission Strength", 1)),
  };
  return principled && Object.values(config).every((value) =>
    typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && value.length > 0)
    ? config
    : null;
}

function configureTexture(texture: THREE.Texture, colorSpace: THREE.ColorSpace): THREE.Texture {
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Load the five packed CC0 maps before the app announces capture readiness. */
export function preloadLightbulbTextures(): Promise<LightbulbTextureSet> {
  if (loadedTextures) return Promise.resolve(loadedTextures);
  if (loadingTextures) return loadingTextures;
  const loader = new THREE.TextureLoader();
  loadingTextures = Promise.all(Object.entries(texturePaths).map(async ([name, path]) => {
    const texture = await loader.loadAsync(textureUrl(path));
    const colorSpace = name === "baseColor" || name === "emissive"
      ? THREE.SRGBColorSpace
      : THREE.NoColorSpace;
    return [name, configureTexture(texture, colorSpace)] as const;
  })).then((entries) => {
    loadedTextures = Object.fromEntries(entries) as LightbulbTextureSet;
    return loadedTextures;
  });
  return loadingTextures;
}

export function makeLightbulbMaterial(
  dump: Dump,
  materialName: string,
  textures: LightbulbTextureSet | null = loadedTextures,
): THREE.MeshPhysicalMaterial | null {
  const config = extractLightbulbMaterialConfig(dump, materialName);
  if (!config || !textures) return null;
  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: textures.baseColor,
    metalness: 1,
    metalnessMap: textures.metalness,
    roughness: 1,
    roughnessMap: textures.roughness,
    normalMap: textures.normal,
    normalScale: new THREE.Vector2(config.normalStrength, config.normalStrength),
    emissive: 0xffffff,
    emissiveMap: textures.emissive,
    emissiveIntensity: config.emissionStrength,
    side: THREE.DoubleSide,
  });
  material.name = "lightbulb_01_base · packed CC0 PBR reconstruction";
  material.userData.lightbulbContract = config;
  return material;
}
