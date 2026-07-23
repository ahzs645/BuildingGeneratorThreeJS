// Surface-aware comparison for the Blender truth mesh and GN-VM export.
//
// `mesh-diff.ts` compares vertices, which is useful for locating sampling
// differences but overstates errors when equivalent faces are triangulated in
// different ways. This script measures points against the other mesh's actual
// triangle surface using a small median-split BVH.
//
// Usage: npx tsx tools/mesh-surface-diff.ts [truth.glb] [vm.json]
import { readFileSync } from "node:fs";

type Vec3 = [number, number, number];
type Mat4 = number[];
interface TriMesh { positions: Vec3[]; triangles: [number, number, number][]; }
interface Bounds { min: Vec3; max: Vec3; }
interface BvhNode extends Bounds { left?: BvhNode; right?: BvhNode; ids?: number[]; }

const positionalArgs = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const truthPath = positionalArgs[0] ?? "public/dojo/vase_truth.glb";
const vmPath = positionalArgs[1] ?? "public/dojo/vase_vm.json";
const materialOption = process.argv.find((arg) => arg.startsWith("--material="));
const materialFilter = materialOption ? materialOption.slice("--material=".length) : undefined;
const normalizedMaterialFilter = materialFilter === "<none>" ? null : materialFilter;
const brief = process.argv.includes("--brief");

function identity(): Mat4 { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}
function fromTrs(t?: number[], q?: number[], s?: number[]): Mat4 {
  const [x, y, z, w] = q ?? [0, 0, 0, 1];
  const [sx, sy, sz] = s ?? [1, 1, 1];
  const [tx, ty, tz] = t ?? [0, 0, 0];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - yy - zz) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - xx - zz) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - xx - yy) * sz, 0,
    tx, ty, tz, 1,
  ];
}
function apply(m: Mat4, p: Vec3): Vec3 { return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]]; }

function readGlb(path: string, filter?: string | null): TriMesh {
  const buf = readFileSync(path);
  if (buf.toString("utf8", 0, 4) !== "glTF") throw new Error("not a GLB");
  let off = 12, json: any, bin: Buffer | undefined;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4), chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8").trim());
    if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error("missing GLB JSON/BIN chunk");
  const accessor = (index: number): { acc: any; view: any; offset: number; stride: number } => {
    const acc = json.accessors[index], view = json.bufferViews[acc.bufferView];
    const widths: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
    const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
    const width = widths[acc.componentType], count = components[acc.type];
    return { acc, view, offset: (view.byteOffset ?? 0) + (acc.byteOffset ?? 0), stride: view.byteStride ?? width * count };
  };
  const positions = (index: number): Vec3[] => {
    const { acc, offset, stride } = accessor(index);
    if (acc.componentType !== 5126 || acc.type !== "VEC3") throw new Error("POSITION must be FLOAT VEC3");
    return Array.from({ length: acc.count }, (_, i) => {
      const p = offset + i * stride;
      return [bin!.readFloatLE(p), bin!.readFloatLE(p + 4), bin!.readFloatLE(p + 8)] as Vec3;
    });
  };
  const indices = (index: number | undefined, count: number): number[] => {
    if (index === undefined) return Array.from({ length: count }, (_, i) => i);
    const { acc, offset, stride } = accessor(index);
    const read = acc.componentType === 5121 ? (p: number) => bin!.readUInt8(p) : acc.componentType === 5123 ? (p: number) => bin!.readUInt16LE(p) : (p: number) => bin!.readUInt32LE(p);
    return Array.from({ length: acc.count }, (_, i) => read(offset + i * stride));
  };
  const out: TriMesh = { positions: [], triangles: [] };
  const roots: number[] = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
  const visit = (nodeIndex: number, parent: Mat4) => {
    const node = json.nodes[nodeIndex], world = mul(parent, node.matrix ? node.matrix.slice(0, 16) : fromTrs(node.translation, node.rotation, node.scale));
    if (node.mesh !== undefined) for (const primitive of json.meshes[node.mesh].primitives ?? []) {
      if ((primitive.mode ?? 4) !== 4) continue;
      const material = primitive.material === undefined ? null : json.materials?.[primitive.material]?.name ?? null;
      if (filter !== undefined && material !== filter) continue;
      const local = positions(primitive.attributes.POSITION), base = out.positions.length;
      // glTF is Y-up. Convert transformed positions back to Blender/VM Z-up.
      for (const p of local) {
        const q = apply(world, p);
        out.positions.push([q[0], -q[2], q[1]]);
      }
      const ids = indices(primitive.indices, local.length);
      for (let i = 0; i + 2 < ids.length; i += 3) out.triangles.push([base + ids[i], base + ids[i + 1], base + ids[i + 2]]);
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const root of roots) visit(root, identity());
  return out;
}

