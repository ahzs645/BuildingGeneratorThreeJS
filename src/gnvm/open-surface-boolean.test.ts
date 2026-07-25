import assert from "node:assert/strict";
import test from "node:test";
import { Mesh } from "./geometry";
import {
  filterOpenSurfaceCutterCycles,
  partitionOpenSurfaceAtomicCells,
  partitionOpenSurfaceCompoundOperand,
  partitionOpenSurfaceSplitGroup,
  selectOpenSurfaceMaterialBoundaryCells,
  selectOpenSurfaceOwnedShellCells,
  selectOpenSurfaceUnionBoundaryCells,
  type OpenSurfaceAtomicPartition,
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

function triangle(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
): OpenBooleanTriangle {
  const vertex = ([x, y, z]: [number, number, number]): OpenBooleanVertex => ({ x, y, z });
  return { v0: vertex(a), v1: vertex(b), v2: vertex(c) };
}

function disconnectedTrianglesMesh(triangles: OpenBooleanTriangle[]): Mesh {
  const mesh = new Mesh();
  for (const entry of triangles) {
    const offset = mesh.positions.length;
    mesh.positions.push(
      [entry.v0.x, entry.v0.y, entry.v0.z],
      [entry.v1.x, entry.v1.y, entry.v1.z],
      [entry.v2.x, entry.v2.y, entry.v2.z],
    );
    mesh.faces.push([offset, offset + 1, offset + 2]);
    mesh.faceMaterial.push(0);
  }
  return mesh;
}

function appendCube(mesh: Mesh, center: [number, number, number], size = 2): void {
  const offset = mesh.positions.length;
  const half = size * 0.5;
  for (const z of [-half, half]) for (const y of [-half, half]) for (const x of [-half, half])
    mesh.positions.push([center[0] + x, center[1] + y, center[2] + z]);
  mesh.faces.push(
    [offset + 0, offset + 2, offset + 3, offset + 1],
    [offset + 4, offset + 5, offset + 7, offset + 6],
    [offset + 0, offset + 1, offset + 5, offset + 4],
    [offset + 2, offset + 6, offset + 7, offset + 3],
    [offset + 0, offset + 4, offset + 6, offset + 2],
    [offset + 1, offset + 3, offset + 7, offset + 5],
  );
  mesh.faceMaterial.push(0, 0, 0, 0, 0, 0);
}

function appendOpenCube(mesh: Mesh, center: [number, number, number], size = 2): void {
  const offset = mesh.positions.length;
  const half = size * 0.5;
  for (const z of [-half, half]) for (const y of [-half, half]) for (const x of [-half, half])
    mesh.positions.push([center[0] + x, center[1] + y, center[2] + z]);
  mesh.faces.push(
    [offset + 0, offset + 1, offset + 5, offset + 4],
    [offset + 2, offset + 6, offset + 7, offset + 3],
    [offset + 0, offset + 4, offset + 6, offset + 2],
    [offset + 1, offset + 3, offset + 7, offset + 5],
  );
  mesh.faceMaterial.push(0, 0, 0, 0);
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
  assert.equal(result.sourceAtomicCellCount, 3);
  assert.equal(result.sourceAtomicTriangleCount, 3);
  assert.equal(result.sourceAtomicConstraintCount, 0);
  assert.equal(result.sourceAtomicArea, 9);
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

test("partitions a retained sheet into atomic cells at a cutter-cutter constraint", () => {
  const region = [
    triangle([0, 0, 0], [1, 0, 0], [1, 1, 0]),
    triangle([0, 0, 0], [1, 1, 0], [0, 1, 0]),
  ];
  const cutter = disconnectedTrianglesMesh([
    triangle([10, 10, 10], [11, 10, 10], [10, 11, 10]),
    triangle([0.5, -1, -1], [0.5, 2, -1], [0.5, 0.5, 2]),
  ]);

  const partition = partitionOpenSurfaceAtomicCells(cutter, [{
    triangles: region,
    ownerCutterIsland: 0,
  }]);

  assert.ok(partition);
  assert.ok(partition.constraintCount >= 2);
  assert.ok(partition.triangles.length > region.length);
  assert.equal(partition.cells.length, 2);
  assert.ok(Math.abs(partition.cells.reduce((sum, cell) => sum + cell.area, 0) - 1) < 1e-7);
  assert.deepEqual(partition.cells.map((cell) => cell.boundaryCutterIslands), [[1], [1]]);
});

test("inserts one stable crossing for two constraint families inside a parent", () => {
  const parent = triangle([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  const cutter = disconnectedTrianglesMesh([
    triangle([10, 10, 10], [11, 10, 10], [10, 11, 10]),
    triangle([0.3, -1, -1], [0.3, 2, -1], [0.3, 0.5, 2]),
    triangle([-1, 0.3, -1], [2, 0.3, -1], [0.5, 0.3, 2]),
  ]);

  const partition = partitionOpenSurfaceAtomicCells(cutter, [{
    triangles: [parent],
    ownerCutterIsland: 0,
  }]);

  assert.ok(partition);
  assert.equal(partition.cells.length, 4);
  assert.ok(Math.abs(partition.cells.reduce((sum, cell) => sum + cell.area, 0) - 0.5) < 1e-7);
  const crossingPoints = partition.triangles.flatMap((entry) => [entry.v0, entry.v1, entry.v2])
    .filter((point) => Math.hypot(point.x - 0.3, point.y - 0.3, point.z) < 1e-8);
  assert.ok(crossingPoints.length >= 4);
  assert.ok(crossingPoints.every((point) => point.x === crossingPoints[0].x
    && point.y === crossingPoints[0].y
    && point.z === crossingPoints[0].z));
});

test("declines overlapping cutter-cutter constraints conservatively", () => {
  const crossing = triangle([0.3, -1, -1], [0.3, 2, -1], [0.3, 0.5, 2]);
  const cutter = disconnectedTrianglesMesh([
    triangle([10, 10, 10], [11, 10, 10], [10, 11, 10]),
    crossing,
    crossing,
  ]);
  const region = triangle([0, 0, 0], [1, 0, 0], [0, 1, 0]);

  const diagnostics = {};
  assert.equal(partitionOpenSurfaceAtomicCells(cutter, [{
    triangles: [region],
    ownerCutterIsland: 0,
  }], 1e-4, diagnostics), null);
  assert.deepEqual(diagnostics, {
    failure: "overlapping-or-degenerate-constraints",
    region: 0,
    triangle: 0,
    constraintCount: 2,
  });
});

test("selects only stable two-sided material boundaries", () => {
  const cellTriangle = triangle([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  const partition: OpenSurfaceAtomicPartition = {
    cells: [{
      triangles: [cellTriangle],
      ownerCutterIsland: 0,
      boundaryCutterIslands: [],
      area: 0.5,
    }],
    triangles: [cellTriangle],
    constraintCount: 0,
  };

  const selected = selectOpenSurfaceMaterialBoundaryCells(partition, (point) => point.z > 0, 0.01);
  assert.ok(selected);
  assert.equal(selected.cells.length, 1);
  assert.deepEqual(selected.triangles, [cellTriangle]);
  assert.equal(selectOpenSurfaceMaterialBoundaryCells(partition, () => false, 0.01)?.cells.length, 0);
  assert.equal(selectOpenSurfaceMaterialBoundaryCells(
    partition,
    (point) => Math.abs(point.z) < 0.015,
    0.01,
  ), null);
});

test("selects an owned shell cell only inside its occluding cutter island", () => {
  const cutter = new Mesh();
  appendCube(cutter, [10, 0, 0]);
  appendCube(cutter, [0, 0, 0]);
  const insideTriangle = triangle([-0.5, -0.5, 0], [0.5, -0.5, 0], [-0.5, 0.5, 0]);
  const outsideTriangle = triangle([3, -0.5, 0], [4, -0.5, 0], [3, 0.5, 0]);
  const partition: OpenSurfaceAtomicPartition = {
    cells: [insideTriangle, outsideTriangle].map((entry) => ({
      triangles: [entry],
      ownerCutterIsland: 0,
      occludingCutterIsland: 1,
      boundaryCutterIslands: [1],
      area: 0.5,
    })),
    triangles: [insideTriangle, outsideTriangle],
    constraintCount: 1,
  };

  const selected = selectOpenSurfaceOwnedShellCells(cutter, partition);

  assert.ok(selected);
  assert.equal(selected.cells.length, 1);
  assert.deepEqual(selected.triangles, [insideTriangle]);
});

test("declines an owned shell cell whose representative lies on the occluder", () => {
  const cutter = new Mesh();
  appendCube(cutter, [10, 0, 0]);
  appendCube(cutter, [0, 0, 0]);
  const boundaryTriangle = triangle([1, -0.5, -0.5], [1, 0.5, -0.5], [1, -0.5, 0.5]);
  const partition: OpenSurfaceAtomicPartition = {
    cells: [{
      triangles: [boundaryTriangle],
      ownerCutterIsland: 0,
      occludingCutterIsland: 1,
      boundaryCutterIslands: [1],
      area: 0.5,
    }],
    triangles: [boundaryTriangle],
    constraintCount: 1,
  };

  assert.equal(selectOpenSurfaceOwnedShellCells(cutter, partition), null);
});

test("selects an open compound source union without returning synthetic caps", () => {
  const source = new Mesh();
  appendOpenCube(source, [0, 0, 0]);
  appendOpenCube(source, [1, 0, 0]);
  const visible = triangle([-1, -0.5, -0.5], [-1, 0.5, -0.5], [-1, -0.5, 0.5]);
  const hidden = triangle([1, -0.5, -0.5], [1, -0.5, 0.5], [1, 0.5, -0.5]);
  const partition: OpenSurfaceAtomicPartition = {
    cells: [visible, hidden].map((entry) => ({
      triangles: [entry],
      ownerCutterIsland: 0,
      boundaryCutterIslands: [1],
      area: 0.5,
    })),
    triangles: [visible, hidden],
    constraintCount: 1,
  };

  const selected = selectOpenSurfaceUnionBoundaryCells(source, partition);

  assert.ok(selected);
  assert.deepEqual(selected.triangles, [visible]);
  assert.equal(selected.cells.length, 1);
  assert.equal(selected.cells[0].area, 0.5);
});

test("partitions every island of a compound source operand", () => {
  const source = disconnectedTrianglesMesh([
    triangle([0, 0, 0], [1, 0, 0], [0, 1, 0]),
    triangle([0.3, -1, -1], [0.3, 2, -1], [0.3, 0.5, 2]),
  ]);

  const partition = partitionOpenSurfaceCompoundOperand(source);

  assert.ok(partition);
  assert.ok(partition.constraintCount >= 2);
  assert.ok(partition.triangles.length > source.faces.length);
});

test("maps BMS split regions by vertex provenance instead of traversal order", () => {
  const first = triangle([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  const second = triangle([10, 0, 0], [11, 0, 0], [10, 1, 0]);
  const operand = disconnectedTrianglesMesh([first, second]);

  const partition = partitionOpenSurfaceSplitGroup(operand, [second, first]);

  assert.ok(partition);
  assert.deepEqual(partition.cells.map((cell) => cell.ownerCutterIsland), [1, 0]);
  assert.equal(partition.triangles.length, 2);
});

test("declines a synthetic BMS region with no stable operand provenance", () => {
  const operand = disconnectedTrianglesMesh([
    triangle([0, 0, 0], [1, 0, 0], [0, 1, 0]),
    triangle([10, 0, 0], [11, 0, 0], [10, 1, 0]),
  ]);
  const diagnostics = {};

  const partition = partitionOpenSurfaceSplitGroup(operand, [
    triangle([20, 0, 0], [21, 0, 0], [20, 1, 0]),
  ], 1e-4, diagnostics);

  assert.equal(partition, null);
  assert.deepEqual(diagnostics, {
    failure: "ambiguous-region-owner",
    region: 0,
  });
});
