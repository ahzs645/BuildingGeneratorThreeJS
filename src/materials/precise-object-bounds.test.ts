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
  assert.ok(precise.containsBox(surface));
  assert.notDeepEqual(surface.getSize(new THREE.Vector3()).toArray(), precise.getSize(new THREE.Vector3()).toArray());
  geometry.dispose();
});
