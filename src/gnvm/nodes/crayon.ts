// Geometry-node handlers first required by the Node Dojo Chrome Crayon graph.
// They are general VM operations, kept in one module so the compatibility
// milestone remains easy to audit against its Blender source.
import { Field, FieldCtx, Vec3, Elem, Domain, asNum, asVec3, vadd, vsub, vscale, vdot, vcross, vlen, vnorm, vnormBlenderFloat } from "../core";
import { Geometry, Mesh, buildTopology, invalidateMeshCaches, orientClosedSurface, realizeInstances, triangulateFaceIndices } from "../geometry";
import { resampleSplineWithSamples, SplineSample, splineFrames, splineLength } from "../curves";
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
  const mode = api.prop<string>("mode", "COUNT");
  const count = Math.max(1, Math.round(api.num("Count")));
  const length = Math.max(1e-9, api.num("Length") || 0.1);
  const converted = new WeakMap<Geometry, Geometry>();
  const convertInput = (input: Geometry): Geometry => {
    const cached = converted.get(input);
    if (cached) return cached;
    let inputOffset = 0;
    const sourceTangents = input.curveAttributes.get("__curve_tangent")?.data;
    const sourceNormals = input.curveAttributes.get("__curve_normal")?.data;
    const importedTangents = input.curveAttributes.get("__curve_imported_tangent");
    const sampledTangents: Vec3[][] = [];
    const sampledNormals: Vec3[][] = [];
    const sampleVectors = (samples: SplineSample[], values?: Elem[]): Vec3[] => {
      if (!values?.length) return [];
      const f = Math.fround;
      return samples.map(({ a, b, factor }) => {
        const va = asVec3(values[a] ?? values[0]);
        const vb = asVec3(values[b] ?? va);
        const inverse = f(1 - factor);
        return vnormBlenderFloat([
          f(f(f(va[0]) * inverse) + f(f(vb[0]) * factor)),
          f(f(f(va[1]) * inverse) + f(f(vb[1]) * factor)),
          f(f(f(va[2]) * inverse) + f(f(vb[2]) * factor)),
        ]);
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
      let samples: SplineSample[];
      if (mode === "EVALUATED") {
        result = { points: s.points.map((p) => [...p] as Vec3), cyclic: s.cyclic };
        samples = s.points.map((_, index) => ({ a: index, b: index, factor: 0 }));
      } else if (mode === "LENGTH") {
        // Blender fits whole requested-length intervals independently on every
        // spline. Open splines include the endpoint after those intervals, so a
        // spline shorter than Length still emits one point. The old rounded,
        // minimum-two rule made dense hat stitches too sparse while adding a
        // second point to each short ground-fuzz spline.
        const fittedIntervals = Math.floor(splineLength(s) / length);
        const n = Math.max(1, fittedIntervals + (s.cyclic ? 0 : 1));
        if (n === 1) {
          result = { points: s.points.length ? [[...s.points[0]] as Vec3] : [], cyclic: false };
          samples = s.points.length ? [{ a: 0, b: 0, factor: 0 }] : [];
        } else {
          const resampled = resampleSplineWithSamples(s, n);
          result = resampled.spline;
          samples = resampled.samples;
        }
      } else {
        const resampled = resampleSplineWithSamples(s, count);
        result = resampled.spline;
        samples = resampled.samples;
      }
      // When Count preserves a poly spline's point count, Blender constructs the
      // evaluated frame from the redistributed output polyline. Interpolating
      // the original corner frames instead rotates Text Soup's glyph instances
      // by an entire segment. A genuinely different sample count (32 -> 24 on
      // the Intro emblem) still needs source-frame interpolation.
      const keepsPointCount = result.points.length === s.points.length;
      sampledTangents.push(convertedImportedPoly || sourceTangents || !keepsPointCount
        ? sampleVectors(samples, values)
        : []);
      sampledNormals.push(sourceNormals || !keepsPointCount
        ? sampleVectors(samples, normalValues)
        : []);
      return result;
    });
    const out = new Geometry();
    converted.set(input, out);
    const mesh = new Mesh();
    const tangents: Vec3[] = [], normals: Vec3[] = [], rotations: Vec3[] = [];
    const frameRotation = (normal: Vec3, binormal: Vec3, tangent: Vec3): Vec3 => {
      const f = Math.fround;
      const crossFloat32 = (a: Vec3, b: Vec3): Vec3 => [
        f(f(a[1] * b[2]) - f(a[2] * b[1])),
        f(f(a[2] * b[0]) - f(a[0] * b[2])),
        f(f(a[0] * b[1]) - f(a[1] * b[0])),
      ];
      // Curve to Points does not use the curve normal directly as the matrix X
      // axis. Blender first rebuilds an orthonormal basis in float32.
      binormal = vnormBlenderFloat(crossFloat32(tangent, normal));
      normal = crossFloat32(binormal, tangent);
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

      // Blender 5.1's normalized_to_quat_fast (Mike Day's branch selection),
      // with MatBase's column-major accessor translated to the row-major matrix
      // above. It canonicalizes W and avoids unconditional normalization.
      const at = (column: number, row: number) => f(m[row][column]);
      let x = 0, yq = 0, z = 0, w = 1;
      let s: number;
      if (at(2, 2) < 0) {
        if (at(0, 0) > at(1, 1)) {
          const trace = f(f(f(1 + at(0, 0)) - at(1, 1)) - at(2, 2));
          s = f(2 * f(Math.sqrt(trace)));
          if (at(1, 2) < at(2, 1)) s = f(-s);
          x = f(0.25 * s);
          s = f(1 / s);
          w = f(f(at(1, 2) - at(2, 1)) * s);
          yq = f(f(at(0, 1) + at(1, 0)) * s);
          z = f(f(at(2, 0) + at(0, 2)) * s);
          if (trace === 1 && w === 0 && yq === 0 && z === 0) x = 1;
        } else {
          const trace = f(f(f(1 - at(0, 0)) + at(1, 1)) - at(2, 2));
          s = f(2 * f(Math.sqrt(trace)));
          if (at(2, 0) < at(0, 2)) s = f(-s);
          yq = f(0.25 * s);
          s = f(1 / s);
          w = f(f(at(2, 0) - at(0, 2)) * s);
          x = f(f(at(0, 1) + at(1, 0)) * s);
          z = f(f(at(1, 2) + at(2, 1)) * s);
          if (trace === 1 && w === 0 && x === 0 && z === 0) yq = 1;
        }
      } else if (at(0, 0) < -at(1, 1)) {
        const trace = f(f(f(1 - at(0, 0)) - at(1, 1)) + at(2, 2));
        s = f(2 * f(Math.sqrt(trace)));
        if (at(0, 1) < at(1, 0)) s = f(-s);
        z = f(0.25 * s);
        s = f(1 / s);
        w = f(f(at(0, 1) - at(1, 0)) * s);
        x = f(f(at(2, 0) + at(0, 2)) * s);
        yq = f(f(at(1, 2) + at(2, 1)) * s);
        if (trace === 1 && w === 0 && x === 0 && yq === 0) z = 1;
      } else {
        const trace = f(f(f(1 + at(0, 0)) + at(1, 1)) + at(2, 2));
        s = f(2 * f(Math.sqrt(trace)));
        w = f(0.25 * s);
        s = f(1 / s);
        x = f(f(at(1, 2) - at(2, 1)) * s);
        yq = f(f(at(2, 0) - at(0, 2)) * s);
        z = f(f(at(0, 1) - at(1, 0)) * s);
        if (trace === 1 && x === 0 && yq === 0 && z === 0) w = 1;
      }
      let quaternion: Quat = [x, yq, z, w];
      let lengthSquared = f(f(x * x) + f(yq * yq));
      lengthSquared = f(f(lengthSquared + f(z * z)) + f(w * w));
      if (Math.abs(f(lengthSquared - 1)) >= 0.0002) {
        const inverseLength = f(1 / f(Math.sqrt(lengthSquared)));
        quaternion = quaternion.map((component) => f(component * inverseLength)) as Quat;
      }
      Object.defineProperty(euler, ROTATION_QUATERNION, {
        value: quaternion,
        enumerable: false,
      });
      return euler;
    };
    const transportedFrames = (points: Vec3[], supplied: Vec3[], cyclic: boolean) => {
      if (!supplied.length) return splineFrames(points, cyclic);
      // `sampleVectors` already follows Blender's float32 normalize path. A
      // second double-precision normalization here perturbs the tangent by a
      // few ULPs; those errors grow through instance rotation, proximity, and
      // the marching-square interpolation used by Text Soup.
      const ts = supplied.map((t) => t.map(Math.fround) as Vec3);
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
    if (mesh.positions.length) out.mesh = mesh;
    out.instances = input.instances.map((instance) => ({
      ...instance,
      geometry: convertInput(instance.geometry),
      position: [...instance.position] as Vec3,
      rotation: [...instance.rotation] as Vec3,
      scale: [...instance.scale] as Vec3,
      transformMatrix: instance.transformMatrix?.map((row) => [...row]),
      attributes: instance.attributes ? new Map(instance.attributes) : undefined,
    }));
    if (FIELD_PROBE.node === api.node.name) {
      const requested = FIELD_PROBE.socket ?? "Rotation";
      const values = requested === "Tangent" ? tangents : requested === "Normal" ? normals : rotations;
      FIELD_PROBE.batches.push({ domain: "POINT", positions: mesh.positions, values });
    }
    return out;
  };
  const out = convertInput(curveInput);
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
type TriangleBvh = {
  min: Vec3;
  max: Vec3;
  mainAxis: number;
  children?: [TriangleBvh, TriangleBvh?];
  triangle?: Triangle;
};

/** Public compatibility alias retained for focused raycast regression tests. */
export const normalizeBlenderFloat3 = vnormBlenderFloat;

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

const BLENDER_FLT_EPSILON = 1.1920928955078125e-7;
const BLENDER_FLT_MAX = 3.4028234663852886e38;

function triangleLeaf(triangle: Triangle): TriangleBvh {
  const f = Math.fround;
  const min: Vec3 = [0, 0, 0], max: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const lower = Math.min(triangle.a[axis], triangle.b[axis], triangle.c[axis]);
    const upper = Math.max(triangle.a[axis], triangle.b[axis], triangle.c[axis]);
    // BLI_bvhtree_new clamps its requested zero epsilon to FLT_EPSILON, then
    // inflates every primitive bound. Tangent rays depend on this rounding.
    min[axis] = f(lower - BLENDER_FLT_EPSILON);
    max[axis] = f(upper + BLENDER_FLT_EPSILON);
  }
  return { min, max, mainAxis: 0, triangle };
}

function branchBounds(leaves: TriangleBvh[], begin: number, end: number): { min: Vec3; max: Vec3; mainAxis: number } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let index = begin; index < end; index++) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], leaves[index].min[axis]);
    max[axis] = Math.max(max[axis], leaves[index].max[axis]);
  }
  const f = Math.fround;
  const x = f(max[0] - min[0]), y = f(max[1] - min[1]), z = f(max[2] - min[2]);
  const mainAxis = x > y ? (x > z ? 0 : 2) : (y > z ? 1 : 2);
  return { min, max, mainAxis };
}

