import { asNum, Field, Vec3 } from "../core";
import { makeFieldCtx } from "../evaluator";
import { Geometry, Mesh } from "../geometry";
import { reg, SockVal } from "../registry";

interface VolumeGrid {
  kind: "GNVM_VOLUME_GRID";
  density: Field;
  background: number;
  min: Vec3;
  max: Vec3;
  resolution: Vec3;
}

function isVolumeGrid(value: unknown): value is VolumeGrid {
  return !!value && typeof value === "object" && (value as VolumeGrid).kind === "GNVM_VOLUME_GRID";
}

function splitNonManifoldFans(mesh: Mesh): void {
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
  if (![...edgeFaces.values()].some((edge) => edge.faces.length !== 2)) return;
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
}

// Blender's OpenVDB mesher uses a surface-net topology: one vertex in every
// active voxel cell and one quad around every crossed grid edge. Building that
// topology directly is both smaller and more faithful than pairing triangles
// emitted by Marching Cubes.
function surfaceNets(values: Float32Array, resolution: number, isolation: number, center: Vec3, spacing: number): Mesh {
  const mesh = new Mesh();
  const sample = (x: number, y: number, z: number) => values[z * resolution * resolution + y * resolution + x];
  const cellResolution = resolution - 1;
  const cellIndex = (x: number, y: number, z: number) => z * cellResolution * cellResolution + y * cellResolution + x;
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
  // edges. Ambiguous checkerboards are resolved with the bilinear face-center
  // sign, consistently on both cells sharing the face.
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
    center[0] + (x - resolution * 0.5) * spacing,
    center[1] + (y - resolution * 0.5) * spacing,
    center[2] + (z - resolution * 0.5) * spacing,
  ];

  for (let z = 0; z < cellResolution; z++) for (let y = 0; y < cellResolution; y++) for (let x = 0; x < cellResolution; x++) {
    const cornerValues = cornerOffsets.map(([dx, dy, dz]) => sample(x + dx, y + dy, z + dz));
    const below = cornerValues.some((value) => value < isolation);
    const above = cornerValues.some((value) => value >= isolation);
    if (!below || !above) continue;
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
        const centerInside = face.corners.reduce((sum, corner) => sum + cornerValues[corner], 0) * 0.25 < isolation;
        const firstInside = cornerValues[face.corners[0]] < isolation;
        const [e0, e1, e2, e3] = face.edges;
        if (centerInside === firstInside) { join(e0, e1); join(e2, e3); }
        else { join(e3, e0); join(e1, e2); }
      }
    }
    const components = new Map<number, number[]>();
    for (let edge = 0; edge < edgePoints.length; edge++) {
      if (!edgePoints[edge]) continue;
      const component = root(edge);
      const edges = components.get(component);
      if (edges) edges.push(edge); else components.set(component, [edge]);
    }
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

  const addQuad = (indices: number[], forward: boolean) => {
    if (indices.some((index) => index < 0) || new Set(indices).size !== 4) return;
    mesh.faces.push(forward ? indices : [...indices].reverse());
  };
  const cellEdge = (x: number, y: number, z: number, edge: number) => cellEdgeVertices.get(cellIndex(x, y, z))?.[edge] ?? -1;
  for (let z = 1; z < resolution - 1; z++) for (let y = 1; y < resolution - 1; y++) for (let x = 1; x < resolution - 1; x++) {
    const value = sample(x, y, z);
    const crossX = sample(x + 1, y, z);
    if ((value < isolation) !== (crossX < isolation))
      addQuad([cellEdge(x, y - 1, z - 1, 3), cellEdge(x, y, z - 1, 2), cellEdge(x, y, z, 0), cellEdge(x, y - 1, z, 1)], value < isolation);
    const crossY = sample(x, y + 1, z);
    if ((value < isolation) !== (crossY < isolation))
      addQuad([cellEdge(x - 1, y, z - 1, 7), cellEdge(x - 1, y, z, 5), cellEdge(x, y, z, 4), cellEdge(x, y, z - 1, 6)], value < isolation);
    const crossZ = sample(x, y, z + 1);
    if ((value < isolation) !== (crossZ < isolation))
      addQuad([cellEdge(x - 1, y - 1, z, 11), cellEdge(x, y - 1, z, 10), cellEdge(x, y, z, 8), cellEdge(x - 1, y, z, 9)], value < isolation);
  }
  splitNonManifoldFans(mesh);
  return mesh;
}

