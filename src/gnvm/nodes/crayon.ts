// Geometry-node handlers first required by the Node Dojo Chrome Crayon graph.
// They are general VM operations, kept in one module so the compatibility
// milestone remains easy to audit against its Blender source.
import { Field, FieldCtx, Vec3, Elem, Domain, asNum, asVec3, vadd, vsub, vscale, vdot, vcross, vlen, vnorm } from "../core";
import { Geometry, Mesh, buildTopology, invalidateMeshCaches, orientClosedSurface, realizeInstances, triangulateFaceIndices } from "../geometry";
import { resampleSpline, splineFrames, splineLength } from "../curves";
import { FIELD_PROBE, makeFieldCtx } from "../evaluator";
import { reg, EvalAPI } from "../registry";

const DOMAINS = new Set<Domain>(["POINT", "EDGE", "FACE", "CORNER", "CURVE", "INSTANCE"]);
type Quat = [number, number, number, number];
const ROTATION_QUATERNION = Symbol.for("gnvm.rotationQuaternion");
type TaggedRotation = Vec3 & { [ROTATION_QUATERNION]?: Quat };
const domainOf = (api: EvalAPI, fallback: Domain = "POINT"): Domain => {
  const raw = api.prop<string>("domain", fallback) as Domain;
  return DOMAINS.has(raw) ? raw : fallback;
};

const zeroLike = (value: Elem): Elem => Array.isArray(value) ? [0, 0, 0] : 0;
const addElem = (a: Elem, b: Elem): Elem => Array.isArray(a) || Array.isArray(b)
  ? vadd(asVec3(a), asVec3(b))
  : asNum(a) + asNum(b);

reg("GeometryNodeInputSplineCyclic", () => ({
  Cyclic: Field.perElem((i, ctx) => ctx.splineCyclic?.(i) ? 1 : 0),
}));

reg("GeometryNodeInputShadeSmooth", () => ({ Smooth: Field.of(1) }));

reg("GeometryNodeSplineLength", () => ({
  Length: Field.perElem((i, ctx) => ctx.splineLength?.(i) ?? 0).tagged("CURVE"),
  "Point Count": Field.perElem((i, ctx) => ctx.splinePointCount?.(i) ?? 0).tagged("CURVE"),
}));

