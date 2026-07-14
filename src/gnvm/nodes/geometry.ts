// Geometry-operation handlers.
import { Field, Vec3, asVec3, asNum, vadd, vdot, vsub } from "../core";
import { Geometry, Mesh, InstanceRef, buildTopology, inverseTransformPoint, mergeMeshInto, realizeInstances, rotateEulerXYZ, transformPoint, triangulateFaceIndices } from "../geometry";
import { meshCube, meshGrid, meshCircle, meshLine, meshCone } from "../primitives";
import { reg, EvalAPI, DUMP_CONTEXT } from "../registry";
import { FIELD_PROBE, makeFieldCtx } from "../evaluator";

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

function relativeInstanceTransform(objectMatrix: Matrix4Rows, activeMatrix: Matrix4Rows): { position: Vec3; rotation: Vec3; scale: Vec3 } {
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
  return { position, rotation, scale };
}

reg("GeometryNodeObjectInfo", (api) => {
  const ref = api.ref("Object");
  const obj = DUMP_CONTEXT.objects.find((o) => o.name === ref?.name);
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
    const relative = objectMatrix && activeMatrix
      ? (point: Vec3) => inverseTransformByMatrix(transformByMatrix(point, objectMatrix), activeMatrix)
      : (point: Vec3) => inverseTransformPoint(transformPoint(point, loc, rot, scl), activeLoc, activeRot, activeScale);
    if (out.mesh) out.mesh.positions = out.mesh.positions.map(relative);
    for (const spline of out.curves) spline.points = spline.points.map(relative);
    for (const instance of out.instances) instance.position = relative(instance.position);
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
    const relative = api.prop<string>("transform_space", "ORIGINAL") === "RELATIVE" && objectMatrix && activeMatrix
      ? relativeInstanceTransform(objectMatrix, activeMatrix)
      : null;
    out.instances.push({
      geometry,
      position: resetChildren ? [0, 0, 0] : relative?.position ?? ((object?.location ?? [0, 0, 0]) as Vec3),
      rotation: resetChildren ? [0, 0, 0] : relative?.rotation ?? ((object?.rotation ?? [0, 0, 0]) as Vec3),
      scale: resetChildren ? [1, 1, 1] : relative?.scale ?? ((object?.scale ?? [1, 1, 1]) as Vec3),
    });
  }
  return { Instances: out };
});

// ---- primitives -----------------------------------------------------------
reg("GeometryNodeMeshCube", (api) => ({
  Mesh: meshCube(api.vec("Size"), api.num("Vertices X") || 2, api.num("Vertices Y") || 2, api.num("Vertices Z") || 2),
}));
reg("GeometryNodeMeshGrid", (api) => ({
  Mesh: meshGrid(api.num("Size X"), api.num("Size Y"), api.num("Vertices X") || 3, api.num("Vertices Y") || 3),
}));
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
  if (g.mesh) g.mesh.positions = g.mesh.positions.map((p) => transformPoint(p, t, r, s));
  for (const spline of g.curves) {
    spline.points = spline.points.map((p) => transformPoint(p, t, r, s));
    if (spline.controlPoints) spline.controlPoints = spline.controlPoints.map((p) => transformPoint(p, t, r, s));
  }
  for (const inst of g.instances) {
    inst.position = transformPoint(inst.position, t, r, s);
    // Transform Geometry composes with the complete instance transform, not
    // only its origin. The Dojo text assets rotate/scale glyph instances before
    // Extrude Mesh and expose the difference in their raised letter bounds.
    // Component-wise Euler composition is exact for the single-axis rotations
    // used by these graphs (and matches Rotate Instances' current semantics).
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
    return vadd(base, asVec3(off[i] ?? [0, 0, 0]));
  };
  if (hasMeshPoints) {
    g.mesh!.positions = g.mesh!.positions.map(move);
  } else if (g.curves.length) {
    // curve geometry: the ctx flattens control points in spline order
    let i = 0;
    g.curves = g.curves.map((s) => ({ cyclic: s.cyclic, points: s.points.map((p) => move(p, i++)) }));
  } else {
    g.instances = g.instances.map((instance, i) => ({ ...instance, position: move(instance.position, i) }));
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
      return { ...instance, position: vadd(base, asVec3(instanceOffset[i] ?? [0, 0, 0])) };
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
    });
  }
  return { Geometry: out };
});

