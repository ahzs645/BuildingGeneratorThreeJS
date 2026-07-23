import type { Vec3 } from "./core";
import { buildTopology, type Mesh, triangulateFaceIndices } from "./geometry";

export interface OpenBooleanVertex {
  x: number;
  y: number;
  z: number;
}

export interface OpenBooleanTriangle {
  v0: OpenBooleanVertex;
  v1: OpenBooleanVertex;
  v2: OpenBooleanVertex;
}

export interface OpenBooleanSegment {
  p0: OpenBooleanVertex;
  p1: OpenBooleanVertex;
  idxA: number;
  idxB: number;
}

export interface OpenSurfaceSplit {
  groups: { bInside: OpenBooleanTriangle[] };
  segments: OpenBooleanSegment[];
}

export interface OpenSurfaceCycleFilterReport {
  bInside: OpenBooleanTriangle[];
  regionCount: number;
  interfaceCount: number;
  retainedInterfaces: [number, number][];
  droppedInterfaces: [number, number][];
  retainedTriangles: number;
  droppedTriangles: number;
}

interface Region {
  triangles: OpenBooleanTriangle[];
  boundaryEdges: string[];
  area: number;
  seamLength: number;
  ownerSourceIsland: number;
  touchedSourceIsland: number;
}

interface UnlabelledRegion {
  triangles: OpenBooleanTriangle[];
  boundaryEdges: string[];
  area: number;
  seamLength: number;
}

interface Interface {
  a: number;
  b: number;
  regions: Region[];
  area: number;
  seamLength: number;
}

const pointKey = (point: OpenBooleanVertex, tolerance: number): string =>
  `${Math.round(point.x / tolerance)},${Math.round(point.y / tolerance)},${Math.round(point.z / tolerance)}`;

function edgeKey(a: OpenBooleanVertex, b: OpenBooleanVertex, tolerance: number): string {
  const ka = pointKey(a, tolerance);
  const kb = pointKey(b, tolerance);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

function triangleEdges(triangle: OpenBooleanTriangle): [OpenBooleanVertex, OpenBooleanVertex][] {
  return [
    [triangle.v0, triangle.v1],
    [triangle.v1, triangle.v2],
    [triangle.v2, triangle.v0],
  ];
}

function triangleArea(triangle: OpenBooleanTriangle): number {
  const a: Vec3 = [triangle.v1.x - triangle.v0.x, triangle.v1.y - triangle.v0.y, triangle.v1.z - triangle.v0.z];
  const b: Vec3 = [triangle.v2.x - triangle.v0.x, triangle.v2.y - triangle.v0.y, triangle.v2.z - triangle.v0.z];
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  return Math.hypot(x, y, z) * 0.5;
}

function edgeLength(key: string, points: Map<string, OpenBooleanVertex>): number {
  const [aKey, bKey] = key.split("|");
  const a = points.get(aKey);
  const b = points.get(bKey);
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : 0;
}

function connectedRegions(triangles: OpenBooleanTriangle[], tolerance: number): UnlabelledRegion[] {
  const edgeTriangles = new Map<string, number[]>();
  const points = new Map<string, OpenBooleanVertex>();
  for (let triangle = 0; triangle < triangles.length; triangle++) {
    for (const [a, b] of triangleEdges(triangles[triangle])) {
      const key = edgeKey(a, b, tolerance);
      const incident = edgeTriangles.get(key) ?? [];
      incident.push(triangle);
      edgeTriangles.set(key, incident);
      points.set(pointKey(a, tolerance), a);
      points.set(pointKey(b, tolerance), b);
    }
  }

  const neighbors = triangles.map(() => [] as number[]);
  for (const incident of edgeTriangles.values()) {
    for (let i = 0; i < incident.length; i++) {
      for (let j = i + 1; j < incident.length; j++) {
        neighbors[incident[i]].push(incident[j]);
        neighbors[incident[j]].push(incident[i]);
      }
    }
  }

  const visited = new Uint8Array(triangles.length);
  const regions: UnlabelledRegion[] = [];
  for (let seed = 0; seed < triangles.length; seed++) {
    if (visited[seed]) continue;
    const indices: number[] = [];
    const queue = [seed];
    visited[seed] = 1;
    for (let head = 0; head < queue.length; head++) {
      const triangle = queue[head];
      indices.push(triangle);
      for (const neighbor of neighbors[triangle]) {
        if (visited[neighbor]) continue;
        visited[neighbor] = 1;
        queue.push(neighbor);
      }
    }
    const component = indices.map((index) => triangles[index]);
    const componentEdges = new Map<string, number>();
    for (const triangle of component) {
      for (const [a, b] of triangleEdges(triangle)) {
        const key = edgeKey(a, b, tolerance);
        componentEdges.set(key, (componentEdges.get(key) ?? 0) + 1);
      }
    }
    const boundaryEdges = [...componentEdges].filter(([, count]) => count === 1).map(([key]) => key);
    regions.push({
      triangles: component,
      boundaryEdges,
      area: component.reduce((sum, triangle) => sum + triangleArea(triangle), 0),
      seamLength: boundaryEdges.reduce((sum, key) => sum + edgeLength(key, points), 0),
    });
  }
  return regions;
}

function triangleIslands(mesh: Mesh): { byTriangle: number[]; centers: Vec3[] } {
  const topology = buildTopology(mesh);
  const vertices = Array.from({ length: topology.faceIslandCount }, () => new Set<number>());
  const byTriangle: number[] = [];
  for (let faceIndex = 0; faceIndex < mesh.faces.length; faceIndex++) {
    const island = topology.faceIsland[faceIndex];
    for (const vertex of mesh.faces[faceIndex]) vertices[island].add(vertex);
    for (let count = triangulateFaceIndices(mesh, mesh.faces[faceIndex]).length; count > 0; count--) byTriangle.push(island);
  }
  const centers = vertices.map((indices) => {
    const center: Vec3 = [0, 0, 0];
    for (const index of indices) {
      const point = mesh.positions[index];
      center[0] += point[0];
      center[1] += point[1];
      center[2] += point[2];
    }
    const scale = indices.size ? 1 / indices.size : 0;
    return [center[0] * scale, center[1] * scale, center[2] * scale] as Vec3;
  });
  return { byTriangle, centers };
}

function meshScale(source: Mesh, cutter: Mesh): number {
  const points = [...source.positions, ...cutter.positions];
  if (!points.length) return 1;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const point of points) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], point[axis]);
    max[axis] = Math.max(max[axis], point[axis]);
  }
  return Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]), 1);
}