function readProbeJson(path: string): TriMesh {
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const positions = payload.positions as Vec3[];
  if (!Array.isArray(positions) || (positions.length > 0 && !Array.isArray(positions[0])))
    throw new Error("probe JSON must contain nested positions");
  const source = (payload.loop_triangles ?? payload.faces ?? []) as number[][];
  const triangles: [number, number, number][] = [];
  for (const face of source) {
    if (face.length === 3) triangles.push(face as [number, number, number]);
    else for (let i = 1; i + 1 < face.length; i++) triangles.push([face[0], face[i], face[i + 1]]);
  }
  return { positions, triangles };
}

function readVm(path: string, filter?: string | null): TriMesh {
  const vm = JSON.parse(readFileSync(path, "utf8"));
  const local = process.argv.includes("--local");
  const loc = local ? [0, 0, 0] : vm.object?.location ?? [275.16204833984375, 0, 0];
  const rot = local ? [0, 0, 0] : vm.object?.rotation ?? [0, 0, 0];
  const scale = local ? [1, 1, 1] : vm.object?.scale ?? [1, 1, 1];
  const positions: Vec3[] = [];
  for (let i = 0; i < vm.positions.length; i += 3) {
    let x = vm.positions[i] * scale[0], y = vm.positions[i + 1] * scale[1], z = vm.positions[i + 2] * scale[2];
    let c = Math.cos(rot[0]), s = Math.sin(rot[0]); [y, z] = [y * c - z * s, y * s + z * c];
    c = Math.cos(rot[1]); s = Math.sin(rot[1]); [x, z] = [x * c + z * s, -x * s + z * c];
    c = Math.cos(rot[2]); s = Math.sin(rot[2]); [x, y] = [x * c - y * s, x * s + y * c];
    positions.push([x + loc[0], y + loc[1], z + loc[2]]);
  }
  const triangles: [number, number, number][] = [];
  if (filter === undefined) {
    for (let i = 0; i < vm.indices.length; i += 3) triangles.push([vm.indices[i], vm.indices[i + 1], vm.indices[i + 2]]);
  } else {
    for (const group of vm.groups ?? []) {
      if ((group.material ?? null) !== filter) continue;
      for (let i = group.start; i < group.start + group.count; i += 3)
        triangles.push([vm.indices[i], vm.indices[i + 1], vm.indices[i + 2]]);
    }
  }
  if (filter === undefined) return { positions, triangles };
  const remap = new Map<number, number>();
  const filteredPositions: Vec3[] = [];
  const filteredTriangles = triangles.map((triangle) => triangle.map((old) => {
    let next = remap.get(old);
    if (next === undefined) {
      next = filteredPositions.length;
      remap.set(old, next);
      filteredPositions.push(positions[old]);
    }
    return next;
  }) as [number, number, number]);
  return { positions: filteredPositions, triangles: filteredTriangles };
}

