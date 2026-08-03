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

export function glslFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

export function glslVec3(value: readonly number[]): string {
  return `vec3(${value.map(glslFloat).join(", ")})`;
}