reg("GeometryNodeGeometryToInstance", (api) => {
  const out = new Geometry();
  for (const geometry of api.geoInputs("Geometry")) {
    out.instances.push({ geometry, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
  }
  return { Instances: out };
});

function copySubmesh(
  mesh: Mesh,
  vertices: Set<number>,
  faces: number[],
  edgeIndices: number[],
  topology: ReturnType<typeof buildTopology>,
): Mesh {
  const out = new Mesh();
  out.materialSlots = [...mesh.materialSlots];
  const ordered = [...vertices].sort((a, b) => a - b);
  const remap = new Map(ordered.map((old, next) => [old, next]));
  out.positions = ordered.map((i) => [...mesh.positions[i]] as Vec3);
  out.edges = edgeIndices.map((index) => {
    const [a, b] = topology.edges[index].verts;
    return [remap.get(a)!, remap.get(b)!];
  });
  out.faces = faces.map((fi) => mesh.faces[fi].map((vi) => remap.get(vi)!));
  out.faceMaterial = faces.map((fi) => mesh.faceMaterial[fi] ?? 0);
  const cornerStarts: number[] = [];
  let cornerStart = 0;
  for (const face of mesh.faces) {
    cornerStarts.push(cornerStart);
    cornerStart += face.length;
  }
  for (const [name, attr] of mesh.attributes) {
    if (attr.domain === "POINT") out.attributes.set(name, { domain: "POINT", data: ordered.map((i) => attr.data[i] ?? 0) });
    else if (attr.domain === "EDGE") out.attributes.set(name, { domain: "EDGE", data: edgeIndices.map((i) => attr.data[i] ?? 0) });
    else if (attr.domain === "FACE") out.attributes.set(name, { domain: "FACE", data: faces.map((fi) => attr.data[fi] ?? 0) });
    else if (attr.domain === "CORNER") out.attributes.set(name, {
      domain: "CORNER",
      data: faces.flatMap((fi) => mesh.faces[fi].map((_, corner) => attr.data[cornerStarts[fi] + corner] ?? 0)),
    });
  }
  return out;
}

reg("GeometryNodeSplitToInstances", (api) => {
  const g = api.geo("Geometry");
  const out = new Geometry();
  if (!g.mesh) return { Instances: out, "Group ID": Field.of(0) };
  const mesh = g.mesh;
  const topo = buildTopology(mesh);
  const domain = domainOf(api);
  const groupIdLinked = api.node.inputs.some((socket) =>
    (socket.identifier === "Group ID" || socket.name === "Group ID") && socket.linked);

  // Split to Instances evaluates Selection and Group ID on its chosen domain.
  // In FACE mode a group owns whole faces, and vertices shared with another
  // group are copied into both instance payloads. String to Text deliberately
  // feeds Face Index into Group ID, so its 20 N-gons become 20 independent
  // instances and their 246 corners realize as 246 vertices.
  if (domain === "FACE" && groupIdLinked) {
    const ctx = makeFieldCtx(g, "FACE");
    const selection = api.field("Selection").array(ctx);
    const groupIds = api.field("Group ID").array(ctx);
    const faceGroups = new Map<number, number[]>();
    for (let fi = 0; fi < mesh.faces.length; fi++) {
      if (asNum(selection[fi] ?? 1) <= 0) continue;
      const group = Math.round(asNum(groupIds[fi] ?? 0));
      const faces = faceGroups.get(group);
      if (faces) faces.push(fi);
      else faceGroups.set(group, [fi]);
    }
    for (const [group, faces] of [...faceGroups].sort((a, b) => a[0] - b[0])) {
      const faceSet = new Set(faces);
      const vertices = new Set(faces.flatMap((fi) => mesh.faces[fi]));
      const edgeIndices = topo.edges
        .map((edge, index) => edge.faces.some((fi) => faceSet.has(fi)) ? index : -1)
        .filter((index) => index >= 0);
      const geometry = new Geometry();
      geometry.mesh = copySubmesh(mesh, vertices, faces, edgeIndices, topo);
      out.instances.push({
        geometry,
        position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        attributes: new Map([["__split_group", group]]),
      });
    }
    return {
      Instances: out,
      "Group ID": Field.perElem((i) => out.instances[i]?.attributes?.get("__split_group") ?? 0).tagged("INSTANCE"),
    };
  }

  // Retain the compatibility behavior for unsupported domains and older dumps
  // whose Group ID socket was not connected: one instance per topology island.
  const groups = new Map<number, Set<number>>();
  for (let vi = 0; vi < mesh.positions.length; vi++) {
    const group = topo.pointIsland[vi] ?? 0;
    const verts = groups.get(group) ?? new Set<number>();
    verts.add(vi);
    groups.set(group, verts);
  }
  for (const [group, vertices] of [...groups].sort((a, b) => a[0] - b[0])) {
    const faces: number[] = [];
    for (let fi = 0; fi < mesh.faces.length; fi++) if (mesh.faces[fi].every((vi) => vertices.has(vi))) faces.push(fi);
    const edgeIndices = topo.edges
      .map((edge, index) => vertices.has(edge.verts[0]) && vertices.has(edge.verts[1]) ? index : -1)
      .filter((index) => index >= 0);
    const geometry = new Geometry();
    geometry.mesh = copySubmesh(mesh, vertices, faces, edgeIndices, topo);
    out.instances.push({ geometry, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], attributes: new Map([["__split_group", group]]) });
  }
  return {
    Instances: out,
    "Group ID": Field.perElem((i) => out.instances[i]?.attributes?.get("__split_group") ?? 0).tagged("INSTANCE"),
  };
});

reg("GeometryNodeDuplicateElements", (api) => {
  const g = api.geo("Geometry");
  const domain = domainOf(api);
  if (domain !== "FACE" || !g.mesh) return { Geometry: g.clone(), "Duplicate Index": Field.of(0) };
  const source = g.mesh;
  const ctx = makeFieldCtx(g, "FACE");
  const selection = api.field("Selection").array(ctx);
  const amounts = api.field("Amount").array(ctx);
  if (FIELD_PROBE.node === api.node.name) {
    const values = FIELD_PROBE.socket === "Amount" ? amounts : selection;
    FIELD_PROBE.batches.push({
      domain: "FACE",
      positions: Array.from({ length: ctx.size }, (_, i) => ctx.position?.(i) ?? [0, 0, 0]),
      values,
    });
  }
  const out = new Mesh();
  out.materialSlots = [...source.materialSlots];
  const duplicateIndex: number[] = [];
  for (let fi = 0; fi < source.faces.length; fi++) {
    const selected = asNum(selection[fi] ?? 1) > 0;
    // Duplicate Elements outputs copies of the selected component; elements
    // outside Selection are not carried through. Downstream graphs explicitly
    // join any untouched branch they need. Treating unselected faces as one
    // implicit copy passed the entire marching grid through both branches.
    const copies = selected ? Math.max(0, Math.round(asNum(amounts[fi] ?? 1))) : 0;
    for (let copy = 0; copy < copies; copy++) {
      const face = source.faces[fi];
      const nextFace: number[] = [];
      for (const oldVi of face) {
        nextFace.push(out.positions.length);
        out.positions.push([...source.positions[oldVi]] as Vec3);
        for (const [name, attr] of source.attributes) {
          if (attr.domain !== "POINT") continue;
          const target = out.attributes.get(name) ?? { domain: "POINT" as const, data: [] };
          target.data.push(attr.data[oldVi] ?? 0);
          out.attributes.set(name, target);
        }
      }
      out.faces.push(nextFace);
      out.faceMaterial.push(source.faceMaterial[fi] ?? 0);
      duplicateIndex.push(copy);
      for (const [name, attr] of source.attributes) {
        if (attr.domain !== "FACE") continue;
        const target = out.attributes.get(name) ?? { domain: "FACE" as const, data: [] };
        target.data.push(attr.data[fi] ?? 0);
        out.attributes.set(name, target);
      }
    }
  }
  out.attributes.set("__duplicate_index", { domain: "FACE", data: duplicateIndex });
  const geometry = new Geometry();
  geometry.mesh = out;
  return {
    Geometry: geometry,
    "Duplicate Index": Field.perElem((i, ctx2) => ctx2.attr?.("__duplicate_index", i) ?? 0).tagged("FACE"),
  };
});

reg("GeometryNodeCurveToPoints", (api) => {
  const curveInput = api.geo("Curve");
  const input = curveInput.instances.length ? realizeInstances(curveInput) : curveInput;
  const mode = api.prop<string>("mode", "COUNT");
  const count = Math.max(1, Math.round(api.num("Count")));
  const length = Math.max(1e-9, api.num("Length") || 0.1);
  let inputOffset = 0;
  const sourceTangents = input.curveAttributes.get("__curve_tangent")?.data;
  const sourceNormals = input.curveAttributes.get("__curve_normal")?.data;
  const importedTangents = input.curveAttributes.get("__curve_imported_tangent");
  const sampledTangents: Vec3[][] = [];
  const sampledNormals: Vec3[][] = [];
  const sampleVectors = (s: { points: Vec3[]; cyclic: boolean }, sampledPoints: Vec3[], values?: Elem[]): Vec3[] => {
    if (!values?.length || s.points.length < 2) return [];
    return sampledPoints.map((point) => {
      let bestDistance = Infinity;
      let best: Vec3 = asVec3(values[0]);
      const segmentCount = s.cyclic ? s.points.length : s.points.length - 1;
      for (let i = 0; i < segmentCount; i++) {
        const j = (i + 1) % s.points.length;
        const a = s.points[i], delta = vsub(s.points[j], a);
        const denom = Math.max(1e-12, vdot(delta, delta));
        const t = Math.max(0, Math.min(1, vdot(vsub(point, a), delta) / denom));
        const closest = vadd(a, vscale(delta, t));
        const distance = vlen(vsub(point, closest));
        if (distance < bestDistance) {
          bestDistance = distance;
          best = vnorm(vadd(vscale(asVec3(values[i]), 1 - t), vscale(asVec3(values[j]), t)));
        }
      }
      return best;
    });
  };
  const sampled = input.curves.map((s) => {
    const sourceFrames = splineFrames(s.points, s.cyclic);
    // Set Spline Type -> Poly replaces an imported curve's evaluated samples
    // with its authored control points. Its old evaluated tangent field is no
    // longer valid on that new topology; Blender recomputes poly corner frames
    // before Curve to Points resamples them. The retained provenance marker and
    // absence of controlPoints distinguish the converted result from the
    // original imported spline.
    const convertedImportedPoly = Boolean(importedTangents && sourceTangents && !s.controlPoints);
    // Curve to Points samples the evaluated frame of the input curve. When no
    // explicit frame attributes are present, Blender interpolates tangents and
    // normals from the original curve before resampling; deriving a fresh
    // frame from the coarser output points creates an alternating rotation
    // error whenever the source/output counts are not multiples (32 -> 24 on
    // the Intro emblem's spike ring).
    const values = convertedImportedPoly
      ? sourceFrames.map((frame) => frame.tangent)
      : sourceTangents?.slice(inputOffset, inputOffset + s.points.length)
        ?? sourceFrames.map((frame) => frame.tangent);
    const normalValues = sourceNormals?.slice(inputOffset, inputOffset + s.points.length)
      ?? sourceFrames.map((frame) => frame.normal);
    inputOffset += s.points.length;
    let result: { points: Vec3[]; cyclic: boolean };
    if (mode === "EVALUATED") {
      result = { points: s.points.map((p) => [...p] as Vec3), cyclic: s.cyclic };
    } else if (mode === "LENGTH") {
      // Blender fits whole requested-length intervals independently on every
      // spline. Open splines include the endpoint after those intervals, so a
      // spline shorter than Length still emits one point. The old rounded,
      // minimum-two rule made dense hat stitches too sparse while adding a
      // second point to each short ground-fuzz spline.
      const fittedIntervals = Math.floor(splineLength(s) / length);
      const n = Math.max(1, fittedIntervals + (s.cyclic ? 0 : 1));
      result = n === 1
        ? { points: s.points.length ? [[...s.points[0]] as Vec3] : [], cyclic: false }
        : resampleSpline(s, n);
    } else {
      result = resampleSpline(s, count);
    }
    // When Count preserves a poly spline's point count, Blender constructs the
    // evaluated frame from the redistributed output polyline. Interpolating
    // the original corner frames instead rotates Text Soup's glyph instances
    // by an entire segment. A genuinely different sample count (32 -> 24 on
    // the Intro emblem) still needs source-frame interpolation.
    const keepsPointCount = result.points.length === s.points.length;
    sampledTangents.push(convertedImportedPoly || sourceTangents || !keepsPointCount
      ? sampleVectors(s, result.points, values)
      : []);
    sampledNormals.push(sourceNormals || !keepsPointCount
      ? sampleVectors(s, result.points, normalValues)
      : []);
    return result;
  });
  const out = new Geometry();
  const mesh = new Mesh();
  const tangents: Vec3[] = [], normals: Vec3[] = [], rotations: Vec3[] = [];
  const frameRotation = (normal: Vec3, binormal: Vec3, tangent: Vec3): Vec3 => {
    // Matrix columns are the rotated local X/Y/Z axes. Blender's curve-point
    // rotation uses X=normal, Y=binormal, Z=tangent.
    const m = [
      [normal[0], binormal[0], tangent[0]],
      [normal[1], binormal[1], tangent[1]],
      [normal[2], binormal[2], tangent[2]],
    ];
    const y = Math.asin(Math.max(-1, Math.min(1, -m[2][0])));
    const cy = Math.cos(y);
    const euler = (Math.abs(cy) > 1e-6
      ? [Math.atan2(m[2][1], m[2][2]), y, Math.atan2(m[1][0], m[0][0])]
      : [Math.atan2(-m[1][2], m[1][1]), y, 0]) as TaggedRotation;

    // Rotation sockets are quaternions inside Blender. Keep the exact frame
    // quaternion alongside the Euler compatibility value so downstream
    // rotation nodes can distinguish a native 180-degree curve frame from an
    // Euler value that merely displays the same [pi, 0, 0]. The metadata is
    // deliberately non-enumerable, leaving dumps/probes and ordinary vector
    // consumers unchanged.
    const trace = m[0][0] + m[1][1] + m[2][2];
    let quaternion: Quat;
    if (trace > 0) {
      const s = 2 * Math.sqrt(trace + 1);
      quaternion = [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, s / 4];
    } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
      const s = 2 * Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]);
      quaternion = [s / 4, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s];
    } else if (m[1][1] > m[2][2]) {
      const s = 2 * Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]);
      quaternion = [(m[0][1] + m[1][0]) / s, s / 4, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s];
    } else {
      const s = 2 * Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]);
      quaternion = [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, s / 4, (m[1][0] - m[0][1]) / s];
    }
    const qLength = Math.hypot(...quaternion) || 1;
    Object.defineProperty(euler, ROTATION_QUATERNION, {
      value: quaternion.map((component) => component / qLength) as Quat,
      enumerable: false,
    });
    return euler;
  };
  const transportedFrames = (points: Vec3[], supplied: Vec3[], cyclic: boolean) => {
    if (!supplied.length) return splineFrames(points, cyclic);
    const ts = supplied.map((t) => vnorm(t));
    const rotate = (v: Vec3, axis: Vec3, angle: number): Vec3 => {
      const c = Math.cos(angle), sn = Math.sin(angle);
      return vadd(vadd(vscale(v, c), vscale(vcross(axis, v), sn)), vscale(axis, vdot(axis, v) * (1 - c)));
    };
    let normal = vcross(ts[0], [0, 0, 1]);
    if (vlen(normal) < 1e-8) normal = [1, 0, 0];
    normal = vnorm(normal);
    const frames: { tangent: Vec3; normal: Vec3; binormal: Vec3 }[] = [];
    for (let i = 0; i < ts.length; i++) {
      if (i) {
        const axis = vcross(ts[i - 1], ts[i]);
        const sin = vlen(axis);
        if (sin > 1e-8) normal = rotate(normal, vscale(axis, 1 / sin), Math.atan2(sin, vdot(ts[i - 1], ts[i])));
        normal = vnorm(vsub(normal, vscale(ts[i], vdot(normal, ts[i]))));
      }
      frames.push({ tangent: ts[i], normal, binormal: vnorm(vcross(ts[i], normal)) });
    }
    return frames;
  };
  for (let splineIndex = 0; splineIndex < sampled.length; splineIndex++) {
    const s = sampled[splineIndex];
    let frames = transportedFrames(s.points, sampledTangents[splineIndex] ?? [], s.cyclic);
    const retainedNormals = sampledNormals[splineIndex] ?? [];
    if (retainedNormals.length === frames.length) {
      frames = frames.map((frame, i) => {
        const normal = vnorm(vsub(retainedNormals[i], vscale(frame.tangent, vdot(retainedNormals[i], frame.tangent))));
        return { tangent: frame.tangent, normal, binormal: vnorm(vcross(frame.tangent, normal)) };
      });
    }
    for (let i = 0; i < s.points.length; i++) {
      mesh.positions.push([...s.points[i]] as Vec3);
      tangents.push(frames[i]?.tangent ?? [1, 0, 0]);
      normals.push(frames[i]?.normal ?? [0, 0, 1]);
      rotations.push(frameRotation(frames[i]?.normal ?? [1, 0, 0], frames[i]?.binormal ?? [0, 1, 0], frames[i]?.tangent ?? [0, 0, 1]));
    }
  }
  mesh.attributes.set("__curve_tangent", { domain: "POINT", data: tangents });
  mesh.attributes.set("__curve_normal", { domain: "POINT", data: normals });
  mesh.attributes.set("__curve_rotation", { domain: "POINT", data: rotations });
  mesh.attributes.set("__gnvm_point_cloud", { domain: "POINT", data: mesh.positions.map(() => 1) });
  out.mesh = mesh;
  if (FIELD_PROBE.node === api.node.name) {
    const requested = FIELD_PROBE.socket ?? "Rotation";
    const values = requested === "Tangent" ? tangents : requested === "Normal" ? normals : rotations;
    FIELD_PROBE.batches.push({ domain: "POINT", positions: mesh.positions, values });
  }
  const attr = (name: string, fallback: Vec3) => Field.perElem((i, ctx) => ctx.attr?.(name, i) ?? fallback).tagged("POINT");
  return {
    Points: out,
    Tangent: attr("__curve_tangent", [1, 0, 0]),
    Normal: attr("__curve_normal", [0, 0, 1]),
    Rotation: attr("__curve_rotation", [0, 0, 0]),
  };
});

