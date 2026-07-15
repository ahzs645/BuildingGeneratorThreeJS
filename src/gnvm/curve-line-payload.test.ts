import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Geometry, Mesh, toTriSoup } from "./geometry";
import { runGenerator, type Dump } from "./index";

test("toTriSoup exports open and cyclic curves as display-only line segments", () => {
  const geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  geometry.mesh.faces = [[0, 1, 2]];
  geometry.mesh.faceMaterial = [0];
  geometry.curves = [
    {
      cyclic: false,
      controlPoints: [[0, 0, 1], [2, 0, 1]],
      points: [[0, 0, 1], [1, 0.5, 1], [2, 0, 1]],
    },
    {
      cyclic: true,
      points: [[0, 0, 2], [1, 0, 2], [1, 1, 2]],
    },
  ];

  const soup = toTriSoup(geometry);
  assert.deepEqual(soup.stats, { verts: 3, faces: 1, tris: 1 });
  assert.deepEqual(soup.lines?.stats, {
    controlPoints: 5,
    evaluatedPoints: 6,
    segments: 5,
    splines: 2,
  });
  assert.deepEqual(Array.from(soup.lines?.positions ?? []), [
    0, 0, 1, 1, 0.5, 1,
    1, 0.5, 1, 2, 0, 1,
    0, 0, 2, 1, 0, 2,
    1, 0, 2, 1, 1, 2,
    1, 1, 2, 0, 0, 2,
  ]);
});

test("toTriSoup omits a line payload when no curve has a segment", () => {
  const geometry = new Geometry();
  geometry.curves = [{ cyclic: false, points: [[1, 2, 3]] }];

  const soup = toTriSoup(geometry);
  assert.deepEqual(soup.stats, { verts: 0, faces: 0, tris: 0 });
  assert.equal(soup.lines, undefined);
});

test("Nodes Node check wire matches Blender world bounds without becoming mesh topology", async () => {
  const dump = JSON.parse(readFileSync("public/dojo/nodes-node/dump.json", "utf8")) as Dump;
  const reference = JSON.parse(readFileSync(
    "public/dojo/nodes-node/references/check-blender.json",
    "utf8",
  )) as { bbox: { min: number[]; max: number[] } };
  const object = dump.objects?.find((candidate) => candidate.name === "check");
  assert.ok(object?.location);

  const result = await runGenerator(dump, { object: "check" });
  assert.deepEqual(result.coverage.missingTypes, []);
  assert.deepEqual(result.soup.stats, { verts: 0, faces: 0, tris: 0 });
  assert.deepEqual(result.soup.lines?.stats, {
    controlPoints: 3,
    evaluatedPoints: 25,
    segments: 24,
    splines: 1,
  });

  const positions = result.soup.lines!.positions;
  const localMin = [Infinity, Infinity, Infinity];
  const localMax = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      localMin[axis] = Math.min(localMin[axis], positions[offset + axis]);
      localMax[axis] = Math.max(localMax[axis], positions[offset + axis]);
    }
  }
  for (let axis = 0; axis < 3; axis++) {
    const worldMin = localMin[axis] + object.location[axis];
    const worldMax = localMax[axis] + object.location[axis];
    assert.ok(Math.abs(worldMin - reference.bbox.min[axis]) <= 1e-6);
    assert.ok(Math.abs(worldMax - reference.bbox.max[axis]) <= 1e-6);
  }

  const meshResult = await runGenerator(dump, { object: "Cube.002" });
  assert.deepEqual(meshResult.soup.stats, { verts: 8, faces: 6, tris: 12 });
  assert.equal(meshResult.soup.lines, undefined);
});
