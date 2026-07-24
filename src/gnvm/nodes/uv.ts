import {
  Field,
  asNum,
  asVec3,
  vcross,
  vdot,
  vlen,
  vnorm,
  vsub,
  type FieldCtx,
  type Vec3,
} from "../core";
import { recordApproximation, reg } from "../registry";

type FaceProjection = {
  face: number;
  corners: number[];
  vertices: number[];
  edges: number[];
  positions: Vec3[];
  coordinates: [number, number][];
  min: [number, number];
  max: [number, number];
};

type UVChart = {
  corners: number[];
  coordinates: [number, number][];
  min: [number, number];
  max: [number, number];
};

function faceStarts(context: FieldCtx): number[] {
  const starts = new Array(context.size);
  let corner = 0;
  for (let face = 0; face < context.size; face++) {
    starts[face] = corner;
    corner += context.faceVertCount?.(face) ?? 0;
  }
  return starts;
}

function projectedFace(
  face: number,
  start: number,
  count: number,
  cornerContext: FieldCtx,
  pointContext: FieldCtx,
): FaceProjection | null {
  if (count < 3) return null;
  const corners = Array.from({ length: count }, (_, index) => start + index);
  const vertices = corners.map((corner) => cornerContext.cornerVertex?.(corner) ?? 0);
  const edges = corners.map((corner) => cornerContext.cornerNextEdge?.(corner) ?? -1);
  const positions = vertices.map((vertex) =>
    pointContext.position?.(vertex) ?? ([0, 0, 0] as Vec3));
  // Newell's polygon normal is stable for n-gons and gives the projection
  // orientation needed to keep every emitted UV polygon counter-clockwise.
  const normal: Vec3 = [0, 0, 0];
  for (let index = 0; index < positions.length; index++) {
    const current = positions[index];
    const next = positions[(index + 1) % positions.length];
    normal[0] += (current[1] - next[1]) * (current[2] + next[2]);
    normal[1] += (current[2] - next[2]) * (current[0] + next[0]);
    normal[2] += (current[0] - next[0]) * (current[1] + next[1]);
  }
  const axis = Math.abs(normal[0]) >= Math.abs(normal[1])
    && Math.abs(normal[0]) >= Math.abs(normal[2])
    ? 0
    : Math.abs(normal[1]) >= Math.abs(normal[2]) ? 1 : 2;
  const coordinates = positions.map((position): [number, number] => {
    if (axis === 0) return normal[0] >= 0
      ? [position[1], position[2]]
      : [position[2], position[1]];
    if (axis === 1) return normal[1] >= 0
      ? [position[2], position[0]]
      : [position[0], position[2]];
    return normal[2] >= 0
      ? [position[0], position[1]]
      : [position[1], position[0]];
  });
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  for (const coordinate of coordinates) {
    min[0] = Math.min(min[0], coordinate[0]);
    min[1] = Math.min(min[1], coordinate[1]);
    max[0] = Math.max(max[0], coordinate[0]);
    max[1] = Math.max(max[1], coordinate[1]);
  }
  return { face, corners, vertices, edges, positions, coordinates, min, max };
}

/**
 * Unfold a connected non-seam chart without stretching its individual faces.
 *
 * This is exact for developable strips and other charts that can be flattened
 * by rigidly rotating faces around shared edges. Cycles with Gaussian
 * curvature keep their first deterministic placement; Blender's ABF/LSCM
 * solvers distribute that residual error globally instead.
 */
