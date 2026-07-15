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
    targetSrgbLuminance: { topAndLeft: 0.504, screenRight: 0.227 },
    label: "approximation",
  });
  material.dispose();
});
