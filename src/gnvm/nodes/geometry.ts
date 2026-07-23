// Geometry-operation handlers.
import { Field, Vec3, asVec3, asNum, vadd } from "../core";
import { Geometry, Mesh, InstanceRef, MATERIAL_MATCH_ATTRIBUTE, buildTopology, inverseTransformPoint, mergeMeshInto, realizeInstances, rotateEulerXYZ, transformPoint, transformPointFloat32, transformPointMatrixFloat32, triangulateFaceIndices } from "../geometry";
import { meshCube, meshGrid, meshCircle, meshLine, meshCone } from "../primitives";
import { reg, EvalAPI, DUMP_CONTEXT } from "../registry";
import { FIELD_PROBE, makeFieldCtx } from "../evaluator";
import { evaluateBezierSpline } from "../bezier";

export function matchLegacyCurvePassthrough(geometry: Geometry): void {
  // A legacy Curve datablock routed through an otherwise empty Geometry Nodes
  // modifier enters downstream Object Info on its control-point domain. The
  // dump also carries dense preview samples for browser-side Bézier work; using
  // those here overbuilds every later sweep (800/770 instead of 96/66 for the
  // Nodes Node checkmark).
  let changed = false;
  for (const spline of geometry.curves) {
    if (!spline.controlPoints?.length || spline.controlPoints.length === spline.points.length) continue;
    spline.points = spline.controlPoints.map((point) => [...point] as Vec3);
    spline.resolution = 1;
    changed = true;
  }
  if (changed) geometry.curveAttributes.delete("__curve_tangent");
}

// ---- object info ------------------------------------------------------------
// Materializes a referenced scene object from the dump's embedded plain meshes
// (dump_blend.py exports them for non-GN objects, e.g. the bin's 'printbed').
function geometryOfDumpObject(obj: (typeof DUMP_CONTEXT.objects)[number] | undefined, evaluated = false): Geometry {
  if (evaluated && obj) {
    const runtime = DUMP_CONTEXT.evaluatedObjects.get(obj.name);
    if (runtime) return runtime.clone();
  }
  const out = new Geometry();
  const source = evaluated ? obj?.evaluated_mesh ?? obj?.mesh : obj?.mesh;
  if (source) {
    const m = new Mesh();
    m.positions = source.verts.map((p) => [p[0], p[1], p[2]] as Vec3);
    m.faces = source.faces.map((f) => [...f]);
    m.faceMaterial = source.face_materials ? [...source.face_materials] : m.faces.map(() => 0);
    const evaluatedMaterials = (source as { materials?: (string | null)[] }).materials;
    m.materialSlots = evaluatedMaterials?.length ? [...evaluatedMaterials] : obj?.materials?.length ? [...obj.materials] : [null];
    const highestMaterialSlot = m.faceMaterial.reduce((highest, slot) => Math.max(highest, slot), -1);
    while (m.materialSlots.length <= highestMaterialSlot) m.materialSlots.push(null);
    m.edges = (source.edges ?? []).map((edge) => [...edge] as [number, number]);
    for (const [name, attribute] of Object.entries(source.attributes ?? {})) {
      m.attributes.set(name, { domain: attribute.domain, data: [...attribute.data] });
    }
    // Blender vertex groups are object-level data, so evaluated.to_mesh() may
    // omit them even when evaluation kept identical point topology. Reattach
    // the base POINT arrays in that safe one-to-one case (Procedural Box uses
    // the `bolt` and `axel` groups as placement masks on top/bottom panels).
    if (evaluated && obj?.mesh?.attributes && obj.mesh.verts.length === source.verts.length) {
      for (const [name, attribute] of Object.entries(obj.mesh.attributes)) {
        if (!m.attributes.has(name) && attribute.domain === "POINT" && attribute.data.length === m.positions.length)
          m.attributes.set(name, { domain: "POINT", data: [...attribute.data] });
      }
    }
    out.mesh = m;
  }
  if (obj?.curves && (!evaluated || !source)) {
    out.curves = obj.curves.map((spline) => ({
      cyclic: Boolean(spline.cyclic), points: spline.points.map((p) => [p[0], p[1], p[2]] as Vec3),
      resolution: spline.resolution,
      controlPoints: spline.control_points?.map((p) => [p[0], p[1], p[2]] as Vec3),
      bezierLeft: spline.bezier_left?.map((p) => [p[0], p[1], p[2]] as Vec3),
      bezierRight: spline.bezier_right?.map((p) => [p[0], p[1], p[2]] as Vec3),
    }));
    const tilts = obj.curves.flatMap((spline) => spline.tilts ?? spline.points.map(() => 0));
    if (tilts.some((value) => value !== 0)) out.curveAttributes.set("tilt", { domain: "POINT", data: tilts });
  }
  if (evaluated && obj && DUMP_CONTEXT.legacyCurvePassthroughObjects.has(obj.name)) matchLegacyCurvePassthrough(out);
  return out;
}

type Matrix4Rows = number[][];
type Quaternion = [number, number, number, number];
const ROTATION_QUATERNION = Symbol.for("gnvm.rotationQuaternion");

function taggedRotationQuaternion(rotation: Vec3): Quaternion | undefined {
  return (rotation as Vec3 & { [ROTATION_QUATERNION]?: Quaternion })[ROTATION_QUATERNION];
}

/**
 * Match Blender's `math::to_euler(Quaternion)` float path. Blender first
 * creates a float matrix with double-precision quaternion products, then
 * extracts the lower-Manhattan-length XYZ Euler solution. Keeping this path
 * matters at quarter turns: the resulting cosine is a small positive float,
 * while an Euler socket display round-trip produces a small negative float.
 */
function quaternionToEulerXYZBlender(quaternion: Quaternion): Vec3 {
  const f = Math.fround;
  const [x, y, z, w] = quaternion.map(f) as Quaternion;
  const q0 = Math.SQRT2 * w;
  const q1 = Math.SQRT2 * x;
  const q2 = Math.SQRT2 * y;
  const q3 = Math.SQRT2 * z;
  const qda = q0 * q1;
  const qdb = q0 * q2;
  const qdc = q0 * q3;
  const qaa = q1 * q1;
  const qab = q1 * q2;
  const qac = q1 * q3;
  const qbb = q2 * q2;
  const qbc = q2 * q3;
  const qcc = q3 * q3;
  // Blender matrices are indexed [column][row]. Each assignment below casts
  // the double intermediate back to the Quaternion's float scalar type.
  const matrix = [
    [f(1 - qbb - qcc), f(qdc + qab), f(-qdb + qac)],
    [f(-qdc + qab), f(1 - qaa - qcc), f(qda + qbc)],
    [f(qdb + qac), f(-qda + qbc), f(1 - qaa - qbb)],
  ];
  const cy = f(Math.hypot(matrix[0][0], matrix[0][1]));
  let first: Vec3;
  let second: Vec3;
  if (cy > 16 * 1.1920928955078125e-7) {
    first = [
      f(Math.atan2(matrix[1][2], matrix[2][2])),
      f(Math.atan2(-matrix[0][2], cy)),
      f(Math.atan2(matrix[0][1], matrix[0][0])),
    ];
    second = [
      f(Math.atan2(-matrix[1][2], -matrix[2][2])),
      f(Math.atan2(-matrix[0][2], -cy)),
      f(Math.atan2(-matrix[0][1], -matrix[0][0])),
    ];
  }
  else {
    first = [
      f(Math.atan2(-matrix[2][1], matrix[1][1])),
      f(Math.atan2(-matrix[0][2], cy)),
      0,
    ];
    second = [...first];
  }
  const manhattan = (value: Vec3) => f(f(Math.abs(value[0]) + Math.abs(value[1])) + Math.abs(value[2]));
  return manhattan(first) > manhattan(second) ? second : first;
}

function instanceMatrix(position: Vec3, rotation: Vec3, scale: Vec3): Matrix4Rows {
  const f = Math.fround;
  const quaternion = taggedRotationQuaternion(rotation);
  let axes: Vec3[];
  if (quaternion) {
    const [x, y, z, w] = quaternion.map(f) as Quaternion;
    // `math::from_rotation(Quaternion)` deliberately promotes a float
    // quaternion to double and uses sqrt(2)-scaled products before casting
    // each completed matrix element back to float. The algebraically
    // equivalent `2 * (x * y ...)` form differs by a few ULPs and is visible
    // after instance realization feeds Geometry Proximity.
    const q0 = Math.SQRT2 * w;
    const q1 = Math.SQRT2 * x;
    const q2 = Math.SQRT2 * y;
    const q3 = Math.SQRT2 * z;
    const qda = q0 * q1;
    const qdb = q0 * q2;
    const qdc = q0 * q3;
    const qaa = q1 * q1;
    const qab = q1 * q2;
    const qac = q1 * q3;
    const qbb = q2 * q2;
    const qbc = q2 * q3;
    const qcc = q3 * q3;
    const rows = [
      [f(1 - qbb - qcc), f(-qdc + qab), f(qdb + qac)],
      [f(qdc + qab), f(1 - qaa - qcc), f(-qda + qbc)],
      [f(-qdb + qac), f(qda + qbc), f(1 - qaa - qbb)],
    ];
    axes = [0, 1, 2].map((column) => [
      f(rows[0][column] * f(scale[column])),
      f(rows[1][column] * f(scale[column])),
      f(rows[2][column] * f(scale[column])),
    ] as Vec3);
  } else {
    axes = [
      rotateEulerXYZ([scale[0], 0, 0], rotation),
      rotateEulerXYZ([0, scale[1], 0], rotation),
      rotateEulerXYZ([0, 0, scale[2]], rotation),
    ];
  }
  return [0, 1, 2].map((row) => [
    f(axes[0][row]), f(axes[1][row]), f(axes[2][row]), f(position[row]),
  ]).concat([[0, 0, 0, 1]]);
}