reg("GeometryNodeAccumulateField", (api) => {
  const domain = domainOf(api);
  const value = api.field("Value");
  const group = api.field("Group ID");
  const evaluate = (ctx: FieldCtx) => {
    const source = ctx.domain === domain ? ctx : ctx.fork?.(domain) ?? ctx;
    const values = value.array(source);
    const groups = group.array(source);
    const leading: Elem[] = new Array(source.size);
    const trailing: Elem[] = new Array(source.size);
    const totals = new Map<number, Elem>();
    for (let i = 0; i < source.size; i++) {
      const id = Math.round(asNum(groups[i] ?? 0));
      const next = addElem(totals.get(id) ?? zeroLike(values[i] ?? 0), values[i] ?? 0);
      totals.set(id, next);
      leading[i] = next;
    }
    const seen = new Map<number, Elem>();
    for (let i = 0; i < source.size; i++) {
      const id = Math.round(asNum(groups[i] ?? 0));
      trailing[i] = seen.get(id) ?? zeroLike(values[i] ?? 0);
      seen.set(id, addElem(trailing[i], values[i] ?? 0));
    }
    const total = groups.map((raw) => totals.get(Math.round(asNum(raw ?? 0))) ?? 0);
    return { source, leading, trailing, total };
  };
  const output = (key: "leading" | "trailing" | "total") => Field.make((ctx) => {
    const result = evaluate(ctx);
    const values = result[key];
    if (ctx.domain === domain || !ctx.toDomain) return values;
    return Array.from({ length: ctx.size }, (_, i) => ctx.toDomain!(domain, values, i) ?? 0);
  }).tagged(domain);
  return { Leading: output("leading"), Trailing: output("trailing"), Total: output("total") };
});

