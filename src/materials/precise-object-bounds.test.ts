import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { preciseObjectBounds } from "../precise-object-bounds";

test("frames rotated geometry from transformed vertices instead of inflated AABB corners", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -2, 0, 0,
     2, 0, 0,
     0, -0.5, 0,
     0,  0.5, 0,
     0, 0, -0.1,
     0, 0,  0.1,
  ], 3));
  geometry.setIndex([0, 2, 4]);
  const mesh = new THREE.Mesh(geometry);
  mesh.rotation.set(0.7, 0.3, -0.8);

  const conservative = new THREE.Box3().setFromObject(mesh);
  const precise = preciseObjectBounds(mesh);
  const expected = new THREE.Box3();
  const position = geometry.getAttribute("position");
  const point = new THREE.Vector3();
  mesh.updateWorldMatrix(true, true);
  for (let index = 0; index < position.count; index++) {
    expected.expandByPoint(point.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld));
  }

  assert.deepEqual(precise.min.toArray(), expected.min.toArray());
  assert.deepEqual(precise.max.toArray(), expected.max.toArray());
  assert.ok(conservative.getSize(new THREE.Vector3()).length() > precise.getSize(new THREE.Vector3()).length());

  const surface = preciseObjectBounds(mesh, true);
  const meshBounds = preciseObjectBounds(mesh, "mesh");
  assert.deepEqual(meshBounds.min.toArray(), precise.min.toArray());
  assert.deepEqual(meshBounds.max.toArray(), precise.max.toArray());
  assert.ok(precise.containsBox(surface));
  assert.notDeepEqual(surface.getSize(new THREE.Vector3()).toArray(), precise.getSize(new THREE.Vector3()).toArray());
  geometry.dispose();
});

test("can frame hidden loose curves while surface-only bounds ignore them", () => {
  const surfaceGeometry = new THREE.BufferGeometry();
  surfaceGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -1, -1, 0,
     1, -1, 0,
     0,  1, 0,
  ], 3));
  surfaceGeometry.setIndex([0, 1, 2]);
  const mesh = new THREE.Mesh(surfaceGeometry);

  const guideGeometry = new THREE.BufferGeometry();
  guideGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -5, 0, 0,
     5, 0, 0,
  ], 3));
  const guide = new THREE.LineSegments(guideGeometry);
  guide.visible = false;
  mesh.add(guide);

  assert.deepEqual(preciseObjectBounds(mesh).min.toArray(), [-5, -1, 0]);
  assert.deepEqual(preciseObjectBounds(mesh).max.toArray(), [5, 1, 0]);
  assert.deepEqual(preciseObjectBounds(mesh, "mesh").min.toArray(), [-1, -1, 0]);
  assert.deepEqual(preciseObjectBounds(mesh, "mesh").max.toArray(), [1, 1, 0]);
  assert.deepEqual(preciseObjectBounds(mesh, true).min.toArray(), [-1, -1, 0]);
  assert.deepEqual(preciseObjectBounds(mesh, true).max.toArray(), [1, 1, 0]);

  guideGeometry.dispose();
  surfaceGeometry.dispose();
});