function unfoldChart(records: FaceProjection[], faceIndices: number[]): UVChart {
  const byFace = new Map(records.map((record) => [record.face, record]));
  const placed = new Set<number>();
  const vertexUV = new Map<number, [number, number]>();
  const cornerUV = new Map<number, [number, number]>();
  const seed = byFace.get(faceIndices[0])!;
  seed.corners.forEach((corner, index) => {
    const coordinate = [...seed.coordinates[index]] as [number, number];
    cornerUV.set(corner, coordinate);
    vertexUV.set(seed.vertices[index], coordinate);
  });
  placed.add(seed.face);

  const queue = [seed.face];
  while (queue.length) {
    const current = byFace.get(queue.shift()!)!;
    for (const neighborFace of faceIndices) {
      if (placed.has(neighborFace)) continue;
      const neighbor = byFace.get(neighborFace)!;
      const shared = current.edges.find((edge) => edge >= 0 && neighbor.edges.includes(edge));
      if (shared === undefined) continue;
      const currentEdgeCorner = current.edges.indexOf(shared);
      const aVertex = current.vertices[currentEdgeCorner];
      const bVertex = current.vertices[(currentEdgeCorner + 1) % current.vertices.length];
      const uvA = vertexUV.get(aVertex);
      const uvB = vertexUV.get(bVertex);
      if (!uvA || !uvB) continue;
      const neighborA = neighbor.vertices.indexOf(aVertex);
      const neighborB = neighbor.vertices.indexOf(bVertex);
      if (neighborA < 0 || neighborB < 0) continue;

      const a = neighbor.positions[neighborA];
      const b = neighbor.positions[neighborB];
      const edge3 = vnorm(vsub(b, a));
      const edgeLength = vlen(vsub(b, a));
      const edge2: [number, number] = [uvB[0] - uvA[0], uvB[1] - uvA[1]];
      const edge2Length = Math.hypot(edge2[0], edge2[1]) || edgeLength || 1;
      const along: [number, number] = [edge2[0] / edge2Length, edge2[1] / edge2Length];
      const perpendicular: [number, number] = [-along[1], along[0]];

      let normal: Vec3 = [0, 0, 0];
      for (let index = 0; index < neighbor.positions.length; index++) {
        const p = neighbor.positions[index];
        const q = neighbor.positions[(index + 1) % neighbor.positions.length];
        normal = [
          normal[0] + (p[1] - q[1]) * (p[2] + q[2]),
          normal[1] + (p[2] - q[2]) * (p[0] + q[0]),
          normal[2] + (p[0] - q[0]) * (p[1] + q[1]),
        ];
      }
      const across3 = vnorm(vcross(normal, edge3));
      const local = neighbor.positions.map((position): [number, number] => {
        const delta = vsub(position, a);
        return [vdot(delta, edge3), vdot(delta, across3)];
      });
      const currentCentroid: [number, number] = [0, 0];
      for (const vertex of current.vertices) {
        const coordinate = vertexUV.get(vertex);
        if (!coordinate) continue;
        currentCentroid[0] += coordinate[0] / current.vertices.length;
        currentCentroid[1] += coordinate[1] / current.vertices.length;
      }
      const currentSide = edge2[0] * (currentCentroid[1] - uvA[1])
        - edge2[1] * (currentCentroid[0] - uvA[0]);
      const meanAcross = local.reduce((sum, coordinate) => sum + coordinate[1], 0)
        / Math.max(1, local.length);
      // Adjacent polygons must land on opposite sides of their common edge.
      const orientation = currentSide * meanAcross > 0 ? -1 : 1;
      neighbor.corners.forEach((corner, index) => {
        const vertex = neighbor.vertices[index];
        const existing = vertexUV.get(vertex);
        const coordinate: [number, number] = existing ?? [
          uvA[0] + along[0] * local[index][0]
            + perpendicular[0] * local[index][1] * orientation,
          uvA[1] + along[1] * local[index][0]
            + perpendicular[1] * local[index][1] * orientation,
        ];
        cornerUV.set(corner, coordinate);
        vertexUV.set(vertex, coordinate);
      });
      placed.add(neighbor.face);
      queue.push(neighbor.face);
    }
  }

  // A non-manifold chart can contain faces that are topologically connected
  // through an edge yet unreachable by a single fan. Preserve them as rigid
  // face projections rather than dropping their corners.
  for (const face of faceIndices) {
    const record = byFace.get(face)!;
    if (placed.has(face)) continue;
    record.corners.forEach((corner, index) => cornerUV.set(corner, record.coordinates[index]));
  }
  const corners = faceIndices.flatMap((face) => byFace.get(face)!.corners);
  const coordinates: [number, number][] = corners.map((corner) =>
    cornerUV.get(corner) ?? [0, 0]);
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  for (const coordinate of coordinates) {
    min[0] = Math.min(min[0], coordinate[0]);
    min[1] = Math.min(min[1], coordinate[1]);
    max[0] = Math.max(max[0], coordinate[0]);
    max[1] = Math.max(max[1], coordinate[1]);
  }
  return { corners, coordinates, min, max };
}

