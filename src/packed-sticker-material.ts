import * as THREE from "three";
import type { Dump } from "./gnvm";

type RawNode = {
  name: string;
  type: string;
  inputs?: Array<{ identifier?: string; value?: unknown }>;
  outputs?: Array<{ identifier?: string; default?: unknown }>;
  props?: Record<string, any>;
};
type RawMaterial = { nodes?: RawNode[] };
type IndexGroup = { start: number; count: number };

const packedTextureUrls: Record<string, string> = {
  "sticky1@2x.png": "dojo/chrome-assets/textures/sticky1-2x.png",
  "stickie2.png": "dojo/chrome-assets/textures/stickie2.png",
  "sticker texture.png": "dojo/chrome-assets/textures/sticker-texture.png",
  "foolish bb spooky sticker.png": "dojo/chrome-assets/textures/foolish-bb-spooky-sticker.png",
  "fuck around find out.png": "dojo/chrome-assets/textures/fuck-around-find-out.png",
  "ryu electrify.png": "dojo/chrome-assets/textures/ryu-electrify.png",
};

export type PackedStickerMaterialConfig = {
  imageName: string;
  url: string;
  shader: "image" | "spoke-control" | "soft-star-wear";
  secondaryImageName?: string;
  secondaryUrl?: string;
  secondaryTextureCount: number;
};

export function extractPackedStickerMaterialConfig(dump: Dump, materialName: string): PackedStickerMaterialConfig | null {
  const tree = dump.materials?.[materialName] as RawMaterial | undefined;
  const images = (tree?.nodes ?? []).filter((node) => node.type === "ShaderNodeTexImage");
  const primary = images[0]?.props?.image?.name;
  const url = packedTextureUrls[String(primary ?? "")];
  if (!url) return null;
  const secondaryImageName = images[1]?.props?.image?.name as string | undefined;
  const secondaryUrl = secondaryImageName ? packedTextureUrls[secondaryImageName] : undefined;
  const shader = materialName === "10pt spoke stickie"
    ? "spoke-control"
    : materialName === "8pt soft star stickie"
      ? "soft-star-wear"
      : "image";
  return {
    imageName: primary,
    url,
    shader,
    ...(secondaryImageName ? { secondaryImageName } : {}),
    ...(secondaryUrl ? { secondaryUrl } : {}),
    secondaryTextureCount: Math.max(0, images.length - 1),
  };
}

/** Reconstruct the per-face UV quad discarded when evaluated geometry becomes triangle soup. */
export function ensureStickerQuadUv(geometry: THREE.BufferGeometry, group: IndexGroup): boolean {
  const index = geometry.index;
  const position = geometry.getAttribute("position");
  if (!index || group.count !== 6 || group.start < 0 || group.start + group.count > index.count) return false;
  let uv = geometry.getAttribute("uv") as THREE.BufferAttribute | undefined;
  if (!uv) {
    uv = new THREE.Float32BufferAttribute(new Float32Array(position.count * 2), 2);
    geometry.setAttribute("uv", uv);
  }
  if (uv.itemSize !== 2) return false;
  const a = index.getX(group.start), b = index.getX(group.start + 1), c = index.getX(group.start + 2);
  const a2 = index.getX(group.start + 3), c2 = index.getX(group.start + 4), d = index.getX(group.start + 5);
  if (a !== a2 || c !== c2 || new Set([a, b, c, d]).size !== 4) return false;
  uv.setXY(a, 0, 0);
  uv.setXY(b, 1, 0);
  uv.setXY(c, 1, 1);
  uv.setXY(d, 0, 1);
  uv.needsUpdate = true;
  return true;
}

const textureCache = new Map<string, THREE.Texture>();

