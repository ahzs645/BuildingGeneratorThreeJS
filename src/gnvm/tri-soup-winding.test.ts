import assert from "node:assert/strict";
import test from "node:test";
import type { Vec3 } from "./core";
import { Geometry, toTriSoup } from "./geometry";
import { surfaceNetsForTest } from "./nodes/volume";

function triangleSignedVolume(a: Vec3, b: Vec3, c: Vec3): number {
  return (
    a[0] * (b[1] * c[2] - b[2] * c[1])
    + a[1] * (b[2] * c[0] - b[0] * c[2])
    + a[2] * (b[0] * c[1] - b[1] * c[0])
  ) / 6;
}

test("toTriSoup preserves Blender's intentionally inward Volume to Mesh winding", () => {
  const resolution: Vec3 = [16, 16, 16];
  const values = new Float32Array(resolution[0] * resolution[1] * resolution[2]);
  for (let z = 0; z < resolution[2]; z++) for (let y = 0; y < resolution[1]; y++) for (let x = 0; x < resolution[0]; x++) {
    const px = -1 + x * 2 / (resolution[0] - 1);
    const py = -1 + y * 2 / (resolution[1] - 1);
    const pz = -1 + z * 2 / (resolution[2] - 1);
    values[z * resolution[0] * resolution[1] + y * resolution[0] + x] = Math.fround(
      Math.hypot(px, py, pz) - 0.7,
    );
  }

  const geometry = new Geometry();
  geometry.mesh = surfaceNetsForTest(
    values,
    resolution,
    0,
    [-1, -1, -1],
    [2 / 15, 2 / 15, 2 / 15],
  );
  const soup = toTriSoup(geometry);
  let signedVolume = 0;
  for (let offset = 0; offset < soup.indices.length; offset += 3) {
    const point = (index: number): Vec3 => [
      soup.positions[index * 3],
      soup.positions[index * 3 + 1],
      soup.positions[index * 3 + 2],
    ];
    signedVolume += triangleSignedVolume(
      point(soup.indices[offset]),
      point(soup.indices[offset + 1]),
      point(soup.indices[offset + 2]),
    );
  }

  assert.ok(signedVolume < 0, `expected inward signed volume, received ${signedVolume}`);
  assert.ok(Math.abs(signedVolume + 1.378306) < 1e-5);
});