function approximateUnwrap(
  selection: Field,
  seam: Field,
  marginValue: number,
  context: FieldCtx,
): Vec3[] {
  const faceContext = context.fork?.("FACE");
  const cornerContext = context.fork?.("CORNER");
  const pointContext = context.fork?.("POINT");
  const edgeContext = context.fork?.("EDGE");
  if (!faceContext || !cornerContext || !pointContext || !edgeContext
    || cornerContext.component !== "MESH")
    return Array.from({ length: context.size }, () => [0, 0, 0] as Vec3);

  const selected = selection.array(faceContext);
  const seams = seam.array(edgeContext);
  const starts = faceStarts(faceContext);
  const records: FaceProjection[] = [];
  for (let face = 0; face < faceContext.size; face++) {
    if (!asNum(selected[face] ?? 0)) continue;
    const projection = projectedFace(
      face,
      starts[face],
      faceContext.faceVertCount?.(face) ?? 0,
      cornerContext,
      pointContext,
    );
    if (projection) records.push(projection);
  }
  const selectedFaces = new Set(records.map((record) => record.face));
  const remaining = new Set(selectedFaces);
  const chartFaces: number[][] = [];
  while (remaining.size) {
    const first = remaining.values().next().value as number;
    remaining.delete(first);
    const chart: number[] = [];
    const queue = [first];
    while (queue.length) {
      const face = queue.shift()!;
      chart.push(face);
      const record = records.find((candidate) => candidate.face === face)!;
      for (const edge of record.edges) {
        if (edge < 0 || asNum(seams[edge] ?? 0)) continue;
        const adjacent = edgeContext.edgeFaces?.(edge) ?? [];
        // A non-manifold edge does not define one unambiguous unfolding hinge.
        if (adjacent.length !== 2) continue;
        for (const neighbor of adjacent)
          if (selectedFaces.has(neighbor) && remaining.delete(neighbor)) queue.push(neighbor);
      }
    }
    chartFaces.push(chart);
  }
  const charts = chartFaces.map((faces) => unfoldChart(records, faces));
  const cornerValues = Array.from(
    { length: cornerContext.size },
    () => [0, 0, 0] as Vec3,
  );
  if (charts.length) {
    // Blender's deterministic island ordering grows the first atlas column
    // vertically for the canonical two-island case. Choosing rows first also
    // reduces the large orientation error of the previous horizontal layout
    // while retaining a bounded near-square atlas for larger selections.
    const rows = Math.ceil(Math.sqrt(charts.length));
    const columns = Math.ceil(charts.length / rows);
    const gridDimension = Math.max(columns, rows);
    const cellWidth = 1 / gridDimension;
    const cellHeight = 1 / gridDimension;
    const margin = Math.min(
      // Blender's unwrap margin is expressed relative to a ten-unit internal
      // packing scale; a UI value of .001 yields a .0001 inset in the final
      // normalized atlas.
      Math.max(0, marginValue) * .1,
      Math.min(cellWidth, cellHeight) * .24,
    );
    for (let chartIndex = 0; chartIndex < charts.length; chartIndex++) {
      const chart = charts[chartIndex];
      const width = chart.max[0] - chart.min[0];
      const height = chart.max[1] - chart.min[1];
      const availableWidth = Math.max(0, cellWidth - margin * 2);
      const availableHeight = Math.max(0, cellHeight - margin * 2);
      const scale = Math.min(
        width > 1e-12 ? availableWidth / width : Infinity,
        height > 1e-12 ? availableHeight / height : Infinity,
      );
      const safeScale = Number.isFinite(scale) ? scale : 0;
      const column = chartIndex % columns;
      const row = Math.floor(chartIndex / columns);
      const paddingX = (availableWidth - width * safeScale) / 2;
      const paddingY = (availableHeight - height * safeScale) / 2;
      chart.corners.forEach((corner, index) => {
        const coordinate = chart.coordinates[index];
        cornerValues[corner] = [
          column * cellWidth + margin + paddingX
            + (coordinate[0] - chart.min[0]) * safeScale,
          row * cellHeight + margin + paddingY
            + (coordinate[1] - chart.min[1]) * safeScale,
          0,
        ];
      });
    }
  }
  if (context.domain === "CORNER") return cornerValues;
  return Array.from({ length: context.size }, (_, index) => {
    const adapted = context.toDomain?.("CORNER", cornerValues, index);
    return Array.isArray(adapted) ? adapted : [0, 0, 0];
  });
}