/**
 * Match concentric source/cutter islands conservatively.
 *
 * This open-shell construction is only well-defined when every closed cutter
 * island has one source shell with the same center. Ambiguous or offset island
 * sets return null and leave the splitter's ordinary classification untouched.
 */
function matchCutterToSourceIslands(sourceCenters: Vec3[], cutterCenters: Vec3[], tolerance: number): number[] | null {
  if (sourceCenters.length !== cutterCenters.length || sourceCenters.length < 2) return null;
  const matches: number[] = [];
  const used = new Set<number>();
  for (const cutter of cutterCenters) {
    const candidates = sourceCenters
      .map((source, island) => ({ island, distance: Math.hypot(
        cutter[0] - source[0],
        cutter[1] - source[1],
        cutter[2] - source[2],
      ) }))
      .sort((a, b) => a.distance - b.distance || a.island - b.island);
    if (candidates[0].distance > tolerance || used.has(candidates[0].island)) return null;
    if (candidates[1] && candidates[1].distance <= tolerance) return null;
    matches.push(candidates[0].island);
    used.add(candidates[0].island);
  }
  return matches;
}

class DisjointSet {
  private parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(value: number): number {
    const parent = this.parent[value];
    return parent === value ? value : (this.parent[value] = this.find(parent));
  }

  join(a: number, b: number): boolean {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return false;
    this.parent[rootB] = rootA;
    return true;
  }
}

/**
 * Remove only redundant reciprocal cutter interfaces from cycles in a
 * compound open-shell difference.
 *
 * Each B-inside region is labelled from the splitter's exact intersection
 * provenance. Reciprocal directed regions form one source-island interface.
 * Kruskal's maximum spanning forest retains every bridge and removes only
 * complete, weakest interface pairs that would close a cycle. Any ambiguous
 * provenance returns null so callers can keep the unfiltered split.
 */
