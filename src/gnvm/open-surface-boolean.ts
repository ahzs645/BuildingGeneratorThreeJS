import type { Vec3 } from "./core";
import { buildTopology, type Mesh, triangulateFaceIndices } from "./geometry";
import {
  countOpenEdges,
  intersectMeshPairTagged,
  retriangulateWithSteinerPoints,
} from "trimesh-boolean";

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
  atomicCellCount?: number;
  atomicTriangleCount?: number;
  atomicConstraintCount?: number;
  ownedSelectedCellCount?: number;
  ownedSelectedTriangleCount?: number;
  ownedSelectedArea?: number;
}

export interface OpenSurfaceAtomicRegion {
  triangles: OpenBooleanTriangle[];
  ownerCutterIsland: number;
  occludingCutterIsland?: number;
}

export interface OpenSurfaceAtomicCell {
  triangles: OpenBooleanTriangle[];
  ownerCutterIsland: number;
  occludingCutterIsland?: number;
  boundaryCutterIslands: number[];
  area: number;
}

export interface OpenSurfaceAtomicPartition {
  cells: OpenSurfaceAtomicCell[];
  triangles: OpenBooleanTriangle[];
  constraintCount: number;
}

export interface OpenSurfaceAtomicSelection {
  cells: OpenSurfaceAtomicCell[];
  triangles: OpenBooleanTriangle[];
}

interface Region {
  triangles: OpenBooleanTriangle[];
  boundaryEdges: BoundaryEdge[];
  area: number;
  seamLength: number;
  ownerCutterIsland: number;
  ownerSourceIsland: number;
  touchedSourceIsland: number;
}

interface UnlabelledRegion {
  triangles: OpenBooleanTriangle[];
  boundaryEdges: BoundaryEdge[];
  area: number;
  seamLength: number;
}

interface BoundaryEdge {
  key: string;
  a: OpenBooleanVertex;
  b: OpenBooleanVertex;
}

interface Interface {
  a: number;
  b: number;
  regions: Region[];
  area: number;
  seamLength: number;
}

