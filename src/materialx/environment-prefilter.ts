import * as THREE from "three";
import type { EsslManifest } from "./essl-adapter";

export type MaterialXEnvironmentPrefilterOptions = {
  baseUrl: string;
  manifest: EsslManifest;
  shaderName: string;
  source: THREE.DataTexture;
  signal?: AbortSignal;
  onProgress?: (completedLevels: number, totalLevels: number) => void;
};

export type MaterialXPrefilteredEnvironment = {
  readonly radiance: THREE.DataTexture;
  readonly mipCount: number;
  readonly elapsedMilliseconds: number;
  readonly levels: ReadonlyArray<Readonly<{
    width: number;
    height: number;
    meanRadiance: number;
    maximumRadiance: number;
  }>>;
};

type PrefilterLevel = {
  data: Float32Array;
  width: number;
  height: number;
};

function summarizeLevel(level: PrefilterLevel): {
  width: number;
  height: number;
  meanRadiance: number;
  maximumRadiance: number;
} {
  let sum = 0;
  let maximum = 0;
  for (let offset = 0; offset < level.data.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const value = level.data[offset + channel];
      if (!Number.isFinite(value)) {
        throw new Error(`MaterialX environment prefilter produced a non-finite value at ${level.width}x${level.height}`);
      }
      sum += value;
      maximum = Math.max(maximum, value);
    }
  }
  return {
    width: level.width,
    height: level.height,
    meanRadiance: sum / (level.width * level.height * 3),
    maximumRadiance: maximum,
  };
}

const REQUIRED_PREFILTER_UNIFORMS = [
  "u_envMatrix",
  "u_envRadiance",
  "u_envRadianceMips",
  "u_envPrefilterMip",
] as const;

function stripVersion(source: string): string {
  return source.replace(/^#version 300 es\s*/, "");
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function powerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

export function materialXPrefilterDimensions(
  width: number,
  height: number,
): ReadonlyArray<Readonly<{ width: number; height: number }>> {
  if (!powerOfTwo(width) || !powerOfTwo(height) || width !== height * 2) {
    throw new Error(
      `MaterialX environment prefilter requires a power-of-two 2:1 lat-long map; received ${width}x${height}`,
    );
  }
  const levels = Math.trunc(Math.log2(Math.max(width, height))) + 1;
  return Object.freeze(Array.from({ length: levels }, (_, mip) => Object.freeze({
    width: Math.max(1, width >> mip),
    height: Math.max(1, height >> mip),
  })));
}

export function validateMaterialXEnvironmentPrefilterManifest(
  manifest: EsslManifest,
  shaderName: string,
): void {
  if (
    manifest.generator.specularEnvironment !== "PREFILTER"
    || manifest.generator.writesEnvironmentPrefilter !== true
  ) {
    throw new Error("MaterialX environment prefilter pass requires a PREFILTER writer manifest");
  }
  const shader = manifest.shaders[shaderName];
  if (!shader) throw new Error(`Generated MaterialX shader is missing ${shaderName}`);
  const uniforms = new Set(
    Object.values(shader.fragmentInterface.uniforms).flat().map((port) => port.name),
  );
  for (const uniform of REQUIRED_PREFILTER_UNIFORMS) {
    if (!uniforms.has(uniform)) {
      throw new Error(`MaterialX environment prefilter shader is missing ${uniform}`);
    }
  }
}

function makeFullscreenGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.Float32BufferAttribute([
    -1, -1, 0,
    3, -1, 0,
    -1, 3, 0,
  ], 3);
  // Three derives non-indexed draw count from the conventional position
  // attribute, while official MaterialX ESSL consumes i_position.
  geometry.setAttribute("position", position);
  geometry.setAttribute("i_position", position);
  geometry.setAttribute("i_normal", new THREE.Float32BufferAttribute([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ], 3));
  geometry.setAttribute("i_tangent", new THREE.Float32BufferAttribute([
    1, 0, 0,
    1, 0, 0,
    1, 0, 0,
  ], 3));
  geometry.setAttribute("i_texcoord_0", new THREE.Float32BufferAttribute([
    0, 0,
    2, 0,
    0, 2,
  ], 2));
  return geometry;
}

async function fetchShader(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`MaterialX prefilter shader fetch failed: ${response.status}`);
  return response.text();
}