function multiplyInstanceMatrices(a: Matrix4Rows, b: Matrix4Rows): Matrix4Rows {
  const f = Math.fround;
  return [0, 1, 2, 3].map((row) => [0, 1, 2, 3].map((column) => {
    let value = f(f(a[row][0]) * f(b[0][column]));
    value = f(value + f(f(a[row][1]) * f(b[1][column])));
    value = f(value + f(f(a[row][2]) * f(b[2][column])));
    return f(value + f(f(a[row][3]) * f(b[3][column])));
  }));
}

function translationMatrix(translation: Vec3): Matrix4Rows {
  return [
    [1, 0, 0, Math.fround(translation[0])],
    [0, 1, 0, Math.fround(translation[1])],
    [0, 0, 1, Math.fround(translation[2])],
    [0, 0, 0, 1],
  ];
}

/** Matrix form of Transform Geometry's component sockets.
 *
 * The Rotation socket is quaternion-backed even when extraction exposes its
 * Euler display value. Building the three basis columns through the same
 * float32 path as direct mesh points keeps instance and component transforms
 * numerically identical before their matrices are composed.
 */
function geometryTransformMatrix(position: Vec3, rotation: Vec3, scale: Vec3): Matrix4Rows {
  const zero: Vec3 = [0, 0, 0];
  const x = transformPointFloat32([1, 0, 0], zero, rotation, scale);
  const y = transformPointFloat32([0, 1, 0], zero, rotation, scale);
  const z = transformPointFloat32([0, 0, 1], zero, rotation, scale);
  return [
    [x[0], y[0], z[0], Math.fround(position[0])],
    [x[1], y[1], z[1], Math.fround(position[1])],
    [x[2], y[2], z[2], Math.fround(position[2])],
    [0, 0, 0, 1],
  ];
}

function axisAngleMatrix(axisValue: Vec3, angleValue: number): Matrix4Rows {
  const f = Math.fround;
  let lengthSquared = f(f(f(axisValue[0]) * f(axisValue[0])) + f(f(axisValue[1]) * f(axisValue[1])));
  lengthSquared = f(lengthSquared + f(f(axisValue[2]) * f(axisValue[2])));
  const length = lengthSquared > 1e-35 ? f(Math.sqrt(lengthSquared)) : 1;
  const x = f(f(axisValue[0]) / length);
  const y = f(f(axisValue[1]) / length);
  const z = f(f(axisValue[2]) / length);
  const angle = f(angleValue);
  const c = f(Math.cos(angle));
  const s = f(Math.sin(angle));
  const t = f(1 - c);
  const sx = f(x * s), sy = f(y * s), sz = f(z * s);
  const xx = f(f(x * x) * t), yy = f(f(y * y) * t), zz = f(f(z * z) * t);
  const xy = f(f(x * y) * t), xz = f(f(x * z) * t), yz = f(f(y * z) * t);
  return [
    [f(xx + c), f(xy - sz), f(xz + sy), 0],
    [f(xy + sz), f(yy + c), f(yz - sx), 0],
    [f(xz - sy), f(yz + sx), f(zz + c), 0],
    [0, 0, 0, 1],
  ];
}

/** Match Blender's node_geo_rotate_instances.cc matrix operation. */
function rotateInstanceMatrix(
  base: Matrix4Rows,
  rotation: Vec3,
  pivot: Vec3,
  local: boolean,
): Matrix4Rows {
  const f = Math.fround;
  let rotationMatrix: Matrix4Rows;
  let usedPivot: Vec3;
  if (local) {
    const euler = taggedRotationQuaternion(rotation)
      ? quaternionToEulerXYZBlender(taggedRotationQuaternion(rotation)!)
      : rotation;
    const axis = (column: number): Vec3 => [base[0][column], base[1][column], base[2][column]];
    const x = axisAngleMatrix(axis(0), euler[0]);
    const y = axisAngleMatrix(axis(1), euler[1]);
    const z = axisAngleMatrix(axis(2), euler[2]);
    rotationMatrix = multiplyInstanceMatrices(multiplyInstanceMatrices(z, y), x);
    usedPivot = transformPointMatrixFloat32(pivot, base);
  }
  else {
    rotationMatrix = instanceMatrix([0, 0, 0], rotation, [1, 1, 1]);
    usedPivot = pivot.map(f) as Vec3;
  }
  const shifted = base.map((row) => [...row]);
  for (let row = 0; row < 3; row++) shifted[row][3] = f(f(shifted[row][3]) - f(usedPivot[row]));
  const result = multiplyInstanceMatrices(rotationMatrix, shifted);
  for (let row = 0; row < 3; row++) result[row][3] = f(f(result[row][3]) + f(usedPivot[row]));
  return result;
}

function transformByMatrix(point: Vec3, matrix: Matrix4Rows): Vec3 {
  return [
    matrix[0][0] * point[0] + matrix[0][1] * point[1] + matrix[0][2] * point[2] + matrix[0][3],
    matrix[1][0] * point[0] + matrix[1][1] * point[1] + matrix[1][2] * point[2] + matrix[1][3],
    matrix[2][0] * point[0] + matrix[2][1] * point[1] + matrix[2][2] * point[2] + matrix[2][3],
  ];
}

function inverseTransformByMatrix(point: Vec3, matrix: Matrix4Rows): Vec3 {
  const x = point[0] - matrix[0][3];
  const y = point[1] - matrix[1][3];
  const z = point[2] - matrix[2][3];
  const a = matrix[0][0], b = matrix[0][1], c = matrix[0][2];
  const d = matrix[1][0], e = matrix[1][1], f = matrix[1][2];
  const g = matrix[2][0], h = matrix[2][1], i = matrix[2][2];
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(determinant) < 1e-12) return [0, 0, 0];
  const inverse = 1 / determinant;
  return [
    ((e * i - f * h) * x + (c * h - b * i) * y + (b * f - c * e) * z) * inverse,
    ((f * g - d * i) * x + (a * i - c * g) * y + (c * d - a * f) * z) * inverse,
    ((d * h - e * g) * x + (b * g - a * h) * y + (a * e - b * d) * z) * inverse,
  ];
}

function relativeInstanceTransform(objectMatrix: Matrix4Rows, activeMatrix: Matrix4Rows): { position: Vec3; rotation: Vec3; scale: Vec3; transformMatrix: Matrix4Rows } {
  const relativePoint = (point: Vec3): Vec3 => inverseTransformByMatrix(transformByMatrix(point, objectMatrix), activeMatrix);
  const position = relativePoint([0, 0, 0]);
  const endpoints = [relativePoint([1, 0, 0]), relativePoint([0, 1, 0]), relativePoint([0, 0, 1])];
  const axes = endpoints.map((endpoint) => [
    endpoint[0] - position[0], endpoint[1] - position[1], endpoint[2] - position[2],
  ] as Vec3);
  const scale = axes.map((axis) => Math.hypot(axis[0], axis[1], axis[2]) || 1) as Vec3;
  const r = axes.map((axis, column) => axis.map((value) => value / scale[column])) as Vec3[];
  // The normalized basis vectors above are matrix columns: r[column][row].
  // Extract Blender XYZ Euler from Rz*Ry*Rx. Reading r as rows transposes the
  // rotation; single-axis transforms happen to survive, but combined X/Z
  // rotations (such as Modern Pipe's horizontal dowel) lose their long axis.
  const sinY = Math.max(-1, Math.min(1, -r[0][2]));
  const y = Math.asin(sinY);
  const rotation: Vec3 = Math.abs(sinY) < .9999999
    ? [Math.atan2(r[1][2], r[2][2]), y, Math.atan2(r[0][1], r[0][0])]
    : [Math.atan2(-r[2][1], r[1][1]), y, 0];
  const transformMatrix: Matrix4Rows = [0, 1, 2].map((row) => [
    axes[0][row], axes[1][row], axes[2][row], position[row],
  ]);
  transformMatrix.push([0, 0, 0, 1]);
  return { position, rotation, scale, transformMatrix };
}

