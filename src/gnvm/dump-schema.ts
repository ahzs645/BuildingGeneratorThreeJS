import type { Domain, Elem, Vec3 } from "./core";
import type { ExtractionMetadataV1 } from "./dependency-metadata";

/** A datablock reference serialized by Blender's RNA extractor. */
export interface DataRef {
  datablock?: string;
  name: string;
}

export interface FontAtlas {
  name: string;
  error?: string;
  unavailable?: boolean;
  filepath?: string;
  atlas_status?: "embedded" | "unavailable" | "error" | "skipped" | "not-referenced";
  source?: {
    status?: "builtin" | "packed-extractable" | "packed-unreadable"
      | "external-available" | "external-missing";
    authored_filepath?: string;
    packed_size_bytes?: number;
    binary_extractable?: boolean;
  };
  packed_binary?: {
    included?: boolean;
    encoding?: "base64";
    byte_length?: number;
    sha256?: string;
    data?: string;
    error?: string;
  };
  sample_stride?: number;
  align_offsets?: Record<string, number>;
  glyphs: Record<string, {
    advance: number;
    curves: { cyclic: boolean; points: number[][] }[];
  }>;
}

export interface RawSocket {
  name: string;
  identifier: string;
  idx?: number;
  type: string;
  linked: boolean;
  enabled?: boolean;
  hide?: boolean;
  hide_value?: boolean;
  display_shape?: string;
  value: any;
  default?: any;
  /** Preserve extractor additions from newer Blender versions. */
  [key: string]: unknown;
}

export interface RawOutput {
  name: string;
  identifier: string;
  idx?: number;
  type?: string;
  linked?: boolean;
  enabled?: boolean;
  hide?: boolean;
  hide_value?: boolean;
  display_shape?: string;
  value?: any;
  default?: any;
  /** Preserve extractor additions from newer Blender versions. */
  [key: string]: unknown;
}

export interface BakeSnapshotAttribute {
  domain: "POINT" | "EDGE" | "FACE" | "CORNER" | "CURVE" | "INSTANCE";
  data: unknown[];
}

export interface BakeSnapshotMesh {
  positions: Vec3[];
  edges: [number, number][];
  faces: number[][];
  face_material?: number[];
  material_slots?: (string | null)[];
  attributes?: Record<string, BakeSnapshotAttribute>;
}

export interface BakeSnapshotSpline {
  points: Vec3[];
  cyclic: boolean;
  spline_type?: "POLY" | "BEZIER" | "NURBS" | "CATMULL_ROM";
  resolution?: number;
  control_points?: Vec3[];
  bezier_left?: Vec3[];
  bezier_right?: Vec3[];
}

export interface BakeSnapshotGeometrySet {
  mesh?: BakeSnapshotMesh;
  curves?: BakeSnapshotSpline[];
  curve_attributes?: Record<string, BakeSnapshotAttribute>;
  instances?: {
    geometry: BakeSnapshotGeometrySet;
    position: Vec3;
    rotation: Vec3;
    scale: Vec3;
    transform_matrix?: number[][];
    attributes?: Record<string, unknown>;
  }[];
}

export interface BakeSnapshotVolumeGrid {
  background: number;
  min: Vec3;
  max: Vec3;
  resolution: Vec3;
  origin: Vec3;
  voxel_size: Vec3;
  values: number[];
  requested_voxel_size: number;
  requested_sample_count: number;
  budget_adjusted: boolean;
  sample_budget: number;
}

export type BakeSnapshotV2Item =
  | {
      socket_type: "NodeSocketGeometry";
      value_contract: "geometry-set";
      geometry: BakeSnapshotGeometrySet;
    }
  | {
      socket_type: "NodeSocketVolume";
      value_contract: "volume-grid";
      volume_grid: BakeSnapshotVolumeGrid;
    }
  | {
      socket_type: string;
      value_contract: "literal";
      value: unknown;
    };

export type BakeSnapshot =
  | {
      schema_version: 1;
      source: "blender-evaluated";
      frame: number;
      source_fingerprint_sha256?: string;
      items: Record<string, {
        socket_type: "NodeSocketGeometry";
        component_contract: "realized-mesh";
        geometry: BakeSnapshotMesh;
      }>;
    }
  | {
      schema_version: 2;
      source: "blender-evaluated";
      frame: number;
      source_fingerprint_sha256?: string;
      items: Record<string, BakeSnapshotV2Item>;
    };