function insertionSortLeaves(leaves: TriangleBvh[], begin: number, end: number, axis: number): void {
  for (let index = begin; index < end; index++) {
    let destination = index;
    const item = leaves[index];
    while (destination !== begin && item.max[axis] < leaves[destination - 1].max[axis]) {
      leaves[destination] = leaves[destination - 1];
      destination--;
    }
    leaves[destination] = item;
  }
}

function medianOfThreeLeaf(leaves: TriangleBvh[], low: number, middle: number, high: number, axis: number): TriangleBvh {
  const a = leaves[low], b = leaves[middle], c = leaves[high];
  if (b.max[axis] < a.max[axis]) {
    if (c.max[axis] < b.max[axis]) return b;
    if (c.max[axis] < a.max[axis]) return c;
    return a;
  }
  if (c.max[axis] < b.max[axis]) return c.max[axis] < a.max[axis] ? a : c;
  return b;
}

function partitionLeaves(leaves: TriangleBvh[], low: number, high: number, pivot: TriangleBvh, axis: number): number {
  let left = low, right = high;
  while (true) {
    while (leaves[left].max[axis] < pivot.max[axis]) left++;
    right--;
    while (pivot.max[axis] < leaves[right].max[axis]) right--;
    if (!(left < right)) return left;
    [leaves[left], leaves[right]] = [leaves[right], leaves[left]];
    left++;
  }
}

