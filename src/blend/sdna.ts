/**
 * Reader for Blender's embedded struct catalogue (the `DNA1` block).
 *
 * Every `.blend` file carries the exact C layout of the structs it was written
 * with, which is what makes a self-describing file readable by a decoder that
 * was never compiled against that Blender version.
 */

export interface SdnaField {
  /** Declared name with the pointer/array decoration stripped. */
  name: string;
  /** Raw declaration as written by the compiler, e.g. `*next` or `name[64]`. */
  declaration: string;
  typeName: string;
  typeIndex: number;
  /** Byte offset from the start of the owning struct. */
  offset: number;
  /** Total byte size of the member, including every array dimension. */
  size: number;
  pointer: boolean;
  /** Product of all array dimensions; 1 for scalars. */
  arrayLength: number;
  /** Per-dimension array lengths, outermost first. */
  dimensions: number[];
}

export interface SdnaStruct {
  index: number;
  name: string;
  size: number;
  fields: SdnaField[];
  fieldByName: Map<string, SdnaField>;
}

export interface Sdna {
  names: string[];
  types: string[];
  typeSizes: number[];
  structs: SdnaStruct[];
  structByName: Map<string, SdnaStruct>;
  /** Struct index for each type index, or -1 for primitive types. */
  structIndexByType: Int32Array;
  pointerSize: number;
}

function parseDeclaration(declaration: string): {
  name: string;
  pointer: boolean;
  dimensions: number[];
} {
  let name = declaration;
  let pointer = false;
  // Function pointers are declared `(*callback)()` and occupy one pointer.
  const functionPointer = /^\(\*+(\w+)\)\(\)$/.exec(name);
  if (functionPointer) return { name: functionPointer[1], pointer: true, dimensions: [] };
  while (name.startsWith("*")) {
    pointer = true;
    name = name.slice(1);
  }
  const dimensions: number[] = [];
  for (const match of name.matchAll(/\[(\d+)\]/g)) dimensions.push(Number(match[1]));
  const bracket = name.indexOf("[");
  if (bracket >= 0) name = name.slice(0, bracket);
  return { name, pointer, dimensions };
}

/**
 * Parse the payload of a `DNA1` block.
 *
 * Layout: `SDNA` `NAME`<n><strings> `TYPE`<n><strings> `TLEN`<shorts>
 * `STRC`<n>{type, fieldCount, (type, name)*}. Every section is 4-byte aligned.
 */
export function parseSdna(data: Uint8Array, pointerSize: number, littleEndian = true): Sdna {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let cursor = 0;

  const tag = (expected: string): void => {
    const found = String.fromCharCode(...data.subarray(cursor, cursor + 4));
    if (found !== expected) throw new Error(`DNA1 is malformed: expected "${expected}" at ${cursor}, found "${found}".`);
    cursor += 4;
  };
  const align4 = (): void => { cursor = (cursor + 3) & ~3; };
  const readStrings = (count: number): string[] => {
    const values: string[] = new Array(count);
    for (let index = 0; index < count; index += 1) {
      const start = cursor;
      while (cursor < data.length && data[cursor] !== 0) cursor += 1;
      values[index] = String.fromCharCode(...data.subarray(start, cursor));
      cursor += 1;
    }
    return values;
  };

  const readCount = (): number => {
    const value = view.getInt32(cursor, littleEndian);
    cursor += 4;
    return value;
  };

  tag("SDNA");
  tag("NAME");
  const names = readStrings(readCount());
  align4();
  tag("TYPE");
  const typeCount = readCount();
  const types = readStrings(typeCount);
  align4();
  tag("TLEN");
  const typeSizes: number[] = new Array(typeCount);
  for (let index = 0; index < typeCount; index += 1) {
    typeSizes[index] = view.getUint16(cursor, littleEndian);
    cursor += 2;
  }
  align4();
  tag("STRC");
  const structCount = readCount();

  const structs: SdnaStruct[] = new Array(structCount);
  const structByName = new Map<string, SdnaStruct>();
  const structIndexByType = new Int32Array(typeCount).fill(-1);
  for (let index = 0; index < structCount; index += 1) {
    const typeIndex = view.getUint16(cursor, littleEndian);
    const fieldCount = view.getUint16(cursor + 2, littleEndian);
    cursor += 4;
    const fields: SdnaField[] = new Array(fieldCount);
    const fieldByName = new Map<string, SdnaField>();
    let offset = 0;
    for (let field = 0; field < fieldCount; field += 1) {
      const fieldTypeIndex = view.getUint16(cursor, littleEndian);
      const nameIndex = view.getUint16(cursor + 2, littleEndian);
      cursor += 4;
      const declaration = names[nameIndex];
      const parsed = parseDeclaration(declaration);
      const arrayLength = parsed.dimensions.reduce((product, value) => product * value, 1);
      const elementSize = parsed.pointer ? pointerSize : typeSizes[fieldTypeIndex];
      const entry: SdnaField = {
        name: parsed.name,
        declaration,
        typeName: types[fieldTypeIndex],
        typeIndex: fieldTypeIndex,
        offset,
        size: elementSize * arrayLength,
        pointer: parsed.pointer,
        arrayLength,
        dimensions: parsed.dimensions,
      };
      // Blender pads its structs explicitly, so DNA members are contiguous.
      offset += entry.size;
      fields[field] = entry;
      if (!fieldByName.has(entry.name)) fieldByName.set(entry.name, entry);
    }
    const record: SdnaStruct = {
      index,
      name: types[typeIndex],
      size: typeSizes[typeIndex],
      fields,
      fieldByName,
    };
    structs[index] = record;
    structIndexByType[typeIndex] = index;
    if (!structByName.has(record.name)) structByName.set(record.name, record);
  }

  return { names, types, typeSizes, structs, structByName, structIndexByType, pointerSize };
}
