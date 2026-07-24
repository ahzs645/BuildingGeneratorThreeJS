import * as THREE from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { publicUrl } from "../base-url";
import { loadBlenderStudioEnvironment } from "../blender-studio-environment";
import { createMaterialXPrefilteredEnvironment } from "./environment-prefilter";
import {
  createMaterialXEsslMaterial,
  prepareMaterialXIrradiance,
  prepareMaterialXRadiance,
  type EsslManifest,
} from "./essl-adapter";
import { prepareLiveMaterialXGeometry, type LiveGeometryProperty } from "./live-geometry";

type CatalogMetalAsset = {
  label: string;
  sourceMaterial: string;
  shader: string;
  geometryProperties: LiveGeometryProperty[];
};

type CatalogMetalIndex = {
  schemaVersion: number;
  assets: Record<string, CatalogMetalAsset>;
};

type CatalogMetalResources = {
  index: CatalogMetalIndex;
  manifest: EsslManifest;
  radiance: THREE.DataTexture;
  irradiance: THREE.DataTexture;
  elapsedMilliseconds: number;
  levels: ReadonlyArray<Readonly<{
    width: number;
    height: number;
    meanRadiance: number;
    maximumRadiance: number;
  }>>;
};

const resourcesByRenderer = new WeakMap<THREE.WebGLRenderer, Promise<CatalogMetalResources>>();

async function loadCatalogMetalResources(renderer: THREE.WebGLRenderer): Promise<CatalogMetalResources> {
  const existing = resourcesByRenderer.get(renderer);
  if (existing) return existing;
  const loading = Promise.all([
    fetch(publicUrl("materialx/catalog-metal-surfaces.json"), { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error(`Catalog-metal index fetch failed: ${response.status}`);
      return response.json() as Promise<CatalogMetalIndex>;
    }),
    fetch(publicUrl("materialx/generated/catalog-metals/manifest.json"), { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error(`Catalog-metal manifest fetch failed: ${response.status}`);
      return response.json() as Promise<EsslManifest>;
    }),
    fetch(publicUrl("materialx/generated/environment-prefilter/manifest.json"), { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error(`MaterialX environment-prefilter manifest fetch failed: ${response.status}`);
      return response.json() as Promise<EsslManifest>;
    }),
    loadBlenderStudioEnvironment(),
    new EXRLoader().loadAsync(publicUrl("materialx/references/studio-irradiance.exr")),
  ]).then(async ([index, manifest, writerManifest, studioEnvironment, irradianceSource]) => {
    const source = prepareMaterialXRadiance(
      studioEnvironment,
      renderer.capabilities.getMaxAnisotropy(),
    );
    try {
      const prefiltered = await createMaterialXPrefilteredEnvironment(renderer, {
        baseUrl: publicUrl("materialx/generated/environment-prefilter").replace(/\/$/, ""),
        manifest: writerManifest,
        shaderName: "MaterialXEnvironmentPrefilter",
        source,
      });
      return {
        index,
        manifest,
        radiance: prefiltered.radiance,
        irradiance: prepareMaterialXIrradiance(irradianceSource as THREE.DataTexture),
        elapsedMilliseconds: prefiltered.elapsedMilliseconds,
        levels: prefiltered.levels,
      };
    } finally {
      source.dispose();
    }
  });
  resourcesByRenderer.set(renderer, loading);
  try {
    return await loading;
  } catch (error) {
    resourcesByRenderer.delete(renderer);
    throw error;
  }
}

/** Bind a catalog-declared Blender metal to live GN-VM geometry. */
export async function makeLiveCatalogMetalMaterial(
  renderer: THREE.WebGLRenderer,
  geometry: THREE.BufferGeometry,
  assetId: string,
): Promise<THREE.RawShaderMaterial> {
  const resources = await loadCatalogMetalResources(renderer);
  const entry = resources.index.assets[assetId];
  if (!entry) throw new Error(`No MaterialX catalog-metal contract exists for ${assetId}`);
  const contract = prepareLiveMaterialXGeometry(geometry, entry.geometryProperties);
  const material = await createMaterialXEsslMaterial({
    baseUrl: publicUrl("materialx/generated/catalog-metals").replace(/\/$/, ""),
    manifest: resources.manifest,
    shaderName: entry.shader,
    radiance: resources.radiance,
    irradiance: resources.irradiance,
    lights: [],
    environmentIntensity: 0.8,
    geometry,
    geometryContract: contract,
  });
  material.name = `${entry.sourceMaterial} · catalog MaterialX ESSL/PREFILTER`;
  material.side = THREE.DoubleSide;
  material.userData.catalogMetalAsset = assetId;
  material.userData.geometryContract = contract;
  material.userData.environmentPrefilterMilliseconds = resources.elapsedMilliseconds;
  material.userData.environmentPrefilterLevels = resources.levels;
  material.needsUpdate = true;
  return material;
}
