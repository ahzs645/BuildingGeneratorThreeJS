// Evaluate GN-VM's Blender-float Geometry Proximity path on a raw mesh export.
// Usage: npx tsx tools/gnvm-mesh-proximity-probe.ts MESH.json '[x,y,z]'
import { readFileSync } from "node:fs";
import { Mesh } from "../src/gnvm/geometry";
import { nearestFacePointFloat32 } from "../src/gnvm/nodes/geometry";
import type { Vec3 } from "../src/gnvm/core";

const [, , meshPath, pointJson, offsetJson] = process.argv;
if (!meshPath || !pointJson) throw new Error("usage: gnvm-mesh-proximity-probe MESH.json '[x,y,z]'");
const payload = JSON.parse(readFileSync(meshPath, "utf8"));
const point = JSON.parse(pointJson) as Vec3;
const offset = offsetJson ? JSON.parse(offsetJson) as Vec3 : [0, 0, 0] as Vec3;
const translated = (value: Vec3): Vec3 => [
  Math.fround(Math.fround(value[0]) + Math.fround(offset[0])),
  Math.fround(Math.fround(value[1]) + Math.fround(offset[1])),
  Math.fround(Math.fround(value[2]) + Math.fround(offset[2])),
];
const mesh = new Mesh();
mesh.positions = Array.isArray(payload.positions[0])
  ? payload.positions
  : Array.from({ length: payload.positions.length / 3 }, (_, index) => payload.positions.slice(index * 3, index * 3 + 3));
mesh.positions = mesh.positions.map(translated);
if (payload.triangles) mesh.faces = payload.triangles;
else if (payload.indices) {
  for (let index = 0; index < payload.indices.length; index += 3) {
    mesh.faces.push(payload.indices.slice(index, index + 3));
  }
} else mesh.faces = payload.faces;
const query = translated(point);
console.log(JSON.stringify({ point, offset, query, ...nearestFacePointFloat32(query, mesh) }, null, 2));
