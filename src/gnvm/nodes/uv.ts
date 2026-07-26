import {
  Field,
  asNum,
  asVec3,
  vcross,
  vdot,
  vlen,
  vnorm,
  vsub,
  type Elem,
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
  intrinsic: [number, number][];
  min: [number, number];
  max: [number, number];
};

type UVChart = {
  corners: number[];
  coordinates: [number, number][];
  min: [number, number];
  max: [number, number];
};

type UnwrapMethod = "ANGLE_BASED" | "CONFORMAL";

function unwrapMethod(value: string): UnwrapMethod {
  const normalized = value.trim().replaceAll(" ", "_").toUpperCase();
  return normalized === "CONFORMAL" ? "CONFORMAL" : "ANGLE_BASED";
}

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
  const origin = positions[0];
  const firstEdge = positions
    .slice(1)
    .map((position) => vsub(position, origin))
    .find((edge) => vlen(edge) > 1e-12) ?? ([1, 0, 0] as Vec3);
  const intrinsicX = vnorm(firstEdge);
  const intrinsicY = vnorm(vcross(vnorm(normal), intrinsicX));
  const intrinsic = vlen(intrinsicY) > 1e-12
    ? positions.map((position): [number, number] => {
      const delta = vsub(position, origin);
      return [vdot(delta, intrinsicX), vdot(delta, intrinsicY)];
    })
    : coordinates.map((coordinate) => [...coordinate] as [number, number]);
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  for (const coordinate of coordinates) {
    min[0] = Math.min(min[0], coordinate[0]);
    min[1] = Math.min(min[1], coordinate[1]);
    max[0] = Math.max(max[0], coordinate[0]);
    max[1] = Math.max(max[1], coordinate[1]);
  }
  return {
    face,
    corners,
    vertices,
    edges,
    positions,
    coordinates,
    intrinsic,
    min,
    max,
  };
}

/**
 * Unfold a connected non-seam chart without stretching its individual faces.
 *
 * This is exact for developable strips and other charts that can be flattened
 * by rigidly rotating faces around shared edges. For curved cycles, a bounded
 * face-projection relaxation distributes closure error across the island.
 * ANGLE_BASED keeps each face at its intrinsic scale while CONFORMAL allows a
 * per-face similarity scale. This mirrors the useful distinction between the
 * imported modes without claiming Blender's production ABF/LSCM solver.
 */
