import { asNum, Field, Vec3 } from "../core";
import { makeFieldCtx } from "../evaluator";
import { Geometry, Mesh, realizeInstances, triangulateFaceIndices } from "../geometry";
import {
  OPENVDB_AMBIGUOUS_FACE,
  openVdbCellSigns,
  openVdbEdgeGroup,
  openVdbGroupCount,
} from "../openvdb-edge-groups";
import { recordApproximation, reg, type VolumeGrid } from "../registry";

export type { VolumeGrid } from "../registry";

export interface VolumeGridDiagnostics {
  stage:
    | "volume-cube"
    | "volume-to-mesh"
    | "mesh-to-sdf-grid"
    | "points-to-sdf-grid"
    | "grid-to-mesh";
  background: number;
  min: Vec3;
  max: Vec3;
  resolution: Vec3;
  origin: Vec3;
  spacing: Vec3;
  requestedSpacing?: number;
  requestedSampleCount?: number;
  sampleCount?: number;
  sampleBudget?: number;
  budgetAdjusted?: boolean;
  requestedAdaptivity?: number;
  adaptivityApplied?: boolean;
  isolation?: number;
  values: Float32Array;
}

function isVolumeGrid(value: unknown): value is VolumeGrid {
  return !!value && typeof value === "object" && (value as VolumeGrid).kind === "GNVM_VOLUME_GRID";
}

