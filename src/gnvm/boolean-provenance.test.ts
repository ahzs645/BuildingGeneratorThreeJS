import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureManifold,
  getManifoldFaceProvenance,
  manifoldBoolean,
  manifoldBooleanMany,
  meshToManifoldGL,
} from "./boolean";
import { Mesh, mergeMeshInto } from "./geometry";
import {
  collapseIsolatedBooleanMicroEdgeForTest,
  dissolveCoplanarFacesForTest,
  splitDisconnectedBooleanMeshForTest,
} from "./nodes/extra";

function box(
  min: [number, number, number],
  max: [number, number, number],
  warpTop = 0,
  label = "box",
): Mesh {
  const mesh = new Mesh();
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  mesh.positions = [
    [x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x1, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], [x1, y1, z1 + warpTop],
  ];
  mesh.faces = [
    [0, 2, 3, 1], [4, 5, 7, 6],
    [0, 1, 5, 4], [1, 3, 7, 5], [3, 2, 6, 7], [2, 0, 4, 6],
  ];
  mesh.materialSlots = [`${label}-side`, `${label}-top`];
  mesh.faceMaterial = [0, 1, 0, 0, 0, 0];
  mesh.attributes.set("source_face", { domain: "FACE", data: mesh.faces.map((_, face) => face + 10) });
  return mesh;
}

test("Manifold fan triangles share their authored polygon face ID", () => {
  const mesh = box([0, 0, 0], [1, 1, 1], 0.2);
  const gl = meshToManifoldGL(mesh, 17);
  assert.ok(gl);
  assert.deepEqual([...gl.faceID], [17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22]);
});

test("pairwise Boolean reconstructs warped source polygons and FACE data", async () => {
  await ensureManifold();
  const source = box([0, 0, 0], [1, 1, 1], 0.2, "source");
  const enclosure = box([-1, -1, -1], [2, 2, 2], 0, "cutter");
  const raw = manifoldBoolean(source, enclosure, "INTERSECT");
  assert.ok(raw);
  const provenance = getManifoldFaceProvenance(raw);
  assert.ok(provenance);
  assert.equal(provenance.faceID.length, raw.faces.length);

  const reconstructed = dissolveCoplanarFacesForTest(raw, [source, enclosure]);
  assert.equal(reconstructed.faces.length, 6);
  assert.deepEqual(reconstructed.faces.map((face) => face.length).sort((a, b) => a - b), [4, 4, 4, 4, 4, 4]);
  assert.deepEqual(
    [...(reconstructed.attributes.get("source_face")?.data ?? [])].sort((a, b) => Number(a) - Number(b)),
    [10, 11, 12, 13, 14, 15],
  );
  const materialNames = reconstructed.faceMaterial.map((slot) => reconstructed.materialSlots[slot]);
  assert.equal(materialNames.filter((name) => name === "source-top").length, 1);
  assert.equal(materialNames.filter((name) => name === "source-side").length, 5);
  assert.equal(getManifoldFaceProvenance(reconstructed), null, "provenance must remain internal to the raw mesh");
});

test("pairwise Boolean removes internal fan-diagonal intersection vertices", async () => {
  await ensureManifold();
  const source = box([0, 0, 0], [1, 1, 1], 0.2, "source");
  const cutter = box([-1, -1, -1], [0.5, 2, 2], 0, "cutter");
  const raw = manifoldBoolean(source, cutter, "INTERSECT");
  assert.ok(raw);
  assert.equal(raw.positions.length, 9, "Manifold exposes the warped top face's fan-diagonal crossing");

  const reconstructed = dissolveCoplanarFacesForTest(raw, [source, cutter]);
  assert.equal(reconstructed.positions.length, 8);
  assert.equal(reconstructed.faces.length, 6);
  assert.ok(reconstructed.faces.every((face) => face.length === 4));
  assert.ok(!reconstructed.positions.some((point) =>
    Math.abs(point[0] - 0.5) < 1e-6
    && Math.abs(point[1] - 0.5) < 1e-6
    && Math.abs(point[2] - 1.1) < 1e-6));
});

test("batch Boolean assigns non-colliding face IDs across operands", async () => {
  await ensureManifold();
  const meshes = [
    box([0, 0, 0], [1, 1, 1], 0.1, "a"),
    box([2, 0, 0], [3, 1, 1], 0.1, "b"),
    box([4, 0, 0], [5, 1, 1], 0.1, "c"),
  ];
  const raw = manifoldBooleanMany(meshes[0], meshes.slice(1), "UNION");
  assert.ok(raw);
  const provenance = getManifoldFaceProvenance(raw);
  assert.ok(provenance);
  assert.equal(new Set(provenance.faceID).size, 18);
  assert.equal(Math.max(...provenance.faceID), 17);

  const reconstructed = dissolveCoplanarFacesForTest(raw, meshes);
  assert.equal(reconstructed.faces.length, 18);
  assert.ok(reconstructed.faces.every((face) => face.length === 4));
  assert.equal(reconstructed.attributes.get("source_face")?.data.length, 18);
});

test("disconnected Boolean cutters split into attribute-preserving solids", () => {
  const joined = new Mesh();
  mergeMeshInto(joined, box([-2, -1, -1], [-1, 1, 1], 0, "left"));
  mergeMeshInto(joined, box([1, -1, -1], [2, 1, 1], 0, "right"));

  const parts = splitDisconnectedBooleanMeshForTest(joined);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((part) => part.positions.length), [8, 8]);
  assert.deepEqual(parts.map((part) => part.faces.length), [6, 6]);
  assert.ok(parts.every((part) => part.attributes.get("source_face")?.data.length === 6));
  assert.deepEqual(parts.map((part) => [
    Math.min(...part.positions.map((point) => point[0])),
    Math.max(...part.positions.map((point) => point[0])),
  ]), [[-2, -1], [1, 2]]);
});

test("isolated Boolean micro-edge collapse preserves a closed triangle surface", () => {
  const mesh = new Mesh();
  mesh.positions = [
    [1, 0, 0], [1, 1e-8, 0], [-1, 0, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ];
  mesh.faces = [
    [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4],
    [1, 0, 5], [2, 1, 5], [3, 2, 5], [0, 3, 5],
  ];
  mesh.faceMaterial = mesh.faces.map((_, face) => face);
  mesh.attributes.set("face", { domain: "FACE", data: mesh.faces.map((_, face) => face + 10) });

  const collapsed = collapseIsolatedBooleanMicroEdgeForTest(mesh);
  assert.equal(collapsed.positions.length, 5);
  assert.equal(collapsed.faces.length, 6);
  assert.equal(collapsed.faceMaterial.length, 6);
  assert.equal(collapsed.attributes.get("face")?.data.length, 6);
  assert.ok(collapsed.faces.every((face) => new Set(face).size === 3));
  const edgeUses = new Map<string, number>();
  for (const face of collapsed.faces) for (let corner = 0; corner < face.length; corner++) {
    const a = face[corner], b = face[(corner + 1) % face.length];
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
  }
  assert.ok([...edgeUses.values()].every((uses) => uses === 2));
});