function boundsOf(points: Vec3[]): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  return { min, max };
}
function triBounds(mesh: TriMesh, id: number): Bounds { const tri = mesh.triangles[id]; return boundsOf([mesh.positions[tri[0]], mesh.positions[tri[1]], mesh.positions[tri[2]]]); }
function unionBounds(a: Bounds, b: Bounds): Bounds { return { min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])], max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])] }; }
function buildBvh(mesh: TriMesh, boxes = mesh.triangles.map((_, i) => triBounds(mesh, i)), centers = boxes.map((b) => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2] as Vec3), ids = mesh.triangles.map((_, i) => i)): BvhNode {
  const bounds = ids.reduce((all, id) => unionBounds(all, boxes[id]), { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 });
  if (ids.length <= 16) return { ...bounds, ids };
  const axis = [0, 1, 2].reduce((best, k) => bounds.max[k] - bounds.min[k] > bounds.max[best] - bounds.min[best] ? k : best, 0);
  ids.sort((a, b) => centers[a][axis] - centers[b][axis]);
  const mid = Math.floor(ids.length / 2);
  return { ...bounds, left: buildBvh(mesh, boxes, centers, ids.slice(0, mid)), right: buildBvh(mesh, boxes, centers, ids.slice(mid)) };
}
function boxDistanceSq(p: Vec3, b: Bounds): number { let d = 0; for (let k = 0; k < 3; k++) { const x = p[k] < b.min[k] ? b.min[k] - p[k] : p[k] > b.max[k] ? p[k] - b.max[k] : 0; d += x * x; } return d; }
function pointTriangleDistanceSq(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const sub = (u: Vec3, v: Vec3): Vec3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u: Vec3, v: Vec3) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const pointSegmentDistanceSq = (x: Vec3, u: Vec3, v: Vec3): number => {
    const uv = sub(v, u), ux = sub(x, u), d = dot(uv, uv);
    const t = d > 1e-12 ? Math.max(0, Math.min(1, dot(ux, uv) / d)) : 0;
    const q: Vec3 = [u[0] + t * uv[0], u[1] + t * uv[1], u[2] + t * uv[2]];
    const delta = sub(x, q);
    return dot(delta, delta);
  };
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  const cross: Vec3 = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  if (dot(cross, cross) <= 1e-20)
    return Math.min(pointSegmentDistanceSq(p, a, b), pointSegmentDistanceSq(p, b, c), pointSegmentDistanceSq(p, c, a));
  if (d1 <= 0 && d2 <= 0) return dot(ap, ap);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dot(bp, bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); const q: Vec3 = [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]; const d = sub(p, q); return dot(d, d); }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dot(cp, cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); const q: Vec3 = [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]; const d = sub(p, q); return dot(d, d); }
  const va = d3 * d6 - d5 * d4, area = va + vb + vc;
  if (Math.abs(area) <= 1e-12) return Math.min(pointSegmentDistanceSq(p, a, b), pointSegmentDistanceSq(p, b, c), pointSegmentDistanceSq(p, c, a));
  const denom = 1 / area, v = vb * denom, w = vc * denom;
  const q: Vec3 = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
  const d = sub(p, q); return dot(d, d);
}
function distanceToSurface(p: Vec3, mesh: TriMesh, root: BvhNode): number {
  let best = Infinity; const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (boxDistanceSq(p, node) >= best) continue;
    if (node.ids) for (const id of node.ids) { const [i, j, k] = mesh.triangles[id]; best = Math.min(best, pointTriangleDistanceSq(p, mesh.positions[i], mesh.positions[j], mesh.positions[k])); }
    else if (node.left && node.right) {
      const dl = boxDistanceSq(p, node.left), dr = boxDistanceSq(p, node.right);
      if (dl < dr) { stack.push(node.right, node.left); } else { stack.push(node.left, node.right); }
    }
  }
  return Math.sqrt(best);
}
function sample<T>(items: T[], count: number): T[] { let seed = 0x12345678; const out: T[] = []; for (let i = 0; i < Math.min(count, items.length); i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; out.push(items[Math.floor((seed / 0x100000000) * items.length)]); } return out; }
function report(label: string, source: Vec3[], target: TriMesh, bvh: BvhNode): void {
  const scored = sample(source, 5000).map((point) => ({ point, distance: distanceToSurface(point, target, bvh) })).sort((a, b) => a.distance - b.distance);
  const q = (p: number) => scored[Math.floor((scored.length - 1) * p)].distance;
  const threshold = q(.99);
  const worst = boundsOf(scored.filter((sample) => sample.distance >= threshold).map((sample) => sample.point));
  const maxima = scored.slice(-5).reverse().map((sample) => ({ point: sample.point.map((v) => Number(v.toFixed(2))), distance: Number(sample.distance.toFixed(3)) }));
  console.log(`${label} p50=${q(.5).toFixed(3)} p90=${q(.9).toFixed(3)} p99=${q(.99).toFixed(3)} max=${q(1).toFixed(3)} worst1%=${JSON.stringify(worst)} maxima=${JSON.stringify(maxima)}`);
}

function connectedComponents(mesh: TriMesh): { vertices: Vec3[]; triangleIds: number[] }[] {
  const parent = mesh.positions.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const join = (a: number, b: number): void => {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  };
  for (const [a, b, c] of mesh.triangles) { join(a, b); join(b, c); }
  const groups = new Map<number, { ids: number[]; triangleIds: number[] }>();
  for (let i = 0; i < mesh.positions.length; i++) {
    const root = find(i), group = groups.get(root) ?? { ids: [], triangleIds: [] };
    group.ids.push(i); groups.set(root, group);
  }
  for (let id = 0; id < mesh.triangles.length; id++) groups.get(find(mesh.triangles[id][0]))!.triangleIds.push(id);
  return [...groups.values()]
    .map((group) => ({ vertices: group.ids.map((id) => mesh.positions[id]), triangleIds: group.triangleIds }))
    .sort((a, b) => b.triangleIds.length - a.triangleIds.length);
}

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) / 2;
}

