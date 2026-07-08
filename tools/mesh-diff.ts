import { readFileSync } from "node:fs";

type Vec3 = [number, number, number];
type Mat4 = number[];

const truthPath = process.argv[2] ?? "/Users/ahmadjalil/github/BuildingGeneratorThreeJS/public/dojo/vase_truth.glb";
const vmPath = process.argv[3] ?? "/Users/ahmadjalil/github/BuildingGeneratorThreeJS/public/dojo/vase_vm.json";

function matIdentity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function matMul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function matFromTRS(t?: number[], q?: number[], s?: number[]): Mat4 {
  const [x, y, z, w] = q ?? [0, 0, 0, 1];
  const [sx, sy, sz] = s ?? [1, 1, 1];
  const [tx, ty, tz] = t ?? [0, 0, 0];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function transform(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function parseGlbPositions(path: string): Vec3[] {
  const buf = readFileSync(path);
  if (buf.toString("utf8", 0, 4) !== "glTF") throw new Error("not a GLB");
  let off = 12;
  let json: any = null;
  let bin: Buffer | null = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8").trim());
    if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error("missing GLB JSON/BIN chunk");

  const accessorPositions = (accessorIndex: number): Vec3[] => {
    const acc = json.accessors[accessorIndex];
    if (acc.componentType !== 5126 || acc.type !== "VEC3") throw new Error("POSITION accessor is not FLOAT VEC3");
    if (acc.sparse) throw new Error("sparse accessors not implemented");
    const bv = json.bufferViews[acc.bufferView];
    const byteOffset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const stride = bv.byteStride ?? 12;
    const out: Vec3[] = [];
    for (let i = 0; i < acc.count; i++) {
      const p = byteOffset + i * stride;
      out.push([bin!.readFloatLE(p), bin!.readFloatLE(p + 4), bin!.readFloatLE(p + 8)]);
    }
    return out;
  };

  const sceneIndex = json.scene ?? 0;
  const roots: number[] = json.scenes?.[sceneIndex]?.nodes ?? json.nodes?.map((_: any, i: number) => i) ?? [];
  const points: Vec3[] = [];
  const visit = (nodeIndex: number, parent: Mat4) => {
    const node = json.nodes[nodeIndex];
    const local = node.matrix ? node.matrix.slice(0, 16) : matFromTRS(node.translation, node.rotation, node.scale);
    const world = matMul(parent, local);
    if (node.mesh !== undefined) {
      const mesh = json.meshes[node.mesh];
      for (const prim of mesh.primitives ?? []) {
        const posIndex = prim.attributes?.POSITION;
        if (posIndex === undefined) continue;
        for (const p of accessorPositions(posIndex)) points.push(transform(world, p));
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const root of roots) visit(root, matIdentity());
  // Blender's GLB exporter writes glTF Y-up coordinates. Convert back to the
  // Blender/VM Z-up convention before comparing: (x, y, z)_bl = (x, -z, y)_gltf.
  return points.map((p) => [p[0], -p[2], p[1]] as Vec3);
}

function parseVmPositions(path: string): Vec3[] {
  const vm = JSON.parse(readFileSync(path, "utf8"));
  const loc = vm.object?.location ?? [275.16204833984375, 0, 0];
  const arr: number[] = vm.positions;
  const out: Vec3[] = [];
  for (let i = 0; i < arr.length; i += 3) out.push([arr[i] + loc[0], arr[i + 1] + loc[1], arr[i + 2] + loc[2]]);
  return out;
}

function bbox(points: Vec3[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) {
    if (p[k] < min[k]) min[k] = p[k];
    if (p[k] > max[k]) max[k] = p[k];
  }
  return { min, max };
}

function sample(points: Vec3[], n: number): Vec3[] {
  let seed = 0x12345678;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const out: Vec3[] = [];
  for (let i = 0; i < Math.min(n, points.length); i++) out.push(points[Math.floor(rnd() * points.length)]);
  return out;
}

function nearestDistances(samples: Vec3[], target: Vec3[]): number[] {
  const b = bbox(target);
  const diag = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const cell = Math.max(1e-6, diag / Math.max(24, Math.cbrt(target.length) * 3));
  const grid = new Map<string, number[]>();
  const coord = (p: Vec3): [number, number, number] => [
    Math.floor((p[0] - b.min[0]) / cell),
    Math.floor((p[1] - b.min[1]) / cell),
    Math.floor((p[2] - b.min[2]) / cell),
  ];
  const key = (x: number, y: number, z: number) => `${x}_${y}_${z}`;
  for (let i = 0; i < target.length; i++) {
    const [x, y, z] = coord(target[i]);
    const k = key(x, y, z);
    const bucket = grid.get(k);
    if (bucket) bucket.push(i); else grid.set(k, [i]);
  }
  const out: number[] = [];
  for (const p of samples) {
    const [cx, cy, cz] = coord(p);
    let best = Infinity;
    for (let r = 0; r <= 64; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
        const bucket = grid.get(key(cx + dx, cy + dy, cz + dz));
        if (!bucket) continue;
        for (const i of bucket) {
          const q = target[i];
          const d2 = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
          if (d2 < best) best = d2;
        }
      }
      const lowerBoundOutside = Math.max(0, (r - 1) * cell);
      if (Number.isFinite(best) && lowerBoundOutside * lowerBoundOutside > best) break;
    }
    out.push(Math.sqrt(best));
  }
  return out;
}

function quantiles(vals: number[]): string {
  const a = [...vals].sort((x, y) => x - y);
  const q = (p: number) => a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))];
  return `p50=${q(0.5).toFixed(3)} p90=${q(0.9).toFixed(3)} p99=${q(0.99).toFixed(3)} max=${q(1).toFixed(3)}`;
}

const truth = parseGlbPositions(truthPath);
const vm = parseVmPositions(vmPath);
const tb = bbox(truth), vb = bbox(vm);
console.log(`truth points=${truth.length} bbox=[${tb.min.map((v) => v.toFixed(3)).join(",")}]..[${tb.max.map((v) => v.toFixed(3)).join(",")}]`);
console.log(`vm points=${vm.length} bbox=[${vb.min.map((v) => v.toFixed(3)).join(",")}]..[${vb.max.map((v) => v.toFixed(3)).join(",")}]`);
console.log(`truth->vm ${quantiles(nearestDistances(sample(truth, 5000), vm))}`);
console.log(`vm->truth ${quantiles(nearestDistances(sample(vm, 5000), truth))}`);