function makePrefilteredTexture(levels: readonly PrefilterLevel[]): THREE.DataTexture {
  const base = levels[0];
  const texture = new THREE.DataTexture(
    base.data,
    base.width,
    base.height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  // DataTexture treats manual mipmaps[0] as level zero and suppresses driver
  // box-filter generation. Every level here was produced by MaterialX's
  // Apache-2.0 GGX environment-prefilter shader.
  texture.mipmaps = levels.map((level) => ({
    data: level.data,
    width: level.width,
    height: level.height,
  }));
  texture.name = "MaterialX GGX-prefiltered lat-long radiance";
  texture.colorSpace = THREE.NoColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Generate the exact mip layout consumed by MaterialX's PREFILTER material
 * shaders. This follows MaterialXView's RenderPipelineGL pass: one full-screen
 * render per mip, a -X/-Z environment matrix, and the original radiance map as
 * the filtered-importance-sampling source.
 */
export async function createMaterialXPrefilteredEnvironment(
  renderer: THREE.WebGLRenderer,
  options: MaterialXEnvironmentPrefilterOptions,
): Promise<MaterialXPrefilteredEnvironment> {
  validateMaterialXEnvironmentPrefilterManifest(options.manifest, options.shaderName);
  options.signal?.throwIfAborted();
  if (!renderer.extensions.has("EXT_color_buffer_float")) {
    throw new Error("MaterialX environment prefilter requires EXT_color_buffer_float");
  }
  const dimensions = materialXPrefilterDimensions(
    options.source.image.width,
    options.source.image.height,
  );
  const shader = options.manifest.shaders[options.shaderName];
  const [vertexShader, fragmentShader] = await Promise.all([
    fetchShader(`${options.baseUrl}/${shader.vertex}`, options.signal),
    fetchShader(`${options.baseUrl}/${shader.fragment}`, options.signal),
  ]);
  options.signal?.throwIfAborted();

  options.source.colorSpace = THREE.NoColorSpace;
  options.source.wrapS = THREE.RepeatWrapping;
  options.source.wrapT = THREE.ClampToEdgeWrapping;
  options.source.minFilter = THREE.LinearMipmapLinearFilter;
  options.source.magFilter = THREE.LinearFilter;
  options.source.generateMipmaps = true;
  options.source.needsUpdate = true;

  const uniforms: Record<string, THREE.IUniform> = {
    u_worldMatrix: { value: new THREE.Matrix4() },
    u_viewProjectionMatrix: { value: new THREE.Matrix4() },
    u_worldInverseTransposeMatrix: { value: new THREE.Matrix4() },
    u_envMatrix: { value: new THREE.Matrix4().makeScale(-1, 1, -1) },
    u_envRadiance: { value: options.source },
    u_envRadianceMips: { value: dimensions.length },
    u_envPrefilterMip: { value: 0 },
  };
  const material = new THREE.RawShaderMaterial({
    name: "MaterialX official environment prefilter pass",
    vertexShader: stripVersion(vertexShader),
    fragmentShader: stripVersion(fragmentShader),
    glslVersion: THREE.GLSL3,
    uniforms,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
  });
  const geometry = makeFullscreenGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.Camera();

  const target = new THREE.WebGLRenderTarget(dimensions[0].width, dimensions[0].height, {
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.colorSpace = THREE.NoColorSpace;
  target.texture.generateMipmaps = false;

  const previousTarget = renderer.getRenderTarget();
  const previousViewport = renderer.getViewport(new THREE.Vector4());
  const previousScissor = renderer.getScissor(new THREE.Vector4());
  const previousScissorTest = renderer.getScissorTest();
  const previousAutoClear = renderer.autoClear;
  const previousXrEnabled = renderer.xr.enabled;
  const levels: PrefilterLevel[] = [];
  const started = now();
  try {
    renderer.xr.enabled = false;
    renderer.autoClear = true;
    renderer.setScissorTest(false);
    for (let mip = 0; mip < dimensions.length; mip += 1) {
      options.signal?.throwIfAborted();
      const { width, height } = dimensions[mip];
      target.setSize(width, height);
      uniforms.u_envPrefilterMip.value = mip;
      renderer.setRenderTarget(target);
      renderer.setViewport(0, 0, width, height);
      renderer.clear();
      renderer.render(scene, camera);
      const data = new Float32Array(width * height * 4);
      renderer.readRenderTargetPixels(target, 0, 0, width, height, data);
      levels.push({ data, width, height });
      options.onProgress?.(mip + 1, dimensions.length);
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
    }
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.setViewport(previousViewport);
    renderer.setScissor(previousScissor);
    renderer.setScissorTest(previousScissorTest);
    renderer.autoClear = previousAutoClear;
    renderer.xr.enabled = previousXrEnabled;
    target.dispose();
    geometry.dispose();
    material.dispose();
  }
  options.signal?.throwIfAborted();
  const summaries = levels.map(summarizeLevel);
  if (summaries[0].maximumRadiance <= 1e-8) {
    throw new Error("MaterialX environment prefilter produced an empty level-zero radiance map");
  }
  return Object.freeze({
    radiance: makePrefilteredTexture(levels),
    mipCount: levels.length,
    elapsedMilliseconds: now() - started,
    levels: Object.freeze(summaries.map((summary) => Object.freeze(summary))),
  });
}