function areaSummary(label: string, mesh: TriMesh): void {
  const areas = mesh.triangles.map(([a, b, c]) => triangleArea(mesh.positions[a], mesh.positions[b], mesh.positions[c])).sort((a, b) => a - b);
  const q = (p: number) => areas[Math.floor((areas.length - 1) * p)];
  const total = areas.reduce((sum, area) => sum + area, 0);
  console.log(`${label} triangle area total=${total.toFixed(3)} p50=${q(.5).toFixed(3)} p99=${q(.99).toFixed(3)} p99.9=${q(.999).toFixed(3)} max=${q(1).toFixed(3)} zero=${areas.filter((area) => area < 1e-8).length}`);
}

function axialFanSummary(label: string, mesh: TriMesh): void {
  const bounds = boundsOf(mesh.positions);
  const center: Vec3 = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, 0];
  const fans: { radius: number; z: number; area: number }[] = [];
  for (const [a, b, c] of mesh.triangles) {
    const points = [mesh.positions[a], mesh.positions[b], mesh.positions[c]];
    const radii = points.map((p) => Math.hypot(p[0] - center[0], p[1] - center[1]));
    const minRadius = Math.min(...radii), maxRadius = Math.max(...radii);
    if (minRadius > 2 || maxRadius < 20) continue;
    fans.push({ radius: maxRadius, z: points.reduce((sum, p) => sum + p[2], 0) / 3, area: triangleArea(...points) });
  }
  const minZ = fans.length ? Math.min(...fans.map((fan) => fan.z)) : 0;
  const maxZ = fans.length ? Math.max(...fans.map((fan) => fan.z)) : 0;
  const maxRadius = fans.length ? Math.max(...fans.map((fan) => fan.radius)) : 0;
  console.log(`${label} axial fan triangles=${fans.length} z=[${minZ.toFixed(3)},${maxZ.toFixed(3)}] maxRadius=${maxRadius.toFixed(3)}`);
}

function topPlanarSummary(label: string, mesh: TriMesh): void {
  const bounds = boundsOf(mesh.positions);
  const center: Vec3 = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, 0];
  const nearTop: { z: number; area: number; minRadius: number; maxRadius: number }[] = [];
  for (const [a, b, c] of mesh.triangles) {
    const points = [mesh.positions[a], mesh.positions[b], mesh.positions[c]];
    const zs = points.map((p) => p[2]);
    if (Math.max(...zs) < bounds.max[2] - 5 || Math.max(...zs) - Math.min(...zs) > 1e-3) continue;
    const radii = points.map((p) => Math.hypot(p[0] - center[0], p[1] - center[1]));
    nearTop.push({
      z: zs.reduce((sum, z) => sum + z, 0) / 3,
      area: triangleArea(...points),
      minRadius: Math.min(...radii),
      maxRadius: Math.max(...radii),
    });
  }
  const nonzero = nearTop.filter((tri) => tri.area > 1e-8);
  const zMin = nonzero.reduce((minimum, tri) => Math.min(minimum, tri.z), Infinity);
  const zMax = nonzero.reduce((maximum, tri) => Math.max(maximum, tri.z), -Infinity);
  const rMin = nonzero.reduce((minimum, tri) => Math.min(minimum, tri.minRadius), Infinity);
  const rMax = nonzero.reduce((maximum, tri) => Math.max(maximum, tri.maxRadius), -Infinity);
  const area = nonzero.reduce((sum, tri) => sum + tri.area, 0);
  console.log(`${label} planar top triangles=${nonzero.length} z=[${(nonzero.length ? zMin : 0).toFixed(3)},${(nonzero.length ? zMax : 0).toFixed(3)}] radius=[${(nonzero.length ? rMin : 0).toFixed(3)},${(nonzero.length ? rMax : 0).toFixed(3)}] area=${area.toFixed(3)}`);
}

