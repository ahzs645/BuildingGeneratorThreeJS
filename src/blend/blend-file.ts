import { parseSdna, type Sdna, type SdnaField, type SdnaStruct } from "./sdna";

/** One `BHead` record plus the location of its payload. */
export interface BlendBlock {
  /** Four-character block code: `DATA`, `DNA1`, `OB\0\0`, `NT\0\0`, … */
  code: string;
  sdnaIndex: number;
  /** Address the block had in the writing process; the identity used by pointers. */
  address: bigint;
  /** Payload length in bytes. */
  length: number;
  /** Number of struct elements in the payload. */
  count: number;
  /** Offset of the payload inside the decompressed file. */
  start: number;
}

export interface BlendHeader {
  pointerSize: 4 | 8;
  littleEndian: boolean;
  /** Raw version digits, e.g. `403` or `0500`. */
  versionDigits: string;
  /** `4.3`, `5.0`, … derived from the digits. */
  version: string;
  /**
   * Blend file-format revision. `0` is the classic 12-byte header with 20/24
   * byte block records; `1` is the Blender 5.0 header with 64-bit block sizes.
   */
  fileFormat: number;
  size: number;
}

/** Block codes and the file header are ASCII; everything Blender authors is UTF-8. */
const asciiDecoder = new TextDecoder("latin1");
const textDecoder = new TextDecoder("utf-8");

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return asciiDecoder.decode(bytes.subarray(start, end));
}

/**
 * Parse the file header.
 *
 * Classic: `BLENDER` + pointer char + endian char + 3 version digits.
 * Blender 5.0 introduced `BLENDER` + 2 header-size digits + pointer char +
 * 2 file-format digits + endian char + 4 version digits, which is how a decoder
 * can tell the 32-byte block record apart from the legacy 20/24 byte ones.
 */
export function parseBlendHeader(bytes: Uint8Array): BlendHeader {
  if (ascii(bytes, 0, 7) !== "BLENDER") throw new Error("Missing the BLENDER file magic.");
  const digit = (index: number): boolean => bytes[index] >= 0x30 && bytes[index] <= 0x39;
  const pointerChar = (index: number): 4 | 8 => {
    const char = String.fromCharCode(bytes[index]);
    if (char === "_") return 4;
    if (char === "-") return 8;
    throw new Error(`Unknown pointer-size marker "${char}" in the Blender header.`);
  };
  const endianChar = (index: number): boolean => {
    const char = String.fromCharCode(bytes[index]);
    if (char === "v") return true;
    if (char === "V") return false;
    throw new Error(`Unknown endianness marker "${char}" in the Blender header.`);
  };
  const versionOf = (digits: string): string => {
    const major = Number(digits.slice(0, digits.length - 2));
    const minor = Number(digits.slice(digits.length - 2));
    return `${major}.${minor}`;
  };

  if (digit(7) && digit(8)) {
    const size = Number(ascii(bytes, 7, 9));
    if (size < 13 || size > 64) throw new Error(`Implausible Blender header size ${size}.`);
    const versionDigits = ascii(bytes, 13, size);
    return {
      pointerSize: pointerChar(9),
      fileFormat: Number(ascii(bytes, 10, 12)),
      littleEndian: endianChar(12),
      versionDigits,
      version: versionOf(versionDigits),
      size,
    };
  }
  const versionDigits = ascii(bytes, 9, 12);
  return {
    pointerSize: pointerChar(7),
    fileFormat: 0,
    littleEndian: endianChar(8),
    versionDigits,
    version: versionOf(versionDigits),
    size: 12,
  };
}

function readBlocks(bytes: Uint8Array, view: DataView, header: BlendHeader): BlendBlock[] {
  const { littleEndian, pointerSize, fileFormat } = header;
  const recordSize = fileFormat >= 1 ? 32 : pointerSize === 8 ? 24 : 20;
  const blocks: BlendBlock[] = [];
  let cursor = header.size;
  while (cursor + recordSize <= bytes.length) {
    const code = ascii(bytes, cursor, cursor + 4).replace(/\0+$/, "");
    let sdnaIndex: number;
    let address: bigint;
    let length: number;
    let count: number;
    if (fileFormat >= 1) {
      // code, SDNAnr, then 64-bit old/len/nr so blocks may exceed 4 GB.
      sdnaIndex = view.getUint32(cursor + 4, littleEndian);
      address = view.getBigUint64(cursor + 8, littleEndian);
      length = Number(view.getBigUint64(cursor + 16, littleEndian));
      count = Number(view.getBigUint64(cursor + 24, littleEndian));
    } else {
      length = view.getInt32(cursor + 4, littleEndian);
      address = pointerSize === 8
        ? view.getBigUint64(cursor + 8, littleEndian)
        : BigInt(view.getUint32(cursor + 8, littleEndian));
      const tail = cursor + 8 + pointerSize;
      sdnaIndex = view.getInt32(tail, littleEndian);
      count = view.getInt32(tail + 4, littleEndian);
    }
    if (code === "ENDB") break;
    const start = cursor + recordSize;
    if (length < 0 || start + length > bytes.length) {
      throw new Error(`Block "${code}" at ${cursor} claims ${length} bytes beyond the end of the file.`);
    }
    blocks.push({ code, sdnaIndex, address, length, count, start });
    cursor = start + length;
  }
  return blocks;
}