type KdNode = { index: number; axis: 0 | 1 | 2; left?: KdNode; right?: KdNode };
function kdTree(points: Vec3[], ids = points.map((_, i) => i), depth = 0): KdNode | undefined {
  if (!ids.length) return undefined;
  const axis = (depth % 3) as 0 | 1 | 2;
  ids.sort((a, b) => points[a][axis] - points[b][axis]);
  const mid = Math.floor(ids.length / 2);
  return { index: ids[mid], axis, left: kdTree(points, ids.slice(0, mid), depth + 1), right: kdTree(points, ids.slice(mid + 1), depth + 1) };
}
function kdNearest(points: Vec3[], root: KdNode | undefined, target: Vec3): number {
  let best = -1, bestSq = Infinity;
  const visit = (node?: KdNode) => {
    if (!node) return;
    const p = points[node.index];
    const d = vsub(p, target);
    const distSq = vdot(d, d);
    if (distSq < bestSq) { bestSq = distSq; best = node.index; }
    const delta = target[node.axis] - p[node.axis];
    visit(delta < 0 ? node.left : node.right);
    if (delta * delta < bestSq) visit(delta < 0 ? node.right : node.left);
  };
  visit(root);
  return Math.max(0, best);
}

reg("GeometryNodeSampleNearest", (api) => {
  let g = api.geo("Geometry");
  if (g.instances.length) g = realizeInstances(g);
  const domain = domainOf(api);
  const sourceCtx = makeFieldCtx(g, domain);
  const points = Array.from({ length: sourceCtx.size }, (_, i) => sourceCtx.position?.(i) ?? [0, 0, 0] as Vec3);
  const tree = kdTree(points);
  const samplePosition = api.field("Sample Position");
  return {
    Index: Field.make((ctx) => {
      const linked = api.node.inputs.find((s) => s.identifier === "Sample Position")?.linked;
      const positions = linked ? samplePosition.array(ctx).map(asVec3) : Array.from({ length: ctx.size }, (_, i) => ctx.position?.(i) ?? [0, 0, 0] as Vec3);
      return positions.map((p) => kdNearest(points, tree, p));
    }),
  };
});