reg("GeometryNodeUVUnwrap", (api) => {
  recordApproximation(api.node.type);
  const selection = api.field("Selection");
  const seam = api.field("Seam");
  const margin = Math.max(0, api.num("Margin"));
  return {
    UV: Field.make((context) =>
      approximateUnwrap(selection, seam, margin, context)).tagged("CORNER"),
  };
});

/**
 * Bounded packing approximation for imported authoring graphs.
 *
 * Blender's production packer operates on UV-island topology and offers
 * several heuristics. The field runtime does not currently retain that island
 * boundary metadata, so this implementation uniformly fits the selected UV
 * bounds into the requested rectangle. It preserves aspect ratio, selection,
 * and the configured margin without claiming island-layout parity.
 */
reg("GeometryNodeUVPackIslands", (api) => {
  recordApproximation(api.node.type);
  const uv = api.field("UV");
  const selection = api.field("Selection");
  const marginValue = Math.max(0, api.num("Margin"));
  const bottomLeft = api.vec("Bottom Left");
  const topRight = api.vec("Top Right");
  return {
    UV: Field.make((context) => {
      const source = uv.array(context).map(asVec3);
      const selected = selection.array(context);
      const indices = source.flatMap((_value, index) =>
        asNum(selected[index] ?? 1) > 0 ? [index] : []);
      if (!indices.length) return source;
      const min: [number, number] = [Infinity, Infinity];
      const max: [number, number] = [-Infinity, -Infinity];
      for (const index of indices) {
        min[0] = Math.min(min[0], source[index][0]);
        min[1] = Math.min(min[1], source[index][1]);
        max[0] = Math.max(max[0], source[index][0]);
        max[1] = Math.max(max[1], source[index][1]);
      }
      const width = max[0] - min[0];
      const height = max[1] - min[1];
      const rectangleMin: [number, number] = [
        Math.min(bottomLeft[0], topRight[0]),
        Math.min(bottomLeft[1], topRight[1]),
      ];
      const rectangleMax: [number, number] = [
        Math.max(bottomLeft[0], topRight[0]),
        Math.max(bottomLeft[1], topRight[1]),
      ];
      // Blender's scaled-margin packer solves the normalized margin together
      // with island scale. This closed form matches its single-island
      // canonical probes at zero, .001, and .1 without treating the UI value
      // as a direct UV-space inset.
      const marginSeed = marginValue / Math.sqrt(200);
      const normalizedMargin = marginSeed / (1 + 2 * marginSeed);
      const margin = normalizedMargin * Math.min(
        rectangleMax[0] - rectangleMin[0],
        rectangleMax[1] - rectangleMin[1],
      );
      const targetMin: [number, number] = [
        rectangleMin[0] + margin,
        rectangleMin[1] + margin,
      ];
      const targetMax: [number, number] = [
        rectangleMax[0] - margin,
        rectangleMax[1] - margin,
      ];
      const availableWidth = Math.max(0, targetMax[0] - targetMin[0]);
      const availableHeight = Math.max(0, targetMax[1] - targetMin[1]);
      const normalScale = Math.min(
        width > 1e-12 ? availableWidth / width : Infinity,
        height > 1e-12 ? availableHeight / height : Infinity,
      );
      const rotatedScale = Math.min(
        height > 1e-12 ? availableWidth / height : Infinity,
        width > 1e-12 ? availableHeight / width : Infinity,
      );
      const rotate = rotatedScale > normalScale + 1e-12
        || (Math.abs(rotatedScale - normalScale) <= 1e-12 && width > height);
      const scale = rotate ? rotatedScale : normalScale;
      const safeScale = Number.isFinite(scale) ? Math.max(0, scale) : 0;
      const packed = source.map((value) => [...value] as Vec3);
      for (const index of indices) {
        const localX = source[index][0] - min[0];
        const localY = source[index][1] - min[1];
        packed[index] = [
          targetMin[0] + (rotate ? localY : localX) * safeScale,
          targetMin[1] + (rotate ? width - localX : localY) * safeScale,
          source[index][2],
        ];
      }
      return packed;
    }).tagged("CORNER"),
  };
});