/** A typed cursor over one struct instance inside the file. */
export class BlendStruct {
  constructor(
    readonly file: BlendFile,
    readonly struct: SdnaStruct,
    readonly offset: number,
    /** Writing-process address of this instance; the identity pointers use. */
    readonly address: bigint,
  ) {}

  get type(): string {
    return this.struct.name;
  }

  /**
   * Find a member, following Blender's struct-inheritance idiom: a derived
   * struct embeds its base as the first member, so `NodesModifierData` answers
   * for `ModifierData.name` and `Object` answers for `ID.name`. The base always
   * sits at offset 0, so only the field's own offset moves.
   */
  field(name: string): SdnaField | undefined {
    let struct: SdnaStruct | undefined = this.struct;
    for (let depth = 0; struct && depth < 8; depth += 1) {
      const found = struct.fieldByName.get(name);
      if (found) return found;
      const first: SdnaField | undefined = struct.fields[0];
      if (!first || first.pointer || first.arrayLength !== 1) return undefined;
      struct = this.file.sdna.structs[this.file.sdna.structIndexByType[first.typeIndex]];
    }
    return undefined;
  }

  has(name: string): boolean {
    return this.field(name) !== undefined;
  }

  /** Numeric value of `name`, optionally the element at `index` of an array. */
  number(name: string, index = 0): number {
    const field = this.field(name);
    if (!field) return 0;
    return this.file.readNumber(field, this.offset + field.offset, index);
  }

  /** Every element of a numeric array member, e.g. `location[2]` or `obmat[4][4]`. */
  numbers(name: string): number[] {
    const field = this.field(name);
    if (!field) return [];
    const values: number[] = new Array(field.arrayLength);
    for (let index = 0; index < field.arrayLength; index += 1) {
      values[index] = this.file.readNumber(field, this.offset + field.offset, index);
    }
    return values;
  }

  boolean(name: string): boolean {
    return this.number(name) !== 0;
  }

  /** NUL-terminated text held in a `char[]` member. */
  string(name: string): string {
    const field = this.field(name);
    if (!field || field.pointer) return "";
    return this.file.readString(this.offset + field.offset, field.size);
  }

  pointer(name: string): bigint {
    const field = this.field(name);
    if (!field || !field.pointer) return 0n;
    return this.file.readPointer(this.offset + field.offset);
  }

  /** Text behind a `char *` member. */
  pointerString(name: string): string {
    const address = this.pointer(name);
    const target = address ? this.file.blockAt(address) : null;
    if (!target) return "";
    const start = target.block.start + target.offset;
    return this.file.readString(start, target.block.length - target.offset);
  }

  /** An embedded struct member, e.g. `bNodeTree.id`. */
  child(name: string): BlendStruct | null {
    const field = this.field(name);
    if (!field || field.pointer) return null;
    const struct = this.file.sdna.structs[this.file.sdna.structIndexByType[field.typeIndex]];
    if (!struct) return null;
    return new BlendStruct(this.file, struct, this.offset + field.offset, this.address + BigInt(field.offset));
  }

  /** Follow a pointer member to the struct it addresses. */
  follow(name: string): BlendStruct | null {
    return this.file.structAt(this.pointer(name));
  }

  /** Follow a pointer member to every struct element of the addressed block. */
  followArray(name: string): BlendStruct[] {
    return this.file.arrayAt(this.pointer(name));
  }

  /** Walk a `ListBase` member through the `next` pointers of its elements. */
  list(name: string): BlendStruct[] {
    const base = this.child(name);
    if (!base) return [];
    const items: BlendStruct[] = [];
    const seen = new Set<string>();
    let address = base.pointer("first");
    while (address) {
      const key = address.toString();
      if (seen.has(key)) break;
      seen.add(key);
      const item = this.file.structAt(address);
      if (!item) break;
      items.push(item);
      if (items.length > 1_000_000) break;
      address = item.pointer("next");
    }
    return items;
  }

  /** Raw bytes of this struct instance. */
  bytes(): Uint8Array {
    return this.file.bytes.subarray(this.offset, this.offset + this.struct.size);
  }
}

export class BlendFile {
  readonly view: DataView;
  readonly sdna: Sdna;
  private readonly sortedBlocks: BlendBlock[];
  private readonly addresses: BigUint64Array;