interface AtomicConstraint {
  p0: OpenBooleanVertex;
  p1: OpenBooleanVertex;
  otherCutterIslands: number[];
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

function triangleCross(triangle: OpenBooleanTriangle): Vec3 {
  const a: Vec3 = [triangle.v1.x - triangle.v0.x, triangle.v1.y - triangle.v0.y, triangle.v1.z - triangle.v0.z];
  const b: Vec3 = [triangle.v2.x - triangle.v0.x, triangle.v2.y - triangle.v0.y, triangle.v2.z - triangle.v0.z];
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function edgeLength(edge: BoundaryEdge): number {
  return Math.hypot(edge.a.x - edge.b.x, edge.a.y - edge.b.y, edge.a.z - edge.b.z);
}

function pointsNear(a: OpenBooleanVertex, b: OpenBooleanVertex, tolerance: number): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= tolerance;
}

function edgesNear(a: BoundaryEdge, b: BoundaryEdge, tolerance: number): boolean {
  return (
    pointsNear(a.a, b.a, tolerance) && pointsNear(a.b, b.b, tolerance)
  ) || (
    pointsNear(a.a, b.b, tolerance) && pointsNear(a.b, b.a, tolerance)
  );
}

/**
 * Splitter cracks can expose both copies of a near-coincident edge while only
 * the surrounding intersection contour carries provenance. Accept that narrow
 * case only when the unlabelled edges form an unambiguous perfect matching.
 */
function haveUniqueNearCoincidentPartners(edges: BoundaryEdge[], tolerance: number): boolean {
  if (edges.length % 2 !== 0) return false;
  const partners = edges.map((edge, index) =>
    edges.flatMap((candidate, candidateIndex) =>
      candidateIndex !== index && edgesNear(edge, candidate, tolerance) ? [candidateIndex] : []));
  if (partners.some((matches) => matches.length !== 1)) return false;
  return partners.every((matches, index) => partners[matches[0]][0] === index);
}

function connectedRegions(triangles: OpenBooleanTriangle[], tolerance: number): UnlabelledRegion[] {
  const edgeTriangles = new Map<string, number[]>();
  for (let triangle = 0; triangle < triangles.length; triangle++) {
    for (const [a, b] of triangleEdges(triangles[triangle])) {
      const key = edgeKey(a, b, tolerance);
      const incident = edgeTriangles.get(key) ?? [];
      incident.push(triangle);
      edgeTriangles.set(key, incident);
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
    const componentEdges = new Map<string, { count: number; a: OpenBooleanVertex; b: OpenBooleanVertex }>();
    for (const triangle of component) {
      for (const [a, b] of triangleEdges(triangle)) {
        const key = edgeKey(a, b, tolerance);
        const existing = componentEdges.get(key);
        componentEdges.set(key, {
          count: (existing?.count ?? 0) + 1,
          a: existing?.a ?? a,
          b: existing?.b ?? b,
        });
      }
    }
    const boundaryEdges = [...componentEdges]
      .filter(([, edge]) => edge.count === 1)
      .map(([key, edge]) => ({ key, a: edge.a, b: edge.b }));
    regions.push({
      triangles: component,
      boundaryEdges,
      area: component.reduce((sum, triangle) => sum + triangleArea(triangle), 0),
      seamLength: boundaryEdges.reduce((sum, edge) => sum + edgeLength(edge), 0),
    });
  }
  return regions;
}

function triangleIslands(mesh: Mesh): {
  byTriangle: number[];
  centers: Vec3[];
  soups: OpenBooleanTriangle[][];
} {
  const topology = buildTopology(mesh);
  const vertices = Array.from({ length: topology.faceIslandCount }, () => new Set<number>());
  const soups = Array.from({ length: topology.faceIslandCount }, () => [] as OpenBooleanTriangle[]);
  const byTriangle: number[] = [];
  for (let faceIndex = 0; faceIndex < mesh.faces.length; faceIndex++) {
    const island = topology.faceIsland[faceIndex];
    for (const vertex of mesh.faces[faceIndex]) vertices[island].add(vertex);
    for (const [a, b, c] of triangulateFaceIndices(mesh, mesh.faces[faceIndex])) {
      const vertex = (index: number): OpenBooleanVertex => {
        const point = mesh.positions[index];
        return { x: point[0], y: point[1], z: point[2] };
      };
      soups[island].push({ v0: vertex(a), v1: vertex(b), v2: vertex(c) });
      byTriangle.push(island);
    }
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
  return { byTriangle, centers, soups };
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

interface Bounds {
  min: Vec3;
  max: Vec3;
}

function soupBounds(triangles: OpenBooleanTriangle[]): Bounds | null {
  if (!triangles.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const triangle of triangles) for (const point of [triangle.v0, triangle.v1, triangle.v2]) {
    min[0] = Math.min(min[0], point.x);
    min[1] = Math.min(min[1], point.y);
    min[2] = Math.min(min[2], point.z);
    max[0] = Math.max(max[0], point.x);
    max[1] = Math.max(max[1], point.y);
    max[2] = Math.max(max[2], point.z);
  }
  return { min, max };
}

function boundsOverlap(a: Bounds, b: Bounds, tolerance: number): boolean {
  return a.min.every((value, axis) => value <= b.max[axis] + tolerance)
    && a.max.every((value, axis) => value >= b.min[axis] - tolerance);
}

function lerpPoint(a: OpenBooleanVertex, b: OpenBooleanVertex, factor: number): OpenBooleanVertex {
  return {
    x: a.x + (b.x - a.x) * factor,
    y: a.y + (b.y - a.y) * factor,
    z: a.z + (b.z - a.z) * factor,
  };
}

function segmentLength(a: OpenBooleanVertex, b: OpenBooleanVertex): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function splitAtomicConstraints(
  parent: OpenBooleanTriangle,
  raw: AtomicConstraint[],
  tolerance: number,
): AtomicConstraint[] | null {
  if (!raw.length) return [];
  const normal = triangleCross(parent);
  const dropAxis = Math.abs(normal[0]) >= Math.abs(normal[1]) && Math.abs(normal[0]) >= Math.abs(normal[2])
    ? 0
    : Math.abs(normal[1]) >= Math.abs(normal[2]) ? 1 : 2;
  const axes = [0, 1, 2].filter((axis) => axis !== dropAxis);
  const project = (point: OpenBooleanVertex): [number, number] => {
    const values = [point.x, point.y, point.z];
    return [values[axes[0]], values[axes[1]]];
  };
  const cross2 = (a: [number, number], b: [number, number]) => a[0] * b[1] - a[1] * b[0];
  const subtract2 = (a: [number, number], b: [number, number]): [number, number] => [a[0] - b[0], a[1] - b[1]];
  const splitFactors = raw.map(() => [0, 1]);

  for (let first = 0; first < raw.length; first++) {
    const p = project(raw[first].p0);
    const p1 = project(raw[first].p1);
    const r = subtract2(p1, p);
    const rLength = Math.hypot(r[0], r[1]);
    if (rLength <= tolerance) return null;
    for (let second = first + 1; second < raw.length; second++) {
      const q = project(raw[second].p0);
      const q1 = project(raw[second].p1);
      const s = subtract2(q1, q);
      const sLength = Math.hypot(s[0], s[1]);
      if (sLength <= tolerance) return null;
      const denominator = cross2(r, s);
      const qp = subtract2(q, p);
      const parallelTolerance = tolerance * Math.max(rLength, sLength);
      if (Math.abs(denominator) <= parallelTolerance) {
        if (Math.abs(cross2(qp, r)) > parallelTolerance) continue;
        const dominant = Math.abs(r[0]) >= Math.abs(r[1]) ? 0 : 1;
        const firstRange = [p[dominant], p1[dominant]].sort((a, b) => a - b);
        const secondRange = [q[dominant], q1[dominant]].sort((a, b) => a - b);
        const overlap = Math.min(firstRange[1], secondRange[1]) - Math.max(firstRange[0], secondRange[0]);
        if (overlap > tolerance) return null;
        continue;
      }
      const firstFactor = cross2(qp, s) / denominator;
      const secondFactor = cross2(qp, r) / denominator;
      const firstFactorTolerance = tolerance / rLength;
      const secondFactorTolerance = tolerance / sLength;
      if (
        firstFactor < -firstFactorTolerance || firstFactor > 1 + firstFactorTolerance
        || secondFactor < -secondFactorTolerance || secondFactor > 1 + secondFactorTolerance
      ) continue;
      if (firstFactor > firstFactorTolerance && firstFactor < 1 - firstFactorTolerance)
        splitFactors[first].push(firstFactor);
      if (secondFactor > secondFactorTolerance && secondFactor < 1 - secondFactorTolerance)
        splitFactors[second].push(secondFactor);
    }
  }

  const pieces = new Map<string, AtomicConstraint>();
  for (let index = 0; index < raw.length; index++) {
    const length = segmentLength(raw[index].p0, raw[index].p1);
    const factorTolerance = tolerance / length;
    const factors = splitFactors[index]
      .sort((a, b) => a - b)
      .filter((factor, factorIndex, values) => !factorIndex || factor - values[factorIndex - 1] > factorTolerance);
    for (let factor = 0; factor + 1 < factors.length; factor++) {
      const p0 = lerpPoint(raw[index].p0, raw[index].p1, factors[factor]);
      const p1 = lerpPoint(raw[index].p0, raw[index].p1, factors[factor + 1]);
      if (segmentLength(p0, p1) <= tolerance) continue;
      const key = edgeKey(p0, p1, tolerance);
      const existing = pieces.get(key);
      if (existing) {
        existing.otherCutterIslands = [...new Set([
          ...existing.otherCutterIslands,
          ...raw[index].otherCutterIslands,
        ])].sort((a, b) => a - b);
      } else {
        pieces.set(key, {
          p0,
          p1,
          otherCutterIslands: [...raw[index].otherCutterIslands],
        });
      }
    }
  }
  return [...pieces.values()];
}

/**
 * Partition retained cutter patches at cutter-cutter intersection curves.
 *
 * This is deliberately independent of material selection: it validates every
 * constrained triangulation and returns null on overlaps, topology ambiguity,
 * or area loss so callers can preserve the established cycle-filter result.
 */
export function partitionOpenSurfaceAtomicCells(
  cutter: Mesh,
  regions: OpenSurfaceAtomicRegion[],
  tolerance = 1e-4,
): OpenSurfaceAtomicPartition | null {
  if (!regions.length) return null;
  const cutterIslands = triangleIslands(cutter);
  if (cutterIslands.soups.length < 2) return null;
  const scale = meshScale(cutter, cutter);
  const keyTolerance = Math.max(tolerance * 0.1, scale * 1e-8);
  const islandBounds = cutterIslands.soups.map(soupBounds);
  const cells: OpenSurfaceAtomicCell[] = [];
  const allTriangles: OpenBooleanTriangle[] = [];
  let constraintCount = 0;

  for (const region of regions) {
    const regionBounds = soupBounds(region.triangles);
    if (!regionBounds || !cutterIslands.soups[region.ownerCutterIsland]) return null;
    const constraintsByTriangle = region.triangles.map(() => [] as AtomicConstraint[]);
    for (let otherIsland = 0; otherIsland < cutterIslands.soups.length; otherIsland++) {
      if (otherIsland === region.ownerCutterIsland) continue;
      const otherBounds = islandBounds[otherIsland];
      if (!otherBounds || !boundsOverlap(regionBounds, otherBounds, keyTolerance)) continue;
      const intersections = intersectMeshPairTagged(region.triangles, cutterIslands.soups[otherIsland]);
      for (const segment of intersections) {
        if (!constraintsByTriangle[segment.idxA]) return null;
        constraintsByTriangle[segment.idxA].push({
          p0: segment.p0,
          p1: segment.p1,
          otherCutterIslands: [otherIsland],
        });
      }
    }

    const atomicTriangles: OpenBooleanTriangle[] = [];
    const barrierLabels = new Map<string, number[]>();
    for (let triangleIndex = 0; triangleIndex < region.triangles.length; triangleIndex++) {
      const parent = region.triangles[triangleIndex];
      const constraints = splitAtomicConstraints(parent, constraintsByTriangle[triangleIndex], keyTolerance);
      if (!constraints) return null;
      for (const constraint of constraints) {
        const key = edgeKey(constraint.p0, constraint.p1, keyTolerance);
        barrierLabels.set(key, constraint.otherCutterIslands);
      }
      const children = constraints.length
        ? retriangulateWithSteinerPoints(parent, constraints)
        : [parent];
      const parentArea = triangleArea(parent);
      const childArea = children.reduce((sum, child) => sum + triangleArea(child), 0);
      const areaTolerance = Math.max(parentArea * 1e-7, scale * scale * 1e-12);
      if (!children.length || Math.abs(childArea - parentArea) > areaTolerance) return null;
      const childEdges = new Set(children.flatMap((child) =>
        triangleEdges(child).map(([a, b]) => edgeKey(a, b, keyTolerance))));
      if (constraints.some((constraint) => !childEdges.has(edgeKey(constraint.p0, constraint.p1, keyTolerance))))
        return null;
      atomicTriangles.push(...children);
      constraintCount += constraints.length;
    }

    const edgeTriangles = new Map<string, number[]>();
    for (let triangle = 0; triangle < atomicTriangles.length; triangle++) {
      for (const [a, b] of triangleEdges(atomicTriangles[triangle])) {
        const key = edgeKey(a, b, keyTolerance);
        const incident = edgeTriangles.get(key) ?? [];
        incident.push(triangle);
        edgeTriangles.set(key, incident);
      }
    }
    if ([...edgeTriangles.values()].some((incident) => incident.length > 2)) return null;
    const neighbors = atomicTriangles.map(() => [] as number[]);
    for (const [key, incident] of edgeTriangles) {
      if (barrierLabels.has(key) || incident.length !== 2) continue;
      neighbors[incident[0]].push(incident[1]);
      neighbors[incident[1]].push(incident[0]);
    }
    const visited = new Uint8Array(atomicTriangles.length);
    for (let seed = 0; seed < atomicTriangles.length; seed++) {
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
      const triangles = indices.map((index) => atomicTriangles[index]);
      const triangleSet = new Set(indices);
      const boundaryCutterIslands = new Set<number>();
      for (const [key, incident] of edgeTriangles) {
        if (!barrierLabels.has(key) || !incident.some((triangle) => triangleSet.has(triangle))) continue;
        for (const island of barrierLabels.get(key) ?? []) boundaryCutterIslands.add(island);
      }
      cells.push({
        triangles,
        ownerCutterIsland: region.ownerCutterIsland,
        occludingCutterIsland: region.occludingCutterIsland,
        boundaryCutterIslands: [...boundaryCutterIslands].sort((a, b) => a - b),
        area: triangles.reduce((sum, triangle) => sum + triangleArea(triangle), 0),
      });
    }
    allTriangles.push(...atomicTriangles);
  }

  return { cells, triangles: allTriangles, constraintCount };
}

function atomicCellFrame(cell: OpenSurfaceAtomicCell): {
  centroid: Vec3;
  normal: Vec3;
  area: number;
  minEdge: number;
} | null {
  const centroid: Vec3 = [0, 0, 0];
  const normal: Vec3 = [0, 0, 0];
  let area = 0;
  let minEdge = Infinity;
  for (const triangle of cell.triangles) {
    const triangleWeight = triangleArea(triangle);
    const center: Vec3 = [
      (triangle.v0.x + triangle.v1.x + triangle.v2.x) / 3,
      (triangle.v0.y + triangle.v1.y + triangle.v2.y) / 3,
      (triangle.v0.z + triangle.v1.z + triangle.v2.z) / 3,
    ];
    centroid[0] += center[0] * triangleWeight;
    centroid[1] += center[1] * triangleWeight;
    centroid[2] += center[2] * triangleWeight;
    const cross = triangleCross(triangle);
    normal[0] += cross[0];
    normal[1] += cross[1];
    normal[2] += cross[2];
    for (const [a, b] of triangleEdges(triangle))
      minEdge = Math.min(minEdge, segmentLength(a, b));
    area += triangleWeight;
  }
  const normalLength = Math.hypot(normal[0], normal[1], normal[2]);
  if (!(area > 0) || normalLength <= 1e-12 || !Number.isFinite(minEdge)) return null;
  centroid[0] /= area;
  centroid[1] /= area;
  centroid[2] /= area;
  normal[0] /= normalLength;
  normal[1] /= normalLength;
  normal[2] /= normalLength;
  return { centroid, normal, area, minEdge };
}

function atomicTriangleFrame(triangle: OpenBooleanTriangle): {
  centroid: Vec3;
  normal: Vec3;
  area: number;
  minEdge: number;
} | null {
  const cross = triangleCross(triangle);
  const crossLength = Math.hypot(cross[0], cross[1], cross[2]);
  if (crossLength <= 1e-12) return null;
  return {
    centroid: [
      (triangle.v0.x + triangle.v1.x + triangle.v2.x) / 3,
      (triangle.v0.y + triangle.v1.y + triangle.v2.y) / 3,
      (triangle.v0.z + triangle.v1.z + triangle.v2.z) / 3,
    ],
    normal: [cross[0] / crossLength, cross[1] / crossLength, cross[2] / crossLength],
    area: crossLength * 0.5,
    minEdge: Math.min(...triangleEdges(triangle).map(([a, b]) => segmentLength(a, b))),
  };
}

/**
 * Select atomic cells whose two sides have different material occupancy.
 *
 * Sampling at both one and two epsilon rejects unstable near-boundary
 * classifications. Returning null is intentional: production callers must
 * fall back to their unmodified patch set rather than guess.
 */
export function selectOpenSurfaceMaterialBoundaryCells(
  partition: OpenSurfaceAtomicPartition,
  materialAt: (point: OpenBooleanVertex) => boolean | null,
  epsilon: number,
): OpenSurfaceAtomicSelection | null {
  if (!(epsilon > 0) || !Number.isFinite(epsilon)) return null;
  const cells: OpenSurfaceAtomicCell[] = [];
  for (const cell of partition.cells) {
    const frame = atomicCellFrame(cell);
    if (!frame) return null;
    const sample = (side: number, distance: number): boolean | null => materialAt({
      x: frame.centroid[0] + frame.normal[0] * side * distance,
      y: frame.centroid[1] + frame.normal[1] * side * distance,
      z: frame.centroid[2] + frame.normal[2] * side * distance,
    });
    const plus = sample(1, epsilon);
    const plusFar = sample(1, epsilon * 2);
    const minus = sample(-1, epsilon);
    const minusFar = sample(-1, epsilon * 2);
    if (plus === null || plusFar === null || minus === null || minusFar === null) return null;
    if (plus !== plusFar || minus !== minusFar) return null;
    if (plus !== minus) cells.push(cell);
  }
  return { cells, triangles: cells.flatMap((cell) => cell.triangles) };
}

interface CutterIslandClassifier {
  soup: OpenBooleanTriangle[];
}

function cutterIslandClassifier(soup: OpenBooleanTriangle[]): CutterIslandClassifier | null {
  const edges = countOpenEdges(soup);
  if (edges.openEdges || edges.overShared) return null;
  return { soup };
}

function classifyPointBySolidAngle(
  point: OpenBooleanVertex,
  soup: OpenBooleanTriangle[],
): 1 | -1 | null {
  let winding = 0;
  for (const triangle of soup) {
    const a: Vec3 = [triangle.v0.x - point.x, triangle.v0.y - point.y, triangle.v0.z - point.z];
    const b: Vec3 = [triangle.v1.x - point.x, triangle.v1.y - point.y, triangle.v1.z - point.z];
    const c: Vec3 = [triangle.v2.x - point.x, triangle.v2.y - point.y, triangle.v2.z - point.z];
    const lengthA = Math.hypot(a[0], a[1], a[2]);
    const lengthB = Math.hypot(b[0], b[1], b[2]);
    const lengthC = Math.hypot(c[0], c[1], c[2]);
    if (Math.min(lengthA, lengthB, lengthC) <= 1e-12) return null;
    const determinant = a[0] * (b[1] * c[2] - b[2] * c[1])
      - a[1] * (b[0] * c[2] - b[2] * c[0])
      + a[2] * (b[0] * c[1] - b[1] * c[0]);
    const denominator = lengthA * lengthB * lengthC
      + (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) * lengthC
      + (b[0] * c[0] + b[1] * c[1] + b[2] * c[2]) * lengthA
      + (c[0] * a[0] + c[1] * a[1] + c[2] * a[2]) * lengthB;
    winding += 2 * Math.atan2(determinant, denominator);
  }
  const magnitude = Math.abs(winding);
  if (magnitude >= Math.PI * 2) return 1;
  if (magnitude <= Math.PI) return -1;
  return null;
}

/**
 * Keep owned cutter cells that lie inside the paired cutter of the source
 * shell which exposed them. This is the per-pipe form of material ownership:
 * the overlapping shell no longer hides the owner's inner wall once its own
 * void occupies that atomic cell.
 */
export function selectOpenSurfaceOwnedShellCells(
  cutter: Mesh,
  partition: OpenSurfaceAtomicPartition,
): OpenSurfaceAtomicSelection | null {
  const islands = triangleIslands(cutter);
  const classifiers = islands.soups.map(cutterIslandClassifier);
  if (classifiers.some((entry) => !entry)) return null;
  const scale = meshScale(cutter, cutter);
  const cells: OpenSurfaceAtomicCell[] = [];
  for (const cell of partition.cells) {
    const occludingIsland = cell.occludingCutterIsland;
    if (
      occludingIsland === undefined
      || occludingIsland === cell.ownerCutterIsland
      || !cell.boundaryCutterIslands.includes(occludingIsland)
    ) return null;
    const classifier = classifiers[occludingIsland]!;
    const representative = [...cell.triangles].sort((a, b) => triangleArea(b) - triangleArea(a))[0];
    const frame = representative ? atomicTriangleFrame(representative) : null;
    if (!frame) return null;
    const epsilon = Math.max(scale * 1e-7, frame.minEdge * 1e-4);
    const classify = (side: number, distance: number) => classifyPointBySolidAngle({
      x: frame.centroid[0] + frame.normal[0] * side * distance,
      y: frame.centroid[1] + frame.normal[1] * side * distance,
      z: frame.centroid[2] + frame.normal[2] * side * distance,
    }, classifier.soup);
    const classifications = [
      classify(0, 0),
      classify(1, epsilon),
      classify(1, epsilon * 2),
      classify(-1, epsilon),
      classify(-1, epsilon * 2),
    ];
    if (classifications.some((classification) => classification !== classifications[0])) return null;
    if (classifications[0] === 1) cells.push(cell);
  }
  return { cells, triangles: cells.flatMap((cell) => cell.triangles) };
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
  const scale = meshScale(source, cutter);
  // Splitter duplicates can drift by just over 1e-5 of the operand diagonal
  // (Three-Way Pipe's widest paired crack is 1.0303e-5). Keep a narrow margin
  // while still requiring a unique endpoint-for-endpoint partner.
  const crackTolerance = Math.max(tolerance, scale * 1.1e-5);
  const cutterToSource = matchCutterToSourceIslands(
    sourceIslands.centers,
    cutterIslands.centers,
    scale * 1e-5,
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
    const boundaryLabels = region.boundaryEdges.map((edge) => segmentLabels.get(edge.key));
    const unlabelledEdges = region.boundaryEdges.filter((_, index) => !boundaryLabels[index]?.length);
    if (unlabelledEdges.length && !haveUniqueNearCoincidentPartners(unlabelledEdges, crackTolerance)) return null;
    const labels = boundaryLabels.flatMap((entries) => entries ?? []);
    const first = labels[0];
    if (!first) return null;
    if (labels.some((label) => label.source !== first.source || label.cutter !== first.cutter)) return null;
    const ownerSourceIsland = cutterToSource[first.cutter];
    if (ownerSourceIsland === undefined) return null;
    regions.push({
      ...region,
      ownerCutterIsland: first.cutter,
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
  const sourceToCutter = Array.from({ length: sourceIslands.centers.length }, () => -1);
  for (let cutterIsland = 0; cutterIsland < cutterToSource.length; cutterIsland++)
    sourceToCutter[cutterToSource[cutterIsland]] = cutterIsland;
  const atomicPartition = partitionOpenSurfaceAtomicCells(
    cutter,
    retained.flatMap((entry) => entry.regions).map((region) => ({
      triangles: region.triangles,
      ownerCutterIsland: region.ownerCutterIsland,
      occludingCutterIsland: sourceToCutter[region.touchedSourceIsland],
    })),
    tolerance,
  );
  const ownedSelection = atomicPartition
    ? selectOpenSurfaceOwnedShellCells(cutter, atomicPartition)
    : null;
  return {
    bInside,
    regionCount: regions.length,
    interfaceCount: interfaces.length,
    retainedInterfaces: retained.map(({ a, b }) => [a, b]),
    droppedInterfaces: dropped.map(({ a, b }) => [a, b]),
    retainedTriangles: bInside.length,
    droppedTriangles: split.groups.bInside.length - bInside.length,
    ...(atomicPartition ? {
      atomicCellCount: atomicPartition.cells.length,
      atomicTriangleCount: atomicPartition.triangles.length,
      atomicConstraintCount: atomicPartition.constraintCount,
    } : {}),
    ...(ownedSelection ? {
      ownedSelectedCellCount: ownedSelection.cells.length,
      ownedSelectedTriangleCount: ownedSelection.triangles.length,
      ownedSelectedArea: ownedSelection.cells.reduce((sum, cell) => sum + cell.area, 0),
    } : {}),
  };
}