type Triangle = { a: Vec3; b: Vec3; c: Vec3; normal: Vec3 };
type Hit = { hit: number; position: Vec3; normal: Vec3; distance: number };
type TriangleBvh = { min: Vec3; max: Vec3; left?: TriangleBvh; right?: TriangleBvh; triangles?: Triangle[] };

/** Blender's float3 normalize path stores the dot, sqrt and divisions as float32. */
export function normalizeBlenderFloat3(value: Vec3): Vec3 {
  const f = Math.fround;
  const vector = value.map(f) as Vec3;
  let lengthSquared = f(vector[0] * vector[0]);
  lengthSquared = f(lengthSquared + f(vector[1] * vector[1]));
  lengthSquared = f(lengthSquared + f(vector[2] * vector[2]));
  if (!(lengthSquared > 1e-35)) return [0, 0, 0];
  const length = f(Math.sqrt(lengthSquared));
  return [f(vector[0] / length), f(vector[1] / length), f(vector[2] / length)];
}

function blenderTriangleNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const f = Math.fround;
  const ab: Vec3 = [f(b[0] - a[0]), f(b[1] - a[1]), f(b[2] - a[2])];
  const ac: Vec3 = [f(c[0] - a[0]), f(c[1] - a[1]), f(c[2] - a[2])];
  return normalizeBlenderFloat3([
    f(f(ab[1] * ac[2]) - f(ab[2] * ac[1])),
    f(f(ab[2] * ac[0]) - f(ab[0] * ac[2])),
    f(f(ab[0] * ac[1]) - f(ab[1] * ac[0])),
  ]);
}

