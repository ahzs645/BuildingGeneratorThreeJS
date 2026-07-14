// Geometry-node handlers first required by the Node Dojo Chrome Crayon graph.
// They are general VM operations, kept in one module so the compatibility
// milestone remains easy to audit against its Blender source.
import { Field, FieldCtx, Vec3, Elem, Domain, asNum, asVec3, vadd, vsub, vscale, vdot, vcross, vlen, vnorm } from "../core";
import { Geometry, Mesh, buildTopology, invalidateMeshCaches, orientClosedSurface, realizeInstances, triangulateFaceIndices } from "../geometry";
import { resampleSpline, splineFrames } from "../curves";
import { FIELD_PROBE, makeFieldCtx } from "../evaluator";
import { reg, EvalAPI } from "../registry";

const DOMAINS = new Set<Domain>(["POINT", "EDGE", "FACE", "CORNER", "CURVE", "INSTANCE"]);
const domainOf = (api: EvalAPI, fallback: Domain = "POINT"): Domain => {
  const raw = api.prop<string>("domain", fallback) as Domain;
  return DOMAINS.has(raw) ? raw : fallback;
};

const zeroLike = (value: Elem): Elem => Array.isArray(value) ? [0, 0, 0] : 0;
const addElem = (a: Elem, b: Elem): Elem => Array.isArray(a) || Array.isArray(b)
  ? vadd(asVec3(a), asVec3(b))
  : asNum(a) + asNum(b);
const scaleElem = (value: Elem, factor: number): Elem => Array.isArray(value)
  ? vscale(value, factor)
  : value * factor;

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

function copySubmesh(mesh: Mesh, vertices: Set<number>, faces: number[], edges: [number, number][]): Mesh {
  const out = new Mesh();
  out.materialSlots = [...mesh.materialSlots];
  const ordered = [...vertices].sort((a, b) => a - b);
  const remap = new Map(ordered.map((old, next) => [old, next]));
  out.positions = ordered.map((i) => [...mesh.positions[i]] as Vec3);
  out.edges = edges.map(([a, b]) => [remap.get(a)!, remap.get(b)!]);
  out.faces = faces.map((fi) => mesh.faces[fi].map((vi) => remap.get(vi)!));
  out.faceMaterial = faces.map((fi) => mesh.faceMaterial[fi] ?? 0);
  for (const [name, attr] of mesh.attributes) {
    if (attr.domain === "POINT") out.attributes.set(name, { domain: "POINT", data: ordered.map((i) => attr.data[i] ?? 0) });
    else if (attr.domain === "FACE") out.attributes.set(name, { domain: "FACE", data: faces.map((fi) => attr.data[fi] ?? 0) });
  }
  return out;
}

reg("GeometryNodeSplitToInstances", (api) => {
  const g = api.geo("Geometry");
  const out = new Geometry();
  if (!g.mesh) return { Instances: out, "Group ID": Field.of(0) };
  const mesh = g.mesh;
  const topo = buildTopology(mesh);
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
    const edges = topo.edges.filter((edge) => vertices.has(edge.verts[0]) && vertices.has(edge.verts[1])).map((edge) => edge.verts);
    const geometry = new Geometry();
    geometry.mesh = copySubmesh(mesh, vertices, faces, edges);
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
    const values = sourceTangents?.slice(inputOffset, inputOffset + s.points.length);
    const normalValues = sourceNormals?.slice(inputOffset, inputOffset + s.points.length);
    inputOffset += s.points.length;
    let result: { points: Vec3[]; cyclic: boolean };
    if (mode === "EVALUATED") {
      result = { points: s.points.map((p) => [...p] as Vec3), cyclic: s.cyclic };
    } else if (mode === "LENGTH") {
      const n = Math.max(2, Math.round((makeFieldCtx(new Geometry(), "POINT"), s.points.reduce((sum, p, i) => i ? sum + vlen(vsub(p, s.points[i - 1])) : sum, 0)) / length));
      result = resampleSpline(s, n);
    } else {
      result = resampleSpline(s, count);
    }
    sampledTangents.push(sampleVectors(s, result.points, values));
    sampledNormals.push(sampleVectors(s, result.points, normalValues));
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
    return Math.abs(cy) > 1e-6
      ? [Math.atan2(m[2][1], m[2][2]), y, Math.atan2(m[1][0], m[0][0])]
      : [Math.atan2(-m[1][2], m[1][1]), y, 0];
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
  const e1 = vsub(tri.b, tri.a), e2 = vsub(tri.c, tri.a);
  const h = vcross(direction, e2);
  const det = vdot(e1, h);
  if (Math.abs(det) < 1e-9) return null;
  const inv = 1 / det;
  const s = vsub(origin, tri.a);
  const u = inv * vdot(s, h);
  const barycentricEpsilon = 1e-9;
  if (u < -barycentricEpsilon || u > 1 + barycentricEpsilon) return null;
  const q = vcross(s, e1);
  const v = inv * vdot(direction, q);
  if (v < -barycentricEpsilon || u + v > 1 + barycentricEpsilon) return null;
  const distance = inv * vdot(e2, q);
  if (distance < 0 || distance > maxDistance) return null;
  return { hit: 1, position: vadd(origin, vscale(direction, distance)), normal: tri.normal, distance };
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
    const a = target.mesh.positions[ai], b = target.mesh.positions[bi], c = target.mesh.positions[ci];
    triangles.push({ a, b, c, normal: vnorm(vcross(vsub(b, a), vsub(c, a))) });
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
    const origins = positionLinked ? sourcePosition.array(ctx).map(asVec3) : Array.from({ length: ctx.size }, (_, i) => ctx.position?.(i) ?? [0, 0, 0] as Vec3);
    const dirs = rayDirection.array(ctx).map((v) => vnorm(asVec3(v)));
    const lengths = rayLength.array(ctx).map((v) => Math.max(0, asNum(v)));
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
        const weights = weight.array(ctx).map((v) => Math.max(0, asNum(v)));
        for (let iteration = 0; iteration < iterations; iteration++) {
          const next: Elem[] = new Array(ctx.size);
          for (let i = 0; i < ctx.size; i++) {
            let total = scaleElem(current[i] ?? 0, weights[i] ?? 1);
            let totalWeight = weights[i] ?? 1;
            for (const neighbor of ctx.neighbors(i)) {
              const w = weights[neighbor] ?? 1;
              total = addElem(total, scaleElem(current[neighbor] ?? 0, w));
              totalWeight += w;
            }
            next[i] = totalWeight > 0 ? scaleElem(total, 1 / totalWeight) : current[i] ?? 0;
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
