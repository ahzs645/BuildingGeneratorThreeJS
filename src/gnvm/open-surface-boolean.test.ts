import assert from "node:assert/strict";
import test from "node:test";
import { Mesh } from "./geometry";
import {
  filterOpenSurfaceCutterCycles,
  type OpenBooleanSegment,
  type OpenBooleanTriangle,
  type OpenBooleanVertex,
} from "./open-surface-boolean";

function islandMesh(count: number): Mesh {
  const mesh = new Mesh();
  for (let island = 0; island < count; island++) {
    const center = island * 20;
    const offset = mesh.positions.length;
    mesh.positions.push(
      [center - 1, -1, 0],
      [center + 1, -1, 0],
      [center, 2, 0],
    );
    mesh.faces.push([offset, offset + 1, offset + 2]);
    mesh.faceMaterial.push(0);
  }
  return mesh;
}

function region(
  index: number,
  owner: number,
  touched: number,
  area: number,
): { triangle: OpenBooleanTriangle; segments: OpenBooleanSegment[] } {
  const x = index * 10;
  const v0: OpenBooleanVertex = { x, y: 100, z: 0 };
  const v1: OpenBooleanVertex = { x: x + 1, y: 100, z: 0 };
  const v2: OpenBooleanVertex = { x, y: 100 + area * 2, z: 0 };
  const triangle = { v0, v1, v2 };
  return {
    triangle,
    segments: [
      { p0: v0, p1: v1, idxA: touched, idxB: owner },
      { p0: v1, p1: v2, idxA: touched, idxB: owner },
      { p0: v2, p1: v0, idxA: touched, idxB: owner },
    ],
  };
}

function splitOf(entries: { owner: number; touched: number; area: number }[]) {
  const regions = entries.map((entry, index) =>
    region(index, entry.owner, entry.touched, entry.area));
  return {
    groups: { bInside: regions.map((entry) => entry.triangle) },
    segments: regions.flatMap((entry) => entry.segments),
  };
}

function crackedRegion(
  owner: number,
  touched: number,
): { triangles: OpenBooleanTriangle[]; segments: OpenBooleanSegment[] } {
  const toleranceBoundary = 0.00005;
  const crackDelta = 0.0002;
  const a: OpenBooleanVertex = { x: 0, y: 100, z: 0 };
  const b: OpenBooleanVertex = { x: 1, y: 100, z: 0 };
  const c: OpenBooleanVertex = { x: 0, y: 101 + toleranceBoundary - 1e-6, z: 0 };
  const d: OpenBooleanVertex = { x: 0, y: 101 + toleranceBoundary + crackDelta, z: 0 };
  return {
    triangles: [
      { v0: a, v1: b, v2: c },
      { v0: b, v1: a, v2: d },
    ],
    // The B-C and D-B copies form the unlabelled near-coincident crack. The
    // remaining two boundary edges retain unanimous splitter provenance.
    segments: [
      { p0: c, p1: a, idxA: touched, idxB: owner },
      { p0: a, p1: d, idxA: touched, idxB: owner },
    ],
  };
}

test("drops only the weakest reciprocal interface that closes an island cycle", () => {
  const source = islandMesh(3);
  const cutter = islandMesh(3);
  const split = splitOf([
    { owner: 0, touched: 2, area: 4 },
    { owner: 2, touched: 0, area: 4 },
    { owner: 1, touched: 2, area: 3 },
    { owner: 2, touched: 1, area: 3 },
    { owner: 0, touched: 1, area: 2 },
    { owner: 1, touched: 0, area: 2 },
  ]);

  const result = filterOpenSurfaceCutterCycles(source, cutter, split);

  assert.ok(result);
  assert.deepEqual(result.retainedInterfaces, [[0, 2], [1, 2]]);
  assert.deepEqual(result.droppedInterfaces, [[0, 1]]);
  assert.equal(result.retainedTriangles, 4);
  assert.equal(result.droppedTriangles, 2);
});

test("retains every reciprocal bridge in an acyclic island graph", () => {
  const source = islandMesh(4);
  const cutter = islandMesh(4);
  const split = splitOf([
    { owner: 0, touched: 1, area: 1 },
    { owner: 1, touched: 0, area: 1 },
    { owner: 1, touched: 2, area: 1 },
    { owner: 2, touched: 1, area: 1 },
    { owner: 2, touched: 3, area: 1 },
    { owner: 3, touched: 2, area: 1 },
  ]);

  const result = filterOpenSurfaceCutterCycles(source, cutter, split);

  assert.ok(result);
  assert.equal(result.interfaceCount, 3);
  assert.deepEqual(result.droppedInterfaces, []);
  assert.equal(result.retainedTriangles, 6);
});

test("declines to filter incomplete or ambiguous segment provenance", () => {
  const source = islandMesh(2);
  const cutter = islandMesh(2);
  const split = splitOf([
    { owner: 0, touched: 1, area: 1 },
    { owner: 1, touched: 0, area: 1 },
  ]);
  split.segments.pop();

  assert.equal(filterOpenSurfaceCutterCycles(source, cutter, split), null);
});

test("accepts missing provenance only for uniquely paired near-coincident crack edges", () => {
  const source = islandMesh(2);
  const cutter = islandMesh(2);
  const cracked = crackedRegion(0, 1);
  const reverse = region(1, 1, 0, 1);
  const split = {
    groups: { bInside: [...cracked.triangles, reverse.triangle] },
    segments: [...cracked.segments, ...reverse.segments],
  };

  const result = filterOpenSurfaceCutterCycles(source, cutter, split);

  assert.ok(result);
  assert.equal(result.interfaceCount, 1);
  assert.equal(result.regionCount, 2);
  assert.equal(result.retainedTriangles, 3);
});

test("declines paired crack edges when the labelled boundary provenance is mixed", () => {
  const source = islandMesh(2);
  const cutter = islandMesh(2);
  const cracked = crackedRegion(0, 1);
  cracked.segments[1].idxA = 0;
  const reverse = region(1, 1, 0, 1);
  const split = {
    groups: { bInside: [...cracked.triangles, reverse.triangle] },
    segments: [...cracked.segments, ...reverse.segments],
  };

  assert.equal(filterOpenSurfaceCutterCycles(source, cutter, split), null);
});

test("declines to filter an interface with unmatched same-direction regions", () => {
  const source = islandMesh(2);
  const cutter = islandMesh(2);
  const split = splitOf([
    { owner: 0, touched: 1, area: 1 },
    { owner: 0, touched: 1, area: 2 },
    { owner: 1, touched: 0, area: 1 },
  ]);

  assert.equal(filterOpenSurfaceCutterCycles(source, cutter, split), null);
});
