import type { BlendFile, BlendStruct } from "./blend-file";
import { readIdPropertyGroup, type DatablockResolver, type IdPropertyValue } from "./id-properties";
import {
  ID_TYPE_NAME,
  INTERFACE_PANEL_DEFAULT_CLOSED,
  INTERFACE_SOCKET_HIDE_IN_MODIFIER,
  INTERFACE_SOCKET_HIDE_VALUE,
  INTERFACE_SOCKET_INPUT,
  MODIFIER_TYPE,
  NODE_CUSTOM_COLOR,
  NODE_HIDDEN,
  NODE_LINK_MUTED,
  NODE_MUTED,
  OBJECT_TYPE,
  OB_HIDE_RENDER,
  PROPERTY_SUBTYPE,
  PROPERTY_SUBTYPE_UNIT_MASK,
  PROPERTY_SUBTYPE_VALUE_MASK,
  PROPERTY_UNIT_TIME_ABSOLUTE,
  SOCKET_DISPLAY_SHAPE,
  SOCK_HIDDEN,
  SOCK_HIDE_VALUE,
  SOCK_UNAVAIL,
} from "./enums";

/** One capability the browser decoder cannot supply from the file alone. */
export interface PortableGap {
  code: string;
  detail: string;
  count: number;
  /** Node types, object names, or other identities the gap applies to. */
  subjects?: string[];
}

export interface DecodedBlend {
  dump: Record<string, unknown>;
  gaps: PortableGap[];
}

type Json = unknown;

class GapLog {
  private readonly entries = new Map<string, { code: string; detail: string; count: number; subjects: Set<string> }>();

  add(code: string, detail: string, subject?: string): void {
    const entry = this.entries.get(code) ?? { code, detail, count: 0, subjects: new Set<string>() };
    entry.count += 1;
    if (subject) entry.subjects.add(subject);
    this.entries.set(code, entry);
  }

  list(): PortableGap[] {
    return [...this.entries.values()]
      .sort((a, b) => b.count - a.count)
      .map((entry) => ({
        code: entry.code,
        detail: entry.detail,
        count: entry.count,
        ...(entry.subjects.size ? { subjects: [...entry.subjects].sort().slice(0, 64) } : {}),
      }));
  }
}

/** Strip the two-character type prefix Blender stores in `ID.name`. */
function idName(block: BlendStruct | null): string {
  const id = block?.child("id");
  return id ? id.string("name").slice(2) : "";
}

/** A datablock linked from another `.blend` has its contents in that file. */
function libraryPath(block: BlendStruct | null): string {
  const library = block?.child("id")?.follow("lib");
  if (!library) return "";
  return library.has("filepath") ? library.string("filepath") : library.string("name");
}

function float32(value: number): number {
  return Math.fround(value);
}

export interface StoredNodeLayout {
  name: string;
  parent?: string | null;
  /** Blender 5+ local node location. */
  location?: number[];
  /** Blender 4.x stored coordinates and frame offsets. */
  locx?: number;
  locy?: number;
  offsetx?: number;
  offsety?: number;
}

export interface ResolvedNodeLayout {
  location: [number, number];
  location_absolute: [number, number];
}

/**
 * Normalize node coordinates without keying behavior to a Blender version.
 * Modern DNA carries `location`; legacy DNA carries locx/locy plus frame
 * offsets. Blender's versioning code subtracts the parent frame offset from a
 * child while upgrading, after which absolute positions are a recursive sum.
 */
