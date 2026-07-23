import assert from "node:assert/strict";
import test from "node:test";
import { Field } from "./core";
import { Geometry, Mesh, toTriSoup, topologyOf } from "./geometry";
import { REGISTRY } from "./registry";
import "./nodes/geometry";

function foldedPair(sharp: boolean): Geometry {
  const mesh = new Mesh();
  mesh.positions = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  mesh.faces = [
    [0, 1, 2],
    [1, 0, 3],
  ];
  mesh.faceMaterial = [0, 0];
  mesh.materialSlots = ["surface"];
  const topology = topologyOf(mesh);
  mesh.attributes.set("sharp_edge", {
    domain: "EDGE",
    data: topology.edges.map((edge) =>
      sharp && edge.faces.length === 2 ? 1 : 0),
  });
  const geometry = new Geometry();
  geometry.mesh = mesh;
  return geometry;
}

test("toTriSoup emits split corner normals across Blender sharp edges", () => {
  const geometry = foldedPair(true);
  const mesh = geometry.mesh!;
  const soup = toTriSoup(geometry);
  assert.ok(soup.cornerNormals);
  assert.equal(soup.cornerNormals.length, soup.indices.length * 3);

  const first = mesh.faceNormal(0);
  const second = mesh.faceNormal(1);
  for (let corner = 0; corner < 3; corner++)
    assert.deepEqual(Array.from(soup.cornerNormals.slice(corner * 3, corner * 3 + 3)), first);
  for (let corner = 3; corner < 6; corner++)
    assert.deepEqual(Array.from(soup.cornerNormals.slice(corner * 3, corner * 3 + 3)), second);
});

test("toTriSoup keeps indexed vertex normals when no edge is sharp", () => {
  const soup = toTriSoup(foldedPair(false));
  assert.equal(soup.cornerNormals, undefined);
});

test("Set Shade Smooth stores Blender's inverse sharp attributes", () => {
  const geometry = foldedPair(false);
  const handler = REGISTRY.get("GeometryNodeSetShadeSmooth");
  assert.ok(handler);

  const edges = handler({
    geo: () => geometry,
    prop: () => "EDGE",
    field: (name: string) => name === "Selection" ? Field.of(1) : Field.of(0),
  } as never).Geometry as Geometry;
  assert.deepEqual(edges.mesh?.attributes.get("sharp_edge"), {
    domain: "EDGE",
    data: Array.from({ length: topologyOf(edges.mesh!).edges.length }, () => 1),
  });

  const faces = handler({
    geo: () => edges,
    prop: () => "FACE",
    field: (name: string) => name === "Selection" ? Field.of(1) : Field.of(1),
  } as never).Geometry as Geometry;
  assert.deepEqual(faces.mesh?.attributes.get("sharp_face"), {
    domain: "FACE",
    data: [0, 0],
  });
});