function partitionNthLeaf(leaves: TriangleBvh[], begin: number, end: number, nth: number, axis: number): void {
  while (end - begin > 3) {
    const cut = partitionLeaves(
      leaves,
      begin,
      end,
      medianOfThreeLeaf(leaves, begin, Math.floor((begin + end) / 2), end - 1, axis),
      axis,
    );
    if (cut <= nth) begin = cut;
    else end = cut;
  }
  insertionSortLeaves(leaves, begin, end, axis);
}

/** Build Blender's binary min-leaf implicit BLI_kdopbvh tree. */
function triangleBvh(triangles: Triangle[]): TriangleBvh | undefined {
  if (!triangles.length) return undefined;
  const leaves = triangles.map(triangleLeaf);
  if (leaves.length === 1) return leaves[0];

  const leafCount = leaves.length;
  const branches: TriangleBvh[] = new Array(leafCount);
  const leavesPerChild: number[] = [];
  const branchesOnLevel: number[] = [1];
  let completeLeafCount = 1;
  while (completeLeafCount < leafCount) completeLeafCount *= 2;
  leavesPerChild[0] = completeLeafCount;
  for (let depth = 1; leavesPerChild[depth - 1]; depth++) {
    branchesOnLevel[depth] = branchesOnLevel[depth - 1] * 2;
    leavesPerChild[depth] = Math.floor(leavesPerChild[depth - 1] / 2);
  }
  const remaining = leafCount - leavesPerChild[1];
  const remainLeaves = remaining * 2;
  const implicitLeafIndex = (depth: number, childIndex: number): number => {
    const minimum = childIndex * leavesPerChild[depth - 1];
    if (minimum <= remainLeaves) return minimum;
    if (leavesPerChild[depth])
      return leafCount - (branchesOnLevel[depth - 1] - childIndex) * leavesPerChild[depth];
    return remainLeaves;
  };

  const branchCount = leafCount - 1;
  for (let levelStart = 1, depth = 1; levelStart <= branchCount; levelStart *= 2, depth++) {
    const nextLevelStart = levelStart * 2;
    const levelEnd = Math.min(nextLevelStart, branchCount + 1);
    for (let branchIndex = levelStart; branchIndex < levelEnd; branchIndex++) {
      const levelIndex = branchIndex - levelStart;
      const begin = implicitLeafIndex(depth, levelIndex);
      const end = implicitLeafIndex(depth, levelIndex + 1);
      const bounds = branchBounds(leaves, begin, end);
      const branch = branches[branchIndex] ??= { ...bounds };
      branch.min = bounds.min;
      branch.max = bounds.max;
      branch.mainAxis = bounds.mainAxis;

      const middleChildIndex = branchIndex * 2 + 1 - nextLevelStart;
      const middle = implicitLeafIndex(depth + 1, middleChildIndex);
      partitionNthLeaf(leaves, begin, end, middle, branch.mainAxis);

      const children: [TriangleBvh, TriangleBvh?] = [leaves[begin]];
      for (let child = 0; child < 2; child++) {
        const childBranchIndex = branchIndex * 2 + child;
        const childLevelIndex = childBranchIndex - nextLevelStart;
        const childBegin = implicitLeafIndex(depth + 1, childLevelIndex);
        const childEnd = implicitLeafIndex(depth + 1, childLevelIndex + 1);
        const node = childEnd - childBegin > 1
          ? (branches[childBranchIndex] ??= { min: [0, 0, 0], max: [0, 0, 0], mainAxis: 0 })
          : childEnd - childBegin === 1 ? leaves[childBegin] : undefined;
        if (child === 0 && node) children[0] = node;
        else if (node) children[1] = node;
      }
      branch.children = children;
    }
  }
  return branches[1];
}

