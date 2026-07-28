import type { BlendFile, BlendStruct } from "./blend-file";

/** `eIDPropertyType` from `DNA_ID.h`. Values 3 and 4 were retired. */
const IDP_STRING = 0;
const IDP_INT = 1;
const IDP_FLOAT = 2;
const IDP_ARRAY = 5;
const IDP_GROUP = 6;
const IDP_ID = 7;
const IDP_DOUBLE = 8;
const IDP_IDPARRAY = 9;
const IDP_BOOLEAN = 10;

const reinterpret = new DataView(new ArrayBuffer(8));

function intBitsToFloat(value: number): number {
  reinterpret.setInt32(0, value, true);
  return reinterpret.getFloat32(0, true);
}

export type IdPropertyValue =
  | string
  | number
  | boolean
  | null
  | { datablock: string; name: string }
  | IdPropertyValue[]
  | { [key: string]: IdPropertyValue };

/** Resolve an `ID *` to the `{datablock, name}` shape the portable dump uses. */
export type DatablockResolver = (address: bigint) => { datablock: string; name: string } | null;

function readArray(
  file: BlendFile,
  property: BlendStruct,
  data: BlendStruct,
  length: number,
): IdPropertyValue[] {
  const start = file.blockAt(data.pointer("pointer"));
  if (!start) return [];
  const at = start.block.start + start.offset;
  const available = start.block.length - start.offset;
  const subtype = property.number("subtype");
  const values: IdPropertyValue[] = [];
  const size = subtype === IDP_DOUBLE ? 8 : subtype === IDP_BOOLEAN ? 1 : 4;
  const count = Math.min(length, Math.floor(available / size));
  for (let index = 0; index < count; index += 1) {
    const offset = at + index * size;
    if (subtype === IDP_FLOAT) values.push(file.view.getFloat32(offset, file.header.littleEndian));
    else if (subtype === IDP_DOUBLE) values.push(file.view.getFloat64(offset, file.header.littleEndian));
    else if (subtype === IDP_BOOLEAN) values.push(file.view.getUint8(offset) !== 0);
    else values.push(file.view.getInt32(offset, file.header.littleEndian));
  }
  return values;
}

/** Decode one `IDProperty` node into a plain JSON value. */
export function readIdProperty(
  file: BlendFile,
  property: BlendStruct,
  datablock: DatablockResolver,
  depth = 0,
): IdPropertyValue {
  if (depth > 32) return null;
  const data = property.child("data");
  if (!data) return null;
  const type = property.number("type");
  const length = property.number("len");
  switch (type) {
    case IDP_STRING: {
      const target = file.blockAt(data.pointer("pointer"));
      if (!target) return "";
      return file.readString(target.block.start + target.offset, target.block.length - target.offset);
    }
    case IDP_INT:
      return data.number("val");
    case IDP_BOOLEAN:
      return data.number("val") !== 0;
    case IDP_FLOAT:
      return intBitsToFloat(data.number("val"));
    case IDP_DOUBLE: {
      const field = data.field("val");
      if (!field) return 0;
      return file.view.getFloat64(data.offset + field.offset, file.header.littleEndian);
    }
    case IDP_ARRAY:
      return readArray(file, property, data, length);
    case IDP_GROUP:
      return readIdPropertyGroup(file, property, datablock, depth + 1);
    case IDP_ID:
      return datablock(data.pointer("pointer"));
    case IDP_IDPARRAY: {
      const items = file.arrayAt(data.pointer("pointer"));
      return items.slice(0, length).map((item) => readIdProperty(file, item, datablock, depth + 1));
    }
    default:
      return null;
  }
}

/** Decode an `IDProperty` group (or a pointer to one) into an object. */
export function readIdPropertyGroup(
  file: BlendFile,
  group: BlendStruct | null,
  datablock: DatablockResolver,
  depth = 0,
): Record<string, IdPropertyValue> {
  const values: Record<string, IdPropertyValue> = {};
  if (!group) return values;
  const data = group.child("data");
  if (!data) return values;
  for (const child of data.list("group")) {
    values[child.string("name")] = readIdProperty(file, child, datablock, depth + 1);
  }
  return values;
}
