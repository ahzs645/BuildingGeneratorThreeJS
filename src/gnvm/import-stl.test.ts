import assert from "node:assert/strict";
import test from "node:test";
import { embeddedStlPayloadOf } from "./import-stl-payload";
import type { RawNode } from "./dump-schema";
import { Geometry } from "./geometry";
import { UnsupportedImportStlError } from "./nodes/import-stl";
import { REGISTRY } from "./registry";

function importNode(embedded_stl?: unknown): RawNode {
  return {
    name: "Imported fastener",
    type: "GeometryNodeImportSTL",
    label: null,
    inputs: [{
      name: "Path",
      identifier: "Path",
      type: "NodeSocketStringFilePath",
      linked: false,
      value: "//fastener.stl",
    }],
    outputs: [{
      name: "Mesh",
      identifier: "Mesh",
      type: "NodeSocketGeometry",
    }],
    ...(embedded_stl === undefined ? {} : { embedded_stl }),
  };
}

const trianglePayload = {
  version: 1,
  format: "binary",
  source_size_bytes: 134,
  source_sha256: "a".repeat(64),
  triangle_count: 1,
  positions: [[0, 0, 0], [2, 0, 0], [0, 3, 0]],
  faces: [[0, 1, 2]],
};

test("Import STL materializes only the embedded triangle payload", () => {
  const handler = REGISTRY.get("GeometryNodeImportSTL");
  assert.ok(handler);
  const node = importNode(trianglePayload);
  const outputs = handler({ node } as never);
  const geometry = outputs.Mesh;
  assert.ok(geometry instanceof Geometry);
  assert.deepEqual(geometry.mesh?.positions, trianglePayload.positions);
  assert.deepEqual(geometry.mesh?.faces, trianglePayload.faces);
  assert.deepEqual(geometry.mesh?.faceMaterial, [0]);
  assert.deepEqual(geometry.mesh?.materialSlots, [null]);
  assert.notEqual(geometry.mesh?.positions, trianglePayload.positions);
});

test("Import STL remains an explicit typed failure without an embedded payload", () => {
  const handler = REGISTRY.get("GeometryNodeImportSTL");
  assert.ok(handler);
  assert.throws(
    () => handler({ node: importNode() } as never),
    (error: unknown) => error instanceof UnsupportedImportStlError
      && /re-extract while its authored file is available/.test(error.message),
  );
});

test("Import STL rejects malformed and non-finite embedded geometry", () => {
  const handler = REGISTRY.get("GeometryNodeImportSTL");
  assert.ok(handler);
  const node = importNode({
    ...trianglePayload,
    positions: [[0, 0, 0], [Number.NaN, 0, 0], [0, 3, 0]],
  });
  assert.equal(embeddedStlPayloadOf(node), null);
  assert.throws(
    () => handler({ node } as never),
    (error: unknown) => error instanceof UnsupportedImportStlError
      && /invalid embedded STL payload/.test(error.message),
  );
});

test("Import STL rejects faces that do not preserve extracted triangle order", () => {
  assert.equal(embeddedStlPayloadOf(importNode({
    ...trianglePayload,
    faces: [[2, 1, 0]],
  })), null);
});