reg("GeometryNodeVolumeCube", (api) => {
  const volume: VolumeGrid = {
    kind: "GNVM_VOLUME_GRID",
    density: api.field("Density"),
    background: api.num("Background"),
    min: api.vec("Min"),
    max: api.vec("Max"),
    resolution: [
      Math.max(4, Math.round(api.num("Resolution X"))),
      Math.max(4, Math.round(api.num("Resolution Y"))),
      Math.max(4, Math.round(api.num("Resolution Z"))),
    ],
  };
  return { Volume: volume as unknown as SockVal };
});

reg("GeometryNodeVolumeToMesh", (api) => {
  const volume = api.input("Volume") as unknown;
  if (!isVolumeGrid(volume)) return { Mesh: new Geometry() };

  const spans: Vec3 = [
    Math.max(1e-6, volume.max[0] - volume.min[0]),
    Math.max(1e-6, volume.max[1] - volume.min[1]),
    Math.max(1e-6, volume.max[2] - volume.min[2]),
  ];
  const center: Vec3 = [
    (volume.min[0] + volume.max[0]) * 0.5,
    (volume.min[1] + volume.max[1]) * 0.5,
    (volume.min[2] + volume.max[2]) * 0.5,
  ];
  const maxSpan = Math.max(...spans);
  const sampleSpacing = Math.max(...spans.map((span, axis) => span / Math.max(1, volume.resolution[axis] - 1)));
  const voxelSize = Math.max(1e-6, api.num("Voxel Size") || sampleSpacing);
  const spacing = Math.max(sampleSpacing, voxelSize);
  const coreResolution = Math.max(8, Math.min(140, Math.ceil(maxSpan / spacing) + 1));
  // Keep two background samples around the authored cube, matching the old
  // mesher's padding and ensuring every crossed edge has four adjacent cells.
  const resolution = coreResolution + 4;
  const halfResolution = resolution * 0.5;
  const sampledGrid = new Float32Array(resolution * resolution * resolution);

  // Resolve the density field a slice at a time. This keeps the temporary
  // position/field arrays small even for Node Dojo's million-voxel pipe wrap.
  for (let z = 0; z < resolution; z++) {
    const sampleGeometry = new Geometry();
    const sampleMesh = new Mesh();
    sampleGeometry.mesh = sampleMesh;
    for (let y = 0; y < resolution; y++) {
      for (let x = 0; x < resolution; x++) {
        sampleMesh.positions.push([
          center[0] + (x - halfResolution) * spacing,
          center[1] + (y - halfResolution) * spacing,
          center[2] + (z - halfResolution) * spacing,
        ]);
      }
    }
    const values = volume.density.array(makeFieldCtx(sampleGeometry, "POINT"));
    for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
      const local = y * resolution + x;
      const point = sampleMesh.positions[local];
      const inside = point[0] >= volume.min[0] && point[0] <= volume.max[0]
        && point[1] >= volume.min[1] && point[1] <= volume.max[1]
        && point[2] >= volume.min[2] && point[2] <= volume.max[2];
      const sampled = inside ? asNum(values[local] ?? volume.background) : volume.background;
      sampledGrid[z * resolution * resolution + local] = Number.isFinite(sampled) ? sampled : volume.background;
    }
  }

  // A deterministic half-open tie break prevents exact-zero SDF samples from
  // producing four faces on one dual edge. The offset is far below the voxel
  // scale and mirrors Blender/OpenVDB's stable treatment of the zero level set.
  const isolation = api.num("Threshold") - Math.max(1e-7, spacing * 1e-6);
  const mesh = surfaceNets(sampledGrid, resolution, isolation, center, spacing);
  mesh.materialSlots = [null];
  const geometry = new Geometry();
  geometry.mesh = mesh;
  return { Mesh: geometry };
});

reg("GeometryNodeInputInstanceRotation", () => ({
  Rotation: Field.perElem((index, context) => context.attr?.("__instance_rotation", index) ?? [0, 0, 0]),
}));