  constructor(
    readonly bytes: Uint8Array,
    readonly header: BlendHeader,
    readonly blocks: BlendBlock[],
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dna = blocks.find((block) => block.code === "DNA1");
    if (!dna) throw new Error("This Blender file has no DNA1 struct catalogue.");
    this.sdna = parseSdna(
      bytes.subarray(dna.start, dna.start + dna.length),
      header.pointerSize,
      header.littleEndian,
    );
    this.sortedBlocks = blocks
      .filter((block) => block.address !== 0n && block.length > 0)
      .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0));
    this.addresses = BigUint64Array.from(this.sortedBlocks.map((block) => block.address));
  }

  /** Blocks carrying an ID datablock of the given two-character code. */
  idBlocks(code: string): BlendBlock[] {
    return this.blocks.filter((block) => block.code === code);
  }

  readPointer(at: number): bigint {
    return this.header.pointerSize === 8
      ? this.view.getBigUint64(at, this.header.littleEndian)
      : BigInt(this.view.getUint32(at, this.header.littleEndian));
  }

  readString(at: number, limit: number): string {
    let end = at;
    const stop = Math.min(at + limit, this.bytes.length);
    while (end < stop && this.bytes[end] !== 0) end += 1;
    return textDecoder.decode(this.bytes.subarray(at, end));
  }

  readNumber(field: SdnaField, at: number, index = 0): number {
    const little = this.header.littleEndian;
    if (field.pointer) return Number(this.readPointer(at + index * this.header.pointerSize));
    switch (field.typeName) {
      case "char":
      case "int8_t":
        return this.view.getInt8(at + index);
      case "uchar":
      case "uint8_t":
        return this.view.getUint8(at + index);
      case "short":
        return this.view.getInt16(at + index * 2, little);
      case "ushort":
      case "uint16_t":
        return this.view.getUint16(at + index * 2, little);
      case "int":
      case "long":
      case "int32_t":
        return this.view.getInt32(at + index * 4, little);
      case "uint":
      case "ulong":
      case "uint32_t":
        return this.view.getUint32(at + index * 4, little);
      case "int64_t":
        return Number(this.view.getBigInt64(at + index * 8, little));
      case "uint64_t":
        return Number(this.view.getBigUint64(at + index * 8, little));
      case "float":
        return this.view.getFloat32(at + index * 4, little);
      case "double":
        return this.view.getFloat64(at + index * 8, little);
      default:
        return 0;
    }
  }

  /** Resolve a writing-process address to the block that contains it. */
  blockAt(address: bigint): { block: BlendBlock; offset: number } | null {
    if (!address) return null;
    let low = 0;
    let high = this.addresses.length - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (this.addresses[middle] <= address) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (found < 0) return null;
    const block = this.sortedBlocks[found];
    const offset = Number(address - block.address);
    return offset < block.length ? { block, offset } : null;
  }

  /**
   * Typed cursor for the address. The struct type comes from the block record,
   * so a pointer to a base type still reads as the concrete written struct
   * (`ModifierData *` resolves to `NodesModifierData`, and so on).
   */
  structAt(address: bigint): BlendStruct | null {
    const target = this.blockAt(address);
    if (!target) return null;
    const struct = this.sdna.structs[target.block.sdnaIndex];
    if (!struct) return null;
    return new BlendStruct(this, struct, target.block.start + target.offset, address);
  }

  /** Every struct element of the block the address points into. */
  arrayAt(address: bigint): BlendStruct[] {
    const target = this.blockAt(address);
    if (!target) return [];
    const struct = this.sdna.structs[target.block.sdnaIndex];
    if (!struct || struct.size <= 0) return [];
    const start = target.block.start + target.offset;
    const available = Math.floor((target.block.length - target.offset) / struct.size);
    const items: BlendStruct[] = new Array(available);
    for (let index = 0; index < available; index += 1) {
      items[index] = new BlendStruct(this, struct, start + index * struct.size, address + BigInt(index * struct.size));
    }
    return items;
  }

  /** Struct cursor for the payload of a block, element `index`. */
  structOf(block: BlendBlock, index = 0): BlendStruct | null {
    const struct = this.sdna.structs[block.sdnaIndex];
    if (!struct) return null;
    return new BlendStruct(this, struct, block.start + index * struct.size, block.address + BigInt(index * struct.size));
  }

  /** Read `count` consecutive pointers stored at an address. */
  pointersAt(address: bigint, count: number): bigint[] {
    const target = this.blockAt(address);
    if (!target) return [];
    const start = target.block.start + target.offset;
    const available = Math.floor((target.block.length - target.offset) / this.header.pointerSize);
    const values: bigint[] = [];
    for (let index = 0; index < Math.min(count, available); index += 1) {
      values.push(this.readPointer(start + index * this.header.pointerSize));
    }
    return values;
  }

  /** Raw bytes the address points at, to the end of its block. */
  rawAt(address: bigint): Uint8Array | null {
    const target = this.blockAt(address);
    if (!target) return null;
    const start = target.block.start + target.offset;
    return this.bytes.subarray(start, target.block.start + target.block.length);
  }
}

/** Read an already-decompressed Blender file. */
export function readBlendFile(bytes: Uint8Array): BlendFile {
  const header = parseBlendHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new BlendFile(bytes, header, readBlocks(bytes, view, header));
}