function splitNonManifoldFans(mesh: Mesh): number {
  const initialVertices = mesh.positions.length;
  const edgeFaces = new Map<string, { vertices: [number, number]; faces: number[] }>();
  const pointFaces: number[][] = mesh.positions.map(() => []);
  for (let face = 0; face < mesh.faces.length; face++) {
    const vertices = mesh.faces[face];
    for (const vertex of vertices) pointFaces[vertex].push(face);
    for (let corner = 0; corner < vertices.length; corner++) {
      const a = vertices[corner], b = vertices[(corner + 1) % vertices.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const entry = edgeFaces.get(key);
      if (entry) entry.faces.push(face);
      else edgeFaces.set(key, { vertices: a < b ? [a, b] : [b, a], faces: [face] });
    }
  }
  if (![...edgeFaces.values()].some((edge) => edge.faces.length !== 2)) return 0;
  const edgesAtPoint: { vertices: [number, number]; faces: number[] }[][] = mesh.positions.map(() => []);
  for (const edge of edgeFaces.values()) {
    edgesAtPoint[edge.vertices[0]].push(edge);
    edgesAtPoint[edge.vertices[1]].push(edge);
  }
  for (let vertex = 0; vertex < pointFaces.length; vertex++) {
    const incident = pointFaces[vertex];
    if (incident.length < 2) continue;
    const neighbors = new Map(incident.map((face) => [face, new Set<number>()]));
    for (const edge of edgesAtPoint[vertex]) {
      if (edge.faces.length !== 2) continue;
      neighbors.get(edge.faces[0])?.add(edge.faces[1]);
      neighbors.get(edge.faces[1])?.add(edge.faces[0]);
    }
    const remaining = new Set(incident);
    const components: number[][] = [];
    while (remaining.size) {
      const start = remaining.values().next().value as number;
      remaining.delete(start);
      const component: number[] = [];
      const stack = [start];
      while (stack.length) {
        const face = stack.pop()!;
        component.push(face);
        for (const neighbor of neighbors.get(face) ?? [])
          if (remaining.delete(neighbor)) stack.push(neighbor);
      }
      components.push(component);
    }
    for (const component of components.slice(1)) {
      const replacement = mesh.positions.length;
      mesh.positions.push([...mesh.positions[vertex]] as Vec3);
      for (const face of component)
        mesh.faces[face] = mesh.faces[face].map((candidate) => candidate === vertex ? replacement : candidate);
    }
  }
  return mesh.positions.length - initialVertices;
}

export interface SurfaceNetsDiagnostics {
  resolution: Vec3;
  activeCells: number;
  activeCellComponents: Record<string, number>;
  ambiguousFaces: number;
  crossedGridEdges: number;
  emittedQuads: number;
  skippedMissingVertex: number;
  skippedDuplicateVertex: number;
  preSplitVertices: number;
  preSplitFaces: number;
  splitVerticesAdded: number;
  postSplitVertices: number;
  postSplitFaces: number;
}

let surfaceNetsDiagnosticSink: ((diagnostics: SurfaceNetsDiagnostics) => void) | null = null;
let volumeGridDiagnosticSink: ((diagnostics: VolumeGridDiagnostics) => void) | null = null;

/** Install a process-local diagnostic callback; intended for parity tooling. */
export function setSurfaceNetsDiagnosticSink(sink: ((diagnostics: SurfaceNetsDiagnostics) => void) | null): void {
  surfaceNetsDiagnosticSink = sink;
}

/** Install a process-local scalar-grid callback; intended for parity tooling. */
export function setVolumeGridDiagnosticSink(sink: ((diagnostics: VolumeGridDiagnostics) => void) | null): void {
  volumeGridDiagnosticSink = sink;
}

// Blender's OpenVDB mesher uses a surface-net topology: one vertex in every
// active voxel cell and one quad around every crossed grid edge. Building that
// topology directly is both smaller and more faithful than pairing triangles
// emitted by Marching Cubes.
function surfaceNets(values: Float32Array, resolution: Vec3, isolation: number, origin: Vec3, spacing: Vec3): Mesh {
  const mesh = new Mesh();
  const diagnosticSink = surfaceNetsDiagnosticSink;
  let activeCells = 0;
  let ambiguousFaces = 0;
  const activeCellComponents = new Map<number, number>();
  const sample = (x: number, y: number, z: number) => values[z * resolution[0] * resolution[1] + y * resolution[0] + x];
  const cellResolution: Vec3 = [resolution[0] - 1, resolution[1] - 1, resolution[2] - 1];
  const cellIndex = (x: number, y: number, z: number) => z * cellResolution[0] * cellResolution[1] + y * cellResolution[0] + x;
  const cornerOffsets: Vec3[] = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const cellEdges: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const cellFaceEdges: [number, number, number, number][] = [
    [0, 5, 1, 4], [6, 3, 7, 2], [8, 2, 9, 0],
    [1, 11, 3, 10], [4, 10, 6, 8], [9, 7, 11, 5],
  ];
  const cellEdgeVertices = new Map<number, Int32Array>();
  const gridPoint = (x: number, y: number, z: number): Vec3 => [
    origin[0] + x * spacing[0],
    origin[1] + y * spacing[1],
    origin[2] + z * spacing[2],
  ];
  const rawCellSigns = (x: number, y: number, z: number): number => openVdbCellSigns(
    cornerOffsets.map(([dx, dy, dz]) => sample(x + dx, y + dy, z + dz)),
    isolation,
  );
  const correctedCellSigns = (signs: number, x: number, y: number, z: number): number => {
    const face = OPENVDB_AMBIGUOUS_FACE[signs];
    if (!face) return signs;
    const neighborOffsets: Vec3[] = [
      [0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 1, 0],
    ];
    const oppositeFace = [3, 4, 1, 2, 6, 5];
    const offset = neighborOffsets[face - 1];
    const neighborSigns = rawCellSigns(x + offset[0], y + offset[1], z + offset[2]);
    return OPENVDB_AMBIGUOUS_FACE[neighborSigns] === oppositeFace[face - 1] ? 255 - signs : signs;
  };

  for (let z = 0; z < cellResolution[2]; z++) for (let y = 0; y < cellResolution[1]; y++) for (let x = 0; x < cellResolution[0]; x++) {
    const cornerValues = cornerOffsets.map(([dx, dy, dz]) => sample(x + dx, y + dy, z + dz));
    const below = cornerValues.some((value) => value < isolation);
    const above = cornerValues.some((value) => value >= isolation);
    if (!below || !above) continue;
    if (diagnosticSink) activeCells++;
    const edgePoints: (Vec3 | null)[] = cellEdges.map(() => null);
    for (let edge = 0; edge < cellEdges.length; edge++) {
      const [a, b] = cellEdges[edge];
      const va = cornerValues[a], vb = cornerValues[b];
      if ((va < isolation) === (vb < isolation)) continue;
      const oa = cornerOffsets[a], ob = cornerOffsets[b];
      const denominator = vb - va;
      const t = denominator ? Math.max(0, Math.min(1, (isolation - va) / denominator)) : 0.5;
      edgePoints[edge] = gridPoint(
        x + oa[0] + (ob[0] - oa[0]) * t,
        y + oa[1] + (ob[1] - oa[1]) * t,
        z + oa[2] + (ob[2] - oa[2]) * t,
      );
    }
    if (diagnosticSink)
      for (const face of cellFaceEdges) if (face.filter((edge) => edgePoints[edge] !== null).length === 4) ambiguousFaces++;
    // OpenVDB uses a fixed topology table, then complements certain ambiguous
    // masks when the adjacent cell presents the matching opposite face. This
    // is deliberately sign-only; scalar asymptotic determinants choose a
    // different topology from Blender in locally ambiguous TPMS cells.
    const signs = correctedCellSigns(openVdbCellSigns(cornerValues, isolation), x, y, z);
    const components = Array.from({ length: openVdbGroupCount(signs) }, () => [] as number[]);
    for (let edge = 0; edge < edgePoints.length; edge++) {
      if (!edgePoints[edge]) continue;
      const group = openVdbEdgeGroup(signs, edge);
      if (group > 0) components[group - 1].push(edge);
    }
    if (diagnosticSink)
      activeCellComponents.set(components.length, (activeCellComponents.get(components.length) ?? 0) + 1);
    const edgeVertices = new Int32Array(12).fill(-1);
    for (const edges of components) {
      if (!edges.length) continue;
      let sum: Vec3 = [0, 0, 0];
      for (const edge of edges) {
        const point = edgePoints[edge]!;
        sum = [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]];
      }
      const vertex = mesh.positions.length;
      mesh.positions.push([sum[0] / edges.length, sum[1] / edges.length, sum[2] / edges.length]);
      for (const edge of edges) edgeVertices[edge] = vertex;
    }
    cellEdgeVertices.set(cellIndex(x, y, z), edgeVertices);
  }

  let crossedGridEdges = 0;
  let emittedQuads = 0;
  let skippedMissingVertex = 0;
  let skippedDuplicateVertex = 0;
  const addQuad = (indices: number[], forward: boolean, alternateDiagonal: boolean) => {
    if (diagnosticSink) crossedGridEdges++;
    if (indices.some((index) => index < 0)) { if (diagnosticSink) skippedMissingVertex++; return; }
    if (new Set(indices).size !== 4) { if (diagnosticSink) skippedDuplicateVertex++; return; }
    // OpenVDB's polygon loops use the opposite winding from the incident-cell
    // ring above. X/Y loops also begin one corner later than Z, which selects
    // the other fan diagonal when Manifold consumes the authored quad. Keeping
    // both details matches Blender's Volume to Mesh polygon/loop-triangle order.
    mesh.faces.push(alternateDiagonal
      ? forward
        ? [indices[1], indices[0], indices[3], indices[2]]
        : [indices[2], indices[3], indices[0], indices[1]]
      : forward
        ? [indices[0], indices[3], indices[2], indices[1]]
        : [indices[3], indices[0], indices[1], indices[2]]);
    if (diagnosticSink) emittedQuads++;
  };
  const cellEdge = (x: number, y: number, z: number, edge: number) => cellEdgeVertices.get(cellIndex(x, y, z))?.[edge] ?? -1;
  // A crossed grid edge needs a cell on both sides of each orthogonal axis,
  // but not on the negative side of its own axis. Starting all three axes at
  // one drops the entire negative X/Y/Z cap respectively. The two-sample
  // background padding above guarantees that the guarded incident cells exist.
  for (let z = 0; z < resolution[2] - 1; z++) for (let y = 0; y < resolution[1] - 1; y++) for (let x = 0; x < resolution[0] - 1; x++) {
    const value = sample(x, y, z);
    const crossX = sample(x + 1, y, z);
    if (y > 0 && z > 0 && (value < isolation) !== (crossX < isolation))
      addQuad([cellEdge(x, y - 1, z - 1, 3), cellEdge(x, y, z - 1, 2), cellEdge(x, y, z, 0), cellEdge(x, y - 1, z, 1)], value < isolation, true);
    const crossY = sample(x, y + 1, z);
    if (x > 0 && z > 0 && (value < isolation) !== (crossY < isolation))
      addQuad([cellEdge(x - 1, y, z - 1, 7), cellEdge(x - 1, y, z, 5), cellEdge(x, y, z, 4), cellEdge(x, y, z - 1, 6)], value < isolation, true);
    const crossZ = sample(x, y, z + 1);
    if (x > 0 && y > 0 && (value < isolation) !== (crossZ < isolation))
      addQuad([cellEdge(x - 1, y - 1, z, 11), cellEdge(x, y - 1, z, 10), cellEdge(x, y, z, 8), cellEdge(x - 1, y, z, 9)], value < isolation, false);
  }
  const preSplitVertices = mesh.positions.length;
  const preSplitFaces = mesh.faces.length;
  const splitVerticesAdded = splitNonManifoldFans(mesh);
  diagnosticSink?.({
    resolution: [...resolution] as Vec3,
    activeCells,
    activeCellComponents: Object.fromEntries([...activeCellComponents].map(([count, cells]) => [String(count), cells])),
    ambiguousFaces,
    crossedGridEdges,
    emittedQuads,
    skippedMissingVertex,
    skippedDuplicateVertex,
    preSplitVertices,
    preSplitFaces,
    splitVerticesAdded,
    postSplitVertices: mesh.positions.length,
    postSplitFaces: mesh.faces.length,
  });
  return mesh;
}

/** Direct hook for focused topology tests; production evaluation uses the registered nodes below. */
export const surfaceNetsForTest = surfaceNets;

interface BoundedResolution {
  resolution: Vec3;
  requestedSampleCount: number;
  budgetAdjusted: boolean;
  sampleBudget: number;
}

function resolutionSampleCount(resolution: Vec3): number {
  return resolution[0] * resolution[1] * resolution[2];
}

function requestedResolution(values: Vec3): Vec3 {
  return values.map((value) => {
    if (!Number.isFinite(value))
      throw new RangeError("Volume grid resolution must contain finite values");
    return Math.max(2, Math.trunc(value));
  }) as Vec3;
}

