import assert from "node:assert/strict";
import test from "node:test";
import { parseBlendHeader, readBlendFile } from "./blend-file";
import { parseSdna } from "./sdna";

/** Minimal DNA1 payload describing a `ListBase` and a `Widget` struct. */
function buildDna(): Uint8Array {
  const names = ["*first", "*last", "*next", "*prev", "name[8]", "value", "weight", "items"];
  const types = ["void", "char", "int", "float", "ListBase", "Widget"];
  const sizes = [0, 1, 4, 4, 16, 48];
  const structs: [number, [number, number][]][] = [
    [4, [[0, 0], [0, 1]]],
    [5, [[5, 2], [5, 3], [1, 4], [2, 5], [3, 6], [4, 7]]],
  ];

  const parts: number[] = [];
  const text = (value: string): void => {
    for (const character of value) parts.push(character.charCodeAt(0));
  };
  const int32 = (value: number): void => {
    parts.push(value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255);
  };
  const int16 = (value: number): void => parts.push(value & 255, (value >> 8) & 255);
  const pad4 = (): void => {
    while (parts.length % 4) parts.push(0);
  };

  text("SDNA");
  text("NAME");
  int32(names.length);
  for (const name of names) {
    text(name);
    parts.push(0);
  }
  pad4();
  text("TYPE");
  int32(types.length);
  for (const type of types) {
    text(type);
    parts.push(0);
  }
  pad4();
  text("TLEN");
  for (const size of sizes) int16(size);
  pad4();
  text("STRC");
  int32(structs.length);
  for (const [type, fields] of structs) {
    int16(type);
    int16(fields.length);
    for (const [fieldType, fieldName] of fields) {
      int16(fieldType);
      int16(fieldName);
    }
  }
  return Uint8Array.from(parts);
}

/** Assemble a legacy-format (12-byte header, 24-byte block record) `.blend`. */
function buildLegacyBlend(): Uint8Array {
  const dna = buildDna();
  const widget = (
    next: bigint,
    previous: bigint,
    name: string,
    value: number,
    weight: number,
    itemsFirst: bigint,
    itemsLast: bigint,
  ): Uint8Array => {
    const bytes = new Uint8Array(48);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, next, true);
    view.setBigUint64(8, previous, true);
    for (let index = 0; index < Math.min(8, name.length); index += 1) bytes[16 + index] = name.charCodeAt(index);
    view.setInt32(24, value, true);
    view.setFloat32(28, weight, true);
    view.setBigUint64(32, itemsFirst, true);
    view.setBigUint64(40, itemsLast, true);
    return bytes;
  };

  const blocks: { code: string; sdnaIndex: number; address: bigint; count: number; data: Uint8Array }[] = [
    { code: "DATA", sdnaIndex: 1, address: 0x1000n, count: 1, data: widget(0x2000n, 0n, "alpha", 7, 1.5, 0x2000n, 0x2000n) },
    { code: "DATA", sdnaIndex: 1, address: 0x2000n, count: 1, data: widget(0n, 0x1000n, "beta", 9, -2.25, 0n, 0n) },
    { code: "DNA1", sdnaIndex: 0, address: 0x3000n, count: 1, data: dna },
  ];

  const header = new TextEncoder().encode("BLENDER-v403");
  const size = blocks.reduce((sum, block) => sum + 24 + block.data.length, header.length + 24);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(header, 0);
  let cursor = header.length;
  for (const block of blocks) {
    for (let index = 0; index < 4; index += 1) bytes[cursor + index] = block.code.charCodeAt(index) || 0;
    view.setInt32(cursor + 4, block.data.length, true);
    view.setBigUint64(cursor + 8, block.address, true);
    view.setInt32(cursor + 16, block.sdnaIndex, true);
    view.setInt32(cursor + 20, block.count, true);
    bytes.set(block.data, cursor + 24);
    cursor += 24 + block.data.length;
  }
  for (let index = 0; index < 4; index += 1) bytes[cursor + index] = "ENDB".charCodeAt(index);
  return bytes;
}

test("parses the classic 12-byte file header", () => {
  const header = parseBlendHeader(new TextEncoder().encode("BLENDER-v403"));
  assert.deepEqual(header, {
    pointerSize: 8,
    fileFormat: 0,
    littleEndian: true,
    versionDigits: "403",
    version: "4.3",
    size: 12,
  });
});

test("parses the Blender 5.0 header with its file-format revision", () => {
  const header = parseBlendHeader(new TextEncoder().encode("BLENDER17-01v0500"));
  assert.deepEqual(header, {
    pointerSize: 8,
    fileFormat: 1,
    littleEndian: true,
    versionDigits: "0500",
    version: "5.0",
    size: 17,
  });
});

test("rejects a 32-bit header marker it cannot interpret", () => {
  assert.throws(() => parseBlendHeader(new TextEncoder().encode("BLENDER?v403")), /pointer-size/);
  assert.throws(() => parseBlendHeader(new TextEncoder().encode("NOTBLEND")), /BLENDER file magic/);
});

test("derives contiguous field offsets from the DNA catalogue", () => {
  const sdna = parseSdna(buildDna(), 8);
  const widget = sdna.structByName.get("Widget");
  assert.ok(widget);
  assert.equal(widget.size, 48);
  assert.deepEqual(
    widget.fields.map((field) => [field.name, field.offset, field.size, field.pointer]),
    [
      ["next", 0, 8, true],
      ["prev", 8, 8, true],
      ["name", 16, 8, false],
      ["value", 24, 4, false],
      ["weight", 28, 4, false],
      ["items", 32, 16, false],
    ],
  );
});

test("reads structs, pointers, and list bases from a legacy file", () => {
  const file = readBlendFile(buildLegacyBlend());
  assert.equal(file.header.fileFormat, 0);
  assert.equal(file.blocks.length, 3);

  const first = file.structAt(0x1000n);
  assert.ok(first);
  assert.equal(first.type, "Widget");
  assert.equal(first.string("name"), "alpha");
  assert.equal(first.number("value"), 7);
  assert.equal(first.number("weight"), 1.5);

  const second = first.follow("next");
  assert.ok(second);
  assert.equal(second.string("name"), "beta");
  assert.equal(second.number("weight"), -2.25);
  assert.equal(second.address, 0x2000n);

  assert.deepEqual(first.list("items").map((item) => item.string("name")), ["beta"]);
  assert.deepEqual(second.list("items"), []);
  assert.equal(first.follow("prev"), null);
});

test("resolves a pointer that lands inside a block", () => {
  const file = readBlendFile(buildLegacyBlend());
  const interior = file.blockAt(0x1010n);
  assert.ok(interior);
  assert.equal(interior.offset, 16);
  assert.equal(file.readString(interior.block.start + interior.offset, 8), "alpha");
});
