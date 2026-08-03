import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { chainOnBeforeCompile, glslFloat, glslVec3, replaceOnce } from "./shader-patch";

test("replaceOnce rejects missing and ambiguous shader anchors", () => {
  assert.equal(replaceOnce("before TOKEN after", "TOKEN", "patch"), "before patch after");
  assert.throws(() => replaceOnce("before", "TOKEN", "patch"), /anchor not found/);
  assert.throws(() => replaceOnce("TOKEN TOKEN", "TOKEN", "patch"), /anchor is not unique/);
});

test("shader patch chaining preserves hooks and cache-key components", () => {
  const material = new THREE.MeshStandardMaterial();
  const calls: string[] = [];
  material.onBeforeCompile = () => calls.push("base");
  material.customProgramCacheKey = () => "base-key";
  chainOnBeforeCompile(material, () => calls.push("patch"));
  material.onBeforeCompile({} as never, {} as never);
  assert.deepEqual(calls, ["base", "patch"]);
  assert.match(material.customProgramCacheKey(), /^base-key\|/);
  assert.equal(glslFloat(2), "2.0");
  assert.equal(glslVec3([1, 2.5, 3]), "vec3(1.0, 2.5, 3.0)");
  material.dispose();
});
