import type * as THREE from "three";

export function replaceOnce(source: string, anchor: string, replacement: string): string {
  if (!anchor) throw new Error("Shader patch anchor must not be empty");
  const first = source.indexOf(anchor);
  if (first < 0) throw new Error(`Shader patch anchor not found: ${JSON.stringify(anchor)}`);
  if (source.indexOf(anchor, first + anchor.length) >= 0) {
    throw new Error(`Shader patch anchor is not unique: ${JSON.stringify(anchor)}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + anchor.length);
}

export function chainOnBeforeCompile(
  material: THREE.Material,
  patch: THREE.Material["onBeforeCompile"],
): void {
  const previousPatch = material.onBeforeCompile;
  const previousCacheKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previousPatch.call(material, shader, renderer);
    patch.call(material, shader, renderer);
  };
  material.customProgramCacheKey = () => `${previousCacheKey}|${patch.toString()}`;
}

/**
 * Declares `mat4 <prefix>ObjectMatrix` — the per-object transform for whichever
 * batching path three.js compiled the material into.
 *
 * Shaders that derive WORLD position or normal have to fold this in themselves:
 * `modelMatrix` only carries the scene-graph transform, so on a batched or
 * instanced draw every object would otherwise report the same world position.
 * InstancedMesh exposes it as `instanceMatrix`; BatchedMesh as `batchingMatrix`,
 * declared by the <batching_vertex> chunk, which the stock vertex shader
 * includes ahead of both <beginnormal_vertex> and <begin_vertex>. A plain Mesh
 * has already folded it into `modelMatrix`, so identity is correct there.
 */
export function objectMatrixGlsl(prefix: string): string {
  return `
        #if defined(USE_BATCHING)
          mat4 ${prefix}ObjectMatrix = batchingMatrix;
        #elif defined(USE_INSTANCING)
          mat4 ${prefix}ObjectMatrix = instanceMatrix;
        #else
          mat4 ${prefix}ObjectMatrix = mat4(1.0);
        #endif`;
}

export function glslFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

export function glslVec3(value: readonly number[]): string {
  return `vec3(${value.map(glslFloat).join(", ")})`;
}