function triangleBounds(triangle: Triangle): { min: Vec3; max: Vec3; center: Vec3 } {
  const min: Vec3 = [Math.min(triangle.a[0], triangle.b[0], triangle.c[0]), Math.min(triangle.a[1], triangle.b[1], triangle.c[1]), Math.min(triangle.a[2], triangle.b[2], triangle.c[2])];
  const max: Vec3 = [Math.max(triangle.a[0], triangle.b[0], triangle.c[0]), Math.max(triangle.a[1], triangle.b[1], triangle.c[1]), Math.max(triangle.a[2], triangle.b[2], triangle.c[2])];
  return { min, max, center: [(min[0] + max[0]) * .5, (min[1] + max[1]) * .5, (min[2] + max[2]) * .5] };
}

function triangleBvh(triangles: Triangle[]): TriangleBvh | undefined {
  if (!triangles.length) return undefined;
  const bounds = triangles.map(triangleBounds);
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const entry of bounds) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], entry.min[axis]); max[axis] = Math.max(max[axis], entry.max[axis]);
  }
  if (triangles.length <= 12) return { min, max, triangles };
  const spans = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const axis = spans[1] > spans[0] ? (spans[2] > spans[1] ? 2 : 1) : (spans[2] > spans[0] ? 2 : 0);
  const ordered = triangles.map((triangle, index) => ({ triangle, center: bounds[index].center[axis] })).sort((a, b) => a.center - b.center);
  const middle = Math.floor(ordered.length / 2);
  return { min, max, left: triangleBvh(ordered.slice(0, middle).map((entry) => entry.triangle)), right: triangleBvh(ordered.slice(middle).map((entry) => entry.triangle)) };
}

function rayBox(origin: Vec3, direction: Vec3, min: Vec3, max: Vec3, distance: number): boolean {
  let near = 0, far = distance;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(direction[axis]) < 1e-12) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return false;
      continue;
    }
    let a = (min[axis] - origin[axis]) / direction[axis], b = (max[axis] - origin[axis]) / direction[axis];
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a); far = Math.min(far, b);
    if (near > far) return false;
  }
  return true;
}

function rayBvh(origin: Vec3, direction: Vec3, maxDistance: number, root?: TriangleBvh): Hit | null {
  if (!root) return null;
  let best: Hit | null = null;
  let bestDistance = maxDistance;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (!rayBox(origin, direction, node.min, node.max, bestDistance)) continue;
    if (node.triangles) {
      for (const triangle of node.triangles) {
        const hit = rayTriangle(origin, direction, bestDistance, triangle);
        if (hit && hit.distance < bestDistance) { best = hit; bestDistance = hit.distance; }
      }
    } else {
      if (node.left) stack.push(node.left);
      if (node.right) stack.push(node.right);
    }
  }
  return best;
}
function rayTriangle(origin: Vec3, direction: Vec3, maxDistance: number, tri: Triangle): Hit | null {
  const f = Math.fround;
  const rayOrigin = origin.map(f) as Vec3;
  const rayDirection = direction.map(f) as Vec3;
  let kz = 0;
  if (Math.abs(rayDirection[1]) > Math.abs(rayDirection[kz])) kz = 1;
  if (Math.abs(rayDirection[2]) > Math.abs(rayDirection[kz])) kz = 2;
  if (rayDirection[kz] === 0) return null;
  let kx = kz !== 2 ? kz + 1 : 0;
  let ky = kx !== 2 ? kx + 1 : 0;
  if (rayDirection[kz] < 0) [kx, ky] = [ky, kx];
  const inverseDirectionZ = f(1 / rayDirection[kz]);
  const shearX = f(rayDirection[kx] * inverseDirectionZ);
  const shearY = f(rayDirection[ky] * inverseDirectionZ);
  const relative = (point: Vec3): Vec3 => [
    f(f(point[0]) - rayOrigin[0]),
    f(f(point[1]) - rayOrigin[1]),
    f(f(point[2]) - rayOrigin[2]),
  ];
  const a = relative(tri.a), b = relative(tri.b), c = relative(tri.c);
  const ax = f(a[kx] - f(shearX * a[kz])), ay = f(a[ky] - f(shearY * a[kz]));
  const bx = f(b[kx] - f(shearX * b[kz])), by = f(b[ky] - f(shearY * b[kz]));
  const cx = f(c[kx] - f(shearX * c[kz])), cy = f(c[ky] - f(shearY * c[kz]));
  const u = f(f(cx * by) - f(cy * bx));
  const v = f(f(ax * cy) - f(ay * cx));
  const w = f(f(bx * ay) - f(by * ax));
  if ((u < 0 || v < 0 || w < 0) && (u > 0 || v > 0 || w > 0)) return null;
  const determinant = f(f(u + v) + w);
  if (determinant === 0 || !Number.isFinite(determinant)) return null;
  const scaledDistance = f(f(f(f(u * a[kz]) + f(v * b[kz])) + f(w * c[kz])) * inverseDirectionZ);
  if ((determinant < 0 ? -scaledDistance : scaledDistance) < 0) return null;
  const distance = f(scaledDistance * f(1 / determinant));
  if (distance > f(maxDistance)) return null;
  const position: Vec3 = [
    f(rayOrigin[0] + f(rayDirection[0] * distance)),
    f(rayOrigin[1] + f(rayDirection[1] * distance)),
    f(rayOrigin[2] + f(rayDirection[2] * distance)),
  ];
  return { hit: 1, position, normal: tri.normal, distance };
}

