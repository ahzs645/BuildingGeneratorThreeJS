import assert from "node:assert/strict";
import test from "node:test";
import { baseGeometryOf } from "./dump-object-geometry";
import type { Dump, DumpMesh } from "./dump-schema";
import { toTriSoup } from "./geometry";
import { DUMP_CONTEXT, REGISTRY } from "./registry";
import "./nodes/geometry";

const foldedMesh: DumpMesh = {
  verts: [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  faces: [
    [0, 1, 2],
    [1, 0, 3],
  ],
  edges: [[0, 1], [1, 2], [2, 0], [0, 3], [3, 1]],
  face_smooth: [false, true],
};

test("modifier seed geometry imports Blender face smoothness without changing topology", () => {
  const dump = {
    node_groups: {},
    objects: [{
      name: "Seed",
      type: "MESH",
      mesh: foldedMesh,
      materials: ["surface"],
    }],
  } as unknown as Dump;

  const geometry = baseGeometryOf(dump, "Seed");
  assert.ok(geometry?.mesh);
  assert.deepEqual(geometry.mesh.positions, foldedMesh.verts);
  assert.deepEqual(geometry.mesh.faces, foldedMesh.faces);
  assert.deepEqual(geometry.mesh.attributes.get("sharp_face"), {
    domain: "FACE",
    data: [1, 0],
  });

  const soup = toTriSoup(geometry);
  assert.deepEqual(soup.stats, { verts: 4, faces: 2, tris: 2 });
  assert.ok(soup.cornerNormals, "one imported flat face requires split corner normals");
  assert.equal(soup.cornerNormals.length, soup.indices.length * 3);
});

test("Object Info imports evaluated face smoothness through the same inverse attribute", () => {
  const handler = REGISTRY.get("GeometryNodeObjectInfo");
  assert.ok(handler);
  DUMP_CONTEXT.objects = [{
    name: "Dependency",
    type: "MESH",
    evaluated_mesh: foldedMesh,
    materials: ["surface"],
    location: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  }];
  DUMP_CONTEXT.activeObject = {
    name: "Active",
    location: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };

  try {
    const outputs = handler({
      ref: () => ({ datablock: "Object", name: "Dependency" }),
      bool: () => false,
      prop: (_name: string, fallback: unknown) => fallback,
    } as never);
    const geometry = outputs.Geometry;
    assert.ok(geometry && typeof geometry === "object" && "mesh" in geometry);
    const mesh = (geometry as ReturnType<typeof baseGeometryOf>)?.mesh;
    assert.ok(mesh);
    assert.deepEqual(mesh.attributes.get("sharp_face"), {
      domain: "FACE",
      data: [1, 0],
    });
    const soup = toTriSoup(geometry as NonNullable<ReturnType<typeof baseGeometryOf>>);
    assert.deepEqual(soup.stats, { verts: 4, faces: 2, tris: 2 });
    assert.ok(soup.cornerNormals);
  } finally {
    DUMP_CONTEXT.objects = [];
    DUMP_CONTEXT.activeObject = undefined;
  }
});
