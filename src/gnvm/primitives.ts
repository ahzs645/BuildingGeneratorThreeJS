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
    // Subdivided box: 6 independent face grids (edges unwelded — fine for render).
    const face = (o: Vec3, u: Vec3, vv: Vec3, nu: number, nv: number) => {
      const base = m.positions.length;
      for (let j = 0; j < nv; j++)
        for (let i = 0; i < nu; i++) {
          const fu = nu > 1 ? i / (nu - 1) - 0.5 : 0;
          const fv = nv > 1 ? j / (nv - 1) - 0.5 : 0;
          m.positions.push([
            o[0] + u[0] * fu * 2 + vv[0] * fv * 2,
            o[1] + u[1] * fu * 2 + vv[1] * fv * 2,
            o[2] + u[2] * fu * 2 + vv[2] * fv * 2,
          ]);
        }
      for (let j = 0; j + 1 < nv; j++)
        for (let i = 0; i + 1 < nu; i++) {
          const a = base + j * nu + i;
          m.faces.push([a, a + 1, a + nu + 1, a + nu]);
        }
    };
    face([0, 0, sz], [sx, 0, 0], [0, sy, 0], vx, vy); // +z
    face([0, 0, -sz], [sx, 0, 0], [0, -sy, 0], vx, vy); // -z
    face([0, sy, 0], [sx, 0, 0], [0, 0, sz], vx, vz); // +y
    face([0, -sy, 0], [sx, 0, 0], [0, 0, -sz], vx, vz); // -y
    face([sx, 0, 0], [0, sy, 0], [0, 0, sz], vy, vz); // +x
    face([-sx, 0, 0], [0, -sy, 0], [0, 0, sz], vy, vz); // -x
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
  for (let j = 0; j < vy; j++)
    for (let i = 0; i < vx; i++) {
      const x = (i / (vx - 1) - 0.5) * sizeX;
      const y = (j / (vy - 1) - 0.5) * sizeY;
      m.positions.push([x, y, 0]);
    }
  for (let j = 0; j + 1 < vy; j++)
    for (let i = 0; i + 1 < vx; i++) {
      const a = j * vx + i;
      m.faces.push([a, a + 1, a + vx + 1, a + vx]);
    }
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