function loadPackedTexture(url: string): THREE.Texture {
  let texture = textureCache.get(url);
  if (!texture) {
    texture = new THREE.TextureLoader().load(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    textureCache.set(url, texture);
  }
  return texture;
}

const stickerShaderPars = `
varying vec3 vPackedStickerCol;

float packedStickerValue(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

vec3 packedStickerRgbToHsv(vec3 color) {
  vec4 K = vec4(0.0, -0.3333333333333333, 0.6666666666666666, -1.0);
  vec4 p = mix(vec4(color.bg, K.wz), vec4(color.gb, K.xy), step(color.b, color.g));
  vec4 q = mix(vec4(p.xyw, color.r), vec4(color.r, p.yzx), step(p.x, color.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 packedStickerHsvToRgb(vec3 hsv) {
  vec3 p = abs(fract(hsv.xxx + vec3(0.0, 0.6666666666666666, 0.3333333333333333)) * 6.0 - 3.0);
  return hsv.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), hsv.y);
}

vec3 packedStickerHueSaturation(
  vec3 color,
  float hue,
  float saturation,
  float value,
  float factor
) {
  vec3 hsv = packedStickerRgbToHsv(color);
  hsv.x = fract(hsv.x + hue - 0.5);
  hsv.y = clamp(hsv.y * saturation, 0.0, 1.0);
  hsv.z *= value;
  return mix(color, packedStickerHsvToRgb(hsv), clamp(factor, 0.0, 1.0));
}
`;

const spokeMapFragment = `
#ifdef USE_MAP
  vec4 packedStickerPrimary = texture2D(map, vMapUv);
  vec3 packedStickerGray = packedStickerHueSaturation(
    packedStickerPrimary.rgb,
    1.0,
    0.0,
    1.0,
    1.0
  );
  float packedStickerTint = float(packedStickerValue(packedStickerPrimary.rgb) < 0.7042236328125);
  vec3 packedStickerColor = mix(
    packedStickerGray,
    clamp(packedStickerGray * vPackedStickerCol, 0.0, 1.0),
    packedStickerTint
  );
  diffuseColor *= vec4(packedStickerColor, packedStickerPrimary.a);
#endif
`;

const softStarMapFragment = `
#ifdef USE_MAP
  vec4 packedStickerPrimary = texture2D(map, vMapUv);

  const float packedStickerWearScale = 0.83447265625;
  const float packedStickerWearRotation = -2.455881118774414;
  vec2 packedStickerWearUv = vMapUv * packedStickerWearScale;
  packedStickerWearUv = mat2(
    cos(packedStickerWearRotation), sin(packedStickerWearRotation),
    -sin(packedStickerWearRotation), cos(packedStickerWearRotation)
  ) * packedStickerWearUv;
  packedStickerWearUv += vec2(0.536865234375, 1.132080078125);
  bool packedStickerWearInside =
    packedStickerWearUv.x >= 0.0 && packedStickerWearUv.x <= 1.0 &&
    packedStickerWearUv.y >= 0.0 && packedStickerWearUv.y <= 1.0;
  vec4 packedStickerWear = packedStickerWearInside
    ? texture2D(packedStickerSecondaryMap, packedStickerWearUv)
    : vec4(0.0);
  vec3 packedStickerWearGray = packedStickerHueSaturation(
    packedStickerWear.rgb,
    0.5,
    0.0,
    0.9959999322891235,
    packedStickerWear.a
  );
  float packedStickerWearValue = packedStickerValue(packedStickerWearGray);
  float packedStickerWearMapped = mix(-0.9898681640625, 7.6500244140625, packedStickerWearValue);
  vec3 packedStickerA = mix(
    packedStickerPrimary.rgb,
    vec3(packedStickerWearMapped),
    packedStickerPrimary.a
  );

  float packedStickerPrimaryValue = packedStickerValue(packedStickerPrimary.rgb);
  float packedStickerDarkTint = float(packedStickerPrimaryValue < 0.3787841796875);
  vec3 packedStickerB = mix(
    packedStickerPrimary.rgb,
    clamp(packedStickerPrimary.rgb * vPackedStickerCol, 0.0, 1.0),
    packedStickerDarkTint
  );
  vec3 packedStickerColor = mix(
    packedStickerA,
    packedStickerA * packedStickerB,
    0.9977267980575562
  );

  float packedStickerShadow = float(packedStickerPrimaryValue < 0.2735595703125);
  packedStickerColor = packedStickerHueSaturation(
    packedStickerColor,
    0.5,
    0.0,
    0.5519992709159851,
    packedStickerShadow
  );
  float packedStickerFace = float(packedStickerPrimaryValue > 0.2735595703125);
  packedStickerColor = packedStickerHueSaturation(
    packedStickerColor,
    0.5459991097450256,
    3.0,
    0.567999005317688,
    packedStickerFace
  );
  diffuseColor *= vec4(packedStickerColor, packedStickerPrimary.a);
#endif
`;

export function makePackedStickerMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  group: IndexGroup,
  materialName: string,
): THREE.MeshBasicMaterial | null {
  const config = extractPackedStickerMaterialConfig(dump, materialName);
  if (!config || !ensureStickerQuadUv(geometry, group)) return null;
  const texture = loadPackedTexture(config.url);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 1 / 255,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  material.name = `${materialName} · packed Blender sticker texture`;
  material.userData.packedStickerContract = config;
  if (config.shader !== "image") {
    const secondary = config.secondaryUrl ? loadPackedTexture(config.secondaryUrl) : null;
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\nattribute vec3 col;\nvarying vec3 vPackedStickerCol;`)
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPackedStickerCol = col;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${stickerShaderPars}${secondary ? "\nuniform sampler2D packedStickerSecondaryMap;" : ""}`)
        .replace("#include <map_fragment>", config.shader === "spoke-control" ? spokeMapFragment : softStarMapFragment);
      if (secondary) shader.uniforms.packedStickerSecondaryMap = { value: secondary };
    };
    material.customProgramCacheKey = () => `packed-sticker-${config.shader}-v1`;
  }
  if (config.secondaryTextureCount && !config.secondaryUrl) {
    material.userData.approximation = "Primary packed image restored; a referenced secondary image is unavailable.";
  }
  return material;
}
