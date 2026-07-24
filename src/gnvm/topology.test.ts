import assert from "node:assert/strict";
import test from "node:test";
import { Field, Vec3 } from "./core";
import { makeFieldCtx } from "./evaluator";
import { Geometry, Mesh } from "./geometry";
import { meshEdgesToChains } from "./curves";
import "./nodes/topology";
import { REGISTRY, type EvalAPI } from "./registry";

function topologyApi(
  type: string,
  fields: Record<string, Field>,
  linked: string[] = [],
): EvalAPI {
  return {
    node: {
      name: type,
      type,
      label: null,
      inputs: Object.keys(fields).map((name) => ({
        name,
        identifier: name,
        type: "NodeSocketInt",
        linked: linked.includes(name),
      })),
      outputs: [],
    },
    input: (name) => fields[name],
    inputs: () => [],
    geoInputs: () => [],
    geo: () => new Geometry(),
    field: (name) => fields[name] ?? Field.of(0),
    num: () => 0,
    vec: () => [0, 0, 0],
    bool: () => false,
    str: () => "",
    ref: () => null,
    prop: (_name, fallback) => fallback as never,
    resolve: () => [],
  };
}

function adjacentQuads(): Geometry {
  const geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [
    [0, 0, 0], [1, 0, 0], [2, 0, 0],
    [0, 1, 0], [1, 1, 0], [2, 1, 0],
  ];
  geometry.mesh.faces = [[0, 1, 4, 3], [1, 2, 5, 4]];
  return geometry;
}

test("Edge Vertices positions resolve endpoint indices on the point domain", () => {
  const geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [[10, 0, 0], [12, 1, 0], [15, 4, 0], [20, 9, 0]];
  geometry.mesh.faces = [[0, 2, 3], [0, 3, 1]];

  const handler = REGISTRY.get("GeometryNodeInputMeshEdgeVertices");
  assert.ok(handler);
  const outputs = handler({} as never);
  const context = makeFieldCtx(geometry, "EDGE");
  const positions1 = (outputs["Position 1"] as Field).array(context) as Vec3[];
  const positions2 = (outputs["Position 2"] as Field).array(context) as Vec3[];

  const endpoints = Array.from({ length: context.size }, (_, edge) => context.edgeVerts?.(edge) ?? [0, 0]);
  assert.deepEqual(positions1, endpoints.map(([vertex]) => geometry.mesh!.positions[vertex]));
  assert.deepEqual(positions2, endpoints.map(([, vertex]) => geometry.mesh!.positions[vertex]));
});

test("corner topology nodes share Blender's periodic face and adjacent-edge indexing", () => {
  const geometry = adjacentQuads();
  const cornerContext = makeFieldCtx(geometry, "CORNER");

  const offset = REGISTRY.get("GeometryNodeOffsetCornerInFace");
  const edges = REGISTRY.get("GeometryNodeEdgesOfCorner");
  assert.ok(offset && edges);

  const offsetOutput = offset(topologyApi("GeometryNodeOffsetCornerInFace", {
    "Corner Index": Field.perElem((index) => index),
    Offset: Field.perElem((index) => index % 2 ? 1 : -1),
  }, ["Corner Index"]))["Corner Index"] as Field;
  assert.deepEqual(offsetOutput.array(cornerContext), [3, 2, 1, 0, 7, 6, 5, 4]);

  const edgeOutputs = edges(topologyApi("GeometryNodeEdgesOfCorner", {
    "Corner Index": Field.perElem((index) => index),
  }, ["Corner Index"]));
  assert.deepEqual((edgeOutputs["Next Edge Index"] as Field).array(cornerContext), [0, 1, 2, 3, 4, 5, 6, 1]);
  assert.deepEqual((edgeOutputs["Previous Edge Index"] as Field).array(cornerContext), [3, 0, 1, 2, 1, 4, 5, 6]);
});

