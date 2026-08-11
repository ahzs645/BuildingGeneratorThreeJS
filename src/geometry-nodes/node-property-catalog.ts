/**
 * The enum node properties the editor is allowed to offer, and the values each
 * one accepts.
 *
 * Blender draws these inside the node body — a Math node reads "Multiply", not
 * just two Value sockets — and the extraction dump preserves the current value
 * in `RawNode.props`. What the dump cannot carry is the option list: it stores
 * one value per node, never the enum it came from. The editor needs that list
 * from somewhere, and the only trustworthy source is the GN-VM.
 *
 * So every option below was read off the branch in `src/gnvm/nodes/*` that
 * consumes it, not off Blender's enum definitions, because the two differ in
 * ways a dropdown would hide. `ShaderNodeMath` resolves an unknown operation to
 * `MATH.ADD`, so a "Hyperbolic Sine" entry would evaluate as Add and look like
 * a broken node rather than a missing feature. `ShaderNodeVectorMath` is worse:
 * REFRACT is listed in its own `VECTOR_MATH_OPS` set yet has no `case`, so it
 * falls through to passing Vector A straight out *without* recording a miss.
 * An option earns its place here only when the VM does something different
 * with it, which is why several lists are shorter than Blender's.
 *
 * Four groups are deliberately absent:
 *
 * 1. Properties that choose which socket *identifier* the handler reads.
 *    `FunctionNodeCompare.data_type` swaps `A`/`B` for `A_INT`/`B_INT`, and the
 *    dump carries both pairs with the `enabled` flags Blender froze at export.
 *    Flipping the property alone would leave the editor drawing the old sockets
 *    while the evaluator quietly read the new, unlinked ones — the node would
 *    keep its wires on screen and ignore them. The same holds for
 *    `ShaderNodeMix.data_type` and `factor_mode`, `ShaderNodeMapRange.data_type`,
 *    `FunctionNodeRandomValue.data_type` and `GeometryNodeSwitch.input_type`.
 *    Recomputing socket enablement is the missing piece there, not the dropdown.
 *
 * 2. Properties no handler reads. `ShaderNodeMix.blend_type` and
 *    `ShaderNodeMath.use_clamp` are in every dump and change nothing in the VM.
 *
 * 3. Properties whose values the VM cannot tell apart.
 *    `GeometryNodeStoreNamedAttribute.data_type` only separates BYTE_COLOR from
 *    everything else, and `FunctionNodeAlignRotationToVector.pivot_axis` only
 *    separates AUTO from everything else, so most of their Blender options
 *    would be several labels for one behaviour.
 *
 * 4. Properties that current dumps supersede with a menu input socket. Blender
 *    5 exports Resample Curve, Fill Curve and Merge by Distance with a `Mode`
 *    socket and no `mode` prop, and the handlers read the socket first; a prop
 *    dropdown there would write a key nothing consults.
 *
 * Extending this is one entry in ENUM_PROPERTIES, plus an OPTION_LABELS entry
 * where title-casing the identifier reads wrong.
 */

export interface NodePropertyOption {
  /** Blender's enum identifier, stored verbatim in `RawNode.props`. */
  value: string;
  label: string;
}

export interface NodePropertyDescriptor {
  prop: string;
  label: string;
  options: NodePropertyOption[];
}

/** A descriptor resolved against one node's current property value. */
export interface NodePropertyControl extends NodePropertyDescriptor {
  value: string;
}

const DOMAINS = ["POINT", "EDGE", "FACE", "CORNER", "CURVE", "INSTANCE"];
/** Delete/Separate Geometry have no CORNER branch — Blender omits it too. */
const ELEMENT_DOMAINS = ["POINT", "EDGE", "FACE", "CURVE", "INSTANCE"];
const AXES = ["X", "Y", "Z"];
const CAP_FILLS = ["NONE", "NGON", "TRIANGLE_FAN"];