/**
 * Preserve the requested lattice when it fits, otherwise increase the stride
 * uniformly while retaining both endpoints on every axis.
 */
function boundedVolumeResolution(
  requested: Vec3,
  sampleBudget = denseSdfSampleBudget,
): BoundedResolution {
  if (!Number.isFinite(sampleBudget) || sampleBudget < 8)
    throw new RangeError("Dense volume sample budget must allow at least a 2×2×2 lattice");
  const normalized = requestedResolution(requested);
  const requestedSampleCount = resolutionSampleCount(normalized);
  if (requestedSampleCount <= sampleBudget) {
    return {
      resolution: normalized,
      requestedSampleCount,
      budgetAdjusted: false,
      sampleBudget,
    };
  }

  const atStride = (stride: number): Vec3 => normalized.map((count) =>
    Math.max(2, Math.floor((count - 1) / stride) + 1)) as Vec3;
  let lower = 1;
  let upper = Math.max(...normalized.map((count) => count - 1));
  // Find the smallest uniform stride whose endpoint-preserving lattice fits.
  for (let iteration = 0; iteration < 64; iteration++) {
    const middle = lower + (upper - lower) * 0.5;
    if (resolutionSampleCount(atStride(middle)) > sampleBudget) lower = middle;
    else upper = middle;
  }
  let resolution = atStride(upper);
  while (resolutionSampleCount(resolution) > sampleBudget) {
    upper *= 1.0000001;
    resolution = atStride(upper);
  }
  return {
    resolution,
    requestedSampleCount,
    budgetAdjusted: true,
    sampleBudget,
  };
}

export const boundedVolumeResolutionForTest = boundedVolumeResolution;

reg("GeometryNodeVolumeCube", (api) => {
  recordApproximation("GeometryNodeVolumeCube");
  const min = api.vec("Min");
  const max = api.vec("Max");
  const requested: Vec3 = [
    api.num("Resolution X"),
    api.num("Resolution Y"),
    api.num("Resolution Z"),
  ];
  const normalizedRequested = requestedResolution(requested);
  const layout = boundedVolumeResolution(normalizedRequested);
  const resolution = layout.resolution;
  const requestedVoxelSize = Math.max(...max.map((value, axis) =>
    Math.max(1e-9, (value - min[axis]) / Math.max(1, normalizedRequested[axis] - 1))));
  const voxelSize: Vec3 = [
    Math.max(1e-9, (max[0] - min[0]) / Math.max(1, resolution[0] - 1)),
    Math.max(1e-9, (max[1] - min[1]) / Math.max(1, resolution[1] - 1)),
    Math.max(1e-9, (max[2] - min[2]) / Math.max(1, resolution[2] - 1)),
  ];
  const origin: Vec3 = [...min];
  const background = api.num("Background");
  const values = new Float32Array(resolution[0] * resolution[1] * resolution[2]);
  const density = api.field("Density");
  // Volume Cube is a cache boundary in Blender: evaluate the incoming field at
  // voxel centers once. Volume to Mesh subsequently interpolates this stored
  // grid instead of re-evaluating the original field at unrelated positions.
  for (let z = 0; z < resolution[2]; z++) {
    const sampleGeometry = new Geometry();
    const sampleMesh = new Mesh();
    sampleGeometry.mesh = sampleMesh;
    for (let y = 0; y < resolution[1]; y++) for (let x = 0; x < resolution[0]; x++) {
      sampleMesh.positions.push([
        min[0] + x * voxelSize[0],
        min[1] + y * voxelSize[1],
        min[2] + z * voxelSize[2],
      ]);
    }
    const slice = density.array(makeFieldCtx(sampleGeometry, "POINT"));
    for (let y = 0; y < resolution[1]; y++) for (let x = 0; x < resolution[0]; x++) {
      const local = y * resolution[0] + x;
      const sampled = asNum(slice[local] ?? background);
      values[z * resolution[0] * resolution[1] + local] = Number.isFinite(sampled) ? sampled : background;
    }
  }
  const volume: VolumeGrid = {
    kind: "GNVM_VOLUME_GRID",
    background,
    min,
    max,
    resolution,
    origin,
    voxelSize,
    values,
    requestedVoxelSize,
    requestedSampleCount: layout.requestedSampleCount,
    budgetAdjusted: layout.budgetAdjusted,
    sampleBudget: layout.sampleBudget,
  };
  volumeGridDiagnosticSink?.({
    stage: "volume-cube",
    background,
    min: [...min] as Vec3,
    max: [...max] as Vec3,
    resolution: [...resolution] as Vec3,
    origin: [...origin] as Vec3,
    spacing: [...voxelSize] as Vec3,
    requestedSpacing: requestedVoxelSize,
    requestedSampleCount: layout.requestedSampleCount,
    sampleCount: values.length,
    sampleBudget: layout.sampleBudget,
    budgetAdjusted: layout.budgetAdjusted,
    values,
  });
  return { Volume: volume };
});

function sampleVolumeAtIndex(volume: VolumeGrid, coordinates: Vec3): number {
  const base = coordinates.map(Math.floor) as Vec3;
  const fraction: Vec3 = [coordinates[0] - base[0], coordinates[1] - base[1], coordinates[2] - base[2]];
  const value = (x: number, y: number, z: number) => {
    if (x < 0 || y < 0 || z < 0 || x >= volume.resolution[0] || y >= volume.resolution[1] || z >= volume.resolution[2])
      return volume.background;
    return volume.values[z * volume.resolution[0] * volume.resolution[1] + y * volume.resolution[0] + x];
  };
  // OpenVDB's BoxSampler interpolates z, then y, then x. Because this is a
  // FloatGrid, it rounds every intermediate lerp back to float32 instead of
  // accumulating all eight weighted corners in double precision.
  const lerp = (a: number, b: number, weight: number) => Math.fround(
    a + Math.fround(Math.fround(b - a) * weight),
  );
  const z00 = lerp(value(base[0], base[1], base[2]), value(base[0], base[1], base[2] + 1), fraction[2]);
  const z01 = lerp(value(base[0], base[1] + 1, base[2]), value(base[0], base[1] + 1, base[2] + 1), fraction[2]);
  const z10 = lerp(value(base[0] + 1, base[1], base[2]), value(base[0] + 1, base[1], base[2] + 1), fraction[2]);
  const z11 = lerp(value(base[0] + 1, base[1] + 1, base[2]), value(base[0] + 1, base[1] + 1, base[2] + 1), fraction[2]);
  return lerp(lerp(z00, z01, fraction[1]), lerp(z10, z11, fraction[1]), fraction[0]);
}

interface ResampledVolumeGrid {
  values: Float32Array;
  resolution: Vec3;
  origin: Vec3;
  spacing: Vec3;
  requestedSpacing: number;
  requestedSampleCount: number;
  sampleBudget: number;
  budgetAdjusted: boolean;
}

