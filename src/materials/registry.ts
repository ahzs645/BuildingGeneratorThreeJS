import * as THREE from "three";
import type { Dump, TriSoup } from "../gnvm";
import { makeAttributeEmissionMaterial, type AttributeEmissionColorRemap } from "../attribute-emission-material";
import { makeAttributeColorEmissionMaterial } from "../attribute-color-emission-material";
import { makeAttributePrincipledMaterial } from "../attribute-principled-material";
import { makeBasicBlenderMaterial, makeBlenderDefaultSurfaceMaterial } from "../blender-basic-material";
import { attachChainMaceRoughnessAttribute, makeChainMaceMaterial } from "../chain-mace-material";
import { makeChromeCrayonMaterial } from "../chrome-crayon-material";
import { makeCrossSectionFilamentMaterial } from "../cross-section-filament-material";
import { makeFilamentMaterial } from "../filament-material";
import { makeGreyUiMaterial } from "../grey-ui-material";
import { makeHatStitchMaterial } from "../hat-stitch-material";
import { makeImagePixelStipplerMaterial } from "../image-pixel-stippler-material";
import { makeKnitThreadMaterial } from "../knit-thread-material";
import { makeLightbulbMaterial } from "../lightbulb-material";
import { makeMahoganyMaterial } from "../mahogany-material";
import { makeNodeBaseMaterial, makeSimpleNoiseBumpMaterial } from "../node-base-material";
import { makeNodeColorVtextMaterial } from "../node-color-vtext-material";
import { makePackedStickerMaterial } from "../packed-sticker-material";
import { makeToonCyclesMaterial } from "../toon-cycles-material";
import { makeToonOutlineMaterial } from "../toon-outline-material";
import { makeVtextMaterial } from "../vtext-material";
import { makeWorkbenchApproximationMaterial, shouldUseWorkbenchApproximation } from "../workbench-approx-material";

export type AuthoredMaterialProfile =
  | "image-pixel-stippler"
  | "attribute-emission"
  | "chrome-crayon"
  | "chain-mace";

export interface AuthoredMaterialAsset {
  material?: AuthoredMaterialProfile;
  workbenchColor?: [number, number, number];
  flatShading?: boolean;
  attributeEmissionColorRemaps?: AttributeEmissionColorRemap[];
}

export type MaterialGroup = TriSoup["groups"][number];

export interface AuthoredMaterialContext {
  asset: AuthoredMaterialAsset;
  dump: Dump;
  geometry: THREE.BufferGeometry;
  group: MaterialGroup;
  groups: MaterialGroup[];
  materialName: string;
  previewMode?: string;
  sourceMaterials?: Array<string | null | undefined>;
  stipplerDebugMode: number;
}

/**
 * `undefined` means that an adapter does not recognize this context and the
 * registry should try the next adapter. `null` is a terminal, strict rejection:
 * an explicitly selected adapter recognized its asset profile but could not
 * safely reconstruct the material.
 */
export type MaterialAdapterResult = THREE.Material | null | undefined;

export interface AuthoredMaterialAdapter {
  id: string;
  resolve(context: AuthoredMaterialContext): MaterialAdapterResult;
}

export interface AuthoredMaterialRegistry {
  readonly adapters: readonly AuthoredMaterialAdapter[];
  resolve(context: AuthoredMaterialContext): THREE.Material | null;
}

export function createAuthoredMaterialRegistry(
  adapters: readonly AuthoredMaterialAdapter[],
): AuthoredMaterialRegistry {
  const registered = Object.freeze([...adapters]);
  return Object.freeze({
    adapters: registered,
    resolve(context: AuthoredMaterialContext): THREE.Material | null {
      for (const adapter of registered) {
        const result = adapter.resolve(context);
        if (result !== undefined) return result;
      }
      return null;
    },
  });
}

const continueOnMiss = (material: THREE.Material | null): MaterialAdapterResult => material ?? undefined;

