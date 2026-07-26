import assert from "node:assert/strict";
import test from "node:test";
import type { Dump } from "../gnvm";
import { dependencyExtractionPackage } from "./dependency-extraction";

const recoveredFont = {
  name: "Packed Sans",
  atlas_status: "embedded",
  source: {
    status: "packed-extractable",
    authored_filepath: "//PackedSans.otf",
    packed_size_bytes: 123,
    binary_extractable: true,
  },
  glyphs: {
    A: {
      advance: 1,
      curves: [{ cyclic: true, points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] }],
    },
  },
};

function fixture(): Dump {
  return {
    blender_version: "5.1.2",
    node_groups: {},
    fonts: {
      "Missing Font": {
        name: "Missing Font",
        unavailable: true,
        atlas_status: "unavailable",
        filepath: "//missing.otf",
        source: {
          status: "external-missing",
          authored_filepath: "//missing.otf",
          binary_extractable: false,
        },
        glyphs: {},
      },
      "Packed Sans": recoveredFont,
    },
    images: [
      {
        name: "Embedded",
        filepath: "//embedded.png",
        size: [1, 1],
        channels: 4,
        pixels_rgba8: "AQIDBA==",
      },
      { name: "Missing Image", filepath: "//missing.png", size: [0, 0] },
      { name: "Referenced Image", filepath: "//referenced.png", size: [0, 0] },
    ],
    extraction_metadata: {
      schema_version: 1,
      extractor: { name: "tools/dump_blend.py", version: "1.6", blender_version: "5.1.2" },
      source: { filename: "fixture.blend", fingerprint_sha256: "source-hash" },
      dependencies: [{
        id: "unused",
        kind: "font",
        source: { tree: "Root", node: "Text", socket: "Font", direction: "input" },
        target: { name: "Missing Font" },
        required: true,
        availability: "unavailable",
        provenance: "node_socket",
      }],
      warnings: [
        {
          code: "EXTERNAL_FONT_UNAVAILABLE",
          message: "Missing Font is unavailable",
          path: ["Missing Font", "//missing.otf"],
        },
        {
          code: "EXTERNAL_IMAGE_UNAVAILABLE",
          message: "Missing Image is unavailable",
          path: ["Missing Image", "//missing.png"],
        },
        {
          code: "EXTERNAL_STL_UNAVAILABLE",
          message: "Screw STL is unavailable",
          path: ["Root", "Import STL", "//screw.stl"],
        },
      ],
    },
  } as Dump;
}

test("packages recovered payloads separately from referenced and missing dependencies", async () => {
  const result = await dependencyExtractionPackage(fixture());

  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.source, {
    filename: "fixture.blend",
    fingerprintSha256: "source-hash",
    blenderVersion: "5.1.2",
    extractor: "tools/dump_blend.py",
    extractorVersion: "1.6",
  });
  assert.equal(result.fontAtlases.length, 1);
  assert.equal(result.fontAtlases[0].name, "Packed Sans");
  assert.equal(result.fontAtlases[0].glyphCount, 1);
  assert.match(result.fontAtlases[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.embeddedImages.length, 1);
  assert.equal(result.embeddedImages[0].payloadBytes, 4);
  assert.match(result.embeddedImages[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(result.referencedAssets.some((entry) =>
    entry.kind === "image" && entry.name === "Referenced Image"));
  assert.ok(result.missingAssets.some((entry) =>
    entry.kind === "font" && entry.name === "Missing Font"));
  assert.ok(result.missingAssets.some((entry) =>
    entry.kind === "image" && entry.name === "Missing Image"));
  assert.ok(result.missingAssets.some((entry) =>
    entry.kind === "stl" && entry.path === "//screw.stl"));
  assert.deepEqual(result.summary, {
    fontsRecovered: 1,
    imagesRecovered: 1,
    referenced: 1,
    missing: 3,
    unresolved: 4,
    fontPayloadBytes: result.fontAtlases[0].payloadBytes,
    imagePayloadBytes: 4,
    totalPayloadBytes: result.fontAtlases[0].payloadBytes + 4,
  });
});

test("dependency package ordering and hashes are deterministic", async () => {
  const first = await dependencyExtractionPackage(fixture());
  const second = await dependencyExtractionPackage(fixture());
  assert.deepEqual(second, first);
});
