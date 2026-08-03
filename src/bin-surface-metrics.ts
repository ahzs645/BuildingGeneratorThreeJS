import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

export type DirectionalSurfaceDistance = {
  p99: number;
  max: number;
  samples: number;
};

export type BidirectionalSurfaceDistance = {
  p99: number;
  max: number;
  aToB: DirectionalSurfaceDistance;
  bToA: DirectionalSurfaceDistance;
};

export type BinLiveSurfaceMetrics = {
  whole: BidirectionalSurfaceDistance | null;
  material: BidirectionalSurfaceDistance | null;
  materialMismatch: boolean;
};

type SurfaceMesh = {
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
};

function materialAt(mesh: THREE.Mesh, materialIndex: number): THREE.Material | undefined {
  return Array.isArray(mesh.material) ? mesh.material[materialIndex] : mesh.material;
}

function triangleRanges(mesh: THREE.Mesh, materialName?: string): Array<{ start: number; count: number }> {
  const geometry = mesh.geometry;
  const total = geometry.index?.count ?? geometry.attributes.position?.count ?? 0;
  const drawStart = Math.max(0, geometry.drawRange.start || 0);
  const drawCount = Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.count : total - drawStart;
  if (materialName === undefined) return [{ start: drawStart, count: Math.min(drawCount, total - drawStart) }];
  if (!geometry.groups.length) return materialAt(mesh, 0)?.name === materialName
    ? [{ start: drawStart, count: Math.min(drawCount, total - drawStart) }]
    : [];
  return geometry.groups
    .filter((group) => materialAt(mesh, group.materialIndex ?? 0)?.name === materialName)
    .map((group) => {
      const start = Math.max(group.start, drawStart);
      const end = Math.min(group.start + group.count, drawStart + drawCount, total);
      return { start, count: Math.max(0, end - start) };
    })
    .filter((range) => range.count >= 3);
}

function objectSurface(root: THREE.Object3D, materialName?: string): SurfaceMesh | null {
  root.updateWorldMatrix(true, true);
  const values: number[] = [];
  const point = new THREE.Vector3();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry.attributes.position) return;
    const position = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    for (const range of triangleRanges(mesh, materialName)) {
      const end = range.start + range.count - 2;
      for (let offset = range.start; offset < end; offset += 3) for (let corner = 0; corner < 3; corner++) {
        const vertex = index ? index.getX(offset + corner) : offset + corner;
        point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.matrixWorld);
        values.push(point.x, point.y, point.z);
      }
    }
  });
  if (!values.length) return null;
  const positions = new Float32Array(values);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return { geometry, positions };
}

function radicalInverse(value: number, base: number): number {
  let result = 0;
  let fraction = 1 / base;
  while (value > 0) {
    result += (value % base) * fraction;
    value = Math.floor(value / base);
    fraction /= base;
  }
  return result;
}

function sampledSurfacePoints(positions: Float32Array, requested: number): THREE.Vector3[] {
  const triangles = positions.length / 9;
  const samples = Math.max(1, Math.min(requested, triangles));
  const areas = new Float64Array(triangles);
  let totalArea = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const edgeA = new THREE.Vector3(), edgeB = new THREE.Vector3();
  for (let triangle = 0; triangle < triangles; triangle++) {
    const offset = triangle * 9;
    a.fromArray(positions, offset);
    b.fromArray(positions, offset + 3);
    c.fromArray(positions, offset + 6);
    const area = edgeA.subVectors(b, a).cross(edgeB.subVectors(c, a)).length() * .5;
    totalArea += area;
    areas[triangle] = totalArea;
  }
  const result: THREE.Vector3[] = [];
  let triangle = 0;
  for (let sample = 0; sample < samples; sample++) {
    const targetArea = totalArea > 0 ? totalArea * (sample + .5) / samples : 0;
    while (triangle + 1 < triangles && areas[triangle] < targetArea) triangle++;
    const offset = triangle * 9;
    a.fromArray(positions, offset);
    b.fromArray(positions, offset + 3);
    c.fromArray(positions, offset + 6);
    const sqrtU = Math.sqrt(radicalInverse(sample + 1, 2));
    const v = radicalInverse(sample + 1, 3);
    result.push(new THREE.Vector3()
      .addScaledVector(a, 1 - sqrtU)
      .addScaledVector(b, sqrtU * (1 - v))
      .addScaledVector(c, sqrtU * v));
  }
  return result;
}

function directionalDistance(source: SurfaceMesh, target: SurfaceMesh, sampleCount: number): DirectionalSurfaceDistance {
  const bvh = new MeshBVH(target.geometry, { indirect: true, targetLeafSize: 24 });
  const distances = sampledSurfacePoints(source.positions, sampleCount).map((point) => bvh.closestPointToPoint(point)?.distance ?? Infinity).sort((a, b) => a - b);
  return {
    p99: distances[Math.floor((distances.length - 1) * .99)],
    max: distances[distances.length - 1],
    samples: distances.length,
  };
}

function compareSurfaces(a: SurfaceMesh | null, b: SurfaceMesh | null, sampleCount: number): BidirectionalSurfaceDistance | null {
  if (!a || !b) return null;
  const aToB = directionalDistance(a, b, sampleCount);
  const bToA = directionalDistance(b, a, sampleCount);
  return { p99: Math.max(aToB.p99, bToA.p99), max: Math.max(aToB.max, bToA.max), aToB, bToA };
}

export function measureBinSurfaceParity(
  truth: THREE.Object3D,
  vm: THREE.Object3D,
  options: { samples?: number; materialSamples?: number; materialName?: string } = {},
): BinLiveSurfaceMetrics {
  const truthWhole = objectSurface(truth);
  const vmWhole = objectSurface(vm);
  const materialName = options.materialName ?? "3D.004";
  const truthMaterial = objectSurface(truth, materialName);
  const vmMaterial = objectSurface(vm, materialName);
  try {
    return {
      whole: compareSurfaces(truthWhole, vmWhole, options.samples ?? 4096),
      material: compareSurfaces(truthMaterial, vmMaterial, options.materialSamples ?? 2048),
      materialMismatch: Boolean(truthMaterial) !== Boolean(vmMaterial),
    };
  } finally {
    truthWhole?.geometry.dispose();
    vmWhole?.geometry.dispose();
    truthMaterial?.geometry.dispose();
    vmMaterial?.geometry.dispose();
  }
}