export function resolveStoredNodeLayouts(
  records: StoredNodeLayout[],
): Map<string, ResolvedNodeLayout> {
  const byName = new Map(records.map((record) => [record.name, record]));
  const resolved = new Map<string, ResolvedNodeLayout>();
  const resolving = new Set<string>();

  const localOf = (record: StoredNodeLayout): [number, number] => {
    if (record.location && record.location.length >= 2) {
      return [Number(record.location[0]) || 0, Number(record.location[1]) || 0];
    }
    const parent = record.parent ? byName.get(record.parent) : undefined;
    return [
      (Number(record.locx) || 0) + (Number(record.offsetx) || 0) - (Number(parent?.offsetx) || 0),
      (Number(record.locy) || 0) + (Number(record.offsety) || 0) - (Number(parent?.offsety) || 0),
    ];
  };

  const visit = (record: StoredNodeLayout): ResolvedNodeLayout => {
    const cached = resolved.get(record.name);
    if (cached) return cached;
    const location = localOf(record);
    if (resolving.has(record.name)) {
      const cyclic = { location, location_absolute: location } satisfies ResolvedNodeLayout;
      resolved.set(record.name, cyclic);
      return cyclic;
    }
    resolving.add(record.name);
    const parent = record.parent ? byName.get(record.parent) : undefined;
    const parentAbsolute = parent ? visit(parent).location_absolute : [0, 0];
    resolving.delete(record.name);
    const result: ResolvedNodeLayout = {
      location,
      location_absolute: [location[0] + parentAbsolute[0], location[1] + parentAbsolute[1]],
    };
    resolved.set(record.name, result);
    return result;
  };

  for (const record of records) visit(record);
  return resolved;
}

function multiply(a: number[][], b: number[][]): number[][] {
  const out: number[][] = [];
  for (let row = 0; row < 4; row += 1) {
    out.push([0, 1, 2, 3].map((column) =>
      a[row][0] * b[0][column] + a[row][1] * b[1][column] + a[row][2] * b[2][column] + a[row][3] * b[3][column]));
  }
  return out;
}

/** Blender stores 4x4 matrices column-major; the dump keeps mathutils row order. */
function matrixRows(values: number[]): number[][] {
  const rows: number[][] = [];
  for (let row = 0; row < 4; row += 1) {
    rows.push([0, 1, 2, 3].map((column) => float32(values[column * 4 + row])));
  }
  return rows;
}

function eulerMatrix(rotation: number[], order: number): number[][] {
  const [x, y, z] = rotation;
  const axis = (angle: number, which: 0 | 1 | 2): number[][] => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    if (which === 0) return [[1, 0, 0, 0], [0, c, -s, 0], [0, s, c, 0], [0, 0, 0, 1]];
    if (which === 1) return [[c, 0, s, 0], [0, 1, 0, 0], [-s, 0, c, 0], [0, 0, 0, 1]];
    return [[c, -s, 0, 0], [s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  };
  // `Object.rotmode` 1..6 spell the intrinsic order; Blender composes them as
  // outer-to-inner matrix products.
  const orders: Record<number, [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2]> = {
    1: [2, 1, 0],
    2: [1, 2, 0],
    3: [2, 0, 1],
    4: [0, 2, 1],
    5: [1, 0, 2],
    6: [0, 1, 2],
  };
  const [outer, middle, inner] = orders[order] ?? orders[1];
  const angles = [x, y, z];
  return multiply(multiply(axis(angles[outer], outer), axis(angles[middle], middle)), axis(angles[inner], inner));
}

function quaternionMatrix(q: number[]): number[][] {
  const [w, x, y, z] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
    [0, 0, 0, 1],
  ];
}

function basisMatrix(object: BlendStruct): number[][] {
  const location = object.numbers("loc");
  const delta = object.numbers("dloc");
  const scale = object.numbers("size");
  const deltaScale = object.numbers("dscale");
  const rotmode = object.number("rotmode");
  const rotation = rotmode === 0
    ? quaternionMatrix(object.numbers("quat"))
    : rotmode < 0
      ? quaternionMatrix([Math.cos(object.number("rotAngle") / 2), ...object.numbers("rotAxis").map((value) =>
          value * Math.sin(object.number("rotAngle") / 2))])
      : eulerMatrix(object.numbers("rot"), rotmode);
  const matrix: number[][] = [];
  for (let row = 0; row < 4; row += 1) {
    matrix.push([0, 1, 2, 3].map((column) => {
      if (row === 3) return column === 3 ? 1 : 0;
      if (column === 3) return (location[row] ?? 0) + (delta[row] ?? 0);
      return rotation[row][column] * (scale[column] ?? 1) * (deltaScale[column] || 1);
    }));
  }
  return matrix;
}

