import { readFile } from "node:fs/promises";
import {
  bmsBooleanOp,
  type Triangle,
} from "trimesh-boolean";
import { buildTopology, Mesh, triangulateFaceIndices } from "../src/gnvm/geometry";
import {
  filterOpenSurfaceCutterCycles,
  partitionOpenSurfaceAtomicCells,
  partitionOpenSurfaceSplitGroup,
  selectOpenSurfaceUnionBoundaryCells,
  type OpenBooleanTriangle,
  type OpenBooleanVertex,
  type OpenSurfaceAtomicPartitionDiagnostics,
} from "../src/gnvm/open-surface-boolean";
import { BufferAttribute, BufferGeometry, Vector3 } from "three";
import { MeshBVH } from "three-mesh-bvh";

const sourcePath = process.argv[2];
const cutterPath = process.argv[3];
if (!sourcePath || !cutterPath) throw new Error(
  "Usage: node --import tsx tools/three-way-bms-local-diagnostic.ts <source.json> <cutter.json> [tolerance] [blender-truth.json]",
);
const tolerance = Number(process.argv[4] ?? 1e-4);
const truthPath = process.argv[5];

interface PortableMesh {
  positions: [number, number, number][];
  faces: number[][];
}

function bvhFromPortable(value: PortableMesh): MeshBVH {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(value.positions.flat()), 3));
  geometry.setIndex(value.faces.flatMap((face) =>
    Array.from({ length: Math.max(0, face.length - 2) }, (_, index) => [
      face[0],
      face[index + 1],
      face[index + 2],
    ]).flat()));
  return new MeshBVH(geometry);
}

const truth = truthPath
  ? bvhFromPortable(JSON.parse(await readFile(truthPath, "utf8")))
  : null;

function truthDistance(point: OpenBooleanVertex): number | null {
  if (!truth) return null;
  const result = truth.closestPointToPoint(
    new Vector3(point.x, point.y, point.z),
    new Vector3(),
  );
  return result?.distance ?? null;
}

function cellTruthReport(triangles: OpenBooleanTriangle[]) {
  if (!truth) return null;
  let offSurfaceArea = 0;
  let maximumDistance = 0;
  for (const triangle of triangles) {
    const distance = truthDistance({
      x: (triangle.v0.x + triangle.v1.x + triangle.v2.x) / 3,
      y: (triangle.v0.y + triangle.v1.y + triangle.v2.y) / 3,
      z: (triangle.v0.z + triangle.v1.z + triangle.v2.z) / 3,
    })!;
    maximumDistance = Math.max(maximumDistance, distance);
    if (distance > tolerance) offSurfaceArea += triangleArea(triangle);
  }
  return { offSurfaceArea, maximumDistance };
}

function meshFromPortable(value: PortableMesh): Mesh {
  const mesh = new Mesh();
  mesh.positions = value.positions;
  mesh.faces = value.faces;
  mesh.faceMaterial = value.faces.map(() => 0);
  return mesh;
}

function soupFromMesh(mesh: Mesh): OpenBooleanTriangle[] {
  const vertex = (index: number): OpenBooleanVertex => {
    const [x, y, z] = mesh.positions[index];
    return { x, y, z };
  };
  return mesh.faces.flatMap((face) =>
    triangulateFaceIndices(mesh, face).map(([a, b, c]) => ({
      v0: vertex(a),
      v1: vertex(b),
      v2: vertex(c),
    })));
}

const pointKey = (point: OpenBooleanVertex): string =>
  `${Math.round(point.x / tolerance)},${Math.round(point.y / tolerance)},${Math.round(point.z / tolerance)}`;

function edgeKey(a: OpenBooleanVertex, b: OpenBooleanVertex): string {
  const ka = pointKey(a);
  const kb = pointKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function triangleArea(triangle: OpenBooleanTriangle): number {
  const ax = triangle.v1.x - triangle.v0.x;
  const ay = triangle.v1.y - triangle.v0.y;
  const az = triangle.v1.z - triangle.v0.z;
  const bx = triangle.v2.x - triangle.v0.x;
  const by = triangle.v2.y - triangle.v0.y;
  const bz = triangle.v2.z - triangle.v0.z;
  return Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) * 0.5;
}

function connectedRegions(triangles: OpenBooleanTriangle[]): OpenBooleanTriangle[][] {
  const edgeTriangles = new Map<string, number[]>();
  for (let triangle = 0; triangle < triangles.length; triangle++) {
    const entry = triangles[triangle];
    for (const [a, b] of [[entry.v0, entry.v1], [entry.v1, entry.v2], [entry.v2, entry.v0]]) {
      const key = edgeKey(a, b);
      const incident = edgeTriangles.get(key) ?? [];
      incident.push(triangle);
      edgeTriangles.set(key, incident);
    }
  }
  const neighbors = triangles.map(() => [] as number[]);
  for (const incident of edgeTriangles.values()) for (let i = 0; i < incident.length; i++)
    for (let j = i + 1; j < incident.length; j++) {
      neighbors[incident[i]].push(incident[j]);
      neighbors[incident[j]].push(incident[i]);
    }
  const visited = new Uint8Array(triangles.length);
  const regions: OpenBooleanTriangle[][] = [];
  for (let seed = 0; seed < triangles.length; seed++) {
    if (visited[seed]) continue;
    const indices: number[] = [];
    const queue = [seed];
    visited[seed] = 1;
    for (let head = 0; head < queue.length; head++) {
      const triangle = queue[head];
      indices.push(triangle);
      for (const neighbor of neighbors[triangle]) if (!visited[neighbor]) {
        visited[neighbor] = 1;
        queue.push(neighbor);
      }
    }
    regions.push(indices.map((index) => triangles[index]));
  }
  return regions;
}

