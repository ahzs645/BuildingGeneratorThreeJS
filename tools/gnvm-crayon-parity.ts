// Evaluate the same deterministic flat path as render_crayon_parity_path.py.
// Usage: tsx tools/gnvm-crayon-parity.ts [dump.json]
import { readFileSync } from "node:fs";
import { runGenerator, type Dump } from "../src/gnvm/index";

const dumpPath = process.argv[2] ?? "public/dojo/crayon/dump.json";
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
const target = dump.objects?.find((object) => object.name === "CHROME CRAYON OBJECT");
if (!target) throw new Error("CHROME CRAYON OBJECT missing from dump");
target.curves = [{
  cyclic: false,
  points: [[-48, -14, 0], [-33, 8.4, 0], [-16, 16.4, 0], [1, 1.6, 0], [18, -12.4, 0], [34, -5, 0], [48, 13.6, 0]],
}];

const result = await runGenerator(dump, {
  object: target.name,
  overrides: {
    "Line Thiccness": Number(process.env.CRAYON_THICKNESS ?? 6),
    "Peak Height": Number(process.env.CRAYON_PEAK ?? 10),
    Sigilize: Number(process.env.CRAYON_SIGILIZE ?? 0),
    Soften: 0,
    resolution: Number(process.env.CRAYON_RESOLUTION ?? .8),
    SPIRO: Number(process.env.CRAYON_SPIRO ?? 1),
    "Extrude Base": 1,
    FLATTEN: false,
  },
});

const bounds = (positions: number[][]) => ({
  min: [0, 1, 2].map((axis) => Math.min(...positions.map((point) => point[axis]))),
  max: [0, 1, 2].map((axis) => Math.max(...positions.map((point) => point[axis]))),
});
const mesh = result.geometry.mesh;
const materialStats = mesh ? mesh.materialSlots.map((material, slot) => {
  const faceIndices = mesh.faceMaterial.flatMap((value, index) => value === slot ? [index] : []);
  const vertexIndices = new Set(faceIndices.flatMap((index) => mesh.faces[index]));
  return { material, faces: faceIndices.length, verts: vertexIndices.size, bounds: bounds([...vertexIndices].map((index) => mesh.positions[index])) };
}) : [];
let blenderComparison: unknown = null;
if (mesh && process.argv[3]) {
  const reference = JSON.parse(readFileSync(process.argv[3], "utf8")) as { parity_mesh: { positions: number[][]; faces: number[][] } };
  const blender = reference.parity_mesh;
  const facesIdentical = JSON.stringify(mesh.faces) === JSON.stringify(blender.faces);
  const deltas = mesh.positions.map((point, index) => point.map((value, axis) => value - blender.positions[index][axis]));
  const regression = [0, 1, 2].map((axis) => {
    const x = blender.positions.map((point) => point[axis]);
    const y = mesh.positions.map((point) => point[axis]);
    const xMean = x.reduce((sum, value) => sum + value, 0) / x.length;
    const yMean = y.reduce((sum, value) => sum + value, 0) / y.length;
    const slope = x.reduce((sum, value, index) => sum + (value - xMean) * (y[index] - yMean), 0)
      / x.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
    return { slope, intercept: yMean - slope * xMean };
  });
  blenderComparison = {
    facesIdentical,
    maxIndexDelta: [0, 1, 2].map((axis) => Math.max(...deltas.map((delta) => Math.abs(delta[axis])))),
    meanIndexDelta: [0, 1, 2].map((axis) => deltas.reduce((sum, delta) => sum + Math.abs(delta[axis]), 0) / deltas.length),
    regression,
  };
}
console.log(JSON.stringify({ stats: result.soup.stats, bounds: mesh ? bounds(mesh.positions) : null, materialStats, missing: result.coverage.missingTypes, blenderComparison }, null, 2));
