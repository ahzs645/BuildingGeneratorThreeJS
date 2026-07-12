// Geometry-operation handlers.
import { Field, Vec3, asVec3, asNum, vadd } from "../core";
import { Geometry, Mesh, InstanceRef, buildTopology, mergeMeshInto, realizeInstances, transformPoint } from "../geometry";
import { meshCube, meshGrid, meshCircle, meshLine, meshCone } from "../primitives";
import { reg, EvalAPI, DUMP_CONTEXT } from "../registry";
import { FIELD_PROBE, makeFieldCtx } from "../evaluator";

// ---- object info ------------------------------------------------------------
// Materializes a referenced scene object from the dump's embedded plain meshes
// (dump_blend.py exports them for non-GN objects, e.g. the bin's 'printbed').
reg("GeometryNodeObjectInfo", (api) => {
  const ref = api.ref("Object");
  const obj = DUMP_CONTEXT.objects.find((o) => o.name === ref?.name);
  const out = new Geometry();
  if (obj?.mesh) {
    const m = new Mesh();
    m.positions = obj.mesh.verts.map((p) => [p[0], p[1], p[2]] as Vec3);
    m.faces = obj.mesh.faces.map((f) => [...f]);
    m.faceMaterial = obj.mesh.face_materials ? [...obj.mesh.face_materials] : m.faces.map(() => 0);
    m.materialSlots = obj.materials?.length ? [...obj.materials] : [null];
    m.edges = (obj.mesh.edges ?? []).map((e) => [...e] as [number, number]);
    if (api.prop<string>("transform_space", "ORIGINAL") === "RELATIVE") {
      const loc = (obj.location ?? [0, 0, 0]) as Vec3;
      const rot = (obj.rotation ?? [0, 0, 0]) as Vec3;
      const scl = (obj.scale ?? [1, 1, 1]) as Vec3;
      m.positions = m.positions.map((p) => transformPoint(p, loc, rot, scl));
    }
    out.mesh = m;
  }
  if (obj?.curves) out.curves = obj.curves.map((s) => ({
    cyclic: Boolean(s.cyclic),
    points: s.points.map((p) => [p[0], p[1], p[2]] as Vec3),
  }));
  return {
    Geometry: out,
    Location: Field.of(((obj?.location ?? [0, 0, 0]) as Vec3)),
    Rotation: Field.of(((obj?.rotation ?? [0, 0, 0]) as Vec3)),
    Scale: Field.of(((obj?.scale ?? [1, 1, 1]) as Vec3)),
  };
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
  // Selection fields (const true for whole mesh — enough for non-mask consumers)
  const yes = Field.of(1);
  return { Mesh: mesh, Top: yes, Bottom: yes, Side: yes, "UV Map": Field.of([0, 0, 0]) };
});

// ---- transform ------------------------------------------------------------
reg(["GeometryNodeTransform", "GeometryNodeTransformGeometry"], (api) => {
  const g = api.geo("Geometry").clone();
  const t = api.vec("Translation"), r = api.vec("Rotation"), s = api.vec("Scale");
  if (g.mesh) g.mesh.positions = g.mesh.positions.map((p) => transformPoint(p, t, r, s));
  for (const spline of g.curves) spline.points = spline.points.map((p) => transformPoint(p, t, r, s));
  for (const inst of g.instances) {
    inst.position = transformPoint(inst.position, t, r, s);
  }
  return { Geometry: g };
});

// ---- set position ---------------------------------------------------------
reg("GeometryNodeSetPosition", (api) => {
  const g = api.geo("Geometry").clone();
  if (!g.mesh && !g.curves.length) return { Geometry: g };
  const ctx = makeFieldCtx(g, "POINT");
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
  if (g.mesh) {
    g.mesh.positions = g.mesh.positions.map(move);
  } else {
    // curve geometry: the ctx flattens control points in spline order
    let i = 0;
    g.curves = g.curves.map((s) => ({ cyclic: s.cyclic, points: s.points.map((p) => move(p, i++)) }));
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
    for (const s of g.curves) out.curves.push({ cyclic: s.cyclic, points: s.points.map((p) => [...p] as Vec3) });
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
  // Points come from either a mesh (vertex positions) or a curve (control points).
  const pts: Vec3[] = points.mesh
    ? points.mesh.positions
    : points.curves.flatMap((s) => s.points);
  if (!pts.length) return { Instances: out };
  const ctx = makeFieldCtx(points, "POINT");
  const sel = api.field("Selection").array(ctx);
  const rot = api.field("Rotation").array(ctx);
  const scl = api.field("Scale").array(ctx);
  const pickInstance = api.bool("Pick Instance");
  const instanceIndices = api.field("Instance Index").array(ctx);
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
    const picked = pickInstance && instance.instances.length
      ? instance.instances[((Math.round(asNum(instanceIndices[i] ?? 0)) % instance.instances.length) + instance.instances.length) % instance.instances.length]
      : null;
    out.instances.push({
      geometry: picked?.geometry ?? instance,
      position: pts[i],
      rotation: picked ? vadd(asVec3(rot[i] ?? [0, 0, 0]), picked.rotation) : asVec3(rot[i] ?? [0, 0, 0]),
      scale: picked ? [s[0] * picked.scale[0], s[1] * picked.scale[1], s[2] * picked.scale[2]] : s,
      attributes,
    } as InstanceRef);
  }
  return { Instances: out };
});

reg("GeometryNodeTranslateInstances", (api) => {
  const g = api.geo("Instances").clone();
  const t = api.vec("Translation");
  for (const inst of g.instances) inst.position = vadd(inst.position, t);
  return { Instances: g };
});

reg("GeometryNodeRealizeInstances", (api) => ({ Geometry: realizeInstances(api.geo("Geometry")) }));

// ---- capture attribute ----------------------------------------------------
reg("GeometryNodeCaptureAttribute", (api) => {
  const g = api.geo("Geometry").clone();
  const domMap: Record<string, any> = { POINT: "POINT", EDGE: "EDGE", FACE: "FACE", CORNER: "CORNER", INSTANCE: "INSTANCE", CURVE: "POINT" };
  let domain = domMap[api.prop<string>("domain", "POINT")] ?? "POINT";
  const name = `__cap_${api.node.name}`;
  if (g.mesh) {
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
    // curve geometry: capture over flattened control points (POINT domain)
    const ctx = makeFieldCtx(g, "POINT");
    g.curveAttributes.set(name, { domain: "POINT", data: api.field("Value").array(ctx) });
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
reg("GeometryNodeProximity", (api) => {
  let target = api.geo("Target");
  if (target.instances.length) target = realizeInstances(target);
  const pts: Vec3[] = target.mesh ? target.mesh.positions : target.curves.flatMap((s) => s.points);
  const targetElement = api.prop<string>("target_element", "POINTS");
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
  // Blender's bbox spans all components: mesh verts, curve control points, and
  // instances. Curve-only geometry returned a zero box, which zeroed the bubble
  // vase's whole density chain (bbox dim -> resample count = 0).
  let count = 0;
  const eat = (p: Vec3) => {
    count++;
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  };
  for (const p of g.mesh?.positions ?? []) eat(p);
  for (const s of g.curves) for (const p of s.points) eat(p);
  for (const inst of g.instances) {
    const child = inst.geometry;
    for (const p of child.mesh?.positions ?? []) eat(transformPoint(p, inst.position, inst.rotation, inst.scale));
    for (const s of child.curves) for (const p of s.points) eat(transformPoint(p, inst.position, inst.rotation, inst.scale));
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
