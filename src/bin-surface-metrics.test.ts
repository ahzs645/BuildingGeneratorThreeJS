import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { measureBinSurfaceParity } from "./bin-surface-metrics";

function plane(diagonal: "forward" | "back", z = 0, materialName = "3D.004"): THREE.Mesh {
  const positions = diagonal === "forward"
    ? [-1, -1, z, 1, -1, z, 1, 1, z, -1, -1, z, 1, 1, z, -1, 1, z]
    : [-1, -1, z, 1, -1, z, -1, 1, z, 1, -1, z, 1, 1, z, -1, 1, z];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.addGroup(0, 6, 0);
  const material = new THREE.MeshBasicMaterial();
  material.name = materialName;
  return new THREE.Mesh(geometry, material);
}

test("Recursive Bin live metric recognizes alternate tessellation of the same surface", () => {
  const metric = measureBinSurfaceParity(plane("forward"), plane("back"), { samples: 32, materialSamples: 32 });
  assert.ok(metric.whole);
  assert.ok(metric.material);
  assert.ok(metric.whole.max < 1e-7, `max=${metric.whole.max}`);
  assert.ok(metric.material.max < 1e-7, `material max=${metric.material.max}`);
  assert.equal(metric.materialMismatch, false);
});

test("Recursive Bin live metric measures both surface displacement and material availability", () => {
  const displaced = measureBinSurfaceParity(plane("forward"), plane("back", .02), { samples: 32, materialSamples: 32 });
  assert.ok(displaced.whole);
  assert.ok(Math.abs(displaced.whole.p99 - .02) < 1e-6, `p99=${displaced.whole.p99}`);
  assert.ok(Math.abs(displaced.whole.max - .02) < 1e-6, `max=${displaced.whole.max}`);

  const missingMaterial = measureBinSurfaceParity(plane("forward"), plane("back", 0, "other"), { samples: 8, materialSamples: 8 });
  assert.equal(missingMaterial.material, null);
  assert.equal(missingMaterial.materialMismatch, true);
});
