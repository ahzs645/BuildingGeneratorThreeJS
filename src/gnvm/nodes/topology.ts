// Mesh-topology input nodes: per-element queries resolved against the consuming
// geometry's domain. These drive the bin's recursive subdivision (quad detection),
// wall thickening (edge neighbors), and bin selection (islands).
import { Field, Vec3, asNum } from "../core";
import { reg } from "../registry";
import { FIELD_PROBE } from "../evaluator";

// Face Neighbors: Vertex Count = verts in the face; Face Count = adjacent faces.
// The subdivision uses Vertex Count==4 to find quad faces to split.
reg("GeometryNodeInputMeshFaceNeighbors", () => ({
  "Vertex Count": Field.perElem((i, ctx) => (ctx.faceVertCount ? ctx.faceVertCount(i) : 0)).tagged("FACE"),
  "Face Count": Field.perElem((i, ctx) => (ctx.faceNeighborCount ? ctx.faceNeighborCount(i) : 0)).tagged("FACE"),
}));

// Edge Neighbors: how many faces use this edge (2 = interior, 1 = boundary).
reg("GeometryNodeInputMeshEdgeNeighbors", () => ({
  "Face Count": Field.perElem((i, ctx) => (ctx.edgeFaceCount ? ctx.edgeFaceCount(i) : 0)).tagged("EDGE"),
}));

reg("GeometryNodeInputMeshEdgeAngle", (api) => {
  const angle = (signed: boolean, socket: string) => Field.make((ctx) => {
    const values = Array.from({ length: ctx.size }, (_, i) => ctx.edgeAngle?.(i, signed) ?? 0);
    if (FIELD_PROBE.node === api.node.name && (FIELD_PROBE.socket === socket || (!signed && FIELD_PROBE.socket === "Angle"))) {
      FIELD_PROBE.batches.push({ domain: ctx.domain, positions: Array.from({ length: ctx.size }, (_, i) => ctx.position?.(i) ?? [0, 0, 0]), values });
    }
    return values;
  }).tagged("EDGE");
  return { "Unsigned Angle": angle(false, "Unsigned Angle"), "Signed Angle": angle(true, "Signed Angle") };
});

// Edge Vertices: endpoint indices + positions of each edge. Endpoint indices
// address the POINT domain; using EDGE-context position() interprets them as
// edge indices and returns unrelated edge midpoints.
reg("GeometryNodeInputMeshEdgeVertices", () => {
  const endpointPosition = (endpoint: 0 | 1) => Field.make((ctx) => {
    const pointCtx = ctx.fork?.("POINT");
    const values: Vec3[] = new Array(ctx.size);
    for (let i = 0; i < ctx.size; i++) {
      const vertex = ctx.edgeVerts?.(i)?.[endpoint];
      values[i] = vertex === undefined ? [0, 0, 0] : pointCtx?.position?.(vertex) ?? [0, 0, 0];
    }
    return values;
  }).tagged("EDGE");
  return {
    "Vertex Index 1": Field.perElem((i, ctx) => (ctx.edgeVerts ? ctx.edgeVerts(i)[0] : 0)).tagged("EDGE"),
    "Vertex Index 2": Field.perElem((i, ctx) => (ctx.edgeVerts ? ctx.edgeVerts(i)[1] : 0)).tagged("EDGE"),
    "Position 1": endpointPosition(0),
    "Position 2": endpointPosition(1),
  };
});

// Mesh Island: connected-component id + total count. Drives "choose bin".
reg("GeometryNodeInputMeshIsland", () => ({
  "Island Index": Field.perElem((i, ctx) => (ctx.islandIndex ? ctx.islandIndex(i) : 0)),
  "Island Count": Field.perElem((_i, ctx) => (ctx.islandCount ? ctx.islandCount() : 0)),
}));

// Corners of Face: corner domain index of a face's corner (after optional weight sort).
// Unlinked Face Index uses the evaluation-context index (Blender implicit Index field).
reg("GeometryNodeCornersOfFace", (api) => {
  const faceIdxLinked = !!api.node.inputs.find((s) => (s.identifier === "Face Index" || s.name === "Face Index") && s.linked);
  const faceIdxF = api.field("Face Index");
  const sortIdxF = api.field("Sort Index");
  // Weights ignored when constant — corner order is the face's winding order.
  const cornerOf = (ctx: import("../core").FieldCtx, faceIndex: number, sortIndex: number) => {
    if (!ctx.faceVertCount) return { corner: 0, total: 0 };
    // Build faceStart lazily from faceVertCount
    let start = 0;
    const nFaces = ctx.fork ? ctx.fork("FACE").size : ctx.domain === "FACE" ? ctx.size : 0;
    const fi = Math.max(0, Math.min(Math.max(0, nFaces - 1), Math.round(faceIndex)));
    for (let f = 0; f < fi; f++) start += ctx.faceVertCount(f);
    const total = ctx.faceVertCount(fi) || 0;
    if (total <= 0) return { corner: start, total: 0 };
    let si = Math.round(sortIndex) % total;
    if (si < 0) si += total;
    return { corner: start + si, total };
  };
  return {
    "Corner Index": Field.make((ctx) => {
      const fArr = faceIdxF.array(ctx);
      const sArr = sortIdxF.array(ctx);
      const out: number[] = new Array(ctx.size);
      for (let i = 0; i < ctx.size; i++) {
        // Unlinked Face Index → use context element index (FACE domain).
        const fi = faceIdxLinked ? asNum(fArr[i] ?? 0) : i;
        out[i] = cornerOf(ctx, fi, asNum(sArr[i] ?? 0)).corner;
      }
      return out;
    }),
    Total: Field.make((ctx) => {
      const fArr = faceIdxF.array(ctx);
      const out: number[] = new Array(ctx.size);
      for (let i = 0; i < ctx.size; i++) {
        const fi = faceIdxLinked ? asNum(fArr[i] ?? 0) : i;
        out[i] = cornerOf(ctx, fi, 0).total;
      }
      return out;
    }),
  };
});
