/**
 * Small fixed enumerations that Blender stores as integers in DNA but exposes
 * as identifier strings through RNA. Only the values the portable dump needs
 * are mapped; anything unknown is reported rather than guessed.
 */

/** `Object.type` — `DNA_object_types.h`. */
export const OBJECT_TYPE: Record<number, string> = {
  0: "EMPTY",
  1: "MESH",
  2: "CURVE",
  3: "SURFACE",
  4: "FONT",
  5: "META",
  10: "LIGHT",
  11: "CAMERA",
  12: "SPEAKER",
  13: "LIGHT_PROBE",
  22: "LATTICE",
  25: "ARMATURE",
  26: "GPENCIL",
  27: "CURVES",
  28: "POINTCLOUD",
  29: "VOLUME",
  30: "GREASEPENCIL",
};

/** `eModifierType` — `DNA_modifier_types.h`, matched to RNA identifiers. */
export const MODIFIER_TYPE: Record<number, string> = {
  1: "SUBSURF",
  2: "LATTICE",
  3: "CURVE",
  4: "BUILD",
  5: "MIRROR",
  6: "DECIMATE",
  7: "WAVE",
  8: "ARMATURE",
  9: "HOOK",
  10: "SOFT_BODY",
  11: "BOOLEAN",
  12: "ARRAY",
  13: "EDGE_SPLIT",
  14: "DISPLACE",
  15: "UV_PROJECT",
  16: "SMOOTH",
  17: "CAST",
  18: "MESH_DEFORM",
  19: "PARTICLE_SYSTEM",
  20: "PARTICLE_INSTANCE",
  21: "EXPLODE",
  22: "CLOTH",
  23: "COLLISION",
  24: "BEVEL",
  25: "SHRINKWRAP",
  26: "FLUID_SIMULATION",
  27: "MASK",
  28: "SIMPLE_DEFORM",
  29: "MULTIRES",
  30: "SURFACE",
  31: "SMOKE",
  32: "SHAPE_KEY",
  33: "SOLIDIFY",
  34: "SCREW",
  35: "WARP",
  36: "VERTEX_WEIGHT_EDIT",
  37: "VERTEX_WEIGHT_MIX",
  38: "VERTEX_WEIGHT_PROXIMITY",
  39: "OCEAN",
  40: "DYNAMIC_PAINT",
  41: "REMESH",
  42: "SKIN",
  43: "LAPLACIANSMOOTH",
  44: "TRIANGULATE",
  45: "UV_WARP",
  46: "MESH_CACHE",
  47: "LAPLACIANDEFORM",
  48: "WIREFRAME",
  49: "DATA_TRANSFER",
  50: "NORMAL_EDIT",
  51: "CORRECTIVE_SMOOTH",
  52: "MESH_SEQUENCE_CACHE",
  53: "SURFACE_DEFORM",
  54: "WEIGHTED_NORMAL",
  55: "WELD",
  56: "FLUID",
  57: "NODES",
  58: "MESH_TO_VOLUME",
  59: "VOLUME_DISPLACE",
  60: "VOLUME_TO_MESH",
};

/**
 * `eNodeSocketDisplayShape`. Values 0, 2, 6, and 7 are confirmed against
 * Blender's extractor by `tools/blend-calibrate-enums.ts`; the rest keep the
 * documented order. Blender re-derives this shape from its socket-inference
 * pass when it opens a file, so the stored value is a hint, not a guarantee.
 */
export const SOCKET_DISPLAY_SHAPE: Record<number, string> = {
  0: "CIRCLE",
  1: "SQUARE",
  2: "DIAMOND",
  3: "CIRCLE_DOT",
  4: "SQUARE_DOT",
  5: "DIAMOND_DOT",
  6: "LINE",
  7: "VOLUME_GRID",
};

/**
 * `PropertySubType` — `RNA_types.hh`. The stored integer packs a unit in its
 * high bits (`PROP_UNIT_LENGTH` and friends), so callers mask before lookup.
 * Every entry below either carries no unit or was confirmed by calibration;
 * values outside the table are reported instead of guessed.
 */
export const PROPERTY_SUBTYPE: Record<number, string> = {
  0: "NONE",
  1: "FILE_PATH",
  2: "DIR_PATH",
  3: "FILE_NAME",
  4: "BYTE_STRING",
  6: "PASSWORD",
  12: "PIXEL",
  13: "UNSIGNED",
  14: "PERCENTAGE",
  15: "FACTOR",
  16: "ANGLE",
  18: "DISTANCE",
  21: "TRANSLATION",
  26: "EULER",
  29: "XYZ",
};

/** `PROP_UNIT_*` occupies the high half of a subtype. */
export const PROPERTY_SUBTYPE_UNIT_MASK = 0xffff0000;
export const PROPERTY_SUBTYPE_VALUE_MASK = 0x0000ffff;
export const PROPERTY_UNIT_TIME = 6 << 16;
export const PROPERTY_UNIT_TIME_ABSOLUTE = 7 << 16;

/**
 * `bNodeSocket.flag`, `bNode.flag`, and `bNodeLink.flag` bits, each solved from
 * Blender's own extraction by `tools/blend-calibrate-enums.ts`.
 */
export const SOCK_HIDDEN = 1 << 1;
export const SOCK_UNAVAIL = 1 << 3;
export const SOCK_HIDE_VALUE = 1 << 7;
export const SOCK_MULTI_INPUT = 1 << 13;

export const NODE_HIDDEN = 1 << 3;
export const NODE_MUTED = 1 << 9;
export const NODE_CUSTOM_COLOR = 1 << 15;

export const NODE_LINK_MUTED = 1 << 4;

/** `NodeTreeInterfaceSocketFlag`. */
export const INTERFACE_SOCKET_INPUT = 1 << 0;
export const INTERFACE_SOCKET_OUTPUT = 1 << 1;
export const INTERFACE_SOCKET_HIDE_VALUE = 1 << 2;
export const INTERFACE_SOCKET_HIDE_IN_MODIFIER = 1 << 3;

/** `NodeTreeInterfacePanelFlag`. */
export const INTERFACE_PANEL_DEFAULT_CLOSED = 1 << 0;

/** `Object.restrictflag` (`visibility_flag` in RNA). */
export const OB_HIDE_RENDER = 1 << 2;

/** Two-character ID block codes mapped to their RNA class names. */
export const ID_TYPE_NAME: Record<string, string> = {
  AC: "Action",
  AR: "Armature",
  BR: "Brush",
  CF: "CacheFile",
  CU: "Curve",
  CV: "Curves",
  GD: "GreasePencil",
  GR: "Collection",
  IM: "Image",
  KE: "Key",
  LA: "Light",
  LS: "FreestyleLineStyle",
  LT: "Lattice",
  MA: "Material",
  MB: "MetaBall",
  ME: "Mesh",
  NT: "NodeTree",
  OB: "Object",
  PA: "ParticleSettings",
  PC: "PaintCurve",
  PT: "PointCloud",
  SC: "Scene",
  SO: "Sound",
  TE: "Texture",
  TX: "Text",
  VF: "VectorFont",
  VO: "Volume",
  WO: "World",
  WS: "WorkSpace",
};
