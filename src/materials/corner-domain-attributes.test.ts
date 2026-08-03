import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { expandCornerDomainUv } from "../corner-domain-attributes";
import type { TriSoup } from "../gnvm";
import { expandFaceDomainMaterialAttributes } from "../image-pixel-stippler-material";

test("expands Blender CORNER UVs without changing triangle order or groups", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    1, 1, 0,
    0, 1, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.addGroup(0, 6, 0);
  const soup = {
    positions: geometry.getAttribute("position").array,
    normals: new Float32Array(12),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    triangleCorners: new Uint32Array([0, 1, 2, 0, 2, 3]),
    triangleFaces: new Uint32Array([0, 1]),
    attributes: {
      UVMap: {
        itemSize: 3,
        data: new Float32Array(12),
        domain: "CORNER",
        domainData: new Float32Array([
          0, 0, 0,
          1, 0, 0,
          1, 1, 0,
          0, 1, 0,
        ]),
      },
      rough: {
        itemSize: 1,
        data: new Float32Array([4.5, 2, 4.5, 7]),
        domain: "FACE",
        domainData: new Float32Array([2, 7]),
      },
    },
    groups: [{ start: 0, count: 6, material: "lightbulb_01_base" }],
    stats: { verts: 4, faces: 2, tris: 2 },
  } as TriSoup;

  const binding = expandCornerDomainUv(geometry, soup);
  assert.equal(binding?.sourceAttribute, "UVMap");
  assert.equal(binding?.geometry.index, null);
  assert.deepEqual(Array.from(binding?.geometry.getAttribute("uv").array ?? []), [
    0, 0,
    1, 0,
    1, 1,
    0, 0,
    1, 1,
    0, 1,
  ]);
  assert.deepEqual(binding?.geometry.groups, [{ start: 0, count: 6, materialIndex: 0 }]);
  const faceExpanded = expandFaceDomainMaterialAttributes(binding!.geometry, soup, new Set(["rough"]));
  assert.equal(faceExpanded, binding?.geometry);
  assert.deepEqual(Array.from(faceExpanded.getAttribute("rough").array), [2, 2, 2, 7, 7, 7]);
  assert.deepEqual(Array.from(faceExpanded.getAttribute("uv").array), [
    0, 0,
    1, 0,
    1, 1,
    0, 0,
    1, 1,
    0, 1,
  ]);
  binding?.geometry.dispose();
  geometry.dispose();
});