function blenderRayBoxDistance(origin: Vec3, direction: Vec3, node: TriangleBvh, hitDistance: number): number {
  const f = Math.fround;
  const near: number[] = [], far: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const dot = Math.abs(direction[axis]) < BLENDER_FLT_EPSILON ? 0 : direction[axis];
    const inverse = dot === 0 ? BLENDER_FLT_MAX : f(1 / dot);
    const lower = inverse < 0 ? node.max[axis] : node.min[axis];
    const upper = inverse < 0 ? node.min[axis] : node.max[axis];
    near[axis] = f(f(lower - origin[axis]) * inverse);
    far[axis] = f(f(upper - origin[axis]) * inverse);
  }
  if (near[0] > far[1] || far[0] < near[1]
    || near[0] > far[2] || far[0] < near[2]
    || near[1] > far[2] || far[1] < near[2]
    || far[0] < 0 || far[1] < 0 || far[2] < 0
    || near[0] > hitDistance || near[1] > hitDistance || near[2] > hitDistance) return Infinity;
  return Math.max(near[0], near[1], near[2]);
}

function rayBvh(origin: Vec3, direction: Vec3, maxDistance: number, root?: TriangleBvh): Hit | null {
  if (!root) return null;
  let best: Hit | null = null;
  let bestDistance = maxDistance;
  const visit = (node: TriangleBvh): void => {
    if (blenderRayBoxDistance(origin, direction, node, bestDistance) >= bestDistance) return;
    if (node.triangle) {
      const hit = rayTriangle(origin, direction, bestDistance, node.triangle);
      if (hit && hit.distance < bestDistance) { best = hit; bestDistance = hit.distance; }
      return;
    }
    const children = node.children;
    if (!children) return;
    if (direction[node.mainAxis] > 0) {
      visit(children[0]);
      if (children[1]) visit(children[1]);
    }
    else {
      if (children[1]) visit(children[1]);
      visit(children[0]);
    }
  };
  visit(root);
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

/** Focused hook for validating Blender's BVH build and coincident-hit order. */
export function blenderRaycastTrianglesForTest(
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  coordinates: [Vec3, Vec3, Vec3][],
): Hit | null {
  const triangles = coordinates.map(([a, b, c]) => ({ a, b, c, normal: blenderTriangleNormal(a, b, c) }));
  return rayBvh(origin.map(Math.fround) as Vec3, normalizeBlenderFloat3(direction), Math.fround(maxDistance), triangleBvh(triangles));
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
            // Blender keeps the center value at weight 1. The Weight field is
            // evaluated for the current element and controls every adjacent
            // contribution; it is not evaluated independently on each
            // neighbor. This matters for masks with a hard 0/1 boundary.
            const neighborWeight = weights[i] ?? 1;
            let total = current[i] ?? 0;
            let totalWeight = 1;
            for (const neighbor of ctx.neighbors(i)) {
              total = addFloat32(total, scaleFloat32(current[neighbor] ?? 0, neighborWeight));
              totalWeight = f(totalWeight + neighborWeight);
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
  for (const edge of topo.edges) {
    const [a, b] = edge.verts;
    edgeFaces.set(a < b ? `${a},${b}` : `${b},${a}`, edge.faces);
  }
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