function unfoldChart(
  records: FaceProjection[],
  faceIndices: number[],
  connectedEdges: Set<number>,
  method: UnwrapMethod,
): UVChart {
  const byFace = new Map(records.map((record) => [record.face, record]));
  const chartRecords = faceIndices.map((face) => byFace.get(face)!);

  // A seam splits UV vertices, not merely face adjacency. Build corner
  // equivalence only through selected, non-seam manifold edges. This matters
  // for cyclic islands where opposite sides of a cut can remain in the same
  // face-connected chart but must still have independent boundary UVs.
  const parent = new Map<number, number>();
  const find = (corner: number): number => {
    const previous = parent.get(corner) ?? corner;
    if (previous === corner) return corner;
    const root = find(previous);
    parent.set(corner, root);
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(Math.max(rootA, rootB), Math.min(rootA, rootB));
  };
  for (const record of chartRecords)
    for (const corner of record.corners) parent.set(corner, corner);
  const edgeUses = new Map<number, Array<{ record: FaceProjection; index: number }>>();
  for (const record of chartRecords) {
    record.edges.forEach((edge, index) => {
      if (!connectedEdges.has(edge)) return;
      const uses = edgeUses.get(edge) ?? [];
      uses.push({ record, index });
      edgeUses.set(edge, uses);
    });
  }
  for (const uses of edgeUses.values()) {
    if (uses.length !== 2) continue;
    const [first, second] = uses;
    for (const endpoint of [
      first.record.vertices[first.index],
      first.record.vertices[(first.index + 1) % first.record.vertices.length],
    ]) {
      const firstIndex = first.record.vertices.indexOf(endpoint);
      const secondIndex = second.record.vertices.indexOf(endpoint);
      if (firstIndex >= 0 && secondIndex >= 0)
        union(first.record.corners[firstIndex], second.record.corners[secondIndex]);
    }
  }
  const localVertex = new Map<number, number>();
  for (const record of chartRecords)
    for (const corner of record.corners) localVertex.set(corner, find(corner));

  const placed = new Set<number>();
  const localUV = new Map<number, [number, number]>();
  const seed = byFace.get(faceIndices[0])!;
  seed.corners.forEach((corner, index) => {
    const coordinate = [...seed.coordinates[index]] as [number, number];
    localUV.set(localVertex.get(corner)!, coordinate);
  });
  placed.add(seed.face);

  const queue = [seed.face];
  while (queue.length) {
    const current = byFace.get(queue.shift()!)!;
    for (const neighborFace of faceIndices) {
      if (placed.has(neighborFace)) continue;
      const neighbor = byFace.get(neighborFace)!;
      const shared = current.edges.find((edge) =>
        edge >= 0 && connectedEdges.has(edge) && neighbor.edges.includes(edge));
      if (shared === undefined) continue;
      const currentEdgeCorner = current.edges.indexOf(shared);
      const aVertex = current.vertices[currentEdgeCorner];
      const bVertex = current.vertices[(currentEdgeCorner + 1) % current.vertices.length];
      const currentA = current.vertices.indexOf(aVertex);
      const currentB = current.vertices.indexOf(bVertex);
      const neighborA = neighbor.vertices.indexOf(aVertex);
      const neighborB = neighbor.vertices.indexOf(bVertex);
      if (currentA < 0 || currentB < 0 || neighborA < 0 || neighborB < 0) continue;
      const uvA = localUV.get(localVertex.get(current.corners[currentA])!);
      const uvB = localUV.get(localVertex.get(current.corners[currentB])!);
      if (!uvA || !uvB) continue;

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
      for (const corner of current.corners) {
        const coordinate = localUV.get(localVertex.get(corner)!);
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
        const vertex = localVertex.get(corner)!;
        const existing = localUV.get(vertex);
        const coordinate: [number, number] = existing ?? [
          uvA[0] + along[0] * local[index][0]
            + perpendicular[0] * local[index][1] * orientation,
          uvA[1] + along[1] * local[index][0]
            + perpendicular[1] * local[index][1] * orientation,
        ];
        localUV.set(vertex, coordinate);
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
    record.corners.forEach((corner, index) =>
      localUV.set(localVertex.get(corner)!, record.coordinates[index]));
  }

  const faceFit = (
    record: FaceProjection,
    allowScale: boolean,
  ): { predicted: [number, number][]; error: number } => {
    const target = record.corners.map((corner) =>
      localUV.get(localVertex.get(corner)!) ?? [0, 0]);
    const sourceCenter: [number, number] = [0, 0];
    const targetCenter: [number, number] = [0, 0];
    for (let index = 0; index < record.corners.length; index++) {
      sourceCenter[0] += record.intrinsic[index][0] / record.corners.length;
      sourceCenter[1] += record.intrinsic[index][1] / record.corners.length;
      targetCenter[0] += target[index][0] / record.corners.length;
      targetCenter[1] += target[index][1] / record.corners.length;
    }
    let dot = 0;
    let cross = 0;
    let sourceNorm = 0;
    let targetNorm = 0;
    for (let index = 0; index < record.corners.length; index++) {
      const px = record.intrinsic[index][0] - sourceCenter[0];
      const py = record.intrinsic[index][1] - sourceCenter[1];
      const qx = target[index][0] - targetCenter[0];
      const qy = target[index][1] - targetCenter[1];
      dot += px * qx + py * qy;
      cross += px * qy - py * qx;
      sourceNorm += px * px + py * py;
      targetNorm += qx * qx + qy * qy;
    }
    const rotationNorm = Math.hypot(dot, cross);
    const cosine = rotationNorm > 1e-12 ? dot / rotationNorm : 1;
    const sine = rotationNorm > 1e-12 ? cross / rotationNorm : 0;
    const scale = allowScale && sourceNorm > 1e-12
      ? Math.sqrt(Math.max(1e-12, targetNorm) / sourceNorm)
      : 1;
    let error = 0;
    const predicted = record.intrinsic.map((coordinate, index): [number, number] => {
      const px = coordinate[0] - sourceCenter[0];
      const py = coordinate[1] - sourceCenter[1];
      const value: [number, number] = [
        targetCenter[0] + scale * (cosine * px - sine * py),
        targetCenter[1] + scale * (sine * px + cosine * py),
      ];
      error = Math.max(error, Math.hypot(
        value[0] - target[index][0],
        value[1] - target[index][1],
      ));
      return value;
    });
    return { predicted, error };
  };

  // Rigid unfolding already gives exact developable charts and should remain
  // untouched. Only relax when closing a curved cycle introduced measurable
  // inconsistency between a face's intrinsic shape and its shared UV vertices.
  const initialResidual = Math.max(
    0,
    ...chartRecords.map((record) => faceFit(record, false).error),
  );
  if (initialResidual > 1e-8 && chartRecords.length > 1) {
    const anchorCorners = seed.edges.reduce(
      (best, _edge, index) => {
        const next = (index + 1) % seed.corners.length;
        const length = vlen(vsub(seed.positions[next], seed.positions[index]));
        return length > best.length ? { index, next, length } : best;
      },
      { index: 0, next: 1, length: -Infinity },
    );
    const anchorA = localVertex.get(seed.corners[anchorCorners.index])!;
    const anchorB = localVertex.get(seed.corners[anchorCorners.next])!;
    const fixedA = [...localUV.get(anchorA)!] as [number, number];
    const fixedB = [...localUV.get(anchorB)!] as [number, number];
    const iterations = method === "CONFORMAL" ? 64 : 48;
    for (let iteration = 0; iteration < iterations; iteration++) {
      const sums = new Map<number, [number, number, number]>();
      for (const record of chartRecords) {
        const fit = faceFit(record, method === "CONFORMAL");
        record.corners.forEach((corner, index) => {
          const vertex = localVertex.get(corner)!;
          const sum = sums.get(vertex) ?? [0, 0, 0];
          sum[0] += fit.predicted[index][0];
          sum[1] += fit.predicted[index][1];
          sum[2]++;
          sums.set(vertex, sum);
        });
      }
      for (const [vertex, sum] of sums) {
        if (vertex === anchorA || vertex === anchorB || !sum[2]) continue;
        const previous = localUV.get(vertex) ?? [0, 0];
        // Under-relaxation prevents alternating face projections on symmetric
        // cyclic charts while remaining deterministic across JS engines.
        localUV.set(vertex, [
          previous[0] * .25 + (sum[0] / sum[2]) * .75,
          previous[1] * .25 + (sum[1] / sum[2]) * .75,
        ]);
      }
      localUV.set(anchorA, fixedA);
      localUV.set(anchorB, fixedB);
    }
  }

  const corners = faceIndices.flatMap((face) => byFace.get(face)!.corners);
  const coordinates: [number, number][] = corners.map((corner) =>
    localUV.get(localVertex.get(corner)!) ?? [0, 0]);
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
  method: UnwrapMethod,
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
  const connectedEdges = new Set<number>();
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
        if (adjacent.every((neighbor) => selectedFaces.has(neighbor)))
          connectedEdges.add(edge);
        for (const neighbor of adjacent)
          if (selectedFaces.has(neighbor) && remaining.delete(neighbor)) queue.push(neighbor);
      }
    }
    chartFaces.push(chart);
  }
  const charts = chartFaces.map((faces) =>
    unfoldChart(records, faces, connectedEdges, method));
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
  const method = unwrapMethod(api.str("Method"));
  return {
    UV: Field.make((context) =>
      approximateUnwrap(selection, seam, margin, method, context)).tagged("CORNER"),
  };
});