export const AUTHORED_MATERIAL_ADAPTERS: readonly AuthoredMaterialAdapter[] = [
  {
    id: "preview-workbench",
    resolve: ({ asset, previewMode }) => previewMode === "workbench"
      ? makeWorkbenchApproximationMaterial(asset.workbenchColor ?? [0.8, 0.8, 0.8], !(asset.flatShading ?? false))
      : undefined,
  },
  {
    id: "blender-default-surface",
    resolve: ({ group }) => group.material === null ? makeBlenderDefaultSurfaceMaterial() : undefined,
  },
  {
    id: "unmaterialed-workbench",
    resolve: ({ asset, materialName, sourceMaterials }) =>
      shouldUseWorkbenchApproximation(asset.workbenchColor, sourceMaterials, materialName)
        ? makeWorkbenchApproximationMaterial(asset.workbenchColor!)
        : undefined,
  },
  {
    id: "profile-image-pixel-stippler",
    resolve: ({ asset, dump, geometry, group, stipplerDebugMode }) =>
      asset.material === "image-pixel-stippler"
        ? makeImagePixelStipplerMaterial(dump, geometry, group.material ?? "", stipplerDebugMode)
        : undefined,
  },
  {
    id: "profile-chain-mace",
    resolve: ({ asset, dump, geometry, materialName }) =>
      asset.material === "chain-mace"
        ? makeChainMaceMaterial(dump, geometry, materialName)
        : undefined,
  },
  {
    id: "profile-chrome-crayon",
    resolve: ({ asset, dump, geometry, group }) =>
      asset.material === "chrome-crayon"
        ? makeChromeCrayonMaterial(dump, geometry, group.material ?? "")
        : undefined,
  },
  {
    id: "profile-attribute-emission",
    resolve: ({ asset, dump, geometry, group }) =>
      asset.material === "attribute-emission"
        ? makeAttributeEmissionMaterial(
            dump,
            geometry,
            group.material ?? "",
            asset.attributeEmissionColorRemaps,
          )
        : undefined,
  },
  {
    id: "attribute-emission",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makeAttributeEmissionMaterial(dump, geometry, group.material ?? "")),
  },
  {
    id: "attribute-color-emission",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makeAttributeColorEmissionMaterial(dump, geometry, group.material ?? "")),
  },
  {
    id: "attribute-principled",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makeAttributePrincipledMaterial(dump, geometry, group.material ?? "")),
  },
  {
    id: "node-base",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makeNodeBaseMaterial(dump, geometry, group, group.material ?? "")),
  },
  {
    id: "simple-noise-bump",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makeSimpleNoiseBumpMaterial(dump, geometry, group, group.material ?? "")),
  },
  {
    id: "node-color-vtext",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makeNodeColorVtextMaterial(dump, geometry, group, group.material ?? "")),
  },
  {
    id: "vtext",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makeVtextMaterial(dump, geometry, group, group.material ?? "")),
  },
  {
    id: "knit-thread",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makeKnitThreadMaterial(dump, geometry, group, group.material ?? "")),
  },
  {
    id: "filament",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makeFilamentMaterial(dump, geometry, group, group.material ?? "")),
  },
  {
    id: "cross-section-filament",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makeCrossSectionFilamentMaterial(dump, geometry, group.material ?? "")),
  },
  {
    id: "hat-stitch",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makeHatStitchMaterial(dump, geometry, group, group.material ?? "")),
  },
  {
    id: "lightbulb",
    resolve: ({ dump, group }) => continueOnMiss(makeLightbulbMaterial(dump, group.material ?? "")),
  },
  {
    id: "mahogany",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makeMahoganyMaterial(dump, geometry, group.material ?? "")),
  },
  {
    id: "toon-cycles",
    resolve: ({ dump, group }) => continueOnMiss(makeToonCyclesMaterial(dump, group.material ?? "")),
  },
  {
    id: "toon-outline",
    resolve: ({ dump, group }) => continueOnMiss(makeToonOutlineMaterial(dump, group.material ?? "")),
  },
  {
    id: "grey-ui",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makeGreyUiMaterial(dump, geometry, group.material ?? "")),
  },
  {
    id: "basic-blender",
    resolve: ({ dump, group }) => continueOnMiss(makeBasicBlenderMaterial(dump, group.material ?? "")),
  },
  {
    id: "packed-sticker",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makePackedStickerMaterial(dump, geometry, group, group.material ?? "")),
  },
  {
    id: "chrome-crayon-fallback",
    resolve: ({ dump, geometry, group }) =>
      continueOnMiss(makeChromeCrayonMaterial(dump, geometry, group.material ?? "")),
  },
];

export const authoredMaterialRegistry = createAuthoredMaterialRegistry(AUTHORED_MATERIAL_ADAPTERS);

export function materialNameForGroup(
  asset: AuthoredMaterialAsset,
  group: MaterialGroup,
  groups: readonly MaterialGroup[],
): string {
  return group.material
    ?? (asset.material === "chain-mace" ? groups.find((candidate) => candidate.material)?.material : "")
    ?? "";
}

export function prepareAuthoredMaterialGeometry(
  asset: AuthoredMaterialAsset,
  geometry: THREE.BufferGeometry,
  groups: MaterialGroup[],
): void {
  if (asset.material === "chain-mace") attachChainMaceRoughnessAttribute(geometry, groups);
}
