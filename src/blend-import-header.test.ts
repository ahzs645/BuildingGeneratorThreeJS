import assert from "node:assert/strict";
import test from "node:test";
import { isRecognizedBlendHeader } from "../tools/vite-blend-import";

test("recognizes plain and compressed Blender file envelopes", () => {
  assert.equal(isRecognizedBlendHeader(Buffer.from("BLENDER-v")), true);
  assert.equal(isRecognizedBlendHeader(Uint8Array.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0])), true);
  assert.equal(isRecognizedBlendHeader(Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 0])), true);
  assert.equal(isRecognizedBlendHeader(Buffer.from("notblend")), false);
});
