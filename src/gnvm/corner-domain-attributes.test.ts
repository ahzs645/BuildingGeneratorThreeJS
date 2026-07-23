import assert from "node:assert/strict";
import test from "node:test";
import { Geometry, Mesh, mergeMeshInto, toTriSoup } from "./geometry";

test("Join Geometry retains CORNER attributes and triangle-loop identity", () => {
  const joined = new Mesh();
  joined.positions = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  joined.faces = [[0, 1, 2, 3]];
  joined.faceMaterial = [0];
  joined.materialSlots = [null];

  const textured = new Mesh();
  textured.positions = [[2, 0, 0], [3, 0, 0], [2, 1, 0]];
  textured.faces = [[0, 1, 2]];
  textured.faceMaterial = [0];
  textured.materialSlots = [null];
  textured.attributes.set("UVMap", {
    domain: "CORNER",
    data: [[0.1, 0.2, 0], [0.8, 0.2, 0], [0.1, 0.9, 0]],
  });

  mergeMeshInto(joined, textured);
  const uv = joined.attributes.get("UVMap");
  assert.equal(uv?.domain, "CORNER");
  assert.deepEqual(uv?.data.slice(0, 4), [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  assert.deepEqual(uv?.data.slice(4), textured.attributes.get("UVMap")?.data);

  const geometry = new Geometry();
  geometry.mesh = joined;
  const soup = toTriSoup(geometry);
  assert.deepEqual(Array.from(soup.triangleCorners ?? []), [
    0, 1, 2,
    0, 2, 3,
    4, 5, 6,
  ]);
  assert.equal(soup.attributes.UVMap.domain, "CORNER");
  assert.equal(soup.attributes.UVMap.domainData?.length, 7 * 3);
  assert.deepEqual(
    Array.from(soup.attributes.UVMap.domainData?.slice(12) ?? []),
    [0.1, 0.2, 0, 0.8, 0.2, 0, 0.1, 0.9, 0].map(Math.fround),
  );
});
