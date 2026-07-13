// Geometry-node handlers first required by the Node Dojo Chrome Crayon graph.
// They are general VM operations, kept in one module so the compatibility
// milestone remains easy to audit against its Blender source.
import { Field, FieldCtx, Vec3, Elem, Domain, asNum, asVec3, vadd, vsub, vscale, vdot, vcross, vlen, vnorm } from "../core";
import { Geometry, Mesh, buildTopology, realizeInstances } from "../geometry";
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
  const input = api.geo("Curve");
  const mode = api.prop<string>("mode", "COUNT");
  const count = Math.max(1, Math.round(api.num("Count")));
  const length = Math.max(1e-9, api.num("Length") || 0.1);
  const sampled = input.curves.map((s) => {
    if (mode === "EVALUATED") return { points: s.points.map((p) => [...p] as Vec3), cyclic: s.cyclic };
    if (mode === "LENGTH") {
      const n = Math.max(2, Math.round((makeFieldCtx(new Geometry(), "POINT"), s.points.reduce((sum, p, i) => i ? sum + vlen(vsub(p, s.points[i - 1])) : sum, 0)) / length));
      return resampleSpline(s, n);
    }
    return resampleSpline(s, count);
  });
  const out = new Geometry();
  const mesh = new Mesh();
  const tangents: Vec3[] = [], normals: Vec3[] = [];
  for (const s of sampled) {
    const frames = splineFrames(s.points, s.cyclic);
    for (let i = 0; i < s.points.length; i++) {
      mesh.positions.push([...s.points[i]] as Vec3);
      tangents.push(frames[i]?.tangent ?? [1, 0, 0]);
      normals.push(frames[i]?.normal ?? [0, 0, 1]);
    }
  }
  mesh.attributes.set("__curve_tangent", { domain: "POINT", data: tangents });
  mesh.attributes.set("__curve_normal", { domain: "POINT", data: normals });
  out.mesh = mesh;
  const attr = (name: string, fallback: Vec3) => Field.perElem((i, ctx) => ctx.attr?.(name, i) ?? fallback).tagged("POINT");
  return {
    Points: out,
    Tangent: attr("__curve_tangent", [1, 0, 0]),
    Normal: attr("__curve_normal", [0, 0, 1]),
    Rotation: Field.of([0, 0, 0]),
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
  if (u < 0 || u > 1) return null;
  const q = vcross(s, e1);
  const v = inv * vdot(direction, q);
  if (v < 0 || u + v > 1) return null;
  const distance = inv * vdot(e2, q);
  if (distance < 0 || distance > maxDistance) return null;
  return { hit: 1, position: vadd(origin, vscale(direction, distance)), normal: tri.normal, distance };
}

reg("GeometryNodeRaycast", (api) => {
  let target = api.geo("Target Geometry");
  if (target.instances.length) target = realizeInstances(target);
  const triangles: Triangle[] = [];
  if (target.mesh) for (const face of target.mesh.faces) for (let i = 1; i + 1 < face.length; i++) {
    const a = target.mesh.positions[face[0]], b = target.mesh.positions[face[i]], c = target.mesh.positions[face[i + 1]];
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
  const iterations = Math.max(0, Math.min(512, Math.round(api.num("Iterations"))));
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
  const center = mesh.positions.length
    ? vscale(mesh.positions.reduce((sum, p) => vadd(sum, p), [0, 0, 0] as Vec3), 1 / mesh.positions.length)
    : [0, 0, 0] as Vec3;
  for (let vi = 0; vi < mesh.positions.length; vi++) {
    const adjacent = topo.pointFaces[vi] ?? [];
    if (adjacent.length < 3) continue;
    const normal = vnorm(vsub(mesh.positions[vi], center));
    const ref = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] as Vec3 : [0, 1, 0] as Vec3;
    const u = vnorm(vsub(ref, vscale(normal, vdot(ref, normal))));
    const v = vnorm(vcross(normal, u));
    adjacent.sort((fa, fb) => {
      const pa = vsub(dual.positions[fa], mesh.positions[vi]);
      const pb = vsub(dual.positions[fb], mesh.positions[vi]);
      return Math.atan2(vdot(pa, v), vdot(pa, u)) - Math.atan2(vdot(pb, v), vdot(pb, u));
    });
    const face = [...adjacent];
    if (face.length >= 3) {
      const faceNormal = vnorm(vcross(vsub(dual.positions[face[1]], dual.positions[face[0]]), vsub(dual.positions[face[2]], dual.positions[face[0]])));
      if (vdot(faceNormal, normal) < 0) face.reverse();
    }
    dual.faces.push(face);
    dual.faceMaterial.push(0);
  }
  out.mesh = dual;
  return { "Dual Mesh": out };
});
