import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runGenerator, type Dump } from "./index";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/n03d/layer-height-case/dump.json",
  import.meta.url,
)), "utf8")) as Dump;

test("preserves Blender's unassigned material slots through Join Geometry", async () => {
  const source = (dump.objects as Array<{
    name: string;
    materials?: Array<string | null>;
    mesh?: { face_materials?: number[] };
  }>).find((object) => object.name === "tutorial");
  assert.deepEqual(source?.materials, [null, "filament visualizer .02 mm layer height.001"]);
  assert.ok(source?.mesh?.face_materials?.includes(1));

  const result = await runGenerator(dump, { object: "tutorial" });
  assert.deepEqual(result.soup.stats, { verts: 4512, faces: 3032, tris: 8916 });
  assert.deepEqual(result.soup.groups.map((group) => group.material), [
    null,
    "filament visualizer .02 mm layer height.001",
  ]);
  const materialFaceCounts = Object.fromEntries(result.soup.groups.map((group) => {
    const firstTriangle = group.start / 3;
    const triangleCount = group.count / 3;
    return [
      group.material ?? "<none>",
      new Set(result.soup.triangleFaces.slice(firstTriangle, firstTriangle + triangleCount)).size,
    ];
  }));
  assert.deepEqual(materialFaceCounts, {
    "<none>": 1718,
    "filament visualizer .02 mm layer height.001": 1314,
  });
  assert.equal(result.soup.groups.reduce((sum, group) => sum + group.count, 0), result.soup.indices.length);
});