reg("GeometryNodeObjectInfo", (api) => {
  const ref = api.ref("Object");
  // Blender exposes a dependency-cycle back-edge as unavailable while the
  // referenced object is still being evaluated. Falling back to its authored
  // base mesh here silently deforms the dependency (Send Nodes Hat's front
  // reads the pending embroidery root while the embroidery reads the front).
  const pending = Boolean(ref?.name && DUMP_CONTEXT.evaluatingObjects.has(ref.name));
  const obj = pending ? undefined : DUMP_CONTEXT.objects.find((o) => o.name === ref?.name);
  // Blender's Geometry output includes the referenced object's evaluated
  // modifier stack. Targeted dumps embed that mesh so nested asset generators
  // (Sticker Noodle Brush -> Polarity Sticker) remain procedural in the VM.
  const out = geometryOfDumpObject(obj, true);
  if (api.prop<string>("transform_space", "ORIGINAL") === "RELATIVE") {
    const loc = (obj?.location ?? [0, 0, 0]) as Vec3;
    const rot = (obj?.rotation ?? [0, 0, 0]) as Vec3;
    const scl = (obj?.scale ?? [1, 1, 1]) as Vec3;
    const active = DUMP_CONTEXT.activeObject;
    const activeLoc = (active?.location ?? [0, 0, 0]) as Vec3;
    const activeRot = (active?.rotation ?? [0, 0, 0]) as Vec3;
    const activeScale = (active?.scale ?? [1, 1, 1]) as Vec3;
    // Local TRS is insufficient for parented objects. Blender's Relative mode
    // evaluates object.matrix_world in the active modifier object's space, so
    // retain and use the extracted affine matrices whenever they are present.
    const objectMatrix = (obj as { matrix_world?: Matrix4Rows } | undefined)?.matrix_world;
    const activeMatrix = (active as { matrix_world?: Matrix4Rows } | undefined)?.matrix_world;
    const extractedRelative = active?.name ? obj?.relative_matrices?.[active.name] : undefined;
    const relative = extractedRelative
      ? (point: Vec3) => transformPointMatrixFloat32(point, extractedRelative)
      : objectMatrix && activeMatrix
      ? (point: Vec3) => inverseTransformByMatrix(transformByMatrix(point, objectMatrix), activeMatrix)
      : (point: Vec3) => inverseTransformPoint(transformPoint(point, loc, rot, scl), activeLoc, activeRot, activeScale);
    if (out.mesh) out.mesh.positions = out.mesh.positions.map(relative);
    for (const spline of out.curves) spline.points = spline.points.map(relative);
    for (const instance of out.instances) instance.position = relative(instance.position);
    // Blender gives a Mesh-to-Curve component crossing Object Info its 0.01
    // base display width when a later Bounding Box evaluates it. Local
    // Mesh-to-Curve wires remain positional; retain that provenance split.
    if (out.curves.length && out.curveAttributes.has("__gnvm_planar_mesh_curve")) {
      out.curveAttributes.set("__gnvm_object_info_mesh_curve", {
        domain: "POINT",
        data: Array.from({ length: out.curvePointCount() }, () => 1),
      });
    }
  }
  // As Instance preserves the object as a one-element instance component.
  // Returning its realized payload directly made Domain Size report zero
  // instances and sent wrapper-style generators down their fallback branch.
  let geometry = out;
  if (api.bool("As Instance") && (out.mesh || out.curves.length || out.instances.length)) {
    geometry = new Geometry();
    geometry.instances.push({ geometry: out, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  }
  return {
    Geometry: geometry,
    Location: Field.of(((obj?.location ?? [0, 0, 0]) as Vec3)),
    Rotation: Field.of(((obj?.rotation ?? [0, 0, 0]) as Vec3)),
    Scale: Field.of(((obj?.scale ?? [1, 1, 1]) as Vec3)),
  };
});

reg("GeometryNodeCollectionInfo", (api) => {
  const ref = api.ref("Collection");
  const collection = DUMP_CONTEXT.collections.find((entry) => entry.name === ref?.name);
  const out = new Geometry();
  const resetChildren = api.bool("Reset Children");
  for (const name of collection?.objects ?? []) {
    const object = DUMP_CONTEXT.objects.find((entry) => entry.name === name);
    const geometry = geometryOfDumpObject(object, true);
    if (!geometry.mesh && !geometry.curves.length && !geometry.instances.length) continue;
    const objectMatrix = (object as { matrix_world?: Matrix4Rows } | undefined)?.matrix_world;
    const activeMatrix = (DUMP_CONTEXT.activeObject as { matrix_world?: Matrix4Rows } | undefined)?.matrix_world;
    const activeName = DUMP_CONTEXT.activeObject?.name;
    const extractedRelative = activeName ? object?.relative_matrices?.[activeName] : undefined;
    const relative = api.prop<string>("transform_space", "ORIGINAL") === "RELATIVE"
      ? extractedRelative
        ? relativeInstanceTransform(extractedRelative, [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
        : objectMatrix && activeMatrix
          ? relativeInstanceTransform(objectMatrix, activeMatrix)
          : null
      : null;
    out.instances.push({
      geometry,
      position: resetChildren ? [0, 0, 0] : relative?.position ?? ((object?.location ?? [0, 0, 0]) as Vec3),
      rotation: resetChildren ? [0, 0, 0] : relative?.rotation ?? ((object?.rotation ?? [0, 0, 0]) as Vec3),
      scale: resetChildren ? [1, 1, 1] : relative?.scale ?? ((object?.scale ?? [1, 1, 1]) as Vec3),
      transformMatrix: resetChildren ? undefined : relative?.transformMatrix,
    });
  }
  return { Instances: out };
});

// ---- primitives -----------------------------------------------------------
reg("GeometryNodeMeshCube", (api) => ({
  Mesh: meshCube(api.vec("Size"), api.num("Vertices X") || 2, api.num("Vertices Y") || 2, api.num("Vertices Z") || 2),
}));
reg("GeometryNodeMeshGrid", (api) => {
  const verticesX = Math.floor(api.num("Vertices X"));
  const verticesY = Math.floor(api.num("Vertices Y"));
  return {
    Mesh: meshGrid(api.num("Size X"), api.num("Size Y"), verticesX, verticesY),
    // Grid's anonymous UV field lives on the point domain. Downstream image
    // sampling may consume it on faces, so retain the domain tag and let the
    // evaluator perform Blender's implicit point-to-face interpolation.
    "UV Map": Field.perElem((index) => {
      if (verticesX < 2 || verticesY < 2) return [0, 0, 0];
      return [Math.floor(index / verticesY) / (verticesX - 1), (index % verticesY) / (verticesY - 1), 0];
    }).tagged("POINT"),
  };
});
reg("GeometryNodeMeshCircle", (api) => ({
  Mesh: meshCircle(api.num("Vertices") || 32, api.num("Radius") || 1, (api.prop<string>("fill_type", "NONE") as any)),
}));
reg("GeometryNodeMeshLine", (api) => {
  const count = api.num("Count") || 10;
  const start = api.vec("Start Location");
  const mode = api.prop<string>("mode", "OFFSET");
  let offset = api.vec("Offset");
  if (mode === "END_POINTS") {
    const end = api.vec("Offset"); // socket relabeled "End Location" but identifier stays "Offset"
    offset = count > 1 ? ([(end[0] - start[0]) / (count - 1), (end[1] - start[1]) / (count - 1), (end[2] - start[2]) / (count - 1)] as Vec3) : [0, 0, 0];
  }
  return { Mesh: meshLine(count, start, offset) };
});
reg("GeometryNodeMeshCone", (api) => {
  const verts = api.num("Vertices") || 32;
  const sideSeg = api.num("Side Segments") || 1;
  const fillSeg = api.num("Fill Segments") || 1;
  const rTop = api.num("Radius Top");
  const rBot = api.num("Radius Bottom") || 1;
  const depth = api.num("Depth") || 2;
  const fill = (api.prop<string>("fill_type", "NGON") as "NONE" | "NGON" | "TRIANGLE_FAN");
  const mesh = meshCone(verts, rTop, rBot, depth, sideSeg, fillSeg, fill);
  const sideFaces = Math.max(3, Math.floor(verts)) * Math.max(1, Math.floor(sideSeg));
  const capFaces = fill === "NONE" ? 0 : fill === "NGON" && fillSeg <= 1 ? 1 : Math.max(3, Math.floor(verts));
  const bottomCount = rBot > 1e-12 ? capFaces : 0;
  const topCount = rTop > 1e-12 ? capFaces : 0;
  const faceMask = (start: number, count: number) => Field.perElem((i) => i >= start && i < start + count ? 1 : 0).tagged("FACE");
  return {
    Mesh: mesh,
    Bottom: faceMask(sideFaces, bottomCount), Top: faceMask(sideFaces + bottomCount, topCount), Side: faceMask(0, sideFaces),
    "UV Map": Field.of([0, 0, 0]),
  };
});
reg("GeometryNodeMeshCylinder", (api) => {
  const verts = api.num("Vertices") || 32;
  const sideSeg = api.num("Side Segments") || 1;
  const fillSeg = api.num("Fill Segments") || 1;
  const radius = api.num("Radius") || 1;
  const depth = api.num("Depth") || 2;
  const fill = api.prop<string>("fill_type", "NGON") as "NONE" | "NGON" | "TRIANGLE_FAN";
  const mesh = meshCone(verts, radius, radius, depth, sideSeg, fillSeg, fill, true);
  const sideFaces = Math.max(3, Math.floor(verts)) * Math.max(1, Math.floor(sideSeg));
  const capFaces = fill === "NONE" ? 0 : fill === "NGON" && fillSeg <= 1 ? 1 : Math.max(3, Math.floor(verts));
  const faceMask = (start: number, count: number) => Field.perElem((i) => i >= start && i < start + count ? 1 : 0).tagged("FACE");
  return {
    Mesh: mesh,
    Bottom: faceMask(sideFaces, capFaces), Top: faceMask(sideFaces + capFaces, capFaces), Side: faceMask(0, sideFaces),
    "UV Map": Field.of([0, 0, 0]),
  };
});

// ---- transform ------------------------------------------------------------
reg(["GeometryNodeTransform", "GeometryNodeTransformGeometry"], (api) => {
  const g = api.geo("Geometry").clone();
  const t = api.vec("Translation"), r = api.vec("Rotation"), s = api.vec("Scale");
  if (g.mesh) g.mesh.positions = g.mesh.positions.map((p) => transformPointFloat32(p, t, r, s));
  for (const spline of g.curves) {
    spline.points = spline.points.map((p) => transformPointFloat32(p, t, r, s));
    if (spline.controlPoints) spline.controlPoints = spline.controlPoints.map((p) => transformPointFloat32(p, t, r, s));
    if (spline.bezierLeft) spline.bezierLeft = spline.bezierLeft.map((p) => transformPointFloat32(p, t, r, s));
    if (spline.bezierRight) spline.bezierRight = spline.bezierRight.map((p) => transformPointFloat32(p, t, r, s));
    if (spline.controlPoints?.length && spline.bezierLeft?.length === spline.controlPoints.length
      && spline.bezierRight?.length === spline.controlPoints.length) {
      spline.points = evaluateBezierSpline(
        spline.controlPoints,
        spline.cyclic,
        spline.bezierLeft,
        spline.bezierRight,
        spline.resolution,
      );
    }
  }
  for (const inst of g.instances) {
    // Transform Geometry left-multiplies the complete instance transform.
    // Adding Euler components is only equivalent when both rotations share an
    // axis; the Intro panels apply a root X rotation to Y-rotated socket
    // instances, and the old addition incorrectly changed their X bounds.
    const baseMatrix = inst.transformMatrix
      ?? geometryTransformMatrix(inst.position, inst.rotation, inst.scale);
    inst.transformMatrix = multiplyInstanceMatrices(
      geometryTransformMatrix(t, r, s),
      baseMatrix,
    );
    inst.position = [
      inst.transformMatrix[0][3],
      inst.transformMatrix[1][3],
      inst.transformMatrix[2][3],
    ];
    // Retain socket-compatible components for downstream instance fields; the
    // composed matrix above remains authoritative for realization.
    inst.rotation = vadd(inst.rotation, r);
    inst.scale = [inst.scale[0] * s[0], inst.scale[1] * s[1], inst.scale[2] * s[2]];
  }
  return { Geometry: g };
});

// ---- set position ---------------------------------------------------------
reg("GeometryNodeSetPosition", (api) => {
  const g = api.geo("Geometry").clone();
  if (!g.mesh && !g.curves.length && !g.instances.length) return { Geometry: g };
  const hasMeshPoints = !!g.mesh?.positions.length;
  // Blender 5 applies Set Position directly to the points represented by an
  // instances component as well as mesh/curve points. Periodic Brush uses this
  // to lift each successive dot instance slightly in Z.
  const domain = !hasMeshPoints && !g.curves.length && g.instances.length ? "INSTANCE" : "POINT";
  const ctx = makeFieldCtx(g, domain);
  // Selection chains built entirely from FACE/EDGE-domain masks evaluate on
  // their source domain and convert ONCE at the end (Blender's order) —
  // per-leaf conversion turns NOT(mask) into "not touching any", wrongly
  // excluding boundary verts (the vase's outer-shell mask lost its rim).
  const selF = api.field("Selection");
  let sel: import("../core").Elem[];
  if (g.mesh && selF.srcDomain && selF.srcDomain !== "POINT" && ctx.toDomain) {
    const srcCtx = makeFieldCtx(g, selF.srcDomain);
    const srcArr = selF.array(srcCtx);
    sel = Array.from({ length: ctx.size }, (_, i) => ctx.toDomain!(selF.srcDomain!, srcArr, i) ?? 0);
  } else {
    sel = selF.array(ctx);
  }
  const off = api.field("Offset").array(ctx);
  const posLinked = api.node.inputs.find((s) => s.identifier === "Position")?.linked;
  const posArr = posLinked ? api.field("Position").array(ctx) : null;
  if (FIELD_PROBE.node === api.node.name) {
    const requested = FIELD_PROBE.socket ?? "Position";
    const values = requested.startsWith("attr:")
      ? Array.from({ length: ctx.size }, (_, i) => ctx.attr?.(requested.slice(5), i) ?? 0)
      : requested === "Selection" ? sel : requested === "Offset" ? off : posArr ?? [];
    FIELD_PROBE.batches.push({
      domain: "POINT",
      positions: Array.from({ length: ctx.size }, (_, i) => ctx.position?.(i) ?? [0, 0, 0]),
      values,
    });
  }
  const move = (p: Vec3, i: number): Vec3 => {
    if (!asNum(sel[i] ?? 1)) return p;
    const base = posArr ? asVec3(posArr[i]) : p;
    const offset = asVec3(off[i] ?? [0, 0, 0]);
    return [
      Math.fround(Math.fround(base[0]) + Math.fround(offset[0])),
      Math.fround(Math.fround(base[1]) + Math.fround(offset[1])),
      Math.fround(Math.fround(base[2]) + Math.fround(offset[2])),
    ];
  };
  if (hasMeshPoints) {
    g.mesh!.positions = g.mesh!.positions.map(move);
  } else if (g.curves.length) {
    // curve geometry: the ctx flattens control points in spline order
    let i = 0;
    g.curves = g.curves.map((s) => ({ cyclic: s.cyclic, points: s.points.map((p) => move(p, i++)) }));
  } else {
    g.instances = g.instances.map((instance, i) => ({
      ...instance,
      position: move(instance.position, i),
      transformMatrix: undefined,
    }));
  }
  // Geometry sets can carry a mesh and instances simultaneously. Blender
  // evaluates Set Position once per supported component; choosing the mesh's
  // POINT domain above must not leave the instance points behind. Procedural
  // Box joins its lid shell with a referenced print pin and then animates both
  // through one position field.
  if (g.instances.length && domain !== "INSTANCE") {
    const instanceCtx = makeFieldCtx(g, "INSTANCE");
    const instanceSelection = api.field("Selection").array(instanceCtx);
    const instanceOffset = api.field("Offset").array(instanceCtx);
    const instancePosition = posLinked ? api.field("Position").array(instanceCtx) : null;
    g.instances = g.instances.map((instance, i) => {
      if (!asNum(instanceSelection[i] ?? 1)) return instance;
      const base = instancePosition ? asVec3(instancePosition[i]) : instance.position;
      return {
        ...instance,
        position: vadd(base, asVec3(instanceOffset[i] ?? [0, 0, 0])),
        transformMatrix: undefined,
      };
    });
  }
  return { Geometry: g };
});

// ---- join geometry --------------------------------------------------------
reg("GeometryNodeJoinGeometry", (api) => {
  const parts = api.geoInputs("Geometry");
  const out = new Geometry();
  out.mesh = new Mesh();
  for (const g of parts) {
    if (g.mesh) mergeMeshInto(out.mesh, g.mesh);
    for (const inst of g.instances) out.instances.push({ ...inst });
    for (const s of g.curves) out.curves.push({
      cyclic: s.cyclic,
      resolution: s.resolution,
      points: s.points.map((p) => [...p] as Vec3),
      controlPoints: s.controlPoints?.map((p) => [...p] as Vec3),
      bezierLeft: s.bezierLeft?.map((p) => [...p] as Vec3),
      bezierRight: s.bezierRight?.map((p) => [...p] as Vec3),
    });
  }
  return { Geometry: out };
});

// ---- materials ------------------------------------------------------------
/**
 * Apply a mesh-component operation through an instance hierarchy without
 * realizing it. Geometry Nodes lets Set Material and Store Named Attribute
 * operate on geometry carried by instances; keeping the hierarchy intact is
 * important for later transform and attribute propagation. Shared instance
 * payloads are mapped once, matching Blender's shared geometry components and
 * avoiding a separate copy for every instance reference.
 */
function mapInstancePayloadMeshes(source: Geometry, operation: (geometry: Geometry) => void): Geometry {
  const mapped = new WeakMap<Geometry, Geometry>();
  const visit = (input: Geometry): Geometry => {
    const cached = mapped.get(input);
    if (cached) return cached;
    const output = input.clone();
    mapped.set(input, output);
    output.instances = output.instances.map((instance, index) => ({
      ...instance,
      geometry: visit(input.instances[index].geometry),
    }));
    operation(output);
    return output;
  };
  return visit(source);
}

reg("GeometryNodeSetMaterial", (api) => {
  const mat = api.ref("Material");
  const selection = api.field("Selection");
  const g = mapInstancePayloadMeshes(api.geo("Geometry"), (geometry) => {
    if (!geometry.mesh) return;
    const target = mat?.name ?? null;
    const ctx = makeFieldCtx(geometry, "FACE");
    const sel = selection.array(ctx);
    // Preserve whether a selected face already carried the assigned material.
    // This is source provenance, not a shader approximation: realization can
    // otherwise collapse a mixed existing/null instance hierarchy into one
    // material slot. Chain & Mace uses that distinction for its mace-only
    // roughness field after Blender assigns chrome to the complete result.
    if (geometry.mesh.materialSlots.includes(target)) {
      const existing = geometry.mesh.attributes.get(MATERIAL_MATCH_ATTRIBUTE);
      const data = existing?.domain === "FACE" ? [...existing.data] : [];
      while (data.length < geometry.mesh.faces.length) data.push(0);
      for (let fi = 0; fi < geometry.mesh.faces.length; fi++) if (asNum(sel[fi] ?? 1)) {
        const previous = geometry.mesh.materialSlots[geometry.mesh.faceMaterial[fi] ?? 0] ?? null;
        data[fi] = previous === target ? 1 : 0;
      }
      geometry.mesh.attributes.set(MATERIAL_MATCH_ATTRIBUTE, { domain: "FACE", data });
    }
    const slot = geometry.mesh.ensureMaterialSlot(target);
    for (let fi = 0; fi < geometry.mesh.faces.length; fi++)
      if (asNum(sel[fi] ?? 1)) geometry.mesh.faceMaterial[fi] = slot;
  });
  return { Geometry: g };
});

// ---- instancing -----------------------------------------------------------
reg("GeometryNodeInstanceOnPoints", (api) => {
  const pointGeometry = api.geo("Points");
  const instance = api.geo("Instance");
  // Some supplied products use Blender's version-specific stochastic point
  // distribution as an authored layout rather than as an exposed control.
  // The extraction pipeline can preserve those evaluated transforms directly
  // on this node, just as it preserves packed glyph outlines. Downstream graph
  // controls still operate on the resulting instances in the browser.
  const bakedInstances = api.node.baked_instances
    ?? api.prop<{ position: Vec3; rotation?: Vec3; scale: Vec3 }[]>("baked_instances", []);
  if (bakedInstances.length) {
    const out = new Geometry();
    for (const baked of bakedInstances) out.instances.push({
      geometry: instance,
      position: [...baked.position] as Vec3,
      rotation: [...(baked.rotation ?? [0, 0, 0])] as Vec3,
      scale: [...baked.scale] as Vec3,
    });
    return { Instances: out };
  }
  const processed = new WeakMap<Geometry, Geometry>();
  const processPoints = (points: Geometry): Geometry => {
    const cached = processed.get(points);
    if (cached) return cached;
    const out = new Geometry();
    processed.set(points, out);
    // Blender's foreach_real_geometry() processes point components inside every
    // referenced geometry while retaining the surrounding instance hierarchy.
    // Keeping that boundary is essential for per-point rotations to compose
    // with an authored collection object's transform (Modern Pipe end caps).
    out.instances.push(...points.instances.map((outer) => ({
      ...outer,
      geometry: processPoints(outer.geometry),
      position: [...outer.position] as Vec3,
      rotation: [...outer.rotation] as Vec3,
      scale: [...outer.scale] as Vec3,
      transformMatrix: outer.transformMatrix?.map((row) => [...row]),
      attributes: outer.attributes ? new Map(outer.attributes) : undefined,
    })));
    // Points come from either a mesh (vertex positions) or a curve (control points).
    const pts: Vec3[] = points.mesh
      ? points.mesh.positions
      : points.curves.flatMap((s) => s.points);
    if (!pts.length) return out;
    const ctx = makeFieldCtx(points, "POINT");
    const sel = api.field("Selection").array(ctx);
    const rot = api.field("Rotation").array(ctx);
    const scl = api.field("Scale").array(ctx);
    const instanceIndices = api.field("Instance Index").array(ctx);
    if (FIELD_PROBE.node === api.node.name) {
      const requested = FIELD_PROBE.socket ?? "Rotation";
      FIELD_PROBE.batches.push({
        domain: "POINT",
        positions: pts.map((point) => [...point] as Vec3),
        values: requested === "Scale"
          ? scl
          : requested === "Selection"
            ? sel
            : requested === "Instance Index"
              ? instanceIndices
              : rot,
      });
    }
    const pickInstance = api.bool("Pick Instance");
    const instanceIndexLinked = api.node.inputs.find((socket) => socket.identifier === "Instance Index")?.linked;
    const scaleLinked = api.node.inputs.find((s) => s.identifier === "Scale")?.linked;
    const scaleConst = api.vec("Scale");
    // per-point attributes to carry onto each instance (anonymous-attribute propagation)
    const pointAttrs = points.mesh
      ? [...points.mesh.attributes].filter(([name, a]) => a.domain === "POINT" && name !== "__gnvm_point_cloud")
      : [...points.curveAttributes];
    for (let i = 0; i < pts.length; i++) {
      if (!asNum(sel[i] ?? 1)) continue;
      const s = scaleLinked ? asVec3(scl[i] ?? [1, 1, 1]) : (scaleConst[0] || scaleConst[1] || scaleConst[2] ? scaleConst : [1, 1, 1] as Vec3);
      let attributes: Map<string, any> | undefined;
      if (pointAttrs.length) {
        attributes = new Map();
        for (const [name, a] of pointAttrs) attributes.set(name, a.data[i]);
      }
      // Blender's unlinked Instance Index follows the point index for a list
      // produced by Geometry to Instance, despite the socket displaying 0, and
      // wraps beyond the source count. Text Soup exposes this when a short edited
      // string is repeated over its fixed 14-point guide.
      // A field linked directly to the integer Instance Index socket truncates
      // toward zero. Group-interface Int sockets use Blender's separate rounded
      // coercion; conflating the two made Bit Stand select its larger cutters
      // four points too early.
      const requestedIndex = instanceIndexLinked ? Math.trunc(asNum(instanceIndices[i] ?? 0)) : i;
      const picked = pickInstance && instance.instances.length
        ? instance.instances[((requestedIndex % instance.instances.length) + instance.instances.length) % instance.instances.length]
        : null;
      const outerRotation = asVec3(rot[i] ?? [0, 0, 0]);
      const nativeRotation = taggedRotationQuaternion(outerRotation);
      const outerMatrix = nativeRotation ? instanceMatrix(pts[i], outerRotation, s) : undefined;
      const pickedMatrix = picked
        ? picked.transformMatrix ?? instanceMatrix(picked.position, picked.rotation, picked.scale)
        : undefined;
      const transformMatrix = outerMatrix
        ? pickedMatrix ? multiplyInstanceMatrices(outerMatrix, pickedMatrix) : outerMatrix
        : undefined;
      const composedPosition = transformMatrix
        ? [transformMatrix[0][3], transformMatrix[1][3], transformMatrix[2][3]] as Vec3
        : picked ? transformPoint(picked.position, pts[i], outerRotation, s) : pts[i];
      out.instances.push({
        geometry: picked?.geometry ?? instance,
        // A picked child keeps its own transform. Compose its origin through the
        // point transform before placing it in the parent geometry.
        position: composedPosition,
        rotation: picked ? vadd(outerRotation, picked.rotation) : outerRotation,
        scale: picked ? [s[0] * picked.scale[0], s[1] * picked.scale[1], s[2] * picked.scale[2]] : s,
        transformMatrix,
        attributes,
      } as InstanceRef);
    }
    return out;
  };
  return { Instances: processPoints(pointGeometry) };
});

reg("GeometryNodeInstancesToPoints", (api) => {
  const source = api.geo("Instances");
  const ctx = makeFieldCtx(source, "INSTANCE");
  const selection = api.field("Selection").array(ctx);
  const positionLinked = api.node.inputs.find((socket) => socket.identifier === "Position")?.linked ?? false;
  const positions = positionLinked ? api.field("Position").array(ctx) : null;
  const radii = api.field("Radius").array(ctx);
  const out = new Geometry();
  const mesh = new Mesh();
  const radiusData: import("../core").Elem[] = [];
  const instanceAttributeNames = new Set<string>();
  for (const instance of source.instances) for (const name of instance.attributes?.keys() ?? []) instanceAttributeNames.add(name);
  const instanceAttributeData = new Map([...instanceAttributeNames].map((name) => [name, [] as import("../core").Elem[]]));
  for (let i = 0; i < source.instances.length; i++) {
    if (asNum(selection[i] ?? 1) <= 0) continue;
    mesh.positions.push(positions ? asVec3(positions[i] ?? source.instances[i].position) : [...source.instances[i].position] as Vec3);
    radiusData.push(radii[i] ?? 0.05);
    for (const name of instanceAttributeNames) instanceAttributeData.get(name)!.push(source.instances[i].attributes?.get(name) ?? 0);
  }
  mesh.attributes.set("radius", { domain: "POINT", data: radiusData });
  mesh.attributes.set("__gnvm_point_cloud", { domain: "POINT", data: mesh.positions.map(() => 1) });
  for (const [name, data] of instanceAttributeData) mesh.attributes.set(name, { domain: "POINT", data });
  out.mesh = mesh;
  return { Points: out };
});

reg("GeometryNodeTranslateInstances", (api) => {
  const g = api.geo("Instances").clone();
  const t = api.vec("Translation");
  for (const inst of g.instances) {
    inst.position = vadd(inst.position, t);
    if (inst.transformMatrix) {
      inst.transformMatrix = multiplyInstanceMatrices(translationMatrix(t), inst.transformMatrix);
      inst.position = [inst.transformMatrix[0][3], inst.transformMatrix[1][3], inst.transformMatrix[2][3]];
    }
  }
  return { Instances: g };
});

reg("GeometryNodeScaleInstances", (api) => {
  const g = api.geo("Instances").clone();
  const ctx = makeFieldCtx(g, "INSTANCE");
  const selected = api.field("Selection").array(ctx);
  const scales = api.field("Scale").array(ctx);
  const centers = api.field("Center").array(ctx);
  for (let i = 0; i < g.instances.length; i++) {
    if (asNum(selected[i] ?? 1) <= 0) continue;
    const factor = asVec3(scales[i] ?? [1, 1, 1]);
    const center = asVec3(centers[i] ?? [0, 0, 0]);
    const instance = g.instances[i];
    instance.scale = [instance.scale[0] * factor[0], instance.scale[1] * factor[1], instance.scale[2] * factor[2]];
    // Center is relative to the instance origin in local-space mode. The
    // authored diagnostic graph uses zero, but preserve the pivot displacement.
    instance.position = [
      instance.position[0] + center[0] * (1 - factor[0]),
      instance.position[1] + center[1] * (1 - factor[1]),
      instance.position[2] + center[2] * (1 - factor[2]),
    ];
    if (instance.transformMatrix) {
      for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 3; column++)
          instance.transformMatrix[row][column] = Math.fround(instance.transformMatrix[row][column] * factor[column]);
        instance.transformMatrix[row][3] = Math.fround(instance.position[row]);
      }
    }
  }
  return { Instances: g };
});

reg("GeometryNodeRotateInstances", (api) => {
  const g = api.geo("Instances").clone();
  const ctx = makeFieldCtx(g, "INSTANCE");
  const selection = api.field("Selection").array(ctx);
  const rotations = api.field("Rotation").array(ctx);
  const pivots = api.field("Pivot Point").array(ctx);
  const local = api.bool("Local Space");
  for (let i = 0; i < g.instances.length; i++) {
    if (!asNum(selection[i] ?? 1)) continue;
    const instance = g.instances[i];
    const rotation = asVec3(rotations[i] ?? [0, 0, 0]);
    const pivot = asVec3(pivots[i] ?? [0, 0, 0]);
    // Capture the incoming matrix before updating the compatibility Euler.
    // Blender rotates the existing transform; building this matrix afterward
    // applies the requested rotation twice.
    const baseMatrix = instance.transformMatrix
      ?? (taggedRotationQuaternion(rotation)
        ? instanceMatrix(instance.position, instance.rotation, instance.scale)
        : undefined);
    if (!local) {
      const relative = [instance.position[0] - pivot[0], instance.position[1] - pivot[1], instance.position[2] - pivot[2]] as Vec3;
      instance.position = vadd(pivot, rotateEulerXYZ(relative, rotation));
    }
    // Retain the socket-compatible Euler value for downstream fields. The
    // transformMatrix above remains authoritative whenever native rotations
    // would otherwise be lost to an Euler round-trip.
    instance.rotation = vadd(instance.rotation, rotation);
    if (baseMatrix) {
      instance.transformMatrix = rotateInstanceMatrix(baseMatrix, rotation, pivot, local);
      instance.position = [instance.transformMatrix[0][3], instance.transformMatrix[1][3], instance.transformMatrix[2][3]];
    }
  }
  return { Instances: g };
});

reg("GeometryNodeRealizeInstances", (api) => ({ Geometry: realizeInstances(api.geo("Geometry")) }));

// ---- capture attribute ----------------------------------------------------
let captureAttributeSequence = 0;
reg("GeometryNodeCaptureAttribute", (api) => {
  const g = api.geo("Geometry").clone();
  const domMap: Record<string, any> = { POINT: "POINT", EDGE: "EDGE", FACE: "FACE", CORNER: "CORNER", INSTANCE: "INSTANCE", CURVE: "CURVE" };
  let domain = domMap[api.prop<string>("domain", "POINT")] ?? "POINT";
  // Node names are unique only inside one node group. Nested assets commonly
  // contain many nodes all named "Capture Attribute"; a visible-name key lets
  // point-instance attributes overwrite the prototype's anonymous attribute
  // during realization. Each evaluated capture needs its own anonymous ID.
  const name = `__cap_${captureAttributeSequence++}_${api.node.name}`;
  // A geometry set may contain an allocated but empty mesh beside a populated
  // curve component (Join Geometry commonly produces this shape). Capture on
  // the component that actually owns elements instead of letting the empty
  // mesh swallow the curve attribute.
  if (g.mesh && (g.mesh.domainSize(domain) > 0 || !g.curves.length)) {
    const ctx = makeFieldCtx(g, domain);
    const value = api.field("Value");
    const valueSocket = api.node.inputs.find((socket) => socket.identifier === "Value" || socket.name === "Value");
    let data: import("../core").Elem[];
    if (value.srcDomain && value.srcDomain !== domain && ctx.toDomain && value.srcDomainValueType !== "NUMERIC") {
      const source = value.srcDomain;
      const sourceData = value.array(makeFieldCtx(g, source));
      data = Array.from({ length: ctx.size }, (_, i) => ctx.toDomain!(source, sourceData, i) ?? 0);
    } else {
      data = value.array(ctx);
    }
    // Boolean POINT -> FACE adaptation is an AND across every face corner in
    // Blender: even a three-true/one-false quad resolves false. Retaining the
    // numeric average makes downstream switches choose the wrong marching-
    // squares cell whenever only some corners are selected.
    if (valueSocket?.type === "NodeSocketBool") {
      if (value.srcDomain === "POINT" && value.srcDomainValueType !== "NUMERIC" && domain === "FACE" && g.mesh) {
        const sourceData = value.array(makeFieldCtx(g, "POINT"));
        data = g.mesh.faces.map((face) => face.every((vertex) => asNum(sourceData[vertex] ?? 0) > 0) ? 1 : 0);
      } else {
        data = data.map((item) => asNum(item) > 0 ? 1 : 0);
      }
    }
    if (FIELD_PROBE.node === api.node.name && (FIELD_PROBE.socket === "Value" || FIELD_PROBE.socket === "Attribute")) {
      FIELD_PROBE.batches.push({
        domain,
        positions: Array.from({ length: ctx.size }, (_, i) => ctx.position?.(i) ?? [0, 0, 0]),
        values: data,
      });
    }
    g.mesh.attributes.set(name, { domain, data });
  } else if (g.instances.length) {
    if (domain === "INSTANCE") {
      const ctx = makeFieldCtx(g, "INSTANCE");
      const data = api.field("Value").array(ctx);
      for (let i = 0; i < g.instances.length; i++) {
        const attrs = g.instances[i].attributes ?? new Map<string, import("../core").Elem>();
        attrs.set(name, data[i] ?? 0);
        g.instances[i].attributes = attrs;
      }
    } else {
      // Point/face captures on instance geometry are evaluated inside each
      // referenced payload, then become ordinary attributes when realized.
      // Chrome Crayon uses this to remember the local vertex index of each
      // triangle/quad/pentagon profile before Pick Instance.
      for (const inst of g.instances) {
        const payload = inst.geometry.clone();
        if (payload.mesh) {
          const payloadCtx = makeFieldCtx(payload, domain);
          payload.mesh.attributes.set(name, { domain, data: api.field("Value").array(payloadCtx) });
        } else if (payload.curves.length) {
          const payloadCtx = makeFieldCtx(payload, "POINT");
          payload.curveAttributes.set(name, { domain: "POINT", data: api.field("Value").array(payloadCtx) });
        }
        inst.geometry = payload;
      }
    }
  } else if (g.curves.length) {
    // Curve attributes may live either on flattened control points or once per
    // spline. ETK_Loft Curves captures Index on CURVE so every point in one
    // spline keeps the same row id after resampling.
    const curveDomain = domain === "CURVE" ? "CURVE" : "POINT";
    const ctx = makeFieldCtx(g, curveDomain);
    g.curveAttributes.set(name, { domain: curveDomain, data: api.field("Value").array(ctx) });
  }
  return {
    Geometry: g,
    // tagged with the capture domain so boolean chains over face captures can
    // be evaluated on FACE and converted once at the consumer (Blender order)
    Attribute: Field.perElem((i, ctx) => (ctx.attr ? (ctx.attr(name, i) ?? 0) : 0)).tagged(
      domain,
      api.node.inputs.find((socket) => socket.identifier === "Value" || socket.name === "Value")?.type === "NodeSocketBool"
        ? "BOOLEAN"
        : "NUMERIC",
    ),
  };
});

// ---- geometry proximity ----------------------------------------------------
// POINTS mode: distance from each source element to the nearest target point.
// An unlinked "Source Position" means Blender's implicit position field.
// Instanced targets are realized (the bubble vase probes 58 instanced spheres).
// A k-d tree avoids both O(n*m) brute force and the costly empty-shell scans of
// the previous string-keyed uniform grid when source points sit far from a
// long, thin target (Chrome Crayon's resampled drawing curve).
type ProximityTriangle = { a: Vec3; b: Vec3; c: Vec3; min: Vec3; max: Vec3; center: Vec3 };
type ProximityBvh = { min: Vec3; max: Vec3; left?: ProximityBvh; right?: ProximityBvh; triangles?: ProximityTriangle[] };
const proximityBvhCache = new WeakMap<Mesh, ProximityBvh | null>();

function buildProximityBvh(triangles: ProximityTriangle[]): ProximityBvh | null {
  if (!triangles.length) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const triangle of triangles) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], triangle.min[axis]);
    max[axis] = Math.max(max[axis], triangle.max[axis]);
  }
  if (triangles.length <= 12) return { min, max, triangles };
  const spans = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const axis = spans[1] > spans[0] ? (spans[2] > spans[1] ? 2 : 1) : (spans[2] > spans[0] ? 2 : 0);
  const ordered = [...triangles].sort((a, b) => a.center[axis] - b.center[axis]);
  const middle = ordered.length >> 1;
  return { min, max, left: buildProximityBvh(ordered.slice(0, middle))!, right: buildProximityBvh(ordered.slice(middle))! };
}