export interface RawNode {
  name: string;
  type: string;
  label: string | null;
  ui?: {
    location?: number[];
    location_absolute?: number[];
    width?: number;
    height?: number;
    dimensions?: number[];
    hide?: boolean;
    mute?: boolean;
    parent?: string | null;
    use_custom_color?: boolean;
    color?: number[];
    [key: string]: unknown;
  };
  inputs: RawSocket[];
  outputs: RawOutput[];
  props?: Record<string, any>;
  baked_instances?: { position: Vec3; rotation?: Vec3; scale: Vec3 }[];
  bake_contract?: {
    items: {
      identifier: string;
      name: string;
      socket_type: string;
      has_live_input: boolean;
    }[];
    live_passthrough_portable: boolean;
    persistent_cache_portable: boolean;
    persistent_cache_status: "not-exported" | "portable-evaluated-snapshot";
    reason: string;
  };
  bake_snapshot?: BakeSnapshot;
  group?: string;
  /** Name of the paired output node for repeat/simulation zones. */
  paired_output?: string;
  /** Preserve opaque node payloads until the evaluator learns their semantics. */
  [key: string]: unknown;
}

export interface DumpLink {
  from_node: string;
  from_socket: string;
  to_node: string;
  to_socket: string;
  to_idx?: number | null;
  from_type?: string;
  to_type?: string;
  multi_input_sort_id?: number | null;
  muted?: boolean;
  [key: string]: unknown;
}

export interface DumpInterfaceItem {
  name: string;
  item_type: string;
  identifier?: string;
  in_out?: string;
  socket_type?: string;
  default?: unknown;
  min_value?: number;
  max_value?: number;
  subtype?: string;
  description?: string;
  parent_identifier?: string;
  default_closed?: boolean;
  hide_in_modifier?: boolean;
  hide_value?: boolean;
  [key: string]: unknown;
}

export interface DumpNodeGroup {
  name: string;
  type: string;
  nodes: RawNode[];
  links: DumpLink[];
  interface: DumpInterfaceItem[];
  animation?: DumpAnimation;
  [key: string]: unknown;
}

export interface DumpAnimationKeyframe {
  frame: number;
  value: number;
  interpolation?: string;
  easing?: string;
  handle_left?: [number, number];
  handle_right?: [number, number];
}

export interface DumpAnimationFCurve {
  data_path: string;
  array_index: number;
  extrapolation?: string;
  keyframes: DumpAnimationKeyframe[];
}

export interface DumpAnimation {
  action: string;
  frame_range: [number, number];
  fcurves: DumpAnimationFCurve[];
}

export interface DumpUnitSettings {
  system?: string;
  system_rotation?: string;
  scale_length?: number;
  length_unit?: string;
  mass_unit?: string;
  time_unit?: string;
  temperature_unit?: string;
}

export interface DumpMeshAttribute {
  domain: Domain;
  data: Elem[];
  [key: string]: unknown;
}

export interface DumpMesh {
  verts: number[][];
  faces: number[][];
  face_materials?: number[];
  /** Blender polygon.use_smooth, aligned one-to-one with faces. */
  face_smooth?: boolean[];
  edges?: [number, number][];
  attributes?: Record<string, DumpMeshAttribute>;
  [key: string]: unknown;
}

export interface DumpEvaluatedMesh extends DumpMesh {
  materials?: (string | null)[];
}

export interface DumpCurve {
  points: number[][];
  control_points?: number[][];
  bezier_left?: number[][];
  bezier_right?: number[][];
  cyclic: boolean;
  resolution?: number;
  tilts?: number[];
  radii?: number[];
  tangents?: number[][];
  normals?: number[][];
  [key: string]: unknown;
}

export interface DumpModifier {
  name?: string;
  type: string;
  show_viewport?: boolean;
  show_render?: boolean;
  node_group?: string;
  input_values?: Record<string, any>;
  object?: string;
  vertex_indices?: number[];
  matrix_inverse?: number[][];
  strength?: number;
  falloff_type?: string;
  falloff_radius?: number;
  use_falloff_uniform?: boolean;
  vertex_group?: string;
  invert_vertex_group?: boolean;
  [key: string]: unknown;
}