function resampleVolumeGrid(volume: VolumeGrid, requestedSpacing: number): ResampledVolumeGrid {
  const sampleSpacing = Math.max(...volume.voxelSize);
  if (!Number.isFinite(sampleSpacing) || sampleSpacing <= 0)
    throw new RangeError("Volume grid voxel size must contain finite positive values");
  if (!Number.isFinite(Math.fround(sampleSpacing)))
    throw new RangeError("Volume grid voxel size must fit Blender's float socket range");
  if (!Number.isFinite(requestedSpacing) || requestedSpacing <= 0)
    throw new RangeError("Volume to Mesh voxel size must be a finite positive number");
  const normalizedRequestedSpacing = Math.max(1e-6, requestedSpacing);
  const layoutForSpacing = (targetSpacing: number) => {
    // Blender narrows both voxel sizes and their ratio to float before passing
    // the scale into OpenVDB's double-precision GridTransformer matrix.
    const targetSpacingFloat = Math.fround(targetSpacing);
    if (!Number.isFinite(targetSpacingFloat))
      throw new RangeError("Volume to Mesh voxel size must fit Blender's float socket range");
    const factor = Math.fround(Math.fround(sampleSpacing) / targetSpacingFloat);
    if (!Number.isFinite(factor) || factor <= 0)
      throw new RangeError("Volume to Mesh voxel-size ratio is outside Blender's float range");
    const inverseFactor = 1 / factor;
    // The output grid transform receives `1.0f / factor`, so its world-space
    // voxel basis has one additional float rounding beyond the sampling matrix.
    const transformScale = Math.fround(1 / factor);
    const spacing = volume.voxelSize.map((size) => size * transformScale) as Vec3;
    // OpenVDB transforms the inclusive source index bounds outward. BoxSampler
    // then needs one interpolated sample beyond the negative bound, followed by
    // a hard sparse-background guard. On the positive side, ceil the transformed
    // maximum and keep three samples so interpolation reaches the background.
    // Rebase target indices [-2, ceil(max) + 3] to a dense array.
    const transformedMax = volume.resolution.map((count) =>
      Math.ceil((count - 1) * factor)) as Vec3;
    const resolution = transformedMax.map((maximum) => maximum + 6) as Vec3;
    const origin = volume.min.map((minimum, axis) =>
      minimum - 2 * spacing[axis]) as Vec3;
    return {
      factor,
      inverseFactor,
      spacing,
      resolution,
      origin,
      sampleCount: resolutionSampleCount(resolution),
    };
  };

  const requestedLayout = layoutForSpacing(normalizedRequestedSpacing);
  const minimumResolution = volume.resolution.map((count) => count > 1 ? 7 : 6) as Vec3;
  if (resolutionSampleCount(minimumResolution) > denseSdfSampleBudget)
    throw new RangeError(
      `Dense volume resampling needs at least ${resolutionSampleCount(minimumResolution)} samples, above the configured ${denseSdfSampleBudget} sample budget`,
    );
  let effectiveSpacing = normalizedRequestedSpacing;
  let layout = requestedLayout;
  if (layout.sampleCount > denseSdfSampleBudget) {
    let lower = normalizedRequestedSpacing;
    let upper = normalizedRequestedSpacing;
    do {
      upper *= 2;
      if (!Number.isFinite(upper))
        throw new RangeError("Volume to Mesh could not derive a finite bounded voxel size");
      layout = layoutForSpacing(upper);
    } while (layout.sampleCount > denseSdfSampleBudget);
    for (let iteration = 0; iteration < 64; iteration++) {
      const middle = lower + (upper - lower) * 0.5;
      const candidate = layoutForSpacing(middle);
      if (candidate.sampleCount > denseSdfSampleBudget) lower = middle;
      else {
        upper = middle;
        layout = candidate;
      }
    }
    effectiveSpacing = upper;
    layout = layoutForSpacing(effectiveSpacing);
    while (layout.sampleCount > denseSdfSampleBudget) {
      effectiveSpacing *= 1.0000001;
      layout = layoutForSpacing(effectiveSpacing);
    }
  }
  const {
    factor,
    inverseFactor,
    spacing,
    resolution,
    origin,
  } = layout;
  const values = new Float32Array(resolution[0] * resolution[1] * resolution[2]);
  values.fill(volume.background);
  const active = new Uint8Array(values.length);
  const sourceActive = (coordinates: Vec3) => {
    const base = coordinates.map(Math.floor) as Vec3;
    for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
      const x = base[0] + dx, y = base[1] + dy, z = base[2] + dz;
      if (x >= 0 && y >= 0 && z >= 0
        && x < volume.resolution[0] && y < volume.resolution[1] && z < volume.resolution[2]) return true;
    }
    return false;
  };
  interface SourceUnit { origin: Vec3; tileValue?: number }
  const tiles: SourceUnit[] = [];
  const leaves: SourceUnit[] = [];
  // copyFromDense prunes every uniform, fully populated 8³ FloatGrid leaf to
  // an active tile. GridTransformer processes those tiles before the remaining
  // leaves, and its TileSampler deliberately extends the cached tile by one
  // source voxel on every side.
  for (let x = 0; x < volume.resolution[0]; x += 8) {
    for (let y = 0; y < volume.resolution[1]; y += 8) {
      for (let z = 0; z < volume.resolution[2]; z += 8) {
        const unit: SourceUnit = { origin: [x, y, z] };
        if (x + 8 <= volume.resolution[0]
          && y + 8 <= volume.resolution[1]
          && z + 8 <= volume.resolution[2]) {
          const first = volume.values[z * volume.resolution[0] * volume.resolution[1] + y * volume.resolution[0] + x];
          let uniform = true;
          for (let dz = 0; dz < 8 && uniform; dz++) for (let dy = 0; dy < 8 && uniform; dy++) for (let dx = 0; dx < 8; dx++) {
            if (volume.values[(z + dz) * volume.resolution[0] * volume.resolution[1]
              + (y + dy) * volume.resolution[0] + x + dx] !== first) {
              uniform = false;
              break;
            }
          }
          if (uniform) unit.tileValue = first;
        }
        (unit.tileValue === undefined ? leaves : tiles).push(unit);
      }
    }
  }
  const transformUnit = (unit: SourceUnit) => {
    const isTile = unit.tileValue !== undefined;
    const inputMaximum = isTile ? 8 : 9;
    const outputMin = unit.origin.map((value) => Math.floor(value * factor) - 1) as Vec3;
    const outputMax = unit.origin.map((value) => Math.ceil((value + inputMaximum) * factor) + 1) as Vec3;
    let sourceX = outputMin[0] * inverseFactor;
    for (let targetX = outputMin[0]; targetX <= outputMax[0]; targetX++, sourceX += inverseFactor) {
      let sourceY = outputMin[1] * inverseFactor;
      for (let targetY = outputMin[1]; targetY <= outputMax[1]; targetY++, sourceY += inverseFactor) {
        let sourceZ = outputMin[2] * inverseFactor;
        for (let targetZ = outputMin[2]; targetZ <= outputMax[2]; targetZ++, sourceZ += inverseFactor) {
          const x = targetX + 2, y = targetY + 2, z = targetZ + 2;
          if (x < 0 || y < 0 || z < 0 || x >= resolution[0] || y >= resolution[1] || z >= resolution[2]) continue;
          const coordinates: Vec3 = [sourceX, sourceY, sourceZ];
          const tileHit = isTile
            && coordinates.every((value, axis) => value >= unit.origin[axis] - 1 && value <= unit.origin[axis] + 8);
          const sampleIsActive = tileHit || sourceActive(coordinates);
          const index = z * resolution[0] * resolution[1] + y * resolution[0] + x;
          if (sampleIsActive && (isTile || !active[index])) {
            values[index] = tileHit ? unit.tileValue! : sampleVolumeAtIndex(volume, coordinates);
            active[index] = 1;
          }
          else if (!active[index]) values[index] = sampleVolumeAtIndex(volume, coordinates);
        }
      }
    }
  };
  for (const tile of tiles) transformUnit(tile);
  for (const leaf of leaves) transformUnit(leaf);
  return {
    values,
    resolution,
    origin,
    spacing,
    requestedSpacing: normalizedRequestedSpacing,
    requestedSampleCount: requestedLayout.sampleCount,
    sampleBudget: denseSdfSampleBudget,
    budgetAdjusted: effectiveSpacing !== normalizedRequestedSpacing,
  };
}