test("Offset Corner caches face starts instead of rescanning preceding faces", () => {
  const faceCount = 128;
  let faceSizeQueries = 0;
  const faceContext = {
    size: faceCount,
    domain: "FACE",
    component: "MESH",
    faceVertCount: () => {
      faceSizeQueries++;
      return 1;
    },
  } as const;
  const cornerContext = {
    size: faceCount,
    domain: "CORNER",
    component: "MESH",
    cornerFace: (corner: number) => corner,
    fork: (domain: string) => domain === "FACE" ? faceContext : cornerContext,
  };
  const handler = REGISTRY.get("GeometryNodeOffsetCornerInFace");
  assert.ok(handler);
  const output = handler(topologyApi("GeometryNodeOffsetCornerInFace", {
    "Corner Index": Field.perElem((index) => index),
    Offset: Field.of(0),
  }, ["Corner Index"]))["Corner Index"] as Field;

  assert.deepEqual(
    output.array(cornerContext as never),
    Array.from({ length: faceCount }, (_, index) => index),
  );
  assert.equal(faceSizeQueries, faceCount);
});

test("Corners of Vertex stably sorts attached corners by ascending weight", () => {
  const geometry = adjacentQuads();
  const pointContext = makeFieldCtx(geometry, "POINT");
  const handler = REGISTRY.get("GeometryNodeCornersOfVertex");
  assert.ok(handler);
  const outputs = handler(topologyApi("GeometryNodeCornersOfVertex", {
    "Vertex Index": Field.of(1),
    Weights: Field.perElem((corner) => corner === 1 ? 9 : corner === 4 ? 2 : 0),
    "Sort Index": Field.perElem((index) => index === 1 ? 1 : index === 2 ? -1 : 0),
  }, ["Vertex Index", "Weights", "Sort Index"]));

  assert.deepEqual((outputs["Corner Index"] as Field).array(pointContext).slice(0, 3), [4, 1, 1]);
  assert.deepEqual((outputs.Total as Field).array(pointContext), [2, 2, 2, 2, 2, 2]);
});

test("Face Group Boundaries marks only multi-face edges whose IDs differ", () => {
  const geometry = adjacentQuads();
  const edgeContext = makeFieldCtx(geometry, "EDGE");
  const handler = REGISTRY.get("GeometryNodeMeshFaceSetBoundaries");
  assert.ok(handler);
  const output = handler(topologyApi("GeometryNodeMeshFaceSetBoundaries", {
    "Face Set": Field.perElem((face) => face === 0 ? 3 : 7),
  }, ["Face Set"]))["Boundary Edges"] as Field;

  assert.deepEqual(output.array(edgeContext), [0, 1, 0, 0, 0, 0, 0]);
});

test("Mesh to Curve canonicalizes pure cycles by point and stored edge order", () => {
  const mesh = new Mesh();
  mesh.positions = Array.from({ length: 7 }, (_, index) => [index, 0, 0] as Vec3);
  // Discover the higher-minimum cycle first. Within the other cycle, point 1's
  // edge to point 5 precedes its edge to point 3.
  mesh.edges = [[6, 4], [4, 2], [2, 6], [3, 5], [5, 1], [1, 3]];
  mesh.attributes.set("__gnvm_canonical_curve_cycles", { domain: "POINT", data: mesh.positions.map(() => 1) });

  assert.deepEqual(meshEdgesToChains(mesh).map((chain) => chain.verts), [
    [1, 5, 3],
    [2, 4, 6],
  ]);
});

test("Mesh to Curve preserves authored pure-cycle edge discovery order", () => {
  const mesh = new Mesh();
  mesh.positions = Array.from({ length: 7 }, (_, index) => [index, 0, 0] as Vec3);
  mesh.edges = [[6, 4], [4, 2], [2, 6], [3, 5], [5, 1], [1, 3]];

  assert.deepEqual(meshEdgesToChains(mesh).map((chain) => chain.verts), [
    [6, 4, 2],
    [3, 5, 1],
  ]);
});
