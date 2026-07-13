import { MeshBasicMaterial } from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { asNum, Field, Vec3 } from "../core";
import { makeFieldCtx } from "../evaluator";
import { Geometry, Mesh } from "../geometry";
import { reg, SockVal } from "../registry";

interface VolumeGrid {
  kind: "GNVM_VOLUME_GRID";
  density: Field;
  background: number;
  min: Vec3;
  max: Vec3;
  resolution: Vec3;
}

function isVolumeGrid(value: unknown): value is VolumeGrid {
  return !!value && typeof value === "object" && (value as VolumeGrid).kind === "GNVM_VOLUME_GRID";
}

reg("GeometryNodeVolumeCube", (api) => {
  const volume: VolumeGrid = {
    kind: "GNVM_VOLUME_GRID",
    density: api.field("Density"),
    background: api.num("Background"),
    min: api.vec("Min"),
    max: api.vec("Max"),
    resolution: [
      Math.max(4, Math.round(api.num("Resolution X"))),
      Math.max(4, Math.round(api.num("Resolution Y"))),
      Math.max(4, Math.round(api.num("Resolution Z"))),
    ],
  };
  return { Volume: volume as unknown as SockVal };
});

reg("GeometryNodeVolumeToMesh", (api) => {
  const volume = api.input("Volume") as unknown;
  if (!isVolumeGrid(volume)) return { Mesh: new Geometry() };

  const spans: Vec3 = [
    Math.max(1e-6, volume.max[0] - volume.min[0]),
    Math.max(1e-6, volume.max[1] - volume.min[1]),
    Math.max(1e-6, volume.max[2] - volume.min[2]),
  ];
  const center: Vec3 = [
    (volume.min[0] + volume.max[0]) * 0.5,
    (volume.min[1] + volume.max[1]) * 0.5,
    (volume.min[2] + volume.max[2]) * 0.5,
  ];
  const maxSpan = Math.max(...spans);
  const sampleSpacing = Math.max(...spans.map((span, axis) => span / Math.max(1, volume.resolution[axis] - 1)));
  const voxelSize = Math.max(1e-6, api.num("Voxel Size") || sampleSpacing);
  const spacing = Math.max(sampleSpacing, voxelSize);
  const coreResolution = Math.max(8, Math.min(140, Math.ceil(maxSpan / spacing) + 1));
  // MarchingCubes skips its outer two cells. Pad the sampled SDF with Volume
  // Cube's background value so surfaces can still meet the authored bounds.
  const resolution = coreResolution + 4;
  const paddedSpan = spacing * resolution;
  const halfSpan = paddedSpan * 0.5;
  const halfResolution = resolution * 0.5;
  const marcher = new MarchingCubes(
    resolution,
    new MeshBasicMaterial(),
    false,
    false,
    500_000,
  );
  marcher.isolation = api.num("Threshold");

  // Resolve the density field a slice at a time. This keeps the temporary
  // position/field arrays small even for Node Dojo's million-voxel pipe wrap.
  for (let z = 0; z < resolution; z++) {
    const sampleGeometry = new Geometry();
    const sampleMesh = new Mesh();
    sampleGeometry.mesh = sampleMesh;
    const fz = (z - halfResolution) / halfResolution;
    for (let y = 0; y < resolution; y++) {
      const fy = (y - halfResolution) / halfResolution;
      for (let x = 0; x < resolution; x++) {
        const fx = (x - halfResolution) / halfResolution;
        sampleMesh.positions.push([
          center[0] + fx * halfSpan,
          center[1] + fy * halfSpan,
          center[2] + fz * halfSpan,
        ]);
      }
    }
    const values = volume.density.array(makeFieldCtx(sampleGeometry, "POINT"));
    for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
      const local = y * resolution + x;
      const point = sampleMesh.positions[local];
      const inside = point[0] >= volume.min[0] && point[0] <= volume.max[0]
        && point[1] >= volume.min[1] && point[1] <= volume.max[1]
        && point[2] >= volume.min[2] && point[2] <= volume.max[2];
      const sampled = inside ? asNum(values[local] ?? volume.background) : volume.background;
      marcher.field[z * resolution * resolution + local] = Number.isFinite(sampled) ? sampled : volume.background;
    }
  }

  marcher.update();
  const position = marcher.geometry.getAttribute("position");
  const count = Math.min(marcher.geometry.drawRange.count, position.count);
  const mesh = new Mesh();
  const vertexByPosition = new Map<string, number>();
  const epsilon = Math.max(1e-7, spacing * 1e-5);
  let triangle: number[] = [];
  for (let i = 0; i < count; i++) {
    const point: Vec3 = [
      center[0] + position.getX(i) * halfSpan,
      center[1] + position.getY(i) * halfSpan,
      center[2] + position.getZ(i) * halfSpan,
    ];
    const key = point.map((component) => Math.round(component / epsilon)).join("_");
    let index = vertexByPosition.get(key);
    if (index === undefined) {
      index = mesh.positions.length;
      mesh.positions.push(point);
      vertexByPosition.set(key, index);
    }
    triangle.push(index);
    if (triangle.length === 3) {
      if (new Set(triangle).size === 3) mesh.faces.push(triangle);
      triangle = [];
    }
  }
  mesh.materialSlots = [null];
  const geometry = new Geometry();
  geometry.mesh = mesh;
  return { Mesh: geometry };
});

reg("GeometryNodeInputInstanceRotation", () => ({
  Rotation: Field.perElem((index, context) => context.attr?.("__instance_rotation", index) ?? [0, 0, 0]),
}));
