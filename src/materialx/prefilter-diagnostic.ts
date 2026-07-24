import * as THREE from "three";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { publicUrl } from "../base-url";
import { prepareMaterialXRadiance, type EsslManifest } from "./essl-adapter";
import { createMaterialXPrefilteredEnvironment } from "./environment-prefilter";

export type MaterialXPrefilterDiagnostic = {
  renderer: string;
  extension: boolean;
  mipCount: number;
  elapsedMilliseconds: number;
  levels: ReadonlyArray<Readonly<{
    width: number;
    height: number;
    meanRadiance: number;
    maximumRadiance: number;
  }>>;
};

/** Isolated browser probe that does not evaluate any Geometry Nodes asset. */
export async function runMaterialXPrefilterDiagnostic(): Promise<MaterialXPrefilterDiagnostic> {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
  });
  const gl = renderer.getContext();
  const source = await new EXRLoader().loadAsync(
    publicUrl("materialx/references/studio-environment.exr"),
  ) as THREE.DataTexture;
  const prepared = prepareMaterialXRadiance(
    source,
    renderer.capabilities.getMaxAnisotropy(),
  );
  try {
    const response = await fetch(
      publicUrl("materialx/generated/environment-prefilter/manifest.json"),
      { cache: "no-store" },
    );
    if (!response.ok) {
      throw new Error(`MaterialX environment-prefilter manifest fetch failed: ${response.status}`);
    }
    const manifest = await response.json() as EsslManifest;
    const result = await createMaterialXPrefilteredEnvironment(renderer, {
      baseUrl: publicUrl("materialx/generated/environment-prefilter").replace(/\/$/, ""),
      manifest,
      shaderName: "MaterialXEnvironmentPrefilter",
      source: prepared,
    });
    try {
      return Object.freeze({
        renderer: gl.getParameter(gl.RENDERER) as string,
        extension: renderer.extensions.has("EXT_color_buffer_float"),
        mipCount: result.mipCount,
        elapsedMilliseconds: result.elapsedMilliseconds,
        levels: result.levels,
      });
    } finally {
      result.radiance.dispose();
    }
  } finally {
    prepared.dispose();
    source.dispose();
    renderer.dispose();
  }
}
