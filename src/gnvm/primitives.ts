// Mesh primitive builders matching Blender GN node output (centered at origin).
import { Vec3 } from "./core";
import { Geometry, Mesh } from "./geometry";

export function meshCube(size: Vec3, vx = 2, vy = 2, vz = 2): Geometry {
  const m = new Mesh();
  const [sx, sy, sz] = [size[0] / 2, size[1] / 2, size[2] / 2];
  // Common case: 8 verts / 6 quads (Blender's default cube topology).
  if (vx <= 2 && vy <= 2 && vz <= 2) {
    m.positions = [
      [-sx, -sy, -sz], [sx, -sy, -sz], [sx, sy, -sz], [-sx, sy, -sz],
      [-sx, -sy, sz], [sx, -sy, sz], [sx, sy, sz], [-sx, sy, sz],
    ];
    m.faces = [
      [0, 3, 2, 1], // -z
      [4, 5, 6, 7], // +z
      [0, 1, 5, 4], // -y
      [1, 2, 6, 5], // +x
      [2, 3, 7, 6], // +y
      [3, 0, 4, 7], // -x
    ];
  } else {
    // Blender's subdivided Cube is a single closed surface. Sharing the twelve
    // border rows is essential: Dual Mesh and repeated smoothing otherwise see
    // six open grids and progressively delete the entire shell.
    vx = Math.max(2, Math.floor(vx));
    vy = Math.max(2, Math.floor(vy));
    vz = Math.max(2, Math.floor(vz));
    const vertices = new Map<string, number>();
    const vertex = (x: number, y: number, z: number): number => {
      const key = `${x}_${y}_${z}`;
      const existing = vertices.get(key);
      if (existing !== undefined) return existing;
      const index = m.positions.length;
      m.positions.push([
        (x / (vx - 1) - .5) * sx * 2,
        (y / (vy - 1) - .5) * sy * 2,
        (z / (vz - 1) - .5) * sz * 2,
      ]);
      vertices.set(key, index);
      return index;
    };
    for (let x = 0; x + 1 < vx; x++) for (let y = 0; y + 1 < vy; y++) {
      m.faces.push([vertex(x, y, 0), vertex(x, y + 1, 0), vertex(x + 1, y + 1, 0), vertex(x + 1, y, 0)]);
      m.faces.push([vertex(x, y, vz - 1), vertex(x + 1, y, vz - 1), vertex(x + 1, y + 1, vz - 1), vertex(x, y + 1, vz - 1)]);
    }
    for (let x = 0; x + 1 < vx; x++) for (let z = 0; z + 1 < vz; z++) {
      m.faces.push([vertex(x, 0, z), vertex(x + 1, 0, z), vertex(x + 1, 0, z + 1), vertex(x, 0, z + 1)]);
      m.faces.push([vertex(x, vy - 1, z), vertex(x, vy - 1, z + 1), vertex(x + 1, vy - 1, z + 1), vertex(x + 1, vy - 1, z)]);
    }
    for (let y = 0; y + 1 < vy; y++) for (let z = 0; z + 1 < vz; z++) {
      m.faces.push([vertex(0, y, z), vertex(0, y, z + 1), vertex(0, y + 1, z + 1), vertex(0, y + 1, z)]);
      m.faces.push([vertex(vx - 1, y, z), vertex(vx - 1, y + 1, z), vertex(vx - 1, y + 1, z + 1), vertex(vx - 1, y, z + 1)]);
    }
  }
  m.faceMaterial = m.faces.map(() => 0);
  m.materialSlots = [null];
  const g = new Geometry();
  g.mesh = m;
  return g;
}

