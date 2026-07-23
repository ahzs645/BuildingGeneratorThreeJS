import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runGenerator, type Dump } from "./index";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/joints/bubble-putty/dump.json",
  import.meta.url,
)), "utf8")) as Dump;

function hash(view: ArrayBufferView): string {
  return createHash("sha256")
    .update(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
    .digest("hex");
}

test("Bubble Putty EXACT difference preserves the repeated disconnected cutter", async () => {
  const result = await runGenerator(dump, {
    object: "PUTTY.002",
    overrides: { "finalize for export": true },
  });

  assert.deepEqual(result.soup.stats, {
    verts: 3302,
    faces: 6608,
    tris: 6608,
  });
  assert.deepEqual(result.soup.groups, [{
    start: 0,
    count: 19824,
    material: "Filament and Cross Section 1OCT2024",
  }]);
  assert.equal(hash(result.soup.positions), "1b5bd8e97200b021b057dd6458e19f3a1ac953bb4c3618a0d8650e0df2c32d8b");
  assert.equal(hash(result.soup.indices), "899ab03bbf274a5f6cac86134b3f2c126887f3f2eafa2bb06ccec211b2fc0c08");
  assert.deepEqual(Object.keys(result.soup.attributes).sort(), ["col", "layer", "rough"]);
  const expectedColor = [
    0.0008284280193038285,
    0.8002511262893677,
    0,
  ];
  const color = result.soup.attributes.col.data;
  assert.equal(color.length, 3302 * 3);
  for (let offset = 0; offset < color.length; offset += 3) {
    assert.deepEqual([...color.slice(offset, offset + 3)], expectedColor);
  }
  assert.ok([...result.soup.attributes.layer.data].every((value) => value === 1.5015965700149536));
  assert.ok([...result.soup.attributes.rough.data].every((value) => value === 0.48828125));
});