/** Focused public hook for float32/watertight ray precision regression tests. */
export function blenderRaycastTriangleForTest(origin: Vec3, direction: Vec3, maxDistance: number, a: Vec3, b: Vec3, c: Vec3): Hit | null {
  const triangle = { a, b, c, normal: blenderTriangleNormal(a, b, c) };
  return rayTriangle(origin, normalizeBlenderFloat3(direction), maxDistance, triangle);
}

function pointSegmentDistance2D(point: Vec3, a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const denominator = dx * dx + dy * dy;
  const t = denominator > 1e-20 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator)) : 0;
  return Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dy * t));
}

function projectedTriangleDistance(point: Vec3, triangle: Triangle): number {
  const sign = (a: Vec3, b: Vec3, c: Vec3) => (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1]);
  const d1 = sign(point, triangle.a, triangle.b), d2 = sign(point, triangle.b, triangle.c), d3 = sign(point, triangle.c, triangle.a);
  if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return 0;
  return Math.min(pointSegmentDistance2D(point, triangle.a, triangle.b), pointSegmentDistance2D(point, triangle.b, triangle.c), pointSegmentDistance2D(point, triangle.c, triangle.a));
}

reg("GeometryNodeRaycast", (api) => {
  let target = api.geo("Target Geometry");
  if (target.instances.length) target = realizeInstances(target);
  const triangles: Triangle[] = [];
  if (target.mesh) for (const face of target.mesh.faces) for (const [ai, bi, ci] of triangulateFaceIndices(target.mesh, face)) {
    const a = target.mesh.positions[ai].map(Math.fround) as Vec3;
    const b = target.mesh.positions[bi].map(Math.fround) as Vec3;
    const c = target.mesh.positions[ci].map(Math.fround) as Vec3;
    triangles.push({ a, b, c, normal: blenderTriangleNormal(a, b, c) });
  }
  const bvh = triangleBvh(triangles);
  const sourcePosition = api.field("Source Position");
  const rayDirection = api.field("Ray Direction");
  const rayLength = api.field("Ray Length");
  const cache = new WeakMap<FieldCtx, Hit[]>();
  const hits = (ctx: FieldCtx): Hit[] => {
    const cached = cache.get(ctx);
    if (cached) return cached;
    const positionLinked = api.node.inputs.find((s) => s.identifier === "Source Position")?.linked;
    const origins = (positionLinked ? sourcePosition.array(ctx).map(asVec3) : Array.from({ length: ctx.size }, (_, i) => ctx.position?.(i) ?? [0, 0, 0] as Vec3))
      .map((origin) => origin.map(Math.fround) as Vec3);
    const dirs = rayDirection.array(ctx).map((v) => normalizeBlenderFloat3(asVec3(v)));
    const lengths = rayLength.array(ctx).map((v) => Math.fround(Math.max(0, asNum(v))));
    const result: Hit[] = origins.map((origin, i) => {
      return rayBvh(origin, dirs[i] ?? [0, 0, 1], lengths[i] ?? 100, bvh)
        ?? { hit: 0, position: origin, normal: [0, 0, 0] as Vec3, distance: 0 };
    });
    if (FIELD_PROBE.node === api.node.name) {
      const requested = FIELD_PROBE.socket ?? "Is Hit";
      const values = requested === "Hit Position" ? result.map((hit) => hit.position)
        : requested === "Hit Normal" ? result.map((hit) => hit.normal)
        : requested === "Hit Distance" ? result.map((hit) => hit.distance)
        : result.map((hit) => hit.hit);
      const targets = FIELD_PROBE.socket === "Miss Distance" ? origins.map((origin, i) => {
        if (result[i].hit) return [0, 0, 0] as Vec3;
        let distance = Infinity;
        for (const triangle of triangles) distance = Math.min(distance, projectedTriangleDistance(origin, triangle));
        return [distance, 0, 0] as Vec3;
      }) : undefined;
      FIELD_PROBE.batches.push({ domain: ctx.domain, positions: origins, values, targets });
    }
    cache.set(ctx, result);
    return result;
  };
  return {
    "Is Hit": Field.make((ctx) => hits(ctx).map((h) => h.hit)),
    "Hit Position": Field.make((ctx) => hits(ctx).map((h) => h.position)),
    "Hit Normal": Field.make((ctx) => hits(ctx).map((h) => h.normal)),
    "Hit Distance": Field.make((ctx) => hits(ctx).map((h) => h.distance)),
    Attribute: Field.of(0),
  };
});

