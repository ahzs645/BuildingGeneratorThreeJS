import * as THREE from "three";
import type { Dump } from "./gnvm";

type RawNode = { name: string; type: string; props?: Record<string, any> };
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
  secondaryTextureCount: number;
};

export function extractPackedStickerMaterialConfig(dump: Dump, materialName: string): PackedStickerMaterialConfig | null {
  const tree = dump.materials?.[materialName] as RawMaterial | undefined;
  const images = (tree?.nodes ?? []).filter((node) => node.type === "ShaderNodeTexImage");
  const primary = images[0]?.props?.image?.name;
  const url = packedTextureUrls[String(primary ?? "")];
  if (!url) return null;
  return { imageName: primary, url, secondaryTextureCount: Math.max(0, images.length - 1) };
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

export function makePackedStickerMaterial(
  dump: Dump,
  geometry: THREE.BufferGeometry,
  group: IndexGroup,
  materialName: string,
): THREE.MeshBasicMaterial | null {
  const config = extractPackedStickerMaterialConfig(dump, materialName);
  if (!config || !ensureStickerQuadUv(geometry, group)) return null;
  let texture = textureCache.get(config.url);
  if (!texture) {
    texture = new THREE.TextureLoader().load(config.url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    textureCache.set(config.url, texture);
  }
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 1 / 255,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  material.name = `${materialName} · packed Blender sticker texture`;
  material.userData.packedStickerContract = config;
  if (config.secondaryTextureCount) {
    material.userData.approximation = "Primary packed image/alpha restored; the secondary wear texture remains normalized.";
  }
  return material;
}
