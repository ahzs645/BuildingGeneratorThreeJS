import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runGenerator, type Dump } from "./index";

const dump = JSON.parse(await readFile(fileURLToPath(new URL(
  "../../public/dojo/chrome-assets/flat-stickie-pack/dump.json",
  import.meta.url,
)), "utf8")) as Dump;

test("Object Info keeps exact dependency geometry while retaining modifier-created attributes", async () => {
  const { soup } = await runGenerator(dump, { object: "Flat Stickie Pack.001" });
  assert.deepEqual(soup.stats, { verts: 28, faces: 7, tris: 14 });
  assert.deepEqual(soup.groups.map((group) => group.material), [
    "tree sticky",
    "foolish bb spooky sticker",
    "8pt soft star stickie",
    "ryu electrify",
    "fuck around find out",
    "10pt spoke stickie",
    "ryu electrify1",
  ]);
  const col = soup.attributes.col;
  assert.ok(col);
  assert.equal(col.domain, "POINT");
  assert.equal(col.itemSize, 3);
  assert.deepEqual(Array.from(col.data.slice(8 * 3, 12 * 3)), [
    0, 0.1420930176973343, 0.5122548937797546,
    0, 0.1420930176973343, 0.5122548937797546,
    0, 0.1420930176973343, 0.5122548937797546,
    0, 0.1420930176973343, 0.5122548937797546,
  ]);
  assert.deepEqual(Array.from(col.data.slice(20 * 3, 24 * 3)), [
    0.39278069138526917, 0.804839015007019, 0,
    0.39278069138526917, 0.804839015007019, 0,
    0.39278069138526917, 0.804839015007019, 0,
    0.39278069138526917, 0.804839015007019, 0,
  ]);
});