export interface DumpObject {
  name: string;
  type?: string;
  location?: number[];
  rotation?: number[];
  scale?: number[];
  matrix_world?: number[][];
  relative_matrices?: Record<string, number[][]>;
  visible?: boolean;
  materials?: (string | null)[];
  mesh?: DumpMesh;
  evaluated_mesh?: DumpEvaluatedMesh;
  curves?: DumpCurve[];
  modifiers?: DumpModifier[];
  node_dojo_dependency_snapshot?: string;
  [key: string]: unknown;
}

export interface DumpImage {
  name: string;
  filepath?: string;
  size: number[];
  pixels_rgba8?: string;
  channels?: number;
  [key: string]: unknown;
}

/**
 * Canonical portable graph payload consumed by GN-VM, the editor, and material
 * adapters. Unknown properties remain legal so newer extractors round-trip
 * through an older browser without data loss.
 */
export interface Dump {
  node_groups: Record<string, DumpNodeGroup>;
  blender_version?: string;
  scene?: {
    frame_current?: number;
    frame_start?: number;
    frame_end?: number;
    fps?: number;
    fps_base?: number;
    unit_settings?: DumpUnitSettings;
    [key: string]: unknown;
  };
  collections?: { name: string; objects: string[]; [key: string]: unknown }[];
  images?: DumpImage[];
  fonts?: Record<string, FontAtlas>;
  dependency_objects?: string[];
  extraction_metadata?: ExtractionMetadataV1;
  objects?: DumpObject[];
  materials?: Record<string, DumpNodeGroup>;
  shader_node_groups?: Record<string, DumpNodeGroup>;
  [key: string]: unknown;
}

export interface DumpValidationIssue {
  code: string;
  path: string;
  message: string;
}

export class DumpValidationError extends TypeError {
  constructor(public readonly issues: DumpValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "DumpValidationError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function requireString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: DumpValidationIssue[],
): void {
  if (typeof value[key] !== "string") {
    issues.push({ code: "EXPECTED_STRING", path: `${path}.${key}`, message: "expected a string" });
  }
}

function validateSocket(
  value: unknown,
  path: string,
  issues: DumpValidationIssue[],
  input: boolean,
): void {
  if (!isRecord(value)) {
    issues.push({ code: "EXPECTED_OBJECT", path, message: "expected a socket object" });
    return;
  }
  requireString(value, "name", path, issues);
  requireString(value, "identifier", path, issues);
  if (input) {
    requireString(value, "type", path, issues);
    if (typeof value.linked !== "boolean")
      issues.push({ code: "EXPECTED_BOOLEAN", path: `${path}.linked`, message: "expected a boolean" });
  }
}

function validateNode(value: unknown, path: string, issues: DumpValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ code: "EXPECTED_OBJECT", path, message: "expected a node object" });
    return;
  }
  requireString(value, "name", path, issues);
  requireString(value, "type", path, issues);
  for (const key of ["inputs", "outputs"] as const) {
    const sockets = value[key];
    if (sockets !== undefined && !Array.isArray(sockets)) {
      issues.push({ code: "EXPECTED_ARRAY", path: `${path}.${key}`, message: "expected an array" });
      continue;
    }
    for (const [index, socket] of (sockets ?? []).entries())
      validateSocket(socket, `${path}.${key}[${index}]`, issues, key === "inputs");
  }
}

function validateLink(value: unknown, path: string, issues: DumpValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ code: "EXPECTED_OBJECT", path, message: "expected a link object" });
    return;
  }
  for (const key of ["from_node", "from_socket", "to_node", "to_socket"])
    requireString(value, key, path, issues);
}

function validateGroup(value: unknown, path: string, issues: DumpValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ code: "EXPECTED_OBJECT", path, message: "expected a node-group object" });
    return;
  }
  for (const key of ["nodes", "links", "interface"] as const) {
    if (value[key] !== undefined && !Array.isArray(value[key]))
      issues.push({ code: "EXPECTED_ARRAY", path: `${path}.${key}`, message: "expected an array" });
  }
  if (Array.isArray(value.nodes))
    for (const [index, node] of value.nodes.entries()) validateNode(node, `${path}.nodes[${index}]`, issues);
  if (Array.isArray(value.links))
    for (const [index, link] of value.links.entries()) validateLink(link, `${path}.links[${index}]`, issues);
}

