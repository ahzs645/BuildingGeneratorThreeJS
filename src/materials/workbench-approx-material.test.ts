import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  makeWorkbenchApproximationMaterial,
  shouldUseWorkbenchApproximation,
} from "../workbench-approx-material";

test("uses the Workbench approximation only for explicitly colored unmaterialed assets", () => {
  const color: [number, number, number] = [0.8, 0.8, 0.8];
  assert.equal(shouldUseWorkbenchApproximation(color, [], null), true);
  assert.equal(shouldUseWorkbenchApproximation(color, [null], ""), true);
  assert.equal(shouldUseWorkbenchApproximation(undefined, [], null), false);
  assert.equal(shouldUseWorkbenchApproximation(color, ["node base"], null), false);
  assert.equal(shouldUseWorkbenchApproximation(color, [], "node base"), false);
});

test("builds a scene-light-independent studio approximation with an explicit cavity disclaimer", () => {
  const material = makeWorkbenchApproximationMaterial([0.8, 0.8, 0.8]);
  assert.ok(material.isShaderMaterial);
  assert.equal(material.name, "Blender Workbench studio approximation");
  assert.equal(material.uniforms.workbenchColor.value.r, 0.8);
  assert.equal(material.toneMapped, false);
  assert.equal(material.side, THREE.DoubleSide);
  assert.match(material.fragmentShader, /workbenchSrgbToLinear/);
  assert.match(material.fragmentShader, /dFdx\(workbenchViewPosition\)/);
  assert.match(material.fragmentShader, /viewNormal\.x/);
  assert.match(material.fragmentShader, /0\.504/);
  assert.match(material.fragmentShader, /0\.227/);
  assert.deepEqual(material.userData.workbenchApproximation, {
    color: [0.8, 0.8, 0.8],
    cavityParity: false,
    sceneLightIndependent: true,
    smoothShading: false,
    lightingModel: "cube-calibrated lobes",
    roughness: null,
    targetSrgbLuminance: { topAndLeft: 0.504, screenRight: 0.227 },
    label: "approximation",
  });
  material.dispose();
});

test("can preserve Blender smooth vertex normals for curved Workbench assets", () => {
  const material = makeWorkbenchApproximationMaterial([0.8, 0.8, 0.8], true);
  assert.match(material.vertexShader, /workbenchViewNormal = normalize\(normalMatrix \* normal\)/);
  assert.match(material.fragmentShader, /vec3 viewNormal = normalize\(workbenchViewNormal\)/);
  assert.match(material.fragmentShader, /vec3\(-0\.854701, 0\.111111, 0\.507091\)/);
  assert.match(material.fragmentShader, /workbenchWrappedLighting/);
  assert.equal(material.userData.workbenchApproximation.smoothShading, true);
  assert.equal(material.userData.workbenchApproximation.lightingModel, "Blender 5.1 studio.sl");
  assert.equal(material.userData.workbenchApproximation.roughness, 0.4);
  material.dispose();
});
