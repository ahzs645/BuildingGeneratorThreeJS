import * as THREE from "three";
import { addMaterialXAttributeAliases } from "./essl-adapter";

/** Matched UV sphere used by the Blender/MaterialX renderer comparison. */
export function makeProbeGeometry(widthSegments = 64, heightSegments = 32): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let y = 0; y <= heightSegments; y += 1) {
    const v = y / heightSegments;
    const phi = v * Math.PI;
    for (let x = 0; x <= widthSegments; x += 1) {
      const u = x / widthSegments;
      const theta = u * Math.PI * 2;
      const px = Math.sin(phi) * Math.cos(theta);
      const py = Math.cos(phi);
      const pz = Math.sin(phi) * Math.sin(theta);
      positions.push(px, py, pz);
      normals.push(px, py, pz);
      uvs.push(u, 1 - v);
      colors.push((px + 1) * 0.5, (py + 1) * 0.5, (pz + 1) * 0.5);
    }
  }
  for (let y = 0; y < heightSegments; y += 1) {
    for (let x = 0; x < widthSegments; x += 1) {
      const a = y * (widthSegments + 1) + x;
      const b = a + widthSegments + 1;
      // Counter-clockwise from outside. This is part of the comparison
      // contract: inward winding culls the near hemisphere in Three.js.
      if (y !== 0) indices.push(a, a + 1, b);
      if (y !== heightSegments - 1) indices.push(b, a + 1, b + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("rough", new THREE.Float32BufferAttribute(new Array(positions.length / 3).fill(0.8), 1));
  geometry.setAttribute("col", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeTangents();
  addMaterialXAttributeAliases(geometry);
  geometry.computeBoundingSphere();
  return geometry;
}
