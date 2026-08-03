import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createSnowAccumUniforms, createSnowShellMaterial } from "../snowAccum";
import { applyWet, createWetUniforms } from "../wet";

const vertexShader = "#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>";
const fragmentShader = "#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>";

test("wetness preserves an existing shader hook and uses an inverse-transpose world normal", () => {
  const material = new THREE.MeshStandardMaterial();
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\n#define BASE_PATCH 1");
  };
  material.customProgramCacheKey = () => "base-patch-key";
  applyWet(material, createWetUniforms({ value: 0 }, { value: new THREE.Vector3() }));

  const shader = { uniforms: {}, vertexShader, fragmentShader };
  material.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /#define BASE_PATCH 1/);
  assert.match(shader.vertexShader, /mat3 wetWorldNormalMatrix/);
  assert.match(shader.vertexShader, /cross\(transform\[1\], transform\[2\]\)/);
  assert.match(shader.vertexShader, /wetWorldNormalMatrix\(wetWorldTransform\)/);
  assert.doesNotMatch(shader.vertexShader, /mat3 wetNMat = mat3\(modelMatrix\) \* mat3\(instanceMatrix\)/);
  assert.match(material.customProgramCacheKey(), /base-patch-key/);
  assert.match(material.customProgramCacheKey(), /wet-building-v3/);
  material.dispose();
});

test("the snow shell uses inverse-transpose normals and scale-correct world thickness", () => {
  const material = createSnowShellMaterial(createSnowAccumUniforms({ value: 0 }));
  const shader = { uniforms: {}, vertexShader, fragmentShader };
  material.onBeforeCompile(shader as never, {} as never);
  assert.match(shader.vertexShader, /mat3 snowWorldNormalMatrix/);
  assert.match(shader.vertexShader, /snowWorldNormalMatrix\(snowWorldTransform\)/);
  assert.match(shader.vertexShader, /uSnowThickness \* snowAccumV \* snowMs/);
  assert.doesNotMatch(shader.vertexShader, /mat3 snowNMat = mat3\(modelMatrix\) \* mat3\(instanceMatrix\)/);
  material.dispose();
});