function uvIslands(
  context: FieldCtx,
  source: Vec3[],
  selected: Elem[],
): number[][] {
  if (context.domain !== "CORNER" || context.component !== "MESH")
    return [source.flatMap((_value, index) =>
      asNum(selected[index] ?? 1) > 0 ? [index] : [])].filter((island) => island.length);
  const faceContext = context.fork?.("FACE");
  const edgeContext = context.fork?.("EDGE");
  if (!faceContext || !edgeContext)
    return [source.flatMap((_value, index) =>
      asNum(selected[index] ?? 1) > 0 ? [index] : [])].filter((island) => island.length);
  const parent = new Int32Array(source.length);
  for (let index = 0; index < parent.length; index++) parent[index] = index;
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const a = find(left), b = find(right);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  };
  const starts = faceStarts(faceContext);
  const cornerFace = new Int32Array(source.length).fill(-1);
  const edgeUses = new Map<number, number[]>();
  for (let face = 0; face < faceContext.size; face++) {
    const start = starts[face];
    const count = faceContext.faceVertCount?.(face) ?? 0;
    const faceCorners = Array.from({ length: count }, (_, offset) => start + offset)
      .filter((corner) => asNum(selected[corner] ?? 1) > 0);
    for (const corner of faceCorners) {
      cornerFace[corner] = face;
      const edge = context.cornerNextEdge?.(corner) ?? -1;
      if (edge >= 0) edgeUses.set(edge, [...(edgeUses.get(edge) ?? []), corner]);
    }
    for (let index = 1; index < faceCorners.length; index++)
      union(faceCorners[0], faceCorners[index]);
  }
  const sameUv = (left: number, right: number): boolean =>
    Math.abs(source[left][0] - source[right][0]) <= 1e-6
    && Math.abs(source[left][1] - source[right][1]) <= 1e-6;
  for (const [edge, uses] of edgeUses) {
    if ((edgeContext.edgeFaces?.(edge) ?? []).length !== 2 || uses.length !== 2) continue;
    const [left, right] = uses;
    const leftFace = cornerFace[left], rightFace = cornerFace[right];
    const leftStart = starts[leftFace], rightStart = starts[rightFace];
    const leftCount = faceContext.faceVertCount?.(leftFace) ?? 0;
    const rightCount = faceContext.faceVertCount?.(rightFace) ?? 0;
    for (const vertex of [
      context.cornerVertex?.(left) ?? -1,
      context.cornerVertex?.(leftStart + ((left - leftStart + 1) % leftCount)) ?? -1,
    ]) {
      const leftCorner = Array.from({ length: leftCount }, (_, offset) => leftStart + offset)
        .find((corner) => context.cornerVertex?.(corner) === vertex);
      const rightCorner = Array.from({ length: rightCount }, (_, offset) => rightStart + offset)
        .find((corner) => context.cornerVertex?.(corner) === vertex);
      if (
        leftCorner !== undefined
        && rightCorner !== undefined
        && asNum(selected[leftCorner] ?? 1) > 0
        && asNum(selected[rightCorner] ?? 1) > 0
        && sameUv(leftCorner, rightCorner)
      ) union(leftCorner, rightCorner);
    }
  }
  const islands = new Map<number, number[]>();
  for (let index = 0; index < source.length; index++) {
    if (asNum(selected[index] ?? 1) <= 0) continue;
    const root = find(index);
    islands.set(root, [...(islands.get(root) ?? []), index]);
  }
  return [...islands.values()].sort((left, right) =>
    Math.min(...left) - Math.min(...right));
}

