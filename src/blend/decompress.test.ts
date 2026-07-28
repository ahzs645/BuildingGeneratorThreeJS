import assert from "node:assert/strict";
import test from "node:test";
import { blendEnvelope, decompressBlend } from "./decompress";

const raw = new TextEncoder().encode("BLENDER-v403rest-of-the-file");

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test("identifies the container from its first bytes", () => {
  assert.equal(blendEnvelope(raw), "raw");
  assert.equal(blendEnvelope(Uint8Array.from([0x1f, 0x8b, 0x08, 0])), "gzip");
  assert.equal(blendEnvelope(Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd])), "zstd");
  assert.equal(blendEnvelope(new TextEncoder().encode("PK")), null);
});

test("passes an uncompressed file through untouched", async () => {
  const result = await decompressBlend(raw);
  assert.equal(result.envelope, "raw");
  assert.equal(result.bytes, raw);
});

test("unwraps the gzip envelope older Blender releases write", async () => {
  const result = await decompressBlend(await gzip(raw));
  assert.equal(result.envelope, "gzip");
  assert.deepEqual(result.bytes, raw);
});

test("refuses a container that does not hold a Blender file", async () => {
  await assert.rejects(
    decompressBlend(await gzip(new TextEncoder().encode("not a blend file at all"))),
    /does not contain a Blender file header/,
  );
  await assert.rejects(
    decompressBlend(new TextEncoder().encode("PKzipfile")),
    /recognized Blender or compressed Blender header/,
  );
});
