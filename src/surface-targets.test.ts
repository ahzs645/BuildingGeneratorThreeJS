import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
  ALL_TARGET_SURFACES,
  PICK_TARGET_SURFACE,
  collectTargetSurfaces,
  surfacesForTarget,
  targetLabel,
} from "./surface-targets";

function mesh(name: string): THREE.Mesh {
  const value = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  value.name = name;
  return value;
}

test("surface inventory keeps nested object names and ignores empty meshes", () => {
  const root = new THREE.Group();
  const building = new THREE.Group();
  building.name = "Building";
  building.add(mesh("Roof"), mesh("Wall"));
  const empty = new THREE.Mesh(new THREE.BufferGeometry());
  empty.name = "Empty";
  root.add(building, empty);

  const surfaces = collectTargetSurfaces(root);
  assert.deepEqual(surfaces.map((surface) => surface.label), ["Building / Roof", "Building / Wall"]);
});

test("target modes resolve all meshes, click-to-pick, and one locked mesh", () => {
  const root = new THREE.Group();
  root.add(mesh("A"), mesh("B"));
  const surfaces = collectTargetSurfaces(root);

  assert.equal(surfacesForTarget(surfaces, ALL_TARGET_SURFACES).length, 2);
  assert.equal(surfacesForTarget(surfaces, PICK_TARGET_SURFACE).length, 2);
  assert.deepEqual(surfacesForTarget(surfaces, surfaces[1].id), [surfaces[1]]);
  assert.equal(targetLabel(surfaces, surfaces[1].id), "B");
});

test("unknown target ids safely fall back to every usable surface", () => {
  const root = new THREE.Group();
  root.add(mesh("Only"));
  const surfaces = collectTargetSurfaces(root);
  assert.deepEqual(surfacesForTarget(surfaces, "missing"), surfaces);
});