function validateMeshSmoothness(value: unknown, path: string, issues: DumpValidationIssue[]): void {
  if (!isRecord(value) || value.face_smooth === undefined) return;
  if (!Array.isArray(value.face_smooth)) {
    issues.push({
      code: "EXPECTED_ARRAY",
      path: `${path}.face_smooth`,
      message: "expected an array",
    });
    return;
  }
  for (const [index, smooth] of value.face_smooth.entries()) {
    if (typeof smooth !== "boolean") {
      issues.push({
        code: "EXPECTED_BOOLEAN",
        path: `${path}.face_smooth[${index}]`,
        message: "expected a boolean",
      });
    }
  }
  if (Array.isArray(value.faces) && value.face_smooth.length !== value.faces.length) {
    issues.push({
      code: "LENGTH_MISMATCH",
      path: `${path}.face_smooth`,
      message: `expected ${value.faces.length} values to match faces`,
    });
  }
}

/** Return structural problems without rejecting unknown, forward-compatible data. */
export function validateDump(value: unknown): DumpValidationIssue[] {
  const issues: DumpValidationIssue[] = [];
  if (!isRecord(value)) {
    return [{ code: "EXPECTED_OBJECT", path: "$", message: "expected a Geometry Nodes dump object" }];
  }
  if (!isRecord(value.node_groups)) {
    issues.push({ code: "MISSING_NODE_GROUPS", path: "$.node_groups", message: "expected an object" });
  } else {
    for (const [name, group] of Object.entries(value.node_groups))
      validateGroup(group, `$.node_groups[${JSON.stringify(name)}]`, issues);
  }
  if (value.objects !== undefined && !Array.isArray(value.objects)) {
    issues.push({ code: "EXPECTED_ARRAY", path: "$.objects", message: "expected an array" });
  } else if (Array.isArray(value.objects)) {
    for (const [index, object] of value.objects.entries()) {
      const path = `$.objects[${index}]`;
      if (!isRecord(object)) {
        issues.push({ code: "EXPECTED_OBJECT", path, message: "expected an object" });
        continue;
      }
      requireString(object, "name", path, issues);
      if (object.modifiers !== undefined && !Array.isArray(object.modifiers))
        issues.push({ code: "EXPECTED_ARRAY", path: `${path}.modifiers`, message: "expected an array" });
      validateMeshSmoothness(object.mesh, `${path}.mesh`, issues);
      validateMeshSmoothness(object.evaluated_mesh, `${path}.evaluated_mesh`, issues);
    }
  }
  return issues;
}

const arrayOrEmpty = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

function normalizeNode(value: Record<string, unknown>): RawNode {
  return {
    ...value,
    name: value.name as string,
    type: value.type as string,
    label: typeof value.label === "string" ? value.label : null,
    inputs: arrayOrEmpty<RawSocket>(value.inputs),
    outputs: arrayOrEmpty<RawOutput>(value.outputs),
  };
}

function normalizeGroup(name: string, value: Record<string, unknown>): DumpNodeGroup {
  return {
    ...value,
    name: typeof value.name === "string" ? value.name : name,
    type: typeof value.type === "string" ? value.type : "GeometryNodeTree",
    nodes: arrayOrEmpty<Record<string, unknown>>(value.nodes).map(normalizeNode),
    links: arrayOrEmpty<DumpLink>(value.links),
    interface: arrayOrEmpty<DumpInterfaceItem>(value.interface),
  };
}

/**
 * Validate and minimally normalize a JSON boundary. Missing legacy arrays are
 * supplied as empty arrays; all unknown fields and nested opaque values survive.
 */
export function normalizeDump(value: unknown): Dump {
  const issues = validateDump(value);
  if (issues.length) throw new DumpValidationError(issues);
  const source = value as Record<string, unknown>;
  const groups = source.node_groups as Record<string, Record<string, unknown>>;
  return {
    ...source,
    node_groups: Object.fromEntries(
      Object.entries(groups).map(([name, group]) => [name, normalizeGroup(name, group)]),
    ),
  } as Dump;
}