export function meshGrid(sizeX: number, sizeY: number, vx: number, vy: number): Geometry {
  const m = new Mesh();
  vx = Math.max(2, Math.floor(vx));
  vy = Math.max(2, Math.floor(vy));
  // A malformed or unsupported upstream field must not be allowed to allocate
  // an unbounded browser mesh. Blender's Grid node is constrained by available
  // memory too; fail explicitly so parity diagnostics identify the source node.
  if (!Number.isFinite(vx) || !Number.isFinite(vy) || vx * vy > 2_000_000)
    throw new Error(`Mesh Grid resolution is too large (${vx} x ${vy})`);
  // Blender stores Grid vertices X-major (all Y samples for one X before the
  // next X). Geometry looks identical either way, but Index/Field at Index
  // consumers rely on this order (the Dojo bin samples corners recursively).
  for (let i = 0; i < vx; i++)
    for (let j = 0; j < vy; j++) {
      const x = (i / (vx - 1) - 0.5) * sizeX;
      const y = (j / (vy - 1) - 0.5) * sizeY;
      m.positions.push([x, y, 0]);
    }
  for (let i = 0; i + 1 < vx; i++)
    for (let j = 0; j + 1 < vy; j++) {
      const a = i * vy + j;
      m.faces.push([a, a + vy, a + vy + 1, a + 1]);
    }
  // Native Grid edge order: Y edges within each X column, then X edges by row.
  // Mesh to Curve uses this ordering to choose cyclic spline traversal.
  for (let i = 0; i < vx; i++)
    for (let j = 0; j + 1 < vy; j++) m.edges.push([i * vy + j, i * vy + j + 1]);
  for (let j = 0; j < vy; j++)
    for (let i = 0; i + 1 < vx; i++) m.edges.push([i * vy + j, (i + 1) * vy + j]);
  m.faceMaterial = m.faces.map(() => 0);
  m.materialSlots = [null];
  const g = new Geometry();
  g.mesh = m;
  return g;
}

export function meshCircle(verts: number, radius: number, fill: "NONE" | "NGON" | "TRIANGLE_FAN" = "NGON"): Geometry {
  const m = new Mesh();
  verts = Math.max(3, Math.floor(verts));
  for (let i = 0; i < verts; i++) {
    const a = (i / verts) * Math.PI * 2;
    m.positions.push([Math.cos(a) * radius, Math.sin(a) * radius, 0]);
  }
  for (let i = 0; i < verts; i++) m.edges.push([i, (i + 1) % verts]);
  if (fill === "NGON") {
    m.faces.push(Array.from({ length: verts }, (_, i) => i));
  } else if (fill === "TRIANGLE_FAN") {
    const c = m.positions.length;
    m.positions.push([0, 0, 0]);
    for (let i = 0; i < verts; i++) m.faces.push([c, i, (i + 1) % verts]);
  }
  m.faceMaterial = m.faces.map(() => 0);
  m.materialSlots = [null];
  const g = new Geometry();
  g.mesh = m;
  return g;
}

export function meshLine(count: number, start: Vec3, offset: Vec3): Geometry {
  const m = new Mesh();
  count = Math.max(1, Math.floor(count));
  for (let i = 0; i < count; i++) {
    m.positions.push([start[0] + offset[0] * i, start[1] + offset[1] * i, start[2] + offset[2] * i]);
    if (i > 0) m.edges.push([i - 1, i]);
  }
  const g = new Geometry();
  g.mesh = m;
  return g;
}

/** Welded icosphere matching Blender's subdivision counts (12/20, 42/80, ...). */
export function meshIcoSphere(radius = 1, subdivisions = 2): Geometry {
  const m = new Mesh();
  const phi = (1 + Math.sqrt(5)) / 2;
  const seed: Vec3[] = [
    [-1, phi, 0], [1, phi, 0], [-1, -phi, 0], [1, -phi, 0],
    [0, -1, phi], [0, 1, phi], [0, -1, -phi], [0, 1, -phi],
    [phi, 0, -1], [phi, 0, 1], [-phi, 0, -1], [-phi, 0, 1],
  ];
  m.positions = seed.map((point) => {
    const length = Math.hypot(point[0], point[1], point[2]);
    return [point[0] / length, point[1] / length, point[2] / length] as Vec3;
  });
  m.faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const levels = Math.max(1, Math.min(8, Math.floor(subdivisions)));
  for (let level = 1; level < levels; level++) {
    const midpointCache = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const cached = midpointCache.get(key);
      if (cached !== undefined) return cached;
      const pa = m.positions[a], pb = m.positions[b];
      const point: Vec3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      const length = Math.hypot(point[0], point[1], point[2]);
      const index = m.positions.length;
      m.positions.push([point[0] / length, point[1] / length, point[2] / length]);
      midpointCache.set(key, index);
      return index;
    };
    const faces: number[][] = [];
    for (const [a, b, c] of m.faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      faces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    m.faces = faces;
  }
  m.positions = m.positions.map((point) => [point[0] * radius, point[1] * radius, point[2] * radius]);
  m.faceMaterial = m.faces.map(() => 0);
  m.materialSlots = [null];
  const g = new Geometry();
  g.mesh = m;
  return g;
}