const ENUM_PROPERTIES: Record<string, Record<string, string[]>> = {
  // math.ts — MATH table keys, in Blender's menu order. TRUNCATE is a VM-only
  // alias of Blender's TRUNC and would be a duplicate row.
  ShaderNodeMath: {
    operation: [
      "ADD", "SUBTRACT", "MULTIPLY", "DIVIDE", "MULTIPLY_ADD",
      "POWER", "LOGARITHM", "SQRT", "INVERSE_SQRT", "ABSOLUTE", "EXPONENT",
      "MINIMUM", "MAXIMUM", "LESS_THAN", "GREATER_THAN", "SIGN", "COMPARE",
      "SMOOTH_MIN", "SMOOTH_MAX",
      "ROUND", "FLOOR", "CEIL", "TRUNC", "FRACT", "MODULO", "FLOORED_MODULO",
      "WRAP", "SNAP", "PINGPONG",
      "SINE", "COSINE", "TANGENT", "ARCSINE", "ARCCOSINE", "ARCTANGENT",
      "ARCTAN2", "RADIANS", "DEGREES",
    ],
  },
  // math.ts — INTEGER_MATH table keys.
  FunctionNodeIntegerMath: {
    operation: [
      "ADD", "SUBTRACT", "MULTIPLY", "DIVIDE", "MULTIPLY_ADD",
      "ABSOLUTE", "NEGATE", "POWER", "MINIMUM", "MAXIMUM", "SIGN",
      "DIVIDE_ROUND", "DIVIDE_FLOOR", "DIVIDE_CEIL",
      "FLOORED_MODULO", "MODULO", "GCD", "LCM",
    ],
  },
  // math.ts — the `switch (op)` cases only. REFRACT and WRAP are in Blender's
  // menu and absent from the switch.
  ShaderNodeVectorMath: {
    operation: [
      "ADD", "SUBTRACT", "MULTIPLY", "DIVIDE", "MULTIPLY_ADD",
      "CROSS_PRODUCT", "PROJECT", "REFLECT", "FACEFORWARD",
      "DOT_PRODUCT", "DISTANCE", "LENGTH", "SCALE", "NORMALIZE",
      "ABSOLUTE", "MINIMUM", "MAXIMUM", "FLOOR", "CEIL", "FRACTION",
      "MODULO", "SNAP", "SINE", "COSINE", "TANGENT",
    ],
  },
  FunctionNodeBooleanMath: {
    operation: ["AND", "OR", "NOT", "NAND", "NOR", "XOR", "XNOR", "IMPLY", "NIMPLY"],
  },
  // math.ts — the `cmp` switch. Blender's colour/vector/string comparisons
  // (BRIGHTER, DIRECTION, …) hit its `default: x > y` instead.
  FunctionNodeCompare: {
    operation: ["LESS_THAN", "LESS_EQUAL", "GREATER_THAN", "GREATER_EQUAL", "EQUAL", "NOT_EQUAL"],
  },
  FunctionNodeFloatToInt: {
    rounding_mode: ["ROUND", "FLOOR", "CEILING", "TRUNCATE"],
  },
  ShaderNodeMapRange: {
    interpolation_type: ["LINEAR", "STEPPED", "SMOOTHSTEP", "SMOOTHERSTEP"],
  },
  ShaderNodeVectorRotate: {
    rotation_type: ["AXIS_ANGLE", "X_AXIS", "Y_AXIS", "Z_AXIS", "EULER_XYZ"],
  },

  // fields.ts — axisIndex() understands X/Y/Z and treats anything else as X.
  FunctionNodeAlignEulerToVector: { axis: AXES },
  // pivot_axis is omitted: only AUTO takes its own branch, so X, Y and Z would
  // be three labels for one behaviour.
  FunctionNodeAlignRotationToVector: { axis: AXES },
  FunctionNodeAxesToRotation: { primary_axis: AXES, secondary_axis: AXES },
  FunctionNodeRotateRotation: { rotation_space: ["GLOBAL", "LOCAL"] },
  FunctionNodeRotateEuler: { space: ["OBJECT", "LOCAL"] },

  GeometryNodeCaptureAttribute: { domain: DOMAINS },
  GeometryNodeStoreNamedAttribute: { domain: DOMAINS },
  GeometryNodeFieldAtIndex: { domain: DOMAINS },
  GeometryNodeFieldOnDomain: { domain: DOMAINS },
  GeometryNodeFieldMinAndMax: { domain: DOMAINS },
  GeometryNodeSetShadeSmooth: { domain: ["FACE", "EDGE"] },
  // meshops.ts — EDGE_FACE is missing on purpose: only ONLY_FACE has its own
  // branch, and ALL is what the handler already does for everything else.
  GeometryNodeDeleteGeometry: { domain: ELEMENT_DOMAINS, mode: ["ALL", "ONLY_FACE"] },
  GeometryNodeSeparateGeometry: { domain: ELEMENT_DOMAINS },
  GeometryNodeMeshToPoints: { mode: ["VERTICES", "EDGES", "FACES"] },
  GeometryNodeExtrudeMesh: { mode: ["VERTICES", "EDGES", "FACES"] },
  GeometryNodeProximity: { target_element: ["POINTS", "EDGES", "FACES"] },

  GeometryNodeMeshLine: { mode: ["OFFSET", "END_POINTS"] },
  GeometryNodeMeshCircle: { fill_type: CAP_FILLS },
  GeometryNodeMeshCone: { fill_type: CAP_FILLS },
  GeometryNodeMeshCylinder: { fill_type: CAP_FILLS },

  GeometryNodeCurveSplineType: { spline_type: ["POLY", "BEZIER", "NURBS", "CATMULL_ROM"] },
  GeometryNodeCurveArc: { mode: ["RADIUS", "POINTS"] },
  GeometryNodeCurveToPoints: { mode: ["EVALUATED", "COUNT", "LENGTH"] },
  GeometryNodeTrimCurve: { mode: ["FACTOR", "LENGTH"] },
  GeometryNodeSampleCurve: { mode: ["FACTOR", "LENGTH"] },
  GeometryNodeSetCurveHandlePositions: { mode: ["LEFT", "RIGHT"] },

  GeometryNodeDistributePointsOnFaces: { distribute_method: ["RANDOM", "POISSON"] },
  GeometryNodeMeshBoolean: {
    operation: ["INTERSECT", "UNION", "DIFFERENCE"],
    solver: ["FLOAT", "EXACT"],
  },
  GeometryNodeObjectInfo: { transform_space: ["ORIGINAL", "RELATIVE"] },
  GeometryNodeCollectionInfo: { transform_space: ["ORIGINAL", "RELATIVE"] },

  // extra.ts — 1D and 2D noise are absent because the handler routes anything
  // that is not "4D" through the same 3D evaluator.
  ShaderNodeTexNoise: { noise_dimensions: ["3D", "4D"] },
  ShaderNodeTexGabor: { gabor_type: ["2D", "3D"] },
  // bands_direction and rings_direction are both implemented but both live in
  // every dump, and Blender only ever draws the one matching wave_type. Two
  // simultaneous "Direction" dropdowns would misrepresent the node.
  ShaderNodeTexWave: {
    wave_type: ["BANDS", "RINGS"],
    wave_profile: ["SIN", "SAW", "TRI"],
  },
};

