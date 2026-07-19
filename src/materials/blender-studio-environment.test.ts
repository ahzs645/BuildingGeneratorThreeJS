import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeBase64Asset } from "../base64-asset";

test("ships Blender's exact CC0 studio environment bytes", async () => {
  const metadata = JSON.parse(await readFile("public/dojo/blender-studio-environment.json", "utf8"));
  const encoded = await readFile("public/dojo/blender-studio.exr.b64", "utf8");
  const bytes = decodeBase64Asset(encoded);
  assert.equal(metadata.asset, "dojo/blender-studio.exr.b64");
  assert.equal(bytes.byteLength, metadata.decodedBytes);
  assert.deepEqual(Array.from(bytes.subarray(0, 4)), [0x76, 0x2f, 0x31, 0x01]);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    metadata.sha256,
  );
  assert.equal(metadata.licenseId, "CC0-1.0");
  const license = await readFile(`public/${metadata.license}`, "utf8");
  assert.match(license, /All HDRIs are licensed as CC0/);
  assert.match(license, /Studio: Probably https:\/\/polyhaven\.com\/a\/studio_small_01/);
});