/** Focused hook for sparse-boundary parity tests. */
export const resampleVolumeGridForTest = resampleVolumeGrid;

interface SdfTriangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
  min: Vec3;
  max: Vec3;
  center: Vec3;
}

interface SdfBvh {
  min: Vec3;
  max: Vec3;
  left?: SdfBvh;
  right?: SdfBvh;
  triangles?: SdfTriangle[];
}

interface SdfSphere {
  center: Vec3;
  radius: number;
}

interface SphereBvh {
  min: Vec3;
  max: Vec3;
  maxRadius: number;
  left?: SphereBvh;
  right?: SphereBvh;
  spheres?: SdfSphere[];
}

export const MAX_DENSE_SDF_SAMPLES = 1_000_000;
let denseSdfSampleBudget = MAX_DENSE_SDF_SAMPLES;

/**
 * Configure the process-local dense SDF allocation ceiling.
 *
 * Pass null to restore the browser-safe default. Studio controllers can raise
 * this for an explicit manual preview; automatic live evaluation should keep
 * the default and inspect `budgetAdjusted` diagnostics.
 */
export function setDenseSdfSampleBudget(maxSamples: number | null): void {
  if (maxSamples === null) {
    denseSdfSampleBudget = MAX_DENSE_SDF_SAMPLES;
    return;
  }
  if (!Number.isFinite(maxSamples) || maxSamples <= 0)
    throw new RangeError("Dense SDF sample budget must be a finite positive number");
  denseSdfSampleBudget = Math.max(8, Math.min(16_000_000, Math.trunc(maxSamples)));
}
const SDF_RAY_DIRECTION: Vec3 = [1, 0.3713906763541037, 0.1437023951028752];

function triangleBounds(a: Vec3, b: Vec3, c: Vec3): Pick<SdfTriangle, "min" | "max" | "center"> {
  const min: Vec3 = [
    Math.min(a[0], b[0], c[0]),
    Math.min(a[1], b[1], c[1]),
    Math.min(a[2], b[2], c[2]),
  ];
  const max: Vec3 = [
    Math.max(a[0], b[0], c[0]),
    Math.max(a[1], b[1], c[1]),
    Math.max(a[2], b[2], c[2]),
  ];
  return {
    min,
    max,
    center: [
      (min[0] + max[0]) * 0.5,
      (min[1] + max[1]) * 0.5,
      (min[2] + max[2]) * 0.5,
    ],
  };
}

function trianglesOf(mesh: Mesh): SdfTriangle[] {
  const triangles: SdfTriangle[] = [];
  for (const face of mesh.faces) {
    for (const [ia, ib, ic] of triangulateFaceIndices(mesh, face)) {
      const a = mesh.positions[ia], b = mesh.positions[ib], c = mesh.positions[ic];
      if (![...a, ...b, ...c].every(Number.isFinite)) continue;
      const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cross: Vec3 = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      if (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2] <= 1e-24) continue;
      triangles.push({ a, b, c, ...triangleBounds(a, b, c) });
    }
  }
  return triangles;
}

function boundsOfTriangles(triangles: SdfTriangle[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const triangle of triangles) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], triangle.min[axis]);
    max[axis] = Math.max(max[axis], triangle.max[axis]);
  }
  return { min, max };
}

function buildSdfBvh(triangles: SdfTriangle[]): SdfBvh {
  const bounds = boundsOfTriangles(triangles);
  if (triangles.length <= 8) return { ...bounds, triangles };
  const centerMin: Vec3 = [Infinity, Infinity, Infinity];
  const centerMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const triangle of triangles) for (let axis = 0; axis < 3; axis++) {
    centerMin[axis] = Math.min(centerMin[axis], triangle.center[axis]);
    centerMax[axis] = Math.max(centerMax[axis], triangle.center[axis]);
  }
  let axis = 0;
  if (centerMax[1] - centerMin[1] > centerMax[axis] - centerMin[axis]) axis = 1;
  if (centerMax[2] - centerMin[2] > centerMax[axis] - centerMin[axis]) axis = 2;
  const sorted = [...triangles].sort((a, b) => a.center[axis] - b.center[axis]);
  const middle = Math.floor(sorted.length / 2);
  return {
    ...bounds,
    left: buildSdfBvh(sorted.slice(0, middle)),
    right: buildSdfBvh(sorted.slice(middle)),
  };
}

function buildSphereBvh(spheres: SdfSphere[]): SphereBvh {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let maxRadius = 0;
  for (const sphere of spheres) {
    maxRadius = Math.max(maxRadius, sphere.radius);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], sphere.center[axis]);
      max[axis] = Math.max(max[axis], sphere.center[axis]);
    }
  }
  if (spheres.length <= 12) return { min, max, maxRadius, spheres };
  let axis = 0;
  if (max[1] - min[1] > max[axis] - min[axis]) axis = 1;
  if (max[2] - min[2] > max[axis] - min[axis]) axis = 2;
  const sorted = [...spheres].sort((a, b) => a.center[axis] - b.center[axis]);
  const middle = Math.floor(sorted.length / 2);
  return {
    min,
    max,
    maxRadius,
    left: buildSphereBvh(sorted.slice(0, middle)),
    right: buildSphereBvh(sorted.slice(middle)),
  };
}

function pointBoxDistanceSquared(point: Vec3, min: Vec3, max: Vec3): number {
  let squared = 0;
  for (let axis = 0; axis < 3; axis++) {
    const delta = point[axis] < min[axis]
      ? min[axis] - point[axis]
      : point[axis] > max[axis]
        ? point[axis] - max[axis]
        : 0;
    squared += delta * delta;
  }
  return squared;
}

function nearestSphereDistance(point: Vec3, root: SphereBvh, initial: number): number {
  let best = initial;
  const lowerBound = (node: SphereBvh) =>
    Math.sqrt(pointBoxDistanceSquared(point, node.min, node.max)) - node.maxRadius;
  const visit = (node: SphereBvh) => {
    if (lowerBound(node) >= best) return;
    if (node.spheres) {
      for (const sphere of node.spheres) {
        const dx = point[0] - sphere.center[0];
        const dy = point[1] - sphere.center[1];
        const dz = point[2] - sphere.center[2];
        best = Math.min(best, Math.hypot(dx, dy, dz) - sphere.radius);
      }
      return;
    }
    const leftDistance = node.left ? lowerBound(node.left) : Infinity;
    const rightDistance = node.right ? lowerBound(node.right) : Infinity;
    if (leftDistance < rightDistance) {
      if (node.left) visit(node.left);
      if (node.right) visit(node.right);
    } else {
      if (node.right) visit(node.right);
      if (node.left) visit(node.left);
    }
  };
  visit(root);
  return best;
}

