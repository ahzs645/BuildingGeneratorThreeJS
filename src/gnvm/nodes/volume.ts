import { asNum, Field, Vec3 } from "../core";
import { makeFieldCtx } from "../evaluator";
import { Geometry, Mesh } from "../geometry";
import { reg, SockVal } from "../registry";

interface VolumeGrid {
  kind: "GNVM_VOLUME_GRID";
  background: number;
  min: Vec3;
  max: Vec3;
  resolution: Vec3;
  origin: Vec3;
  voxelSize: Vec3;
  values: Float32Array;
}

export interface VolumeGridDiagnostics {
  stage: "volume-cube" | "volume-to-mesh";
  background: number;
  min: Vec3;
  max: Vec3;
  resolution: Vec3;
  origin: Vec3;
  spacing: Vec3;
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
  // Each face lists its corners cyclically and the corresponding perimeter
  // edges. Ambiguous checkerboards use the bilinear asymptotic determinant,
  // consistently on both cells sharing the face. A center-value average is
  // not equivalent when the two diagonal sign pairs have unequal magnitude.
  const cellFaces: { corners: [number, number, number, number]; edges: [number, number, number, number] }[] = [
    { corners: [0, 1, 3, 2], edges: [0, 5, 1, 4] },
    { corners: [4, 6, 7, 5], edges: [6, 3, 7, 2] },
    { corners: [0, 4, 5, 1], edges: [8, 2, 9, 0] },
    { corners: [2, 3, 7, 6], edges: [1, 11, 3, 10] },
    { corners: [0, 2, 6, 4], edges: [4, 10, 6, 8] },
    { corners: [1, 5, 7, 3], edges: [9, 7, 11, 5] },
  ];
  const cellEdgeVertices = new Map<number, Int32Array>();
  const gridPoint = (x: number, y: number, z: number): Vec3 => [
    origin[0] + x * spacing[0],
    origin[1] + y * spacing[1],
    origin[2] + z * spacing[2],
  ];

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
    const parent = Array.from({ length: 12 }, (_, edge) => edge);
    const root = (edge: number): number => parent[edge] === edge ? edge : (parent[edge] = root(parent[edge]));
    const join = (a: number, b: number) => { const ra = root(a), rb = root(b); if (ra !== rb) parent[ra] = rb; };
    for (const face of cellFaces) {
      const crossed = face.edges.filter((edge) => edgePoints[edge] !== null);
      if (crossed.length === 2) join(crossed[0], crossed[1]);
      else if (crossed.length === 4) {
        if (diagnosticSink) ambiguousFaces++;
        const shifted = face.corners.map((corner) => cornerValues[corner] - isolation);
        const determinant = shifted[0] * shifted[2] - shifted[1] * shifted[3];
        const [e0, e1, e2, e3] = face.edges;
        if (determinant > 0) { join(e0, e1); join(e2, e3); }
        else if (determinant < 0) { join(e3, e0); join(e1, e2); }
        else {
          // Exact symmetric saddle: the face center supplies a deterministic
          // tie-break without disagreeing across the two incident cells.
          const centerInside = shifted.reduce((sum, value) => sum + value, 0) < 0;
          const firstInside = shifted[0] < 0;
          if (centerInside === firstInside) { join(e0, e1); join(e2, e3); }
          else { join(e3, e0); join(e1, e2); }
        }
      }
    }
    const components = new Map<number, number[]>();
    for (let edge = 0; edge < edgePoints.length; edge++) {
      if (!edgePoints[edge]) continue;
      const component = root(edge);
      const edges = components.get(component);
      if (edges) edges.push(edge); else components.set(component, [edge]);
    }
    if (diagnosticSink)
      activeCellComponents.set(components.size, (activeCellComponents.get(components.size) ?? 0) + 1);
    const edgeVertices = new Int32Array(12).fill(-1);
    for (const edges of components.values()) {
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
  const addQuad = (indices: number[], forward: boolean) => {
    if (diagnosticSink) crossedGridEdges++;
    if (indices.some((index) => index < 0)) { if (diagnosticSink) skippedMissingVertex++; return; }
    if (new Set(indices).size !== 4) { if (diagnosticSink) skippedDuplicateVertex++; return; }
    mesh.faces.push(forward ? indices : [...indices].reverse());
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
      addQuad([cellEdge(x, y - 1, z - 1, 3), cellEdge(x, y, z - 1, 2), cellEdge(x, y, z, 0), cellEdge(x, y - 1, z, 1)], value < isolation);
    const crossY = sample(x, y + 1, z);
    if (x > 0 && z > 0 && (value < isolation) !== (crossY < isolation))
      addQuad([cellEdge(x - 1, y, z - 1, 7), cellEdge(x - 1, y, z, 5), cellEdge(x, y, z, 4), cellEdge(x, y, z - 1, 6)], value < isolation);
    const crossZ = sample(x, y, z + 1);
    if (x > 0 && y > 0 && (value < isolation) !== (crossZ < isolation))
      addQuad([cellEdge(x - 1, y - 1, z, 11), cellEdge(x, y - 1, z, 10), cellEdge(x, y, z, 8), cellEdge(x - 1, y, z, 9)], value < isolation);
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

reg("GeometryNodeVolumeCube", (api) => {
  const min = api.vec("Min");
  const max = api.vec("Max");
  const resolution: Vec3 = [
    Math.max(4, Math.round(api.num("Resolution X"))),
    Math.max(4, Math.round(api.num("Resolution Y"))),
    Math.max(4, Math.round(api.num("Resolution Z"))),
  ];
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
  };
  volumeGridDiagnosticSink?.({
    stage: "volume-cube",
    background,
    min: [...min] as Vec3,
    max: [...max] as Vec3,
    resolution: [...resolution] as Vec3,
    origin: [...origin] as Vec3,
    spacing: [...voxelSize] as Vec3,
    values,
  });
  return { Volume: volume as unknown as SockVal };
});

function sampleVolume(volume: VolumeGrid, position: Vec3): number {
  const coordinates: Vec3 = [
    (position[0] - volume.origin[0]) / volume.voxelSize[0],
    (position[1] - volume.origin[1]) / volume.voxelSize[1],
    (position[2] - volume.origin[2]) / volume.voxelSize[2],
  ];
  const base = coordinates.map(Math.floor) as Vec3;
  const fraction: Vec3 = [coordinates[0] - base[0], coordinates[1] - base[1], coordinates[2] - base[2]];
  const value = (x: number, y: number, z: number) => {
    if (x < 0 || y < 0 || z < 0 || x >= volume.resolution[0] || y >= volume.resolution[1] || z >= volume.resolution[2])
      return volume.background;
    return volume.values[z * volume.resolution[0] * volume.resolution[1] + y * volume.resolution[0] + x];
  };
  let result = 0;
  for (let dz = 0; dz <= 1; dz++) for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
    const weight = (dx ? fraction[0] : 1 - fraction[0])
      * (dy ? fraction[1] : 1 - fraction[1])
      * (dz ? fraction[2] : 1 - fraction[2]);
    result += value(base[0] + dx, base[1] + dy, base[2] + dz) * weight;
  }
  return result;
}

reg("GeometryNodeVolumeToMesh", (api) => {
  const volume = api.input("Volume") as unknown;
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
  const factor = sampleSpacing / requestedSpacing;
  const spacing: Vec3 = volume.voxelSize.map((size) => size / factor) as Vec3;
  const coreCells: Vec3 = volume.resolution.map((count) => Math.max(1, Math.floor((count - 1) * factor))) as Vec3;
  const coreSamples: Vec3 = coreCells.map((count) => count + 1) as Vec3;
  // Keep two background samples outside the transformed active grid so every
  // crossed edge has four adjacent cells, without changing the core origin.
  const resolution: Vec3 = coreSamples.map((count) => count + 4) as Vec3;
  const origin: Vec3 = volume.min.map((minimum, axis) => minimum - 2 * spacing[axis]) as Vec3;
  const sampledGrid = new Float32Array(resolution[0] * resolution[1] * resolution[2]);

  for (let z = 0; z < resolution[2]; z++) for (let y = 0; y < resolution[1]; y++) for (let x = 0; x < resolution[0]; x++)
    sampledGrid[z * resolution[0] * resolution[1] + y * resolution[0] + x] = sampleVolume(volume, [
      origin[0] + x * spacing[0],
      origin[1] + y * spacing[1],
      origin[2] + z * spacing[2],
    ]);

  // A deterministic half-open tie break prevents exact-zero SDF samples from
  // producing four faces on one dual edge. The offset is far below the voxel
  // scale and mirrors Blender/OpenVDB's stable treatment of the zero level set.
  const isolation = api.num("Threshold") - Math.max(1e-7, Math.max(...spacing) * 1e-6);
  volumeGridDiagnosticSink?.({
    stage: "volume-to-mesh",
    background: volume.background,
    min: [...volume.min] as Vec3,
    max: [...volume.max] as Vec3,
    resolution: [...resolution] as Vec3,
    origin: [...origin] as Vec3,
    spacing: [...spacing] as Vec3,
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
  Rotation: Field.perElem((index, context) => context.attr?.("__instance_rotation", index) ?? [0, 0, 0]),
}));