function proximityBvh(mesh: Mesh): ProximityBvh | null {
  const cached = proximityBvhCache.get(mesh);
  if (cached !== undefined) return cached;
  const triangles: ProximityTriangle[] = [];
  for (const face of mesh.faces) for (const [ai, bi, ci] of triangulateFaceIndices(mesh, face)) {
    const a = mesh.positions[ai], b = mesh.positions[bi], c = mesh.positions[ci];
    const min: Vec3 = [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])];
    const max: Vec3 = [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])];
    triangles.push({ a, b, c, min, max, center: [(min[0] + max[0]) * .5, (min[1] + max[1]) * .5, (min[2] + max[2]) * .5] });
  }
  const result = buildProximityBvh(triangles);
  proximityBvhCache.set(mesh, result);
  return result;
}

export function closestTrianglePointFloat32(point: Vec3, rawTriangle: Pick<ProximityTriangle, "a" | "b" | "c">): Vec3 {
  // Blender calls closest_on_tri_to_point_v3 with float mesh coordinates.
  // Preserve both its region-test order and each intervening float32 result.
  const f = Math.fround;
  const vec = (value: Vec3): Vec3 => [f(value[0]), f(value[1]), f(value[2])];
  const subtract = (a: Vec3, b: Vec3): Vec3 => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
  const dot = (a: Vec3, b: Vec3) => {
    let value = f(f(a[0] * b[0]) + f(a[1] * b[1]));
    value = f(value + f(a[2] * b[2]));
    return value;
  };
  const madd = (a: Vec3, b: Vec3, factor: number): Vec3 => [
    f(a[0] + f(b[0] * factor)),
    f(a[1] + f(b[1] * factor)),
    f(a[2] + f(b[2] * factor)),
  ];
  const p = vec(point), a = vec(rawTriangle.a), b = vec(rawTriangle.b), c = vec(rawTriangle.c);
  const ab = subtract(b, a), ac = subtract(c, a), ap = subtract(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = subtract(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = f(f(d1 * d4) - f(d3 * d2));
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const squared = f(d1 - d3);
    return squared === 0 ? a : madd(a, ab, f(d1 / squared));
  }
  const cp = subtract(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = f(f(d5 * d2) - f(d1 * d6));
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const squared = f(d2 - d6);
    return squared === 0 ? a : madd(a, ac, f(d2 / squared));
  }
  const va = f(f(d3 * d6) - f(d5 * d4));
  const d43 = f(d4 - d3), d56 = f(d5 - d6);
  if (va <= 0 && d43 >= 0 && d56 >= 0) {
    const squared = f(d43 + d56);
    if (squared === 0) return b;
    const edge = subtract(c, b);
    return madd(b, edge, f(d43 / squared));
  }
  const denominator = f(1 / f(f(va + vb) + vc));
  const v = f(vb * denominator), w = f(vc * denominator);
  const acw: Vec3 = [f(ac[0] * w), f(ac[1] * w), f(ac[2] * w)];
  const result = madd(a, ab, v);
  return [f(result[0] + acw[0]), f(result[1] + acw[1]), f(result[2] + acw[2])];
}

function boxDistanceSquared(point: Vec3, min: Vec3, max: Vec3): number {
  let distance = 0;
  for (let axis = 0; axis < 3; axis++) {
    const delta = point[axis] < min[axis] ? min[axis] - point[axis] : point[axis] > max[axis] ? point[axis] - max[axis] : 0;
    distance += delta * delta;
  }
  return distance;
}

function nearestFacePoint(point: Vec3, root: ProximityBvh | null): { d: number; q: Vec3 } {
  if (!root) return { d: 0, q: [0, 0, 0] };
  const f = Math.fround;
  const p: Vec3 = [f(point[0]), f(point[1]), f(point[2])];
  const distanceSquared = (a: Vec3, b: Vec3) => {
    const delta: Vec3 = [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
    let value = f(f(delta[0] * delta[0]) + f(delta[1] * delta[1]));
    value = f(value + f(delta[2] * delta[2]));
    return value;
  };
  let bestSquared = Infinity;
  let best: Vec3 = [0, 0, 0];
  const visit = (node: ProximityBvh) => {
    if (boxDistanceSquared(p, node.min, node.max) >= bestSquared) return;
    if (node.triangles) {
      for (const triangle of node.triangles) {
        const q = closestTrianglePointFloat32(p, triangle);
        const squared = distanceSquared(q, p);
        if (squared < bestSquared) { bestSquared = squared; best = q; }
      }
      return;
    }
    const children = [node.left, node.right].filter((child): child is ProximityBvh => !!child)
      .sort((a, b) => boxDistanceSquared(p, a.min, a.max) - boxDistanceSquared(p, b.min, b.max));
    for (const child of children) visit(child);
  };
  visit(root);
  return { d: f(Math.sqrt(bestSquared)), q: best };
}

export function nearestFacePointFloat32(point: Vec3, mesh: Mesh): { d: number; q: Vec3 } {
  return nearestFacePoint(point, proximityBvh(mesh));
}

export function nearestEdgePointFloat32(point: Vec3, segments: [Vec3, Vec3][]): { d: number; q: Vec3 } {
  const f = Math.fround;
  const dot = (a: Vec3, b: Vec3) => {
    let result = f(f(a[0] * b[0]) + f(a[1] * b[1]));
    result = f(result + f(a[2] * b[2]));
    return result;
  };
  const p: Vec3 = [f(point[0]), f(point[1]), f(point[2])];
  let bestSq = Infinity;
  let best: Vec3 = segments.length
    ? [f(segments[0][0][0]), f(segments[0][0][1]), f(segments[0][0][2])]
    : [0, 0, 0];
  for (const [rawA, rawB] of segments) {
    const a: Vec3 = [f(rawA[0]), f(rawA[1]), f(rawA[2])];
    const b: Vec3 = [f(rawB[0]), f(rawB[1]), f(rawB[2])];
    const u: Vec3 = [f(b[0] - a[0]), f(b[1] - a[1]), f(b[2] - a[2])];
    const h: Vec3 = [f(p[0] - a[0]), f(p[1] - a[1]), f(p[2] - a[2])];
    const denominator = dot(u, u);
    const lambda = denominator > 0 ? f(dot(u, h) / denominator) : 0;
    const factor = Math.max(0, Math.min(1, lambda));
    const q: Vec3 = [
      f(a[0] + f(u[0] * factor)),
      f(a[1] + f(u[1] * factor)),
      f(a[2] + f(u[2] * factor)),
    ];
    const delta: Vec3 = [f(q[0] - p[0]), f(q[1] - p[1]), f(q[2] - p[2])];
    const distanceSquared = dot(delta, delta);
    if (distanceSquared < bestSq) {
      bestSq = distanceSquared;
      best = q;
    }
  }
  return { d: Number.isFinite(bestSq) ? f(Math.sqrt(bestSq)) : 0, q: best };
}

const BLENDER_BVH_POINT_EPSILON = Math.fround(1.1920928955078125e-7);

export function nearestPointBvhLeafFloat32(point: Vec3, target: Vec3): { dSquared: number; q: Vec3 } {
  // Blender's mesh-vertex BVH silently promotes an explicit zero epsilon to
  // FLT_EPSILON. With no nearest callback, BLI_bvhtree_find_nearest returns
  // the point clamped to that inflated leaf AABB rather than copying the
  // authored vertex coordinate. This is observable when a small coordinate's
  // ULP is finer than FLT_EPSILON (Chrome Crayon's Y coordinate is shifted by
  // exactly one ULP while its larger X/Z coordinates remain unchanged).
  const f = Math.fround;
  const p: Vec3 = [f(point[0]), f(point[1]), f(point[2])];
  const q: Vec3 = [f(target[0]), f(target[1]), f(target[2])];
  const nearest: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const min = f(q[axis] - BLENDER_BVH_POINT_EPSILON);
    const max = f(q[axis] + BLENDER_BVH_POINT_EPSILON);
    nearest[axis] = Math.min(max, Math.max(min, p[axis]));
  }
  const delta: Vec3 = [
    f(nearest[0] - p[0]),
    f(nearest[1] - p[1]),
    f(nearest[2] - p[2]),
  ];
  let dSquared = f(f(delta[0] * delta[0]) + f(delta[1] * delta[1]));
  dSquared = f(dSquared + f(delta[2] * delta[2]));
  return { dSquared, q: nearest };
}

reg("GeometryNodeProximity", (api) => {
  let target = api.geo("Target");
  if (target.instances.length) target = realizeInstances(target);
  const pts: Vec3[] = target.mesh ? target.mesh.positions : target.curves.flatMap((s) => s.points);
  const targetElement = api.prop<string>("target_element", "POINTS");
  const faces = targetElement === "FACES" && target.mesh ? proximityBvh(target.mesh) : null;
  const segments: [Vec3, Vec3][] = targetElement === "EDGES" && target.mesh
    ? buildTopology(target.mesh).edges.map((edge) => [target.mesh!.positions[edge.verts[0]], target.mesh!.positions[edge.verts[1]]])
    : [];
  const posLinked = api.node.inputs.find((s) => s.identifier === "Source Position")?.linked;
  const posF = posLinked ? api.field("Source Position") : null;
  type KdNode = { index: number; axis: 0 | 1 | 2; left: KdNode | null; right: KdNode | null };
  const buildKd = (indices: number[], depth = 0): KdNode | null => {
    if (!indices.length) return null;
    const axis = (depth % 3) as 0 | 1 | 2;
    indices.sort((a, b) => pts[a][axis] - pts[b][axis]);
    const mid = indices.length >> 1;
    return {
      index: indices[mid],
      axis,
      left: buildKd(indices.slice(0, mid), depth + 1),
      right: buildKd(indices.slice(mid + 1), depth + 1),
    };
  };
  const kdRoot = buildKd(Array.from({ length: pts.length }, (_, i) => i));
  const nearest = (p: Vec3): { d: number; q: Vec3 } => {
    if (!pts.length) return { d: 0, q: [0, 0, 0] };
    if (faces) return nearestFacePoint(p, faces);
    if (segments.length) return nearestEdgePointFloat32(p, segments);
    // Blender's point BVH stores float coordinates and BVHTreeNearest.dist_sq
    // is a float. Recomputing this path in JavaScript doubles moved every
    // Chrome Crayon proximity sample, then amplified the error in the marching
    // squares edge-interpolation divide.
    const f = Math.fround;
    const sample: Vec3 = [f(p[0]), f(p[1]), f(p[2])];
    let bestSq = Infinity;
    let best: Vec3 = [0, 0, 0];
    const visit = (node: KdNode | null) => {
      if (!node) return;
      const candidate = nearestPointBvhLeafFloat32(sample, pts[node.index]);
      if (candidate.dSquared < bestSq) { bestSq = candidate.dSquared; best = candidate.q; }
      const q = pts[node.index];
      const delta = f(sample[node.axis] - q[node.axis]);
      const near = delta <= 0 ? node.left : node.right;
      const far = delta <= 0 ? node.right : node.left;
      visit(near);
      // Every leaf crosses its raw split coordinate by FLT_EPSILON. Keep the
      // far branch whenever its inflated plane can still beat the best leaf.
      const outside = f(Math.max(0, Math.abs(delta) - BLENDER_BVH_POINT_EPSILON));
      if (f(outside * outside) < bestSq) visit(far);
    };
    visit(kdRoot);
    return { d: f(Math.sqrt(bestSq)), q: best };
  };
  const sample = (ctx: import("../core").FieldCtx, i: number, arr: import("../core").Elem[] | null): Vec3 =>
    arr ? asVec3(arr[i] ?? [0, 0, 0]) : ctx.position?.(i) ?? [0, 0, 0];
  return {
    Position: Field.make((ctx) => {
      const arr = posF ? posF.array(ctx) : null;
      const positions: Vec3[] = Array.from({ length: ctx.size }, (_, i) => sample(ctx, i, arr));
      const values: Vec3[] = positions.map((position) => (pts.length ? nearest(position).q : [0, 0, 0]));
      if (FIELD_PROBE.node === api.node.name && FIELD_PROBE.socket === "Position") {
        FIELD_PROBE.batches.push({ domain: ctx.domain, positions, values, targets: pts });
      }
      return values;
    }),
    Distance: Field.make((ctx) => {
      const arr = posF ? posF.array(ctx) : null;
      if (FIELD_PROBE.node !== api.node.name || FIELD_PROBE.socket !== "Distance") {
        return Array.from({ length: ctx.size }, (_, i) => (pts.length ? nearest(sample(ctx, i, arr)).d : 0));
      }
      const positions = Array.from({ length: ctx.size }, (_, i) => sample(ctx, i, arr));
      const values = positions.map((p) => (pts.length ? nearest(p).d : 0));
      FIELD_PROBE.batches.push({ domain: ctx.domain, positions, values, targets: pts });
      return values;
    }),
    "Is Valid": Field.of(pts.length ? 1 : 0),
  };
});

// ---- bounding box ---------------------------------------------------------
reg("GeometryNodeBoundBox", (api) => {
  const g = api.geo("Geometry");
  let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  // Blender computes bounds for realized mesh/curve components, but does not
  // open an Instances component. Text Soup deliberately sends glyph instances
  // through Bounding Box before realization, so Blender returns a zero box and
  // its Set Center group becomes a no-op. Curve-only realized geometry must
  // still contribute (the bubble vase derives its resample density from it).
  let count = 0;
  const eat = (p: Vec3) => {
    count++;
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  };
  for (const p of g.mesh?.positions ?? []) eat(p);
  // Blender's bounds for a Curves component include each control point's
  // radius in every axis, even before the curve has a bevel/profile. Radius is
  // implicitly 1 when the attribute is absent. Text Soup uses that two-unit
  // diameter as padding when sizing its marching-squares sampling grid.
  // A Mesh-to-Curve component crossing Object Info contributes Blender's 0.01
  // base curve-width to bounds. Using the generic radius as a world-unit value
  // enlarged UI Window's grids by almost one unit; suppressing it entirely
  // left them 0.01 units too narrow. Local Mesh-to-Curve wires remain purely
  // positional, while native/font Curves retain their full radius behavior.
  // Procedural Box is the mixed-component exception: its pin mesh and font
  // diagnostic are combined before Bounding Box, and Blender uses the font's
  // positional outline there without expanding it by the generic radius.
  const meshCurve = g.curveAttributes.has("__gnvm_planar_mesh_curve");
  const objectInfoMeshCurve = g.curveAttributes.has("__gnvm_object_info_mesh_curve");
  const radius = (meshCurve && !objectInfoMeshCurve)
    || (Boolean(g.mesh?.positions.length) && g.curveAttributes.has("__gnvm_planar_font_curve"))
    ? null
    : g.curveAttributes.get("radius");
  let pointIndex = 0;
  for (const spline of g.curves) {
    for (const p of spline.points) {
      const r = radius === null ? 0 : Math.abs(asNum(radius?.data[pointIndex] ?? 1)) * (objectInfoMeshCurve ? 0.01 : 1);
      count++;
      for (let axis = 0; axis < 3; axis++) {
        const lower = objectInfoMeshCurve ? Math.fround(Math.fround(p[axis]) - Math.fround(r)) : p[axis] - r;
        const upper = objectInfoMeshCurve ? Math.fround(Math.fround(p[axis]) + Math.fround(r)) : p[axis] + r;
        min[axis] = Math.min(min[axis], lower);
        max[axis] = Math.max(max[axis], upper);
      }
      pointIndex++;
    }
  }
  if (!count) { min = [0, 0, 0]; max = [0, 0, 0]; }
  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const center: Vec3 = [(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2];
  const box = meshCube(size, 2, 2, 2);
  if (box.mesh) box.mesh.positions = box.mesh.positions.map((p) => vadd(p, center));
  return { "Bounding Box": box, Min: Field.of(min), Max: Field.of(max) };
});

// ---- passthrough-ish stubs that keep geometry flowing ---------------------
const passGeometry = (api: EvalAPI) => ({ Geometry: api.geo("Geometry") });
reg("GeometryNodeSetShadeSmooth", (api) => {
  const domain = api.prop<"FACE" | "EDGE">("domain", "FACE");
  const selection = api.field("Selection");
  const shadeSmooth = api.field("Shade Smooth");
  const g = mapInstancePayloadMeshes(api.geo("Geometry"), (geometry) => {
    if (!geometry.mesh || (domain !== "FACE" && domain !== "EDGE")) return;
    const ctx = makeFieldCtx(geometry, domain);
    const selected = selection.array(ctx);
    const smooth = shadeSmooth.array(ctx);
    const attributeName = domain === "EDGE" ? "sharp_edge" : "sharp_face";
    const existing = geometry.mesh.attributes.get(attributeName);
    const data = existing?.domain === domain ? [...existing.data] : Array.from({ length: ctx.size }, () => 0);
    while (data.length < ctx.size) data.push(0);
    for (let index = 0; index < ctx.size; index++) {
      if (!asNum(selected[index] ?? 1)) continue;
      // Blender stores the inverse of the node's UI value: smooth faces and
      // smooth edge transitions are represented by false sharp attributes.
      data[index] = asNum(smooth[index] ?? 1) ? 0 : 1;
    }
    geometry.mesh.attributes.set(attributeName, { domain, data });
  });
  return { Geometry: g };
});
reg("GeometryNodeSetID", passGeometry);
reg("GeometryNodeStoreNamedAttribute", (api) => {
  const name = api.str("Name");
  const domain = (api.prop<string>("domain", "POINT") as any);
  const dataType = api.prop<string>("data_type", "FLOAT");
  const value = api.field("Value");
  const g = mapInstancePayloadMeshes(api.geo("Geometry"), (geometry) => {
    if (!geometry.mesh || !name) return;
    const ctx = makeFieldCtx(geometry, domain);
    let data = value.array(ctx);
    // Blender preserves negative and HDR channels in FLOAT_COLOR attributes.
    // Only BYTE_COLOR uses normalized bounded storage.
    if (dataType === "BYTE_COLOR") {
      data = data.map((item) => {
        const color = asVec3(item);
        return color.map((channel) => Math.max(0, Math.min(1, channel))) as Vec3;
      });
    }
    geometry.mesh.attributes.set(name, { domain, data });
  });
  return { Geometry: g };
});