/**
 * Bounded packing approximation for imported authoring graphs.
 *
 * Blender's production packer offers additional shape and placement
 * heuristics. The field runtime reconstructs islands from mesh topology and
 * UV continuity, then deterministically packs each island independently. It
 * preserves aspect ratio, selection, and the configured margin without
 * claiming Blender's exact production layout heuristic.
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
      const islands = uvIslands(context, source, selected);
      if (!islands.length) return source;
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
      const packed = source.map((value) => [...value] as Vec3);
      const rows = Math.ceil(Math.sqrt(islands.length));
      const columns = Math.ceil(islands.length / rows);
      const cellWidth = Math.max(0, targetMax[0] - targetMin[0]) / columns;
      const cellHeight = Math.max(0, targetMax[1] - targetMin[1]) / rows;
      for (let islandIndex = 0; islandIndex < islands.length; islandIndex++) {
        const indices = islands[islandIndex];
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
        const normalScale = Math.min(
          width > 1e-12 ? cellWidth / width : Infinity,
          height > 1e-12 ? cellHeight / height : Infinity,
        );
        const rotatedScale = Math.min(
          height > 1e-12 ? cellWidth / height : Infinity,
          width > 1e-12 ? cellHeight / width : Infinity,
        );
        const rotate = rotatedScale > normalScale + 1e-12
          || (Math.abs(rotatedScale - normalScale) <= 1e-12 && width > height);
        const safeScale = Number.isFinite(rotate ? rotatedScale : normalScale)
          ? Math.max(0, rotate ? rotatedScale : normalScale)
          : 0;
        const column = islandIndex % columns;
        const row = Math.floor(islandIndex / columns);
        const packedWidth = (rotate ? height : width) * safeScale;
        const packedHeight = (rotate ? width : height) * safeScale;
        const centerInCell = islands.length > 1;
        const originX = targetMin[0] + column * cellWidth
          + (centerInCell ? (cellWidth - packedWidth) / 2 : 0);
        const originY = targetMin[1] + row * cellHeight
          + (centerInCell ? (cellHeight - packedHeight) / 2 : 0);
        for (const index of indices) {
          const localX = source[index][0] - min[0];
          const localY = source[index][1] - min[1];
          packed[index] = [
            originX + (rotate ? localY : localX) * safeScale,
            originY + (rotate ? width - localX : localY) * safeScale,
            source[index][2],
          ];
        }
      }
      return packed;
    }).tagged("CORNER"),
  };
});
