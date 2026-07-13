// Compare GN-VM's browser surface wrap with render_crayon_curved_parity.py.
import { readFileSync } from "node:fs";
import { runGenerator, type Dump } from "../src/gnvm/index";

type Vec3 = [number, number, number];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, factor: number): Vec3 => [a[0] * factor, a[1] * factor, a[2] * factor];
const length = (a: Vec3) => Math.hypot(...a);
const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.max(length(a), 1e-12));
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (a: Vec3, b: Vec3, factor: number): Vec3 => add(scale(a, 1 - factor), scale(b, factor));

const center = normalize([.55, -.7, .46]);
const u = normalize(cross([0, 0, 1], center));
const v = normalize(cross(center, u));
const samples = Array.from({ length: 41 }, (_, index) => {
  const t = -1 + index / 20;
  const across = .22 * Math.sin(t * Math.PI * 1.4) + .08 * Math.cos(t * Math.PI * 2.6);
  const normal = normalize(add(add(center, scale(u, t * .75)), scale(v, across)));
  const base = scale(normal, 3);
  const wobble = 1 + .075 * Math.sin(base[2] * 2.4) * Math.cos(Math.atan2(base[1], base[0]) * 5);
  return { point: scale(base, wobble), normal };
});
const distances = [0];
for (let index = 1; index < samples.length; index++) distances.push(distances.at(-1)! + length(sub(samples[index].point, samples[index - 1].point)));

const frameAt = (distance: number) => {
  const clamped = Math.max(0, Math.min(distance, distances.at(-1)!));
  let index = 0;
  while (index < samples.length - 2 && clamped > distances[index + 1]) index++;
  const factor = Math.max(0, Math.min((clamped - distances[index]) / Math.max(distances[index + 1] - distances[index], 1e-9), 1));
  const point = lerp(samples[index].point, samples[index + 1].point, factor);
  const tangent = normalize(sub(samples[index + 1].point, samples[index].point));
  const normal = normalize(lerp(samples[index].normal, samples[index + 1].normal, factor));
  let lateral = normalize(cross(normal, tangent));
  if (length(lateral) < 1e-9) lateral = [0, 1, 0];
  return { point, lateral, normal };
};

const dump = JSON.parse(readFileSync(process.argv[2] ?? "public/dojo/crayon/dump.json", "utf8")) as Dump;
const target = dump.objects?.find((object) => object.name === "CHROME CRAYON OBJECT");
if (!target) throw new Error("CHROME CRAYON OBJECT missing");
target.curves = [{ cyclic: false, points: distances.map((distance) => [distance * 20, 0, 0]) }];
const result = await runGenerator(dump, { object: target.name, overrides: {
  "Line Thiccness": 6, "Peak Height": 10, Sigilize: 0, Soften: 0,
  resolution: .8, SPIRO: 1, "Extrude Base": 1, FLATTEN: false,
} });
const mesh = result.geometry.mesh;
if (!mesh) throw new Error("GN-VM returned no mesh");
const positions = mesh.positions.map((position) => {
  const frame = frameAt(position[0] / 20);
  return add(frame.point, add(scale(frame.lateral, position[1] / 20), scale(frame.normal, position[2] / 20)));
});
const bounds = (points: Vec3[]) => ({ min: [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis]))), max: [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis]))) });
let comparison: unknown = null;
if (process.argv[3]) {
  const reference = JSON.parse(readFileSync(process.argv[3], "utf8")) as { positions: Vec3[]; verts: number; faces: number; bbox: unknown };
  const deltas = positions.map((point, index) => point.map((value, axis) => Math.abs(value - reference.positions[index][axis])));
  const nearestDistances = positions.map((point) => Math.sqrt(reference.positions.reduce((best, candidate) => {
    const distance = (point[0] - candidate[0]) ** 2 + (point[1] - candidate[1]) ** 2 + (point[2] - candidate[2]) ** 2;
    return Math.min(best, distance);
  }, Infinity)));
  comparison = {
    blender: { verts: reference.verts, faces: reference.faces, bbox: reference.bbox },
    maxPositionDelta: [0, 1, 2].map((axis) => Math.max(...deltas.map((delta) => delta[axis]))),
    meanPositionDelta: [0, 1, 2].map((axis) => deltas.reduce((sum, delta) => sum + delta[axis], 0) / deltas.length),
    nearestVertex: { max: Math.max(...nearestDistances), mean: nearestDistances.reduce((sum, value) => sum + value, 0) / nearestDistances.length },
  };
}
console.log(JSON.stringify({ browser: { ...result.soup.stats, bbox: bounds(positions) }, missing: result.coverage.missingTypes, comparison }, null, 2));