export function filterOpenSurfaceCutterCycles(
  source: Mesh,
  cutter: Mesh,
  split: OpenSurfaceSplit,
  tolerance = 1e-4,
): OpenSurfaceCycleFilterReport | null {
  if (!split.groups.bInside.length || !split.segments.length) return null;
  const sourceIslands = triangleIslands(source);
  const cutterIslands = triangleIslands(cutter);
  const cutterToSource = matchCutterToSourceIslands(
    sourceIslands.centers,
    cutterIslands.centers,
    meshScale(source, cutter) * 1e-5,
  );
  if (!cutterToSource) return null;

  const segmentLabels = new Map<string, { source: number; cutter: number }[]>();
  for (const segment of split.segments) {
    const sourceIsland = sourceIslands.byTriangle[segment.idxA];
    const cutterIsland = cutterIslands.byTriangle[segment.idxB];
    if (sourceIsland === undefined || cutterIsland === undefined) return null;
    const key = edgeKey(segment.p0, segment.p1, tolerance);
    const labels = segmentLabels.get(key) ?? [];
    labels.push({ source: sourceIsland, cutter: cutterIsland });
    segmentLabels.set(key, labels);
  }

  const rawRegions = connectedRegions(split.groups.bInside, tolerance);
  const regions: Region[] = [];
  for (const region of rawRegions) {
    if (!region.boundaryEdges.length) return null;
    const boundaryLabels = region.boundaryEdges.map((key) => segmentLabels.get(key));
    if (boundaryLabels.some((labels) => !labels?.length)) return null;
    const labels = boundaryLabels.flatMap((entries) => entries ?? []);
    const first = labels[0];
    if (labels.some((label) => label.source !== first.source || label.cutter !== first.cutter)) return null;
    const ownerSourceIsland = cutterToSource[first.cutter];
    if (ownerSourceIsland === undefined) return null;
    regions.push({
      ...region,
      ownerSourceIsland,
      touchedSourceIsland: first.source,
    });
  }

  const selfRegions = regions.filter((region) => region.ownerSourceIsland === region.touchedSourceIsland);
  const directed = new Map<string, Region[]>();
  for (const region of regions) {
    if (region.ownerSourceIsland === region.touchedSourceIsland) continue;
    const key = `${region.ownerSourceIsland}>${region.touchedSourceIsland}`;
    const entries = directed.get(key) ?? [];
    entries.push(region);
    directed.set(key, entries);
  }

  const interfaces: Interface[] = [];
  const consumed = new Set<string>();
  for (const [key, forward] of directed) {
    if (consumed.has(key)) continue;
    const [a, b] = key.split(">").map(Number);
    const reverseKey = `${b}>${a}`;
    const reverse = directed.get(reverseKey);
    if (!reverse?.length || forward.length !== reverse.length) return null;
    consumed.add(key);
    consumed.add(reverseKey);
    const paired = [...forward, ...reverse];
    interfaces.push({
      a: Math.min(a, b),
      b: Math.max(a, b),
      regions: paired,
      area: paired.reduce((sum, region) => sum + region.area, 0),
      seamLength: paired.reduce((sum, region) => sum + region.seamLength, 0),
    });
  }

  const forest = new DisjointSet(sourceIslands.centers.length);
  const retained: Interface[] = [];
  const dropped: Interface[] = [];
  const ordered = [...interfaces].sort((a, b) =>
    b.area - a.area
    || b.seamLength - a.seamLength
    || a.a - b.a
    || a.b - b.b);
  for (const entry of ordered) {
    if (forest.join(entry.a, entry.b)) retained.push(entry);
    else dropped.push(entry);
  }

  const keptRegions = new Set([...selfRegions, ...retained.flatMap((entry) => entry.regions)]);
  const bInside = regions.filter((region) => keptRegions.has(region)).flatMap((region) => region.triangles);
  return {
    bInside,
    regionCount: regions.length,
    interfaceCount: interfaces.length,
    retainedInterfaces: retained.map(({ a, b }) => [a, b]),
    droppedInterfaces: dropped.map(({ a, b }) => [a, b]),
    retainedTriangles: bInside.length,
    droppedTriangles: split.groups.bInside.length - bInside.length,
  };
}