function reportTriangleCentroids(label: string, mesh: TriMesh, triangleIds: number[], target: TriMesh, bvh: BvhNode): void {
  const scored = triangleIds
    .map((id) => {
      const [a, b, c] = mesh.triangles[id];
      const points = [mesh.positions[a], mesh.positions[b], mesh.positions[c]];
      return {
        id,
        point: points.reduce((sum, point) => [sum[0] + point[0] / 3, sum[1] + point[1] / 3, sum[2] + point[2] / 3] as Vec3, [0, 0, 0] as Vec3),
        area: triangleArea(...points),
      };
    })
    .filter((sample) => sample.area > 1e-8)
    .map((sample) => ({ ...sample, distance: distanceToSurface(sample.point, target, bvh) }))
    .sort((a, b) => a.distance - b.distance);
  const q = (p: number) => scored[Math.floor((scored.length - 1) * p)].distance;
  const outliers = scored.filter((sample) => sample.distance > 2);
  const maxima = scored.slice(-8).reverse().map((sample) => ({
    tri: sample.id,
    point: sample.point.map((value) => Number(value.toFixed(2))),
    area: Number(sample.area.toFixed(3)),
    distance: Number(sample.distance.toFixed(3)),
  }));
  const outlierBounds = outliers.length ? boundsOf(outliers.map((sample) => sample.point)) : null;
  console.log(`${label} centroid p50=${q(.5).toFixed(3)} p90=${q(.9).toFixed(3)} p99=${q(.99).toFixed(3)} max=${q(1).toFixed(3)} outliers>2=${outliers.length} bounds=${JSON.stringify(outlierBounds)} maxima=${JSON.stringify(maxima)}`);
}

function reportHeightBands(label: string, mesh: TriMesh, target: TriMesh, bvh: BvhNode, bandCount = 12): void {
  const bounds = boundsOf(mesh.positions);
  const span = Math.max(1e-9, bounds.max[2] - bounds.min[2]);
  const bands: { distances: number[]; minZ: number; maxZ: number }[] = Array.from({ length: bandCount }, (_, i) => ({
    distances: [],
    minZ: bounds.min[2] + span * i / bandCount,
    maxZ: bounds.min[2] + span * (i + 1) / bandCount,
  }));
  for (const [a, b, c] of mesh.triangles) {
    const points = [mesh.positions[a], mesh.positions[b], mesh.positions[c]];
    if (triangleArea(...points) <= 1e-8) continue;
    const point = points.reduce((sum, p) => [sum[0] + p[0] / 3, sum[1] + p[1] / 3, sum[2] + p[2] / 3] as Vec3, [0, 0, 0] as Vec3);
    const index = Math.min(bandCount - 1, Math.max(0, Math.floor((point[2] - bounds.min[2]) / span * bandCount)));
    bands[index].distances.push(distanceToSurface(point, target, bvh));
  }
  console.log(`${label} height bands:`);
  for (const band of bands) {
    band.distances.sort((a, b) => a - b);
    if (!band.distances.length) continue;
    const q = (p: number) => band.distances[Math.floor((band.distances.length - 1) * p)];
    console.log(`  z=[${band.minZ.toFixed(2)},${band.maxZ.toFixed(2)}] n=${band.distances.length} p50=${q(.5).toFixed(3)} p99=${q(.99).toFixed(3)} max=${q(1).toFixed(3)}`);
  }
}

const truth = truthPath.toLowerCase().endsWith(".json")
  ? readProbeJson(truthPath)
  : readGlb(truthPath, normalizedMaterialFilter);
const vm = readVm(vmPath, normalizedMaterialFilter);
console.log(`truth ${truth.positions.length}v ${truth.triangles.length}t ${JSON.stringify(boundsOf(truth.positions))}`);
console.log(`vm ${vm.positions.length}v ${vm.triangles.length}t ${JSON.stringify(boundsOf(vm.positions))}`);
areaSummary("truth", truth);
areaSummary("vm", vm);
axialFanSummary("truth", truth);
axialFanSummary("vm", vm);
topPlanarSummary("truth", truth);
topPlanarSummary("vm", vm);
console.log("building triangle BVHs...");
const truthBvh = buildBvh(truth), vmBvh = buildBvh(vm);
report("truth points -> VM surface", truth.positions, vm, vmBvh);
report("VM points -> truth surface", vm.positions, truth, truthBvh);
if (process.argv.includes("--centroids")) {
  reportTriangleCentroids("truth -> VM surface", truth, truth.triangles.map((_, i) => i), vm, vmBvh);
  reportTriangleCentroids("VM -> truth surface", vm, vm.triangles.map((_, i) => i), truth, truthBvh);
}
if (process.argv.includes("--regions")) {
  reportHeightBands("truth -> VM", truth, vm, vmBvh);
  reportHeightBands("VM -> truth", vm, truth, truthBvh);
}
if (!brief) for (const [index, component] of connectedComponents(vm).entries()) {
  console.log(`VM component ${index + 1}: ${component.vertices.length}v ${component.triangleIds.length}t ${JSON.stringify(boundsOf(component.vertices))}`);
  report(`VM component ${index + 1} -> truth surface`, component.vertices, truth, truthBvh);
  if (process.argv.includes("--centroids"))
    reportTriangleCentroids(`VM component ${index + 1} -> truth surface`, vm, component.triangleIds, truth, truthBvh);
}
