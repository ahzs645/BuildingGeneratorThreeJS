import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Field, type Vec3 } from "./core";
import { Geometry, Mesh, toTriSoup } from "./geometry";
import { runGenerator, type Dump } from "./index";
import { REGISTRY } from "./registry";

test("Set Material and Store Named Attribute recurse into shared instance payloads", () => {
  const payload = new Geometry();
  payload.mesh = new Mesh();
  payload.mesh.positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  payload.mesh.faces = [[0, 1, 2]];
  payload.mesh.faceMaterial = [0];
  payload.mesh.materialSlots = [null];

  const instances = new Geometry();
  for (const x of [0, 2]) instances.instances.push({
    geometry: payload,
    position: [x, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  });

  const color: Vec3 = [0.25, 0.5, 0.75];
  const store = REGISTRY.get("GeometryNodeStoreNamedAttribute");
  const setMaterial = REGISTRY.get("GeometryNodeSetMaterial");
  assert.ok(store && setMaterial);
  const stored = store({
    geo: () => instances,
    str: () => "col",
    prop: (name: string, fallback: unknown) => name === "domain" ? "FACE" : fallback,
    field: () => Field.of(color),
  } as never).Geometry as Geometry;
  const materialized = setMaterial({
    geo: () => stored,
    ref: () => ({ datablock: "Material", name: "Stitch" }),
    field: () => Field.of(1),
  } as never).Geometry as Geometry;

  assert.equal(materialized.instances[0].geometry, materialized.instances[1].geometry,
    "shared payloads remain shared after recursive mapping");
  assert.notEqual(materialized.instances[0].geometry, payload,
    "the input payload is not mutated");
  assert.equal(payload.mesh.attributes.has("col"), false);
  const soup = toTriSoup(materialized);
  assert.deepEqual(soup.groups, [
    { start: 0, count: 6, material: "Stitch" },
  ]);
  const attribute = soup.attributes.col;
  assert.equal(attribute.itemSize, 3);
  assert.equal(attribute.domain, "FACE");
  assert.deepEqual(Array.from(attribute.domainData ?? []), [...color, ...color]);
});

test("Send Nodes Hat embroidery retains Blender material and face color through realization", async () => {
  const dump = JSON.parse(readFileSync(
    "public/dojo/send-nodes-hat/dump.json",
    "utf8",
  )) as Dump;
  const result = await runGenerator(dump, { object: "embroidery crv" });

  assert.deepEqual(result.soup.stats, { verts: 188934, faces: 188160, tris: 376320 });
  assert.deepEqual(result.soup.groups, [
    { start: 0, count: 1128960, material: "sitch.001" },
  ]);

  const color = result.soup.attributes.col;
  assert.ok(color);
  assert.equal(color.itemSize, 3);
  assert.equal(color.domain, "FACE");
  assert.equal(color.data.length, 188934 * 3);
  assert.equal(color.domainData?.length, 188160 * 3);
  const expected = [0.9770724773406982, 1, 0.9756893515586853];
  for (const values of [color.data, color.domainData!]) {
    for (let offset = 0; offset < values.length; offset += 3) {
      assert.equal(values[offset], expected[0]);
      assert.equal(values[offset + 1], expected[1]);
      assert.equal(values[offset + 2], expected[2]);
    }
  }
});