/** Cone / frustum along +Z, starting at the origin (Blender Mesh Cone). */
export function meshCone(
  verts: number,
  radiusTop: number,
  radiusBottom: number,
  depth: number,
  sideSegments = 1,
  fillSegments = 1,
  fillType: "NONE" | "NGON" | "TRIANGLE_FAN" = "NGON",
  centered = false,
): Geometry {
  const m = new Mesh();
  verts = Math.max(3, Math.floor(verts));
  sideSegments = Math.max(1, Math.floor(sideSegments));
  fillSegments = Math.max(1, Math.floor(fillSegments));
  const z0 = centered ? -depth / 2 : 0;
  const z1 = centered ? depth / 2 : depth;
  // Rings from bottom to top (sideSegments+1 rings)
  const ringStart: number[] = [];
  const ringCount: number[] = [];
  for (let s = 0; s <= sideSegments; s++) {
    const t = s / sideSegments;
    const r = radiusBottom + (radiusTop - radiusBottom) * t;
    const z = z0 + (z1 - z0) * t;
    ringStart.push(m.positions.length);
    if (Math.abs(r) <= 1e-12) {
      ringCount.push(1);
      m.positions.push([0, 0, z]);
    } else {
      ringCount.push(verts);
      for (let i = 0; i < verts; i++) {
        const a = (i / verts) * Math.PI * 2;
        m.positions.push([Math.cos(a) * r, Math.sin(a) * r, z]);
      }
    }
  }
  // Side quads, or triangle fans where a radius collapses to an apex.
  for (let s = 0; s < sideSegments; s++) {
    const a0 = ringStart[s];
    const a1 = ringStart[s + 1];
    if (ringCount[s] === 1 && ringCount[s + 1] === 1) continue;
    if (ringCount[s] === 1) {
      for (let i = 0; i < verts; i++) m.faces.push([a0, a1 + ((i + 1) % verts), a1 + i]);
    } else if (ringCount[s + 1] === 1) {
      for (let i = 0; i < verts; i++) m.faces.push([a0 + i, a0 + ((i + 1) % verts), a1]);
    } else {
      for (let i = 0; i < verts; i++) {
        const j = (i + 1) % verts;
        m.faces.push([a0 + i, a0 + j, a1 + j, a1 + i]);
      }
    }
  }
  // Caps
  const addCap = (ring: number, radius: number, z: number, flip: boolean) => {
    if (radius <= 1e-12 || fillType === "NONE") return;
    if (fillType === "NGON" && fillSegments <= 1) {
      const f = Array.from({ length: verts }, (_, i) => ring + i);
      m.faces.push(flip ? f.reverse() : f);
      return;
    }
    // Triangle fan (also used for fillSegments > 1 with concentric rings simplified to fan)
    const c = m.positions.length;
    m.positions.push([0, 0, z]);
    for (let i = 0; i < verts; i++) {
      const j = (i + 1) % verts;
      m.faces.push(flip ? [c, ring + j, ring + i] : [c, ring + i, ring + j]);
    }
  };
  addCap(ringStart[0], radiusBottom, z0, true);
  addCap(ringStart[sideSegments], radiusTop, z1, false);
  m.faceMaterial = m.faces.map(() => 0);
  m.materialSlots = [null];
  const g = new Geometry();
  g.mesh = m;
  return g;
}