export function buildPortableDump(
  file: BlendFile,
  meta: { filename?: string; bytes?: number; envelope?: string } = {},
): DecodedBlend {
  const gaps = new GapLog();

  const datablockRef: DatablockResolver = (address) => {
    const target = file.blockAt(address);
    if (!target) return null;
    const struct = file.structAt(address);
    const name = idName(struct);
    if (!name) return null;
    const code = target.block.code;
    const className = code === "NT"
      ? struct?.string("idname") || "NodeTree"
      : ID_TYPE_NAME[code] ?? code;
    return { datablock: className, name };
  };

  const socketValue = (socket: BlendStruct): Json => {
    const value = socket.follow("default_value");
    if (!value) return null;
    switch (value.type) {
      case "bNodeSocketValueFloat":
      case "bNodeSocketValueInt":
        return value.number("value");
      case "bNodeSocketValueBoolean":
        return value.boolean("value");
      case "bNodeSocketValueVector": {
        const dimensions = value.has("dimensions") ? value.number("dimensions") || 3 : 3;
        return value.numbers("value").slice(0, Math.min(4, Math.max(2, dimensions)));
      }
      case "bNodeSocketValueRGBA":
        return value.numbers("value");
      case "bNodeSocketValueRotation":
        return value.numbers("value_euler");
      case "bNodeSocketValueString":
        return value.string("value");
      case "bNodeSocketValueMenu":
        gaps.add(
          "MENU_SOCKET_VALUE_UNRESOLVED",
          "Menu socket defaults are stored as integers; Blender resolves them to enum identifiers at runtime.",
        );
        return value.number("value");
      default:
        // Every datablock socket stores exactly one ID pointer named `value`
        // (Object, Collection, Material, Image, Texture, VectorFont, …).
        if (value.field("value")?.pointer) return datablockRef(value.pointer("value"));
        gaps.add("SOCKET_VALUE_TYPE_UNKNOWN", `No decoder for socket value struct ${value.type}.`, value.type);
        return null;
    }
  };

  /** Split a packed `PropertySubType` into its unit and identifier. */
  const subtypeName = (packed: number): string | null => {
    const value = packed & PROPERTY_SUBTYPE_VALUE_MASK;
    if (value === 17) {
      return (packed & PROPERTY_SUBTYPE_UNIT_MASK) === PROPERTY_UNIT_TIME_ABSOLUTE ? "TIME_ABSOLUTE" : "TIME";
    }
    const name = PROPERTY_SUBTYPE[value];
    if (!name) {
      gaps.add(
        "SOCKET_SUBTYPE_UNKNOWN",
        "A socket subtype integer has no calibrated identifier; rerun tools/blend-calibrate-enums.ts to extend the table.",
        String(packed),
      );
      return null;
    }
    return name;
  };

  const socketMeta = (socket: BlendStruct, linked: boolean): Record<string, Json> => {
    const flag = socket.number("flag");
    return {
      name: socket.string("name"),
      identifier: socket.string("identifier"),
      type: socket.string("idname"),
      linked,
      enabled: (flag & SOCK_UNAVAIL) === 0,
      hide: (flag & SOCK_HIDDEN) !== 0,
      hide_value: (flag & SOCK_HIDE_VALUE) !== 0,
      display_shape: SOCKET_DISPLAY_SHAPE[socket.number("display_shape")] ?? "CIRCLE",
    };
  };

  const interfaceCache = new Map<string, Record<string, Json>[]>();
  const interfaceItems = (tree: BlendStruct): Record<string, Json>[] => {
    const cached = interfaceCache.get(tree.address.toString());
    if (cached) return cached;
    const root = tree.child("tree_interface")?.child("root_panel");
    if (!root) return [];
    const entries: Record<string, Json>[] = [];
    const walk = (panel: BlendStruct, parentIdentifier: Json, depth: number): void => {
      if (depth > 32) return;
      const addresses = file.pointersAt(panel.pointer("items_array"), panel.number("items_num"));
      for (const address of addresses) {
        const item = file.structAt(address);
        if (!item) continue;
        const isPanel = item.type === "bNodeTreeInterfacePanel";
        const name = item.pointerString("name");
        const entry: Record<string, Json> = {
          name,
          item_type: isPanel ? "PANEL" : "SOCKET",
        };
        // Panels carry only an internal integer id, which Blender's RNA does not
        // expose; the extractor falls back to the panel name for both keys.
        if (!isPanel) entry.identifier = item.pointerString("identifier");
        entry.parent_identifier = parentIdentifier;
        const description = item.pointerString("description");
        if (description) entry.description = description;
        const flag = item.number("flag");
        if (isPanel) {
          entry.default_closed = (flag & INTERFACE_PANEL_DEFAULT_CLOSED) !== 0;
          entries.push(entry);
          walk(item, name, depth + 1);
          continue;
        }
        entry.in_out = (flag & INTERFACE_SOCKET_INPUT) !== 0 ? "INPUT" : "OUTPUT";
        entry.socket_type = item.pointerString("socket_type");
        entry.hide_in_modifier = (flag & INTERFACE_SOCKET_HIDE_IN_MODIFIER) !== 0;
        entry.hide_value = (flag & INTERFACE_SOCKET_HIDE_VALUE) !== 0;
        const data = item.follow("socket_data");
        if (data) {
          switch (data.type) {
            case "bNodeSocketValueFloat":
            case "bNodeSocketValueInt":
              entry.default = data.number("value");
              entry.min_value = data.number("min");
              entry.max_value = data.number("max");
              {
                const subtype = subtypeName(data.number("subtype"));
                if (subtype) entry.subtype = subtype;
              }
              break;
            case "bNodeSocketValueVector": {
              const dimensions = data.has("dimensions") ? data.number("dimensions") || 3 : 3;
              entry.default = data.numbers("value").slice(0, Math.min(4, Math.max(2, dimensions)));
              entry.min_value = data.number("min");
              entry.max_value = data.number("max");
              {
                const subtype = subtypeName(data.number("subtype"));
                if (subtype) entry.subtype = subtype;
              }
              break;
            }
            case "bNodeSocketValueBoolean":
              entry.default = data.boolean("value");
              break;
            case "bNodeSocketValueRGBA":
              entry.default = data.numbers("value");
              break;
            case "bNodeSocketValueRotation":
              entry.default = data.numbers("value_euler");
              break;
            case "bNodeSocketValueString":
              entry.default = data.string("value");
              {
                const subtype = subtypeName(data.number("subtype"));
                if (subtype) entry.subtype = subtype;
              }
              break;
            case "bNodeSocketValueMenu":
              gaps.add(
                "MENU_SOCKET_VALUE_UNRESOLVED",
                "Menu socket defaults are stored as integers; Blender resolves them to enum identifiers at runtime.",
              );
              entry.default = data.number("value");
              break;
            default:
              if (data.field("value")?.pointer) entry.default = datablockRef(data.pointer("value"));
              break;
          }
        }
        entries.push(entry);
      }
    };
    walk(root, "", 0);
    interfaceCache.set(tree.address.toString(), entries);
    return entries;
  };

  const annotations: Record<string, Json> = {};
  const decodedAnnotationPointers = new Map<string, string>();
  const GP_LAYER_HIDE = 1 << 0;
  const GP_LAYER_LOCKED = 1 << 1;
  const GP_LAYER_ACTIVE = 1 << 2;
  const GP_LAYER_FRAMELOCK = 1 << 11;
  const GP_STROKE_3DSPACE = 1 << 0;
  const GP_STROKE_2DSPACE = 1 << 1;
  const GP_STROKE_2DIMAGE = 1 << 2;
  const GP_STROKE_CYCLIC = 1 << 7;

  const decodeAnnotation = (gpd: BlendStruct | null): string | null => {
    if (!gpd) return null;
    const pointerKey = gpd.address.toString();
    const cached = decodedAnnotationPointers.get(pointerKey);
    if (cached) return cached;
    const name = idName(gpd) || `Annotation@${pointerKey}`;
    decodedAnnotationPointers.set(pointerKey, name);
    annotations[name] = {
      name,
      onion: Boolean(gpd.number("onion_flag")),
      layers: gpd.list("layers").map((layer) => {
        const flags = layer.number("flag");
        const activeFrame = layer.follow("actframe");
        return {
          name: layer.string("info") || "Note",
          flags,
          hidden: (flags & GP_LAYER_HIDE) !== 0,
          locked: (flags & GP_LAYER_LOCKED) !== 0,
          active: (flags & GP_LAYER_ACTIVE) !== 0,
          frame_locked: (flags & GP_LAYER_FRAMELOCK) !== 0,
          color: layer.numbers("color").slice(0, 3),
          opacity: layer.has("opacity") ? layer.number("opacity") : 1,
          thickness: layer.has("thickness") ? layer.number("thickness") : 3,
          active_frame: activeFrame ? activeFrame.number("framenum") : null,
          frames: layer.list("frames").map((frame) => ({
            number: frame.number("framenum"),
            flags: frame.number("flag"),
            strokes: frame.list("strokes").map((stroke) => {
              const strokeFlags = stroke.number("flag");
              const pointCount = Math.max(0, stroke.number("totpoints"));
              const points = stroke.followArray("points").slice(0, pointCount).map((point) => [
                point.number("x"),
                point.number("y"),
                point.number("z"),
                point.has("pressure") ? point.number("pressure") : 1,
                point.has("strength") ? point.number("strength") : 1,
                point.has("time") ? point.number("time") : 0,
                point.has("flag") ? point.number("flag") : 0,
              ]);
              const space = (strokeFlags & GP_STROKE_2DSPACE) !== 0
                ? "VIEW2D"
                : (strokeFlags & GP_STROKE_2DIMAGE) !== 0
                  ? "IMAGE"
                  : (strokeFlags & GP_STROKE_3DSPACE) !== 0
                    ? "WORLD"
                    : "SCREEN";
              return {
                flags: strokeFlags,
                space,
                cyclic: (strokeFlags & GP_STROKE_CYCLIC) !== 0,
                thickness: stroke.has("thickness") ? stroke.number("thickness") : 0,
                ...(stroke.has("caps") ? { caps: stroke.numbers("caps").slice(0, 2) } : {}),
                points,
              };
            }),
          })),
        };
      }),
    };
    return name;
  };

  const nodeDump = (
    node: BlendStruct,
    linkedSockets: Set<string>,
    nodesByIdentifier: Map<number, BlendStruct>,
    layout: ResolvedNodeLayout,
  ): Record<string, Json> => {
    const flag = node.number("flag");
    const type = node.string("idname");
    const parent = node.follow("parent");
    const isLinked = (socket: BlendStruct): boolean => linkedSockets.has(socket.address.toString());
    const entry: Record<string, Json> = {
      name: node.string("name"),
      type,
      label: node.string("label") || null,
      ui: {
        location: layout.location,
        location_absolute: layout.location_absolute,
        width: node.number("width"),
        height: node.number("height"),
        hide: (flag & NODE_HIDDEN) !== 0,
        mute: (flag & NODE_MUTED) !== 0,
        use_custom_color: (flag & NODE_CUSTOM_COLOR) !== 0,
        color: node.numbers("color"),
        parent: parent ? parent.string("name") : null,
      },
      inputs: node.list("inputs").map((socket, index) => {
        const linked = isLinked(socket);
        return { ...socketMeta(socket, linked), idx: index, value: linked ? null : socketValue(socket) };
      }),
      outputs: node.list("outputs").map((socket) => ({
        ...socketMeta(socket, isLinked(socket)),
        default: socketValue(socket),
      })),
    };
    const storage = node.follow("storage");
    if (type === "NodeFrame" && storage) {
      entry.props = {
        label_size: storage.has("label_size") ? storage.number("label_size") : 20,
        shrink: (storage.number("flag") & 1) !== 0,
      };
    }
    if (storage?.has("output_node_id")) {
      const paired = nodesByIdentifier.get(storage.number("output_node_id"));
      if (paired) entry.paired_output = paired.string("name");
    }
    if (type === "GeometryNodeGroup") {
      const group = node.follow("id");
      if (group) entry.group = idName(group);
    }
    if (type === "GeometryNodeImportSTL") {
      gaps.add(
        "STL_PAYLOAD_NOT_EMBEDDED",
        "Import STL reads a path from the authoring machine; the browser decoder cannot embed its triangles.",
        type,
      );
    }
    if (type === "GeometryNodeStringToCurves") {
      gaps.add(
        "FONT_OUTLINES_NOT_EMBEDDED",
        "String to Curves needs Blender-evaluated vector-font outlines, which are not recoverable from DNA alone.",
        type,
      );
    }
    return entry;
  };

  const treeDump = (tree: BlendStruct): Record<string, Json> => {
    const name = idName(tree);
    const nodes = tree.list("nodes");
    const links = tree.list("links");
    const layoutByName = resolveStoredNodeLayouts(nodes.map((node) => {
      const parent = node.follow("parent");
      return {
        name: node.string("name"),
        parent: parent ? parent.string("name") : null,
        ...(node.has("location") ? { location: node.numbers("location") } : {}),
        locx: node.number("locx"),
        locy: node.number("locy"),
        offsetx: node.number("offsetx"),
        offsety: node.number("offsety"),
      };
    }));
    const nodesByIdentifier = new Map<number, BlendStruct>();
    const socketIndex = new Map<string, { node: string; identifier: string; type: string; index: number }>();
    for (const node of nodes) {
      nodesByIdentifier.set(node.number("identifier"), node);
      const nodeName = node.string("name");
      const record = (sockets: BlendStruct[]): void => {
        sockets.forEach((socket, index) => {
          socketIndex.set(socket.address.toString(), {
            node: nodeName,
            identifier: socket.string("identifier"),
            type: socket.string("idname"),
            index,
          });
        });
      };
      record(node.list("inputs"));
      record(node.list("outputs"));
    }

    const linkedSocketAddresses = new Set<string>();
    const linkEntries: Record<string, Json>[] = [];
    for (const link of links) {
      const from = socketIndex.get(link.pointer("fromsock").toString());
      const to = socketIndex.get(link.pointer("tosock").toString());
      linkedSocketAddresses.add(link.pointer("fromsock").toString());
      linkedSocketAddresses.add(link.pointer("tosock").toString());
      if (!from || !to) {
        gaps.add("LINK_ENDPOINT_UNRESOLVED", `A link in "${name}" references a socket outside the tree.`, name);
        continue;
      }
      const entry: Record<string, Json> = {
        from_node: from.node,
        from_socket: from.identifier,
        to_node: to.node,
        to_socket: to.identifier,
        to_idx: to.index,
        from_type: from.type,
        to_type: to.type,
      };
      const sortId = link.number("multi_input_socket_index");
      if (sortId) entry.multi_input_sort_id = sortId;
      if ((link.number("flag") & NODE_LINK_MUTED) !== 0) entry.muted = true;
      linkEntries.push(entry);
    }

    if (tree.pointer("adt")) {
      gaps.add(
        "TREE_ANIMATION_NOT_DECODED",
        "Animated node-tree values (F-curves and drivers) are not decoded by the browser reader.",
        name,
      );
    }

    const annotation = decodeAnnotation(tree.follow("gpd"));
    return {
      name,
      type: tree.string("idname"),
      interface: interfaceItems(tree),
      nodes: nodes.map((node) => nodeDump(
        node,
        linkedSocketAddresses,
        nodesByIdentifier,
        layoutByName.get(node.string("name")) ?? { location: [0, 0], location_absolute: [0, 0] },
      )),
      links: linkEntries,
      ...(annotation ? { annotation } : {}),
      ...(tree.has("view_center") ? { view_center: tree.numbers("view_center").slice(0, 2) } : {}),
    };
  };

  const nodeTreeBlocks = file.idBlocks("NT")
    .map((block) => file.structOf(block))
    .filter((tree): tree is BlendStruct => Boolean(tree));

  const nodeGroups: Record<string, Json> = {};
  const shaderNodeGroups: Record<string, Json> = {};
  for (const tree of nodeTreeBlocks) {
    const name = idName(tree);
    const idname = tree.string("idname");
    const library = libraryPath(tree);
    if (library) {
      gaps.add(
        "LINKED_LIBRARY_NOT_RESOLVED",
        "Some datablocks are linked from another .blend; only the reference is stored in this file.",
        `${name} ← ${library}`,
      );
    }
    if (idname === "GeometryNodeTree") nodeGroups[name] = treeDump(tree);
    else if (idname === "ShaderNodeTree") shaderNodeGroups[name] = treeDump(tree);
  }

  const materials: Record<string, Json> = {};
  for (const block of file.idBlocks("MA")) {
    const material = file.structOf(block);
    if (!material) continue;
    const tree = material.follow("nodetree");
    if (!tree || !material.number("use_nodes")) continue;
    materials[idName(material)] = treeDump(tree);
  }

  const objectStructs = new Map<string, BlendStruct>();
  for (const block of file.idBlocks("OB")) {
    const object = file.structOf(block);
    if (!object) continue;
    objectStructs.set(idName(object), object);
    const library = libraryPath(object);
    if (library) {
      gaps.add(
        "LINKED_LIBRARY_NOT_RESOLVED",
        "Some datablocks are linked from another .blend; only the reference is stored in this file.",
        `${idName(object)} ← ${library}`,
      );
    }
  }

  const worldMatrices = new Map<string, number[][]>();
  const worldMatrix = (object: BlendStruct, depth = 0): number[][] => {
    const name = idName(object);
    const cached = worldMatrices.get(name);
    if (cached) return cached;
    const basis = basisMatrix(object);
    const parent = depth < 32 ? object.follow("parent") : null;
    const matrix = parent && object.number("partype") === 0
      ? multiply(multiply(worldMatrix(parent, depth + 1), matrixRows(object.numbers("parentinv"))), basis)
      : basis;
    worldMatrices.set(name, matrix);
    return matrix;
  };

  const objects: Record<string, Json>[] = [];
  for (const [name, object] of objectStructs) {
    const data = object.follow("data");
    const dataBlock = file.blockAt(object.pointer("data"));
    const type = OBJECT_TYPE[object.number("type")] ?? "EMPTY";
    const entry: Record<string, Json> = {
      name,
      type,
      location: object.numbers("loc"),
      rotation: object.numbers("rot"),
      scale: object.numbers("size"),
      matrix_world: worldMatrix(object).map((row) => row.map(float32)),
      visible: (object.number("restrictflag") & OB_HIDE_RENDER) === 0,
      modifiers: [],
      materials: data && (dataBlock?.block.code === "ME" || dataBlock?.block.code === "CU")
        ? file.pointersAt(data.pointer("mat"), data.number("totcol"))
            .map((address) => datablockRef(address)?.name ?? null)
        : [],
    };
    gaps.add(
      "WORLD_MATRIX_RECOMPOSED",
      "Object matrices are recomposed from stored transforms; Blender's dump uses evaluated depsgraph matrices.",
    );
    if (type === "MESH" && data) {
      const verts = data.has("verts_num") ? data.number("verts_num") : data.number("totvert");
      const faces = data.has("faces_num") ? data.number("faces_num") : data.number("totpoly");
      entry.mesh_stats = { verts, faces };
      if (verts > 0) {
        gaps.add(
          "BASE_MESH_NOT_EMBEDDED",
          "Base mesh vertex, edge, face, and attribute payloads are not extracted by the browser decoder.",
          name,
        );
      }
    }

    const modifiers: Record<string, Json>[] = [];
    for (const modifier of object.list("modifiers")) {
      const modifierType = MODIFIER_TYPE[modifier.number("type")]
        ?? modifier.type.replace(/ModifierData$/, "").toUpperCase();
      const record: Record<string, Json> = {
        name: modifier.string("name"),
        type: modifierType,
        // `eModifierMode_Realtime` / `_Render` in `ModifierData.mode`.
        show_viewport: (modifier.number("mode") & 1) !== 0,
        show_render: (modifier.number("mode") & 2) !== 0,
      };
      if (modifierType === "NODES") {
        const group = modifier.follow("node_group");
        if (group) {
          record.node_group = idName(group);
          const settings = modifier.child("settings");
          const properties = settings ? settings.follow("properties") : null;
          const stored = readIdPropertyGroup(file, properties, datablockRef);
          record.input_values = modifierInputValues(group, stored);
        }
      }
      if (modifierType === "HOOK") {
        gaps.add(
          "HOOK_MODIFIER_PAYLOAD_PARTIAL",
          "Hook modifier vertex indices and falloff are not decoded by the browser reader.",
          name,
        );
      }
      modifiers.push(record);
    }
    entry.modifiers = modifiers;
    objects.push(entry);
  }

  /** Reproduce the extractor's identifier-first, name-second binding table. */
  function modifierInputValues(
    group: BlendStruct,
    stored: Record<string, IdPropertyValue>,
  ): Record<string, Json> {
    const items = interfaceItems(group).filter((item) => item.item_type === "SOCKET" && item.in_out === "INPUT");
    const nameCounts = new Map<string, number>();
    for (const item of items) {
      const name = String(item.name ?? "");
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
    const values: Record<string, Json> = {};
    for (const item of items) {
      const identifier = String(item.identifier ?? "");
      if (!(identifier in stored)) continue;
      let value: Json = stored[identifier];
      // Older files store a boolean socket as an integer property. Blender's RNA
      // reports it through the socket's declared type, so follow the interface.
      if (item.socket_type === "NodeSocketBool" && typeof value === "number") value = value !== 0;
      if (stored[`${identifier}_use_attribute`]) {
        const attribute = stored[`${identifier}_attribute_name`];
        if (typeof attribute === "string" && attribute) value = { attribute, value };
      }
      values[identifier] = value;
      const name = String(item.name ?? "");
      if (nameCounts.get(name) === 1) values[name] = value;
    }
    return values;
  }

  const collections: Record<string, Json>[] = [];
  for (const block of file.idBlocks("GR")) {
    const collection = file.structOf(block);
    if (!collection) continue;
    const members = collection.list("gobject")
      .map((link) => idName(link.follow("ob")))
      .filter(Boolean);
    collections.push({ name: idName(collection), objects: members });
  }

  const images: Record<string, Json>[] = [];
  for (const block of file.idBlocks("IM")) {
    const image = file.structOf(block);
    if (!image) continue;
    // Blender still calls the image's source path `name` in DNA; newer releases
    // may expose it under the RNA spelling instead.
    images.push({
      name: idName(image),
      filepath: image.has("filepath") ? image.string("filepath") : image.string("name"),
    });
    gaps.add(
      "IMAGE_PIXELS_NOT_EMBEDDED",
      "Image pixels and resolution are not decoded; packed and external textures stay Blender-side.",
      idName(image),
    );
  }

  // `FileGlobal` records the exact Blender build that wrote the file, which is
  // the only thing that makes the version-upgrade gap below actionable.
  const global = file.idBlocks("GLOB").map((block) => file.structOf(block))[0] ?? null;
  const sceneBlock = file.idBlocks("SC").map((block) => file.structOf(block))[0] ?? null;
  const renderData = sceneBlock?.child("r") ?? null;
  const subversion = global?.number("subversion") ?? 0;
  const authoredBy = `${file.header.version}.${subversion}`;

  const dump: Record<string, Json> = {
    blender_version: file.header.version,
    ...(renderData ? {
      scene: {
        frame_current: renderData.number("cfra"),
        frame_start: renderData.number("sfra"),
        frame_end: renderData.number("efra"),
        fps: renderData.number("frs_sec"),
        fps_base: renderData.has("frs_sec_base") ? renderData.number("frs_sec_base") : 1,
      },
    } : {}),
    extraction_source: {
      extractor: "blend-decode-ts",
      file_format: file.header.fileFormat,
      envelope: meta.envelope ?? "raw",
      pointer_size: file.header.pointerSize,
      dna_structs: file.sdna.structs.length,
      authored_by: authoredBy,
      authored_path: global?.string("filepath") ?? "",
      build_hash: global?.string("build_hash") ?? "",
    },
    objects,
    collections,
    node_groups: nodeGroups,
    shader_node_groups: shaderNodeGroups,
    materials,
    annotations,
    images,
    fonts: {},
    dependency_objects: [],
  };
  if (meta.filename || meta.bytes !== undefined) {
    dump.import_meta = {
      filename: meta.filename,
      bytes: meta.bytes,
      blender_version: file.header.version,
      extracted_at: new Date().toISOString(),
      transient: true,
    };
  }

  gaps.add(
    "NODE_PROPERTIES_NOT_DECODED",
    "Node enum/mode/data-type properties live in DNA as untagged integers; identifier names need a Blender-derived table.",
  );
  gaps.add(
    "VERSION_UPGRADE_NOT_APPLIED",
    `The graph is reported as authored by Blender ${authoredBy}. Opening it in a newer Blender would run version-upgrade`
    + " passes that can add nodes and sockets; this decoder reads the file as written.",
  );
  gaps.add(
    "SOCKET_DISPLAY_SHAPE_INFERRED",
    "Socket display shapes are read from the file, but Blender recomputes them from its field/structure inference pass,"
    + " so editor-visible shapes can differ.",
  );

  return { dump, gaps: gaps.list() };
}