// Closest-point regions from Real-Time Collision Detection. Keeping the
// squared result avoids one square root per candidate while traversing the BVH.
function pointTriangleDistanceSquared(point: Vec3, triangle: SdfTriangle): number {
  const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const squared = (a: Vec3) => dot(a, a);
  const ab = subtract(triangle.b, triangle.a);
  const ac = subtract(triangle.c, triangle.a);
  const ap = subtract(point, triangle.a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return squared(ap);
  const bp = subtract(point, triangle.b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return squared(bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const projection = subtract(ap, [ab[0] * d1 / (d1 - d3), ab[1] * d1 / (d1 - d3), ab[2] * d1 / (d1 - d3)]);
    return squared(projection);
  }
  const cp = subtract(point, triangle.c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return squared(cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const projection = subtract(ap, [ac[0] * d2 / (d2 - d6), ac[1] * d2 / (d2 - d6), ac[2] * d2 / (d2 - d6)]);
    return squared(projection);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const edge = subtract(triangle.c, triangle.b);
    const weight = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const projection = subtract(bp, [edge[0] * weight, edge[1] * weight, edge[2] * weight]);
    return squared(projection);
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator, w = vc * denominator;
  const projection = subtract(ap, [
    ab[0] * v + ac[0] * w,
    ab[1] * v + ac[1] * w,
    ab[2] * v + ac[2] * w,
  ]);
  return squared(projection);
}

function nearestTriangleDistanceSquared(point: Vec3, root: SdfBvh): number {
  let best = Infinity;
  const visit = (node: SdfBvh) => {
    if (pointBoxDistanceSquared(point, node.min, node.max) >= best) return;
    if (node.triangles) {
      for (const triangle of node.triangles)
        best = Math.min(best, pointTriangleDistanceSquared(point, triangle));
      return;
    }
    const leftDistance = node.left
      ? pointBoxDistanceSquared(point, node.left.min, node.left.max)
      : Infinity;
    const rightDistance = node.right
      ? pointBoxDistanceSquared(point, node.right.min, node.right.max)
      : Infinity;
    if (leftDistance < rightDistance) {
      if (node.left) visit(node.left);
      if (node.right) visit(node.right);
    } else {
      if (node.right) visit(node.right);
      if (node.left) visit(node.left);
    }
  };
  visit(root);
  return best;
}

function rayIntersectsBox(origin: Vec3, min: Vec3, max: Vec3): boolean {
  let near = 0, far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const inverse = 1 / SDF_RAY_DIRECTION[axis];
    let a = (min[axis] - origin[axis]) * inverse;
    let b = (max[axis] - origin[axis]) * inverse;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (far < near) return false;
  }
  return far > 1e-10;
}

function rayTriangleDistance(origin: Vec3, triangle: SdfTriangle): number | null {
  const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const edge1 = subtract(triangle.b, triangle.a);
  const edge2 = subtract(triangle.c, triangle.a);
  const p = cross(SDF_RAY_DIRECTION, edge2);
  const determinant = dot(edge1, p);
  if (Math.abs(determinant) < 1e-12) return null;
  const inverse = 1 / determinant;
  const translated = subtract(origin, triangle.a);
  const u = dot(translated, p) * inverse;
  if (u < -1e-10 || u > 1 + 1e-10) return null;
  const q = cross(translated, edge1);
  const v = dot(SDF_RAY_DIRECTION, q) * inverse;
  if (v < -1e-10 || u + v > 1 + 1e-10) return null;
  const distance = dot(edge2, q) * inverse;
  return distance > 1e-10 ? distance : null;
}

function pointIsInsideMesh(point: Vec3, root: SdfBvh): boolean {
  const hits: number[] = [];
  const visit = (node: SdfBvh) => {
    if (!rayIntersectsBox(point, node.min, node.max)) return;
    if (node.triangles) {
      for (const triangle of node.triangles) {
        const distance = rayTriangleDistance(point, triangle);
        if (distance !== null) hits.push(distance);
      }
      return;
    }
    if (node.left) visit(node.left);
    if (node.right) visit(node.right);
  };
  visit(root);
  hits.sort((a, b) => a - b);
  let uniqueHits = 0;
  let previous = -Infinity;
  for (const hit of hits) {
    const tolerance = 1e-8 * Math.max(1, Math.abs(hit));
    if (hit - previous <= tolerance) continue;
    previous = hit;
    uniqueHits++;
  }
  return uniqueHits % 2 === 1;
}

function isClosedTwoManifold(mesh: Mesh): boolean {
  const edgeUses = new Map<string, number>();
  for (const face of mesh.faces) {
    for (let corner = 0; corner < face.length; corner++) {
      const a = face[corner], b = face[(corner + 1) % face.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
    }
  }
  return edgeUses.size > 0 && [...edgeUses.values()].every((uses) => uses === 2);
}

function boundedGridLayout(
  sourceMin: Vec3,
  sourceMax: Vec3,
  requestedVoxelSize: number,
  padding: number,
): Omit<VolumeGrid, "kind" | "background" | "values"> {
  let spacing = Number.isFinite(requestedVoxelSize) && requestedVoxelSize > 0
    ? Math.max(1e-6, requestedVoxelSize)
    : 1e-3;
  const layout = () => {
    const origin = sourceMin.map((value) => value - padding * spacing) as Vec3;
    const resolution = sourceMax.map((value, axis) =>
      Math.max(2, Math.ceil((value - sourceMin[axis]) / spacing) + padding * 2 + 1)) as Vec3;
    return { origin, resolution, sampleCount: resolution[0] * resolution[1] * resolution[2] };
  };
  let current = layout();
  const requestedSpacing = spacing;
  const requestedSampleCount = current.sampleCount;
  const sampleBudget = denseSdfSampleBudget;
  if (current.sampleCount > sampleBudget) {
    spacing *= Math.cbrt(current.sampleCount / sampleBudget);
    current = layout();
    while (current.sampleCount > sampleBudget) {
      spacing *= 1.01;
      current = layout();
    }
  }
  const voxelSize: Vec3 = [spacing, spacing, spacing];
  const max = current.origin.map((value, axis) =>
    value + (current.resolution[axis] - 1) * spacing) as Vec3;
  return {
    min: [...current.origin] as Vec3,
    max,
    resolution: current.resolution,
    origin: current.origin,
    voxelSize,
    requestedVoxelSize: requestedSpacing,
    requestedSampleCount,
    budgetAdjusted: spacing !== requestedSpacing,
    sampleBudget,
  };
}

export const boundedGridLayoutForTest = boundedGridLayout;

function emptySdfGrid(voxelSize: number): VolumeGrid {
  const spacing = Number.isFinite(voxelSize) && voxelSize > 0 ? Math.max(1e-6, voxelSize) : 1e-3;
  const background = spacing * 3;
  return {
    kind: "GNVM_VOLUME_GRID",
    background,
    min: [0, 0, 0],
    max: [spacing, spacing, spacing],
    resolution: [2, 2, 2],
    origin: [0, 0, 0],
    voxelSize: [spacing, spacing, spacing],
    values: new Float32Array(8).fill(background),
    requestedVoxelSize: spacing,
    requestedSampleCount: 8,
    budgetAdjusted: false,
    sampleBudget: denseSdfSampleBudget,
  };
}

function meshToSdfGrid(mesh: Mesh | null, voxelSize: number, bandWidth: number): VolumeGrid {
  const triangles = mesh ? trianglesOf(mesh) : [];
  if (!triangles.length) return emptySdfGrid(voxelSize);
  const bounds = boundsOfTriangles(triangles);
  const padding = Number.isFinite(bandWidth)
    ? Math.max(1, Math.min(64, Math.trunc(bandWidth)))
    : 3;
  const layout = boundedGridLayout(bounds.min, bounds.max, voxelSize, padding);
  const spacing = layout.voxelSize[0];
  const background = padding * spacing;
  const values = new Float32Array(layout.resolution[0] * layout.resolution[1] * layout.resolution[2]);
  const bvh = buildSdfBvh(triangles);
  // OpenVDB's mesh rasterizer accepts open and non-manifold polygon soups.
  // Its stable contract there is an unsigned narrow band with a tiny negative
  // surface sample, rather than treating an arbitrary ray-parity half-space as
  // solid. Closed two-manifolds retain signed interior distances even when one
  // or more face windings are flipped.
  const signedInterior = mesh ? isClosedTwoManifold(mesh) : false;
  for (let z = 0; z < layout.resolution[2]; z++) for (let y = 0; y < layout.resolution[1]; y++) {
    for (let x = 0; x < layout.resolution[0]; x++) {
      const point: Vec3 = [
        layout.origin[0] + x * spacing,
        layout.origin[1] + y * spacing,
        layout.origin[2] + z * spacing,
      ];
      const unsigned = Math.sqrt(nearestTriangleDistanceSquared(point, bvh));
      // OpenVDB's mesh rasterizer retains an inside-biased float at samples
      // lying exactly on a closed surface. A literal zero makes dual
      // contouring drop the boundary row/column of otherwise planar faces
      // (a unit cube at 0.25 spacing collapses from Blender's 5x5 quads per
      // side to 3x3). One float32-scale inward bias preserves that topology.
      const signed = unsigned <= spacing * 1e-7
        ? -spacing * 4.76837158203125e-7
        : signedInterior && pointIsInsideMesh(point, bvh) ? -unsigned : unsigned;
      values[z * layout.resolution[0] * layout.resolution[1] + y * layout.resolution[0] + x] =
        Math.fround(Math.max(-background, Math.min(background, signed)));
    }
  }
  return { kind: "GNVM_VOLUME_GRID", background, ...layout, values };
}

function pointsToSdfGrid(points: Vec3[], radii: number[], voxelSize: number): VolumeGrid {
  const spheres = points.flatMap((center, index): SdfSphere[] =>
    center.every(Number.isFinite)
      ? [{ center, radius: Math.max(0, Number.isFinite(radii[index]) ? radii[index] : 0) }]
      : []);
  if (!spheres.length) return emptySdfGrid(voxelSize);
  const sourceMin: Vec3 = [Infinity, Infinity, Infinity];
  const sourceMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const sphere of spheres) for (let axis = 0; axis < 3; axis++) {
    sourceMin[axis] = Math.min(sourceMin[axis], sphere.center[axis] - sphere.radius);
    sourceMax[axis] = Math.max(sourceMax[axis], sphere.center[axis] + sphere.radius);
  }
  // Blender's particle-to-level-set path uses the OpenVDB default three-voxel
  // half width; the node intentionally exposes no separate Band Width input.
  const padding = 3;
  const layout = boundedGridLayout(sourceMin, sourceMax, voxelSize, padding);
  const spacing = layout.voxelSize[0];
  const background = padding * spacing;
  const values = new Float32Array(layout.resolution[0] * layout.resolution[1] * layout.resolution[2]);
  const bvh = buildSphereBvh(spheres);
  for (let z = 0; z < layout.resolution[2]; z++) for (let y = 0; y < layout.resolution[1]; y++) {
    for (let x = 0; x < layout.resolution[0]; x++) {
      const sample: Vec3 = [
        layout.origin[0] + x * spacing,
        layout.origin[1] + y * spacing,
        layout.origin[2] + z * spacing,
      ];
      const distance = nearestSphereDistance(sample, bvh, background);
      values[z * layout.resolution[0] * layout.resolution[1] + y * layout.resolution[0] + x] =
        Math.fround(Math.max(-background, Math.min(background, distance)));
    }
  }
  return { kind: "GNVM_VOLUME_GRID", background, ...layout, values };
}

/** Focused hooks for bounded SDF conversion tests. */
export const meshToSdfGridForTest = meshToSdfGrid;
export const pointsToSdfGridForTest = pointsToSdfGrid;

/**
 * Deterministic dense-grid adaptivity for the browser runtime.
 *
 * OpenVDB uses a sparse-tree error metric that is not available in GNVM.
 * Spatial clustering still makes Adaptivity functional and monotonic while
 * preserving a zero-adaptivity bit-for-bit path. Diagnostics label this as a
 * bounded implementation instead of claiming OpenVDB's exact topology.
 */
function adaptSurfaceMesh(mesh: Mesh, adaptivity: number, spacing: Vec3): Mesh {
  const amount = Math.max(0, Math.min(1, Number.isFinite(adaptivity) ? adaptivity : 0));
  if (amount <= 0 || mesh.positions.length < 4) return mesh;
  const base = Math.max(1e-9, Math.max(...spacing));
  // Small values primarily remove redundant planar samples; the quartic term
  // makes the final portion converge to one coarse cell per canonical side.
  const cellSize = base * (1 - .5 * amount + 3 * amount ** 2);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  for (const point of mesh.positions)
    for (let axis = 0; axis < 3; axis++) min[axis] = Math.min(min[axis], point[axis]);
  const clusters = new Map<string, { sum: Vec3; count: number; source: number[] }>();
  for (let vertex = 0; vertex < mesh.positions.length; vertex++) {
    const point = mesh.positions[vertex];
    const key = [0, 1, 2].map((axis) =>
      Math.floor((point[axis] - min[axis] + 1e-10) / cellSize)).join(",");
    const cluster = clusters.get(key);
    if (cluster) {
      cluster.sum = [
        cluster.sum[0] + point[0],
        cluster.sum[1] + point[1],
        cluster.sum[2] + point[2],
      ];
      cluster.count++;
      cluster.source.push(vertex);
    } else {
      clusters.set(key, { sum: [...point] as Vec3, count: 1, source: [vertex] });
    }
  }
  const output = new Mesh();
  const remap = new Int32Array(mesh.positions.length);
  for (const cluster of clusters.values()) {
    const vertex = output.positions.length;
    output.positions.push([
      cluster.sum[0] / cluster.count,
      cluster.sum[1] / cluster.count,
      cluster.sum[2] / cluster.count,
    ]);
    for (const source of cluster.source) remap[source] = vertex;
  }
  const emitted = new Set<string>();
  for (const sourceFace of mesh.faces) {
    const face: number[] = [];
    for (const source of sourceFace) {
      const vertex = remap[source];
      if (face.at(-1) !== vertex) face.push(vertex);
    }
    if (face.length > 1 && face[0] === face.at(-1)) face.pop();
    if (new Set(face).size < 3) continue;
    const canonical = [...new Set(face)].sort((a, b) => a - b).join(",");
    if (emitted.has(canonical)) continue;
    emitted.add(canonical);
    output.faces.push(face);
  }
  output.materialSlots = [...mesh.materialSlots];
  return output;
}

export function adaptiveSurfaceNetsForTest(
  values: Float32Array,
  resolution: Vec3,
  isolation: number,
  origin: Vec3,
  spacing: Vec3,
  adaptivity: number,
): Mesh {
  return adaptSurfaceMesh(
    surfaceNets(values, resolution, isolation, origin, spacing),
    adaptivity,
    spacing,
  );
}

reg("GeometryNodeMeshToSDFGrid", (api) => {
  recordApproximation("GeometryNodeMeshToSDFGrid");
  const source = realizeInstances(api.geo("Mesh"));
  const volume = meshToSdfGrid(
    source.mesh ?? null,
    Math.max(1e-6, api.num("Voxel Size")),
    Math.max(1, Math.trunc(api.num("Band Width"))),
  );
  volumeGridDiagnosticSink?.({
    stage: "mesh-to-sdf-grid",
    background: volume.background,
    min: [...volume.min] as Vec3,
    max: [...volume.max] as Vec3,
    resolution: [...volume.resolution] as Vec3,
    origin: [...volume.origin] as Vec3,
    spacing: [...volume.voxelSize] as Vec3,
    requestedSpacing: volume.requestedVoxelSize,
    requestedSampleCount: volume.requestedSampleCount,
    sampleCount: volume.values.length,
    sampleBudget: volume.sampleBudget,
    budgetAdjusted: volume.budgetAdjusted,
    isolation: 0,
    values: volume.values,
  });
  return { "SDF Grid": volume };
});

reg("GeometryNodePointsToSDFGrid", (api) => {
  recordApproximation("GeometryNodePointsToSDFGrid");
  const source = realizeInstances(api.geo("Points"));
  const mesh = source.mesh;
  const points = mesh?.positions ?? [];
  const resolved = mesh
    ? api.resolve(api.field("Radius"), source, "POINT").map(asNum)
    : [];
  const volume = pointsToSdfGrid(points, resolved, Math.max(1e-6, api.num("Voxel Size")));
  volumeGridDiagnosticSink?.({
    stage: "points-to-sdf-grid",
    background: volume.background,
    min: [...volume.min] as Vec3,
    max: [...volume.max] as Vec3,
    resolution: [...volume.resolution] as Vec3,
    origin: [...volume.origin] as Vec3,
    spacing: [...volume.voxelSize] as Vec3,
    requestedSpacing: volume.requestedVoxelSize,
    requestedSampleCount: volume.requestedSampleCount,
    sampleCount: volume.values.length,
    sampleBudget: volume.sampleBudget,
    budgetAdjusted: volume.budgetAdjusted,
    isolation: 0,
    values: volume.values,
  });
  return { "SDF Grid": volume };
});

reg("GeometryNodeGridToMesh", (api) => {
  recordApproximation("GeometryNodeGridToMesh");
  const volume = api.input("Grid");
  if (!isVolumeGrid(volume)) return { Mesh: new Geometry() };
  const threshold = api.num("Threshold");
  const adaptivity = Math.max(0, Math.min(1, api.num("Adaptivity")));
  volumeGridDiagnosticSink?.({
    stage: "grid-to-mesh",
    background: volume.background,
    min: [...volume.min] as Vec3,
    max: [...volume.max] as Vec3,
    resolution: [...volume.resolution] as Vec3,
    origin: [...volume.origin] as Vec3,
    spacing: [...volume.voxelSize] as Vec3,
    requestedSpacing: volume.requestedVoxelSize,
    requestedSampleCount: volume.requestedSampleCount,
    sampleCount: volume.values.length,
    sampleBudget: volume.sampleBudget,
    budgetAdjusted: volume.budgetAdjusted,
    requestedAdaptivity: adaptivity,
    adaptivityApplied: adaptivity > 0,
    isolation: threshold,
    values: volume.values,
  });
  const mesh = adaptiveSurfaceNetsForTest(
    volume.values,
    volume.resolution,
    threshold,
    volume.origin,
    volume.voxelSize,
    adaptivity,
  );
  mesh.materialSlots = [null];
  const geometry = new Geometry();
  geometry.mesh = mesh;
  return { Mesh: geometry };
});

reg("GeometryNodeVolumeToMesh", (api) => {
  recordApproximation("GeometryNodeVolumeToMesh");
  const volume = api.input("Volume");
  if (!isVolumeGrid(volume)) return { Mesh: new Geometry() };

  const sampleSpacing = Math.max(...volume.voxelSize);
  const resolutionMode = api.str("Resolution Mode").toUpperCase();
  const requestedSpacing = resolutionMode === "SIZE"
    ? Math.max(1e-6, api.num("Voxel Size") || sampleSpacing)
    : sampleSpacing;
  // OpenVDB's GridTransformer keeps the source transform's translation and
  // scales only its voxel basis. Preserve that minimum-bound origin instead of
  // re-centering the target lattice. For anisotropic grids Blender chooses the
  // maximum source voxel size as the requested-size reference.
  const resampled = resampleVolumeGrid(volume, requestedSpacing);
  const { values: sampledGrid, resolution, origin, spacing } = resampled;

  const threshold = api.num("Threshold");
  // Zero-level SDF surfaces must reach OpenVDB verbatim: Modern Pipe's first
  // resampled FloatGrid is native-bit-identical, and a negative epsilon loses
  // eight vertices/faces. Keep the established sub-voxel compatibility bias
  // for nonzero isovalues, where TPMS.016's 163^3 native OpenVDB runs vary at
  // the boundary and the biased result remains inside Blender's observed
  // scheduling range.
  const isolation = threshold === 0
    ? 0
    : threshold - Math.max(1e-7, Math.max(...spacing) * 1e-6);
  volumeGridDiagnosticSink?.({
    stage: "volume-to-mesh",
    background: volume.background,
    min: [...volume.min] as Vec3,
    max: [...volume.max] as Vec3,
    resolution: [...resolution] as Vec3,
    origin: [...origin] as Vec3,
    spacing: [...spacing] as Vec3,
    requestedSpacing: resampled.requestedSpacing,
    requestedSampleCount: resampled.requestedSampleCount,
    sampleCount: sampledGrid.length,
    sampleBudget: resampled.sampleBudget,
    budgetAdjusted: resampled.budgetAdjusted,
    isolation,
    values: sampledGrid,
  });
  const mesh = surfaceNets(sampledGrid, resolution, isolation, origin, spacing);
  mesh.materialSlots = [null];
  const geometry = new Geometry();
  geometry.mesh = mesh;
  return { Mesh: geometry };
});

reg("GeometryNodeInputInstanceRotation", () => ({
  Rotation: Field.perElem((index, context) => context.instanceRotation?.(index) ?? [0, 0, 0]),
}));