// ---- materials ------------------------------------------------------------
reg("GeometryNodeSetMaterial", (api) => {
  const g = api.geo("Geometry").clone();
  const mat = api.ref("Material");
  if (g.mesh) {
    const slot = g.mesh.ensureMaterialSlot(mat?.name ?? null);
    const ctx = makeFieldCtx(g, "FACE");
    const sel = api.field("Selection").array(ctx);
    for (let fi = 0; fi < g.mesh.faces.length; fi++) if (asNum(sel[fi] ?? 1)) g.mesh.faceMaterial[fi] = slot;
  }
  return { Geometry: g };
});

// ---- instancing -----------------------------------------------------------
reg("GeometryNodeInstanceOnPoints", (api) => {
  const points = api.geo("Points");
  const instance = api.geo("Instance");
  const out = new Geometry();
  // Some supplied products use Blender's version-specific stochastic point
  // distribution as an authored layout rather than as an exposed control.
  // The extraction pipeline can preserve those evaluated transforms directly
  // on this node, just as it preserves packed glyph outlines. Downstream graph
  // controls still operate on the resulting instances in the browser.
  const bakedInstances = api.node.baked_instances
    ?? api.prop<{ position: Vec3; rotation?: Vec3; scale: Vec3 }[]>("baked_instances", []);
  if (bakedInstances.length) {
    for (const baked of bakedInstances) out.instances.push({
      geometry: instance,
      position: [...baked.position] as Vec3,
      rotation: [...(baked.rotation ?? [0, 0, 0])] as Vec3,
      scale: [...baked.scale] as Vec3,
    });
    return { Instances: out };
  }
  // Points come from either a mesh (vertex positions) or a curve (control points).
  const pts: Vec3[] = points.mesh
    ? points.mesh.positions
    : points.curves.flatMap((s) => s.points);
  if (!pts.length) return { Instances: out };
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
    ? [...points.mesh.attributes].filter(([, a]) => a.domain === "POINT")
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
    out.instances.push({
      geometry: picked?.geometry ?? instance,
      // A picked child keeps its own transform. Compose its origin through the
      // point transform before placing it in the parent geometry.
      position: picked ? transformPoint(picked.position, pts[i], outerRotation, s) : pts[i],
      rotation: picked ? vadd(outerRotation, picked.rotation) : outerRotation,
      scale: picked ? [s[0] * picked.scale[0], s[1] * picked.scale[1], s[2] * picked.scale[2]] : s,
      attributes,
    } as InstanceRef);
  }
  return { Instances: out };
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
  for (const [name, data] of instanceAttributeData) mesh.attributes.set(name, { domain: "POINT", data });
  out.mesh = mesh;
  return { Points: out };
});