reg("GeometryNodeBlurAttribute", (api) => {
  const value = api.field("Value");
  const weight = api.field("Weight");
  // Chrome Crayon assets author 665–1,111 passes. Keep a generous safety bound
  // without truncating those Blender-authored smoothing loops.
  const iterations = Math.max(0, Math.min(2048, Math.round(api.num("Iterations"))));
  const blurred = Field.make((ctx) => {
      let current = value.array(ctx);
      if (iterations && ctx.neighbors) {
        // Blender stores every intermediate blur pass in the attribute's
        // float32 buffer. Its averaging path also multiplies by a rounded
        // reciprocal instead of dividing the accumulated value directly.
        // That distinction is only one ULP in a single pass, but becomes
        // visible after the 665+ passes authored by the Chrome Crayon graphs.
        const f = Math.fround;
        const weights = weight.array(ctx).map((v) => f(Math.max(0, asNum(v))));
        const addFloat32 = (a: Elem, b: Elem): Elem => Array.isArray(a) || Array.isArray(b)
          ? [
              f(f(asVec3(a)[0]) + f(asVec3(b)[0])),
              f(f(asVec3(a)[1]) + f(asVec3(b)[1])),
              f(f(asVec3(a)[2]) + f(asVec3(b)[2])),
            ]
          : f(f(asNum(a)) + f(asNum(b)));
        const scaleFloat32 = (item: Elem, factor: number): Elem => Array.isArray(item)
          ? [f(f(item[0]) * factor), f(f(item[1]) * factor), f(f(item[2]) * factor)]
          : f(f(item) * factor);
        for (let iteration = 0; iteration < iterations; iteration++) {
          const next: Elem[] = new Array(ctx.size);
          for (let i = 0; i < ctx.size; i++) {
            let total = scaleFloat32(current[i] ?? 0, weights[i] ?? 1);
            let totalWeight = weights[i] ?? 1;
            for (const neighbor of ctx.neighbors(i)) {
              const w = weights[neighbor] ?? 1;
              total = addFloat32(total, scaleFloat32(current[neighbor] ?? 0, w));
              totalWeight = f(totalWeight + w);
            }
            next[i] = totalWeight > 0 ? scaleFloat32(total, f(1 / totalWeight)) : current[i] ?? 0;
          }
          current = next;
        }
      }
      if (FIELD_PROBE.node === api.node.name && (FIELD_PROBE.socket === "Value" || FIELD_PROBE.socket === "Result"))
        FIELD_PROBE.batches.push({
          domain: ctx.domain,
          positions: Array.from({ length: ctx.size }, (_, i) => ctx.position?.(i) ?? [0, 0, 0]),
          values: current,
        });
      return current;
    });
  return { Value: blurred };
});

reg("GeometryNodeDualMesh", (api) => {
  const input = api.geo("Mesh");
  const out = new Geometry();
  if (!input.mesh) return { "Dual Mesh": out };
  const mesh = input.mesh;
  const topo = buildTopology(mesh);
  const dual = new Mesh();
  dual.materialSlots = [...mesh.materialSlots];
  dual.positions = mesh.faces.map((_, fi) => mesh.faceCenter(fi));
  const edgeFaces = new Map<string, number[]>();
  for (const edge of topo.edges)
    edgeFaces.set(`${edge.verts[0]},${edge.verts[1]}`, edge.faces);
  const across = (vertex: number, neighbor: number, face: number): number | undefined => {
    const key = vertex < neighbor ? `${vertex},${neighbor}` : `${neighbor},${vertex}`;
    return edgeFaces.get(key)?.find((candidate) => candidate !== face);
  };
  for (let vi = 0; vi < mesh.positions.length; vi++) {
    const adjacent = topo.pointFaces[vi] ?? [];
    if (adjacent.length < 3) continue;
    // Incident faces form a cycle around a manifold vertex. Traverse that
    // cycle through shared edges instead of projecting around an approximate
    // global/radial normal; radial sorting breaks on concave and threaded
    // meshes even when their topology is perfectly closed.
    const start = adjacent[0];
    const firstSource = mesh.faces[start];
    const firstCorner = firstSource.indexOf(vi);
    const firstNeighbor = firstSource[(firstCorner + 1) % firstSource.length];
    const firstNext = across(vi, firstNeighbor, start);
    const ordered = [start];
    let previous = start;
    let current = firstNext;
    while (current !== undefined && current !== start && !ordered.includes(current)) {
      ordered.push(current);
      const source = mesh.faces[current];
      const corner = source.indexOf(vi);
      const candidates = [
        across(vi, source[(corner - 1 + source.length) % source.length], current),
        across(vi, source[(corner + 1) % source.length], current),
      ];
      const next = candidates.find((candidate) => candidate !== undefined && candidate !== previous);
      previous = current;
      current = next;
    }
    // With Keep Boundaries disabled (the Blender default), only a closed fan
    // produces a dual face. Boundary vertices can still have three or more
    // incident triangles, but their fan is open; emitting it created an extra
    // strip of boundary triangles around Bit Stand's otherwise-hexagonal grid.
    if (current !== start || ordered.length !== adjacent.length) continue;
    const face = ordered;
    const normal = mesh.vertexNormals()[vi] ?? [0, 0, 1] as Vec3;
    if (face.length >= 3) {
      const faceNormal = vnorm(vcross(vsub(dual.positions[face[1]], dual.positions[face[0]]), vsub(dual.positions[face[2]], dual.positions[face[0]])));
      if (vdot(faceNormal, normal) < 0) face.reverse();
    }
    dual.faces.push(face);
    dual.faceMaterial.push(0);
  }
  orientClosedSurface(dual);
  let signedVolume = 0;
  for (const face of dual.faces) for (let corner = 1; corner + 1 < face.length; corner++) {
    const a = dual.positions[face[0]], b = dual.positions[face[corner]], c = dual.positions[face[corner + 1]];
    signedVolume += (
      a[0] * (b[1] * c[2] - b[2] * c[1])
      + a[1] * (b[2] * c[0] - b[0] * c[2])
      + a[2] * (b[0] * c[1] - b[1] * c[0])
    ) / 6;
  }
  if (signedVolume < 0) {
    for (const face of dual.faces) face.reverse();
    invalidateMeshCaches(dual);
  }
  out.mesh = dual;
  return { "Dual Mesh": out };
});