/** Identifiers whose Blender label is not the title-cased identifier. */
const OPTION_LABELS: Record<string, string> = {
  ARCTAN2: "Arctan2",
  AXIS_ANGLE: "Axis Angle",
  CATMULL_ROM: "Catmull-Rom",
  EULER_XYZ: "Euler XYZ",
  FRACT: "Fraction",
  GCD: "GCD",
  INVERSE_SQRT: "Inverse Square Root",
  LCM: "LCM",
  NGON: "N-Gon",
  NURBS: "NURBS",
  ONLY_FACE: "Only Faces",
  PINGPONG: "Ping-Pong",
  SIN: "Sine",
  SAW: "Saw",
  SQRT: "Square Root",
  TRI: "Triangle",
  TRUNC: "Truncate",
  X_AXIS: "X Axis",
  Y_AXIS: "Y Axis",
  Z_AXIS: "Z Axis",
  "3D": "3D",
  "4D": "4D",
  "2D": "2D",
};

const titleCase = (identifier: string): string => identifier
  .toLowerCase()
  .split("_")
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  .join(" ");

const optionLabel = (value: string): string => OPTION_LABELS[value] ?? titleCase(value);

const descriptorCache = new Map<string, NodePropertyDescriptor[]>();

/**
 * Enum descriptors for a node type, or an empty array when the VM branches on
 * nothing this editor can safely change. Callers render nothing for the empty
 * case rather than an inert control.
 */
export function nodePropertyDescriptors(nodeType: string): NodePropertyDescriptor[] {
  const cached = descriptorCache.get(nodeType);
  if (cached) return cached;
  const declared = ENUM_PROPERTIES[nodeType];
  const descriptors: NodePropertyDescriptor[] = declared
    ? Object.entries(declared).map(([prop, values]) => ({
      prop,
      label: titleCase(prop),
      options: values.map((value) => ({ value, label: optionLabel(value) })),
    }))
    : [];
  descriptorCache.set(nodeType, descriptors);
  return descriptors;
}

/**
 * Resolve a node type's descriptors against the property values a specific node
 * carries.
 *
 * A dump may hold a value the VM never implemented — the whole point of the
 * catalog is that Blender's enums are wider. Dropping it from the option list
 * would make the `<select>` display a neighbouring value and rewrite the graph
 * on the first interaction, so the authored value is prepended instead. It
 * reads as itself, and switching away to a supported value is a repair rather
 * than a surprise.
 */
export function nodePropertyControls(
  nodeType: string,
  props: Record<string, unknown> | undefined,
): NodePropertyControl[] {
  const controls: NodePropertyControl[] = [];
  for (const descriptor of nodePropertyDescriptors(nodeType)) {
    const raw = props?.[descriptor.prop];
    // An absent property means the node relies on the handler's own fallback,
    // which the catalog does not duplicate; leave it to the socket-only card.
    if (typeof raw !== "string") continue;
    const known = descriptor.options.some((option) => option.value === raw);
    controls.push({
      ...descriptor,
      value: raw,
      options: known ? descriptor.options : [{ value: raw, label: `${optionLabel(raw)} (as authored)` }, ...descriptor.options],
    });
  }
  return controls;
}

/** Node types with at least one editable enum. Exposed for coverage tests. */
export const nodePropertyCatalogTypes = (): string[] => Object.keys(ENUM_PROPERTIES).sort();