reg("GeometryNodeTranslateInstances", (api) => {
  const g = api.geo("Instances").clone();
  const t = api.vec("Translation");
  for (const inst of g.instances) inst.position = vadd(inst.position, t);
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
    if (!local) {
      const relative = [instance.position[0] - pivot[0], instance.position[1] - pivot[1], instance.position[2] - pivot[2]] as Vec3;
      instance.position = vadd(pivot, rotateEulerXYZ(relative, rotation));
    }
    // The asset graphs rotate only around Z; component-wise Euler addition is
    // exact for that case and preserves existing point rotations.
    instance.rotation = vadd(instance.rotation, rotation);
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
    let data: import("../core").Elem[];
    if (value.srcDomain && value.srcDomain !== domain && ctx.toDomain) {
      const source = value.srcDomain;
      const sourceData = value.array(makeFieldCtx(g, source));
      data = Array.from({ length: ctx.size }, (_, i) => ctx.toDomain!(source, sourceData, i) ?? 0);
    } else {
      data = value.array(ctx);
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
    Attribute: Field.perElem((i, ctx) => (ctx.attr ? (ctx.attr(name, i) ?? 0) : 0)).tagged(domain),
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

function closestTrianglePoint(point: Vec3, triangle: ProximityTriangle): Vec3 {
  const ab = vsub(triangle.b, triangle.a), ac = vsub(triangle.c, triangle.a), ap = vsub(point, triangle.a);
  const d1 = vdot(ab, ap), d2 = vdot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return triangle.a;
  const bp = vsub(point, triangle.b), d3 = vdot(ab, bp), d4 = vdot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return triangle.b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3);
    return [triangle.a[0] + ab[0] * t, triangle.a[1] + ab[1] * t, triangle.a[2] + ab[2] * t];
  }
  const cp = vsub(point, triangle.c), d5 = vdot(ab, cp), d6 = vdot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return triangle.c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6);
    return [triangle.a[0] + ac[0] * t, triangle.a[1] + ac[1] * t, triangle.a[2] + ac[2] * t];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const edge = vsub(triangle.c, triangle.b);
    const t = (d4 - d3) / (d4 - d3 + d5 - d6);
    return [triangle.b[0] + edge[0] * t, triangle.b[1] + edge[1] * t, triangle.b[2] + edge[2] * t];
  }
  const denominator = va + vb + vc;
  if (Math.abs(denominator) < 1e-20) return triangle.a;
  const v = vb / denominator, w = vc / denominator;
  return [triangle.a[0] + ab[0] * v + ac[0] * w, triangle.a[1] + ab[1] * v + ac[1] * w, triangle.a[2] + ab[2] * v + ac[2] * w];
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
  let bestSquared = Infinity;
  let best: Vec3 = [0, 0, 0];
  const visit = (node: ProximityBvh) => {
    if (boxDistanceSquared(point, node.min, node.max) >= bestSquared) return;
    if (node.triangles) {
      for (const triangle of node.triangles) {
        const q = closestTrianglePoint(point, triangle);
        const delta = vsub(point, q), squared = vdot(delta, delta);
        if (squared < bestSquared) { bestSquared = squared; best = q; }
      }
      return;
    }
    const children = [node.left, node.right].filter((child): child is ProximityBvh => !!child)
      .sort((a, b) => boxDistanceSquared(point, a.min, a.max) - boxDistanceSquared(point, b.min, b.max));
    for (const child of children) visit(child);
  };
  visit(root);
  return { d: Math.sqrt(bestSquared), q: best };
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
    if (segments.length) {
      let bestSq = Infinity;
      let best: Vec3 = segments[0][0];
      for (const [a, b] of segments) {
        const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
        const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
        const denom = abx * abx + aby * aby + abz * abz;
        const t = denom > 1e-20 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / denom)) : 0;
        const q: Vec3 = [a[0] + abx * t, a[1] + aby * t, a[2] + abz * t];
        const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
        const dSq = dx * dx + dy * dy + dz * dz;
        if (dSq < bestSq) { bestSq = dSq; best = q; }
      }
      return { d: Math.sqrt(bestSq), q: best };
    }
    let bestSq = Infinity;
    let bestIndex = 0;
    const visit = (node: KdNode | null) => {
      if (!node) return;
      const q = pts[node.index];
      const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < bestSq) { bestSq = dSq; bestIndex = node.index; }
      const delta = p[node.axis] - q[node.axis];
      const near = delta <= 0 ? node.left : node.right;
      const far = delta <= 0 ? node.right : node.left;
      visit(near);
      if (delta * delta < bestSq) visit(far);
    };
    visit(kdRoot);
    return { d: Math.sqrt(bestSq), q: pts[bestIndex] };
  };
  const sample = (ctx: import("../core").FieldCtx, i: number, arr: import("../core").Elem[] | null): Vec3 =>
    arr ? asVec3(arr[i] ?? [0, 0, 0]) : ctx.position?.(i) ?? [0, 0, 0];
  return {
    Position: Field.make((ctx) => {
      const arr = posF ? posF.array(ctx) : null;
      return Array.from({ length: ctx.size }, (_, i) => (pts.length ? nearest(sample(ctx, i, arr)).q : [0, 0, 0]));
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
  for (const s of g.curves) for (const p of s.points) eat(p);
  if (!count) { min = [0, 0, 0]; max = [0, 0, 0]; }
  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const center: Vec3 = [(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2];
  const box = meshCube(size, 2, 2, 2);
  if (box.mesh) box.mesh.positions = box.mesh.positions.map((p) => vadd(p, center));
  return { "Bounding Box": box, Min: Field.of(min), Max: Field.of(max) };
});

// ---- passthrough-ish stubs that keep geometry flowing ---------------------
const passGeometry = (api: EvalAPI) => ({ Geometry: api.geo("Geometry") });
reg("GeometryNodeSetShadeSmooth", passGeometry);
reg("GeometryNodeSetID", passGeometry);
reg("GeometryNodeStoreNamedAttribute", (api) => {
  const g = api.geo("Geometry").clone();
  const name = api.str("Name");
  const domain = (api.prop<string>("domain", "POINT") as any);
  if (g.mesh && name) {
    const ctx = makeFieldCtx(g, domain);
    g.mesh.attributes.set(name, { domain, data: api.field("Value").array(ctx) });
  }
  return { Geometry: g };
});
