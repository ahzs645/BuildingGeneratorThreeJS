// Mesh-topology input nodes: per-element queries resolved against the consuming
// geometry's domain. These drive the bin's recursive subdivision (quad detection),
// wall thickening (edge neighbors), and bin selection (islands).
import { Field } from "../core";
import { reg } from "../registry";

// Face Neighbors: Vertex Count = verts in the face; Face Count = adjacent faces.
// The subdivision uses Vertex Count==4 to find quad faces to split.
reg("GeometryNodeInputMeshFaceNeighbors", () => ({
  "Vertex Count": Field.perElem((i, ctx) => (ctx.faceVertCount ? ctx.faceVertCount(i) : 0)),
  "Face Count": Field.perElem((i, ctx) => (ctx.faceNeighborCount ? ctx.faceNeighborCount(i) : 0)),
}));

// Edge Neighbors: how many faces use this edge (2 = interior, 1 = boundary).
reg("GeometryNodeInputMeshEdgeNeighbors", () => ({
  "Face Count": Field.perElem((i, ctx) => (ctx.edgeFaceCount ? ctx.edgeFaceCount(i) : 0)),
}));

// Edge Vertices: endpoint indices + positions of each edge.
reg("GeometryNodeInputMeshEdgeVertices", () => ({
  "Vertex Index 1": Field.perElem((i, ctx) => (ctx.edgeVerts ? ctx.edgeVerts(i)[0] : 0)),
  "Vertex Index 2": Field.perElem((i, ctx) => (ctx.edgeVerts ? ctx.edgeVerts(i)[1] : 0)),
  "Position 1": Field.perElem((i, ctx) => (ctx.edgeVerts && ctx.position ? ctx.position(ctx.edgeVerts(i)[0]) : [0, 0, 0])),
  "Position 2": Field.perElem((i, ctx) => (ctx.edgeVerts && ctx.position ? ctx.position(ctx.edgeVerts(i)[1]) : [0, 0, 0])),
}));

// Mesh Island: connected-component id + total count. Drives "choose bin".
reg("GeometryNodeInputMeshIsland", () => ({
  "Island Index": Field.perElem((i, ctx) => (ctx.islandIndex ? ctx.islandIndex(i) : 0)),
  "Island Count": Field.perElem((_i, ctx) => (ctx.islandCount ? ctx.islandCount() : 0)),
}));