function islandVertexKeys(mesh: Mesh): Set<string>[] {
  const topology = buildTopology(mesh);
  const keys = Array.from({ length: topology.faceIslandCount }, () => new Set<string>());
  for (let face = 0; face < mesh.faces.length; face++) {
    const island = topology.faceIsland[face];
    for (const index of mesh.faces[face]) {
      const [x, y, z] = mesh.positions[index];
      keys[island].add(pointKey({ x, y, z }));
    }
  }
  return keys;
}

function ownerOf(region: OpenBooleanTriangle[], islands: Set<string>[]): {
  owner: number;
  scores: number[];
} {
  const scores = islands.map(() => 0);
  for (const triangle of region) for (const point of [triangle.v0, triangle.v1, triangle.v2]) {
    const key = pointKey(point);
    for (let island = 0; island < islands.length; island++)
      if (islands[island].has(key)) scores[island]++;
  }
  const owner = scores.reduce(
    (best, score, index) => score > scores[best] ? index : best,
    0,
  );
  return { owner, scores };
}

function diagnoseRegions(label: string, mesh: Mesh, triangles: OpenBooleanTriangle[]) {
  const groupDiagnostics: OpenSurfaceAtomicPartitionDiagnostics = {};
  const groupPartition = partitionOpenSurfaceSplitGroup(
    mesh,
    triangles,
    tolerance,
    groupDiagnostics,
  );
  const islandKeys = islandVertexKeys(mesh);
  const partitions = [];
  const regions = connectedRegions(triangles).map((region) => {
    const { owner, scores } = ownerOf(region, islandKeys);
    const diagnostics: OpenSurfaceAtomicPartitionDiagnostics = {};
    const partition = partitionOpenSurfaceAtomicCells(
      mesh,
      [{ triangles: region, ownerCutterIsland: owner }],
      tolerance,
      diagnostics,
    );
    if (partition) partitions.push(partition);
    return {
      label,
      owner,
      scores,
      triangles: region.length,
      area: region.reduce((sum, triangle) => sum + triangleArea(triangle), 0),
      partition: partition ? {
        cells: partition.cells.length,
        triangles: partition.triangles.length,
        constraints: partition.constraintCount,
        cellAreas: partition.cells.map((cell) => cell.area),
        cellTriangles: partition.cells.map((cell) => cell.triangles.length),
        cellBoundaries: partition.cells.map((cell) => cell.boundaryCutterIslands),
        cellTruth: partition.cells.map((cell) => cellTruthReport(cell.triangles)),
      } : null,
      diagnostics,
    };
  });
  const partition = partitions.length === regions.length ? {
    cells: partitions.flatMap((entry) => entry.cells),
    triangles: partitions.flatMap((entry) => entry.triangles),
    constraintCount: partitions.reduce((sum, entry) => sum + entry.constraintCount, 0),
  } : null;
  const union = partition && label === "aOutside"
    ? selectOpenSurfaceUnionBoundaryCells(mesh, partition)
    : null;
  return {
    groupPartition: groupPartition ? {
      cells: groupPartition.cells.length,
      triangles: groupPartition.triangles.length,
      constraints: groupPartition.constraintCount,
    } : null,
    groupDiagnostics,
    regions,
    union: union ? {
      cells: union.cells.length,
      triangles: union.triangles.length,
      area: union.cells.reduce((sum, cell) => sum + cell.area, 0),
      cellsByOwner: islandKeys.map((_, owner) =>
        union.cells.filter((cell) => cell.ownerCutterIsland === owner).length),
      areasByOwner: islandKeys.map((_, owner) =>
        union.cells.filter((cell) => cell.ownerCutterIsland === owner)
          .reduce((sum, cell) => sum + cell.area, 0)),
    } : null,
  };
}

const source = meshFromPortable(JSON.parse(await readFile(sourcePath, "utf8")));
const cutter = meshFromPortable(JSON.parse(await readFile(cutterPath, "utf8")));
const split = bmsBooleanOp(
  soupFromMesh(source) as Triangle[],
  soupFromMesh(cutter) as Triangle[],
  undefined,
  { classifier: "hybrid", preRepair: false },
);
if (!split) throw new Error("BMS returned no split");
const filtered = filterOpenSurfaceCutterCycles(source, cutter, split);
console.log(JSON.stringify({
  sourcePath,
  cutterPath,
  truthPath,
  tolerance,
  groups: Object.fromEntries(Object.entries(split.groups).map(([key, triangles]) => [key, triangles.length])),
  segments: split.segments.length,
  source: diagnoseRegions("aOutside", source, split.groups.aOutside),
  cutter: diagnoseRegions("bInside", cutter, filtered?.bInside ?? split.groups.bInside),
}, null, 2));
