import assert from "node:assert/strict";
import test from "node:test";
import { buildEeveeFilterTable, buildEeveeJitterOffsets } from "../eevee-temporal-capture";

test("rebuilds legacy Eevee's deterministic Blackman-Harris jitter sequence", () => {
  const table = buildEeveeFilterTable();
  assert.equal(table.length, 512);
  assert.equal(table[0], -2);
  assert.equal(table.at(-1), 2);
  for (let index = 1; index < table.length; index++) assert.ok(table[index] >= table[index - 1]);

  const offsets = buildEeveeJitterOffsets(64, 1.5);
  assert.equal(offsets.length, 64);
  assert.deepEqual(offsets[0], [0, 0]);
  assert.equal(new Set(offsets.slice(1).map((value) => value.join(","))).size, 63);
  assert.ok(offsets.flat().every(Number.isFinite));
  assert.ok(offsets.flat().every((value) => Math.abs(value) <= 3));
  const mean = offsets.reduce((sum, value) => [sum[0] + value[0], sum[1] + value[1]], [0, 0]);
  assert.ok(Math.abs(mean[0] / offsets.length) < 0.08);
  assert.ok(Math.abs(mean[1] / offsets.length) < 0.08);
  assert.deepEqual(offsets.slice(0, 4), [
    [0, 0],
    [-0.0058713555335998535, -0.3750001788139343],
    [-0.5822066068649292, 0.3632504343986511],
    [0.5705338716506958, -1.0373713970184326],
  ]);
});
