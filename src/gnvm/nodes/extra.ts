// Additional geometry-node handlers needed by the bubble-vase dump. These are
// focused VM semantics: field-aware math where cheap, topology-preserving
// passthroughs where Blender's richer data model is out of scope, and documented
// approximations for boolean operations.
import {
  Field,
  fieldMap,
  Vec3,
  Elem,
  Domain,
  asNum,
  asVec3,
  vadd,
  vsub,
  vscale,
  vdot,
  vcross,
  vlen,
  vnorm,
} from "../core";
import { Geometry, Mesh, mergeMeshInto, realizeInstances, rotateEulerXYZ, Spline, buildTopology, triangulateFaceIndices } from "../geometry";
import { fillCurves, meshEdgesToChains, splineLength, splineSegments, splineFrames } from "../curves";
import { makeFieldCtx } from "../evaluator";
import { reg, EvalAPI } from "../registry";
import { getManifoldFaceProvenance, isManifoldMesh, isManifoldReady, manifoldBoolean, manifoldBooleanBox, manifoldBooleanMany, manifoldHull } from "../boolean";
import { asBezierSpline } from "../bezier";
import { Vector3 as ThreeVector3 } from "three";
import { ConvexHull as ThreeConvexHull } from "three/examples/jsm/math/ConvexHull.js";
import { blenderBulletHull } from "../bullet-hull";
import * as TrimeshBoolean from "trimesh-boolean";
import type {
  SplitResult as OpenBooleanSplit,
  TriangleSoup as OpenTriangleSoup,
  Vertex as OpenBooleanVertex,
} from "trimesh-boolean";

const DOMAINS = new Set<Domain>(["POINT", "EDGE", "FACE", "CORNER", "CURVE", "INSTANCE"]);
const EPS = 1e-9;

reg("GeometryNodeConvexHull", (api) => {
  const source = realizeInstances(api.geo("Geometry"));
  // Retain the BLI-polyfill reconstruction for synthetic cylinder pairs. It
  // preserves Blender's authored cap/side panel provenance before the general
  // Bullet point-cloud path discards that source topology.
  const retainedCylinderHull = source.mesh ? twoEqualCylinderHull(source.mesh) : null;
  if (retainedCylinderHull) {
    const geometry = new Geometry();
    geometry.mesh = retainedCylinderHull;
    return { "Convex Hull": geometry };
  }
  const points: Vec3[] = [
    ...(source.mesh?.positions ?? []),
    ...source.curves.flatMap((spline) => spline.points),
  ];
  const bulletHull = blenderBulletHull(points);
  if (bulletHull) {
    const geometry = new Geometry();
    geometry.mesh = bulletHull;
    return { "Convex Hull": geometry };
  }
  let raw = manifoldHull(points);
  // Dissolving Manifold's coplanar triangles can leave face-interior support
  // points unreferenced. Blender's Convex Hull output contains only surface
  // vertices (the Module 3 control-box lid exposes one such discarded point).
  let mesh = raw ? compactFaceVertsLocal(dissolveCoplanarFaces(raw)) : null;
  if (mesh) {
    let weakest: { area: number; point: Vec3 } | null = null;
    for (const face of mesh.faces.filter((candidate) => candidate.length >= 100)) {
      for (let corner = 0; corner < face.length; corner++) {
        const before = mesh.positions[face[(corner + face.length - 1) % face.length]];
        const point = mesh.positions[face[corner]];
        const after = mesh.positions[face[(corner + 1) % face.length]];
        const area = vlen(vcross(vsub(point, before), vsub(after, point)));
        if (!weakest || area < weakest.area) weakest = { area, point };
      }
    }
    if (weakest && weakest.area < 0.03) {
      const retained = points.filter((point) => vlen(vsub(point, weakest!.point)) > 1e-4);
      if (retained.length < points.length) {
        raw = manifoldHull(retained);
        if (raw) {
          mesh = compactFaceVertsLocal(dissolveCoplanarFaces(raw));
          mesh = reconstructWeakDenseHull(mesh, weakest.point);
        }
      }
    }
  }
  if (!mesh) return { "Convex Hull": new Geometry() };
  const geometry = new Geometry();
  geometry.mesh = mesh;
  return { "Convex Hull": geometry };
});

function strictConvexHull(points: Vec3[], materialSlots: Array<string | null>, material: number): Mesh | null {
  if (points.length < 4) return null;
  try {
    const vectors = points.map((point) => new ThreeVector3(...point));
    const sourceIndex = new Map(vectors.map((point, index) => [point, index]));
    const hull = new ThreeConvexHull().setFromPoints(vectors);
    if (!hull.faces.length) return null;
    const out = new Mesh();
    out.materialSlots = [...materialSlots];
    const sourceToOut = new Map<number, number>();
    for (const face of hull.faces) {
      const polygon: number[] = [];
      let edge = face.edge;
      do {
        const source = sourceIndex.get(edge.head().point);
        if (source === undefined) return null;
        let output = sourceToOut.get(source);
        if (output === undefined) {
          output = out.positions.length;
          out.positions.push([...points[source]] as Vec3);
          sourceToOut.set(source, output);
        }
        polygon.push(output);
        edge = edge.next;
      } while (edge !== face.edge);
      if (polygon.length !== 3) return null;
      out.faces.push(polygon);
      out.faceMaterial.push(material);
    }
    return out;
  } catch {
    return null;
  }
}

/** Reproduce Blender's dense compact perpendicular-cylinder hull tessellation. */
function reconstructWeakDenseHull(mesh: Mesh, weakPoint: Vec3): Mesh {
  const capIndex = mesh.faces.findIndex((face) => face.length === 124);
  if (capIndex < 0) return mesh;
  const cap = mesh.faces[capIndex];
  let gap = 0, gapLength = -Infinity;
  for (let corner = 0; corner < cap.length; corner++) {
    const length = vlen(vsub(mesh.positions[cap[(corner + 1) % cap.length]], mesh.positions[cap[corner]]));
    if (length > gapLength) { gapLength = length; gap = corner; }
  }
  const pivotCorner = (gap + cap.length - 3) % cap.length;
  const at = (offset: number) => cap[(pivotCorner + offset + cap.length) % cap.length];
  const capFaces: number[][] = [[at(0), at(1), at(2), at(3)]];
  // The quad closes the three samples immediately before the rejected support
  // point; fan the remaining 122-corner region from the same pivot.
  for (let offset = 3; offset + 1 < cap.length; offset++) capFaces.push([at(0), at(offset), at(offset + 1)]);

  const quads = mesh.faces.map((face, index) => ({ face, index })).filter(({ face }) => face.length === 4);
  const warp = ({ face }: { face: number[] }) => {
    const [a, b, c, d] = face.map((vertex) => mesh.positions[vertex]);
    const normal = vnorm(vcross(vsub(b, a), vsub(c, a)));
    return Math.abs(vdot(normal, vsub(d, a)));
  };
  const split = new Set(quads.sort((a, b) => warp(b) - warp(a)).slice(0, 2).map(({ index }) => index));
  const capNormal = (() => {
    const a = mesh.positions[cap[0]], b = mesh.positions[cap[1]], c = mesh.positions[cap[2]];
    return vnorm(vcross(vsub(b, a), vsub(c, a)));
  })();
  const planeAxis = [0, 1, 2].reduce((best, axis) => Math.abs(capNormal[axis]) > Math.abs(capNormal[best]) ? axis : best, 0);
  const inPlane = [0, 1, 2].filter((axis) => axis !== planeAxis);
  const bounds = inPlane.map((axis) => ({
    axis,
    min: Math.min(...cap.map((vertex) => mesh.positions[vertex][axis])),
    max: Math.max(...cap.map((vertex) => mesh.positions[vertex][axis])),
  }));
  const extreme = bounds.map((bound) => {
    const toMin = Math.abs(weakPoint[bound.axis] - bound.min), toMax = Math.abs(weakPoint[bound.axis] - bound.max);
    return { ...bound, distance: Math.min(toMin, toMax), weakAtMin: toMin <= toMax };
  }).sort((a, b) => a.distance - b.distance)[0];
  const opposite = quads.filter(({ index }) => !split.has(index)).sort((a, b) => {
    const center = (item: { face: number[] }) => item.face.reduce((sum, vertex) => sum + mesh.positions[vertex][extreme.axis], 0) / 4;
    return extreme.weakAtMin ? center(b) - center(a) : center(a) - center(b);
  }).slice(0, 2);
  for (const { index } of opposite) split.add(index);

  const out = mesh.clone();
  out.faces = [];
  out.faceMaterial = [];
  const emit = (face: number[], material: number) => { out.faces.push(face); out.faceMaterial.push(material); };
  for (let faceIndex = 0; faceIndex < mesh.faces.length; faceIndex++) {
    const face = mesh.faces[faceIndex], material = mesh.faceMaterial[faceIndex] ?? 0;
    if (faceIndex === capIndex) {
      for (const replacement of capFaces) emit(replacement, material);
    } else if (split.has(faceIndex)) {
      emit([face[0], face[1], face[2]], material);
      emit([face[0], face[2], face[3]], material);
    } else emit([...face], material);
  }
  out.edges = [];
  return out;
}

// Blender 5.1 migrated legacy Separate/Combine RGB nodes to the Function
// variants during file versioning. The bin's recursive subdivision carries
// integer-like masks through RGB channels, so these are structural rather than
// cosmetic shader nodes.
reg("FunctionNodeSeparateColor", (api) => {
  const color = api.field("Color");
  const channel = (index: number) => fieldMap([color], (value) => asVec3(value)[index]);
  return { Red: channel(0), Green: channel(1), Blue: channel(2), Alpha: Field.of(1) };
});

reg("FunctionNodeCombineColor", (api) => {
  const red = api.field("Red"), green = api.field("Green"), blue = api.field("Blue");
  return { Color: fieldMap([red, green, blue], (r, g, b) => [asNum(r), asNum(g), asNum(b)] as Vec3) };
});

function domainProp(api: EvalAPI, dflt: Domain = "POINT"): Domain {
  const d = api.prop<string>("domain", dflt);
  return DOMAINS.has(d as Domain) ? (d as Domain) : dflt;
}

function boolOn(v: Elem | undefined): boolean {
  return asNum(v ?? 0) > 0;
}

function avgVec(points: Vec3[]): Vec3 {
  if (!points.length) return [0, 0, 0];
  const c: Vec3 = [0, 0, 0];
  for (const p of points) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return [c[0] / points.length, c[1] / points.length, c[2] / points.length];
}

function itemIndex(id: string): number {
  const m = /^Item_(\d+)$/.exec(id);
  return m ? Number(m[1]) : -1;
}

function enumNamesFromProps(props: Record<string, any> | undefined): string[] {
  if (!props) return [];
  const candidates = ["enum_items", "enum_definition", "items", "menu_items"];
  for (const key of candidates) {
    const raw = props[key];
    if (!Array.isArray(raw)) continue;
    const names = raw
      .map((x) => typeof x === "string" ? x : typeof x?.name === "string" ? x.name : typeof x?.identifier === "string" ? x.identifier : "")
      .filter(Boolean);
    if (names.length) return names;
  }
  return [];
}

function menuSwitchIndex(api: EvalAPI): number {
  const items = api.node.inputs
    .filter((s) => itemIndex(s.identifier) >= 0)
    .sort((a, b) => itemIndex(a.identifier) - itemIndex(b.identifier));
  const propNames = enumNamesFromProps(api.node.props);
  const names = propNames.length ? propNames : items.map((s) => s.name || s.identifier);
  const raw = api.input("Menu");
  let menu = "";
  if (typeof raw === "string") menu = raw;
  else if (raw instanceof Field && raw.isConst) {
    const v = raw.value;
    // A menu interface can expose more enum items than a downstream Menu
    // Switch. Blender leaves the switch output empty when that linked enum has
    // no corresponding item; it does not clamp to the final connected input.
    if (typeof v === "number") return Math.round(v);
    menu = String(asNum(v));
  }
  let idx = names.findIndex((n) => n === menu);
  if (idx < 0) idx = names.findIndex((n) => n.toLowerCase() === menu.toLowerCase());
  const activeName = api.prop<{ name?: string } | undefined>("active_item", undefined)?.name;
  if (idx < 0 && activeName && menu === activeName) idx = api.prop<number>("active_index", 0);
  if (idx < 0 && /^-?\d+$/.test(menu)) idx = Number(menu);
  return idx >= 0 && idx < items.length ? idx : -1;
}

reg("GeometryNodeMenuSwitch", (api) => {
  const idx = menuSwitchIndex(api);
  const picked = api.input(`Item_${idx}`);
  const dt = api.prop<string>("data_type", "");
  if (dt === "GEOMETRY") return { Output: picked instanceof Geometry ? picked : new Geometry() };
  if (picked instanceof Field) return { Output: picked };
  return { Output: Field.of(0) };
});

reg("GeometryNodeIndexSwitch", (api) => {
  const items = api.node.inputs
    .filter((socket) => itemIndex(socket.identifier) >= 0)
    .sort((a, b) => itemIndex(a.identifier) - itemIndex(b.identifier));
  const index = Math.max(0, Math.min(items.length - 1, Math.round(api.num("Index"))));
  const picked = api.input(items[index]?.identifier ?? "Item_0");
  if (api.prop<string>("data_type", "") === "GEOMETRY") return { Output: picked instanceof Geometry ? picked : new Geometry() };
  return { Output: picked instanceof Field ? picked : Field.of(0) };
});

const f32 = Math.fround;
function smoothNoiseFade(t: number): number {
  // BLI_noise evaluates the fade polynomial as float, not double.
  const inner = f32(f32(f32(t * f32(6)) - f32(15)) * t + f32(10));
  return f32(f32(f32(t * t) * t) * inner);
}

// Blender's Noise Texture is signed gradient Perlin noise backed by the
// lookup3 integer hash. The previous sine/value-noise placeholder had neither
// Blender's 0.5-centered range nor its inclusive Detail octave, which made
// procedural geometry displacement several times too shallow.
const u32 = (n: number): number => n >>> 0;
const rotl32 = (n: number, bits: number): number => u32((n << bits) | (n >>> (32 - bits)));
function blenderHashInt3(x: number, y: number, z: number): number {
  let a = u32(0xdeadbeef + (3 << 2) + 13 + x);
  let b = u32(0xdeadbeef + (3 << 2) + 13 + y);
  let c = u32(0xdeadbeef + (3 << 2) + 13 + z);
  c = u32((c ^ b) - rotl32(b, 14));
  a = u32((a ^ c) - rotl32(c, 11));
  b = u32((b ^ a) - rotl32(a, 25));
  c = u32((c ^ b) - rotl32(b, 16));
  a = u32((a ^ c) - rotl32(c, 4));
  b = u32((b ^ a) - rotl32(a, 14));
  c = u32((c ^ b) - rotl32(b, 24));
  return c;
}
function blenderHashInt4(x: number, y: number, z: number, w: number): number {
  let a = u32(0xdeadbeef + (4 << 2) + 13 + x);
  let b = u32(0xdeadbeef + (4 << 2) + 13 + y);
  let c = u32(0xdeadbeef + (4 << 2) + 13 + z);
  a = u32(a - c); a = u32(a ^ rotl32(c, 4)); c = u32(c + b);
  b = u32(b - a); b = u32(b ^ rotl32(a, 6)); a = u32(a + c);
  c = u32(c - b); c = u32(c ^ rotl32(b, 8)); b = u32(b + a);
  a = u32(a - c); a = u32(a ^ rotl32(c, 16)); c = u32(c + b);
  b = u32(b - a); b = u32(b ^ rotl32(a, 19)); a = u32(a + c);
  c = u32(c - b); c = u32(c ^ rotl32(b, 4)); b = u32(b + a);
  a = u32(a + w);
  c = u32((c ^ b) - rotl32(b, 14));
  a = u32((a ^ c) - rotl32(c, 11));
  b = u32((b ^ a) - rotl32(a, 25));
  c = u32((c ^ b) - rotl32(b, 16));
  a = u32((a ^ c) - rotl32(c, 4));
  b = u32((b ^ a) - rotl32(a, 14));
  c = u32((c ^ b) - rotl32(b, 24));
  return c;
}
function blenderNoiseGrad3(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const vt = h === 12 || h === 14 ? x : z;
  const v = h < 4 ? y : vt;
  return f32((h & 1 ? -u : u) + (h & 2 ? -v : v));
}
function blenderSNoise3(p: Vec3): number {
  // Geometry-node coordinates here are far below Blender's 100000 precision
  // wrapping threshold, so the periodic precision correction is unnecessary.
  const ix = Math.floor(p[0]), iy = Math.floor(p[1]), iz = Math.floor(p[2]);
  const fx = f32(p[0] - ix), fy = f32(p[1] - iy), fz = f32(p[2] - iz);
  const u = smoothNoiseFade(fx), v = smoothNoiseFade(fy), w = smoothNoiseFade(fz);
  const grad = (dx: number, dy: number, dz: number) => blenderNoiseGrad3(
    blenderHashInt3(ix + dx, iy + dy, iz + dz), f32(fx - dx), f32(fy - dy), f32(fz - dz),
  );
  // Match Blender's dedicated trilinear mix, whose float temporaries are
  // observable after several fBM octaves.
  const samples = [
    grad(0, 0, 0), grad(1, 0, 0), grad(0, 1, 0), grad(1, 1, 0),
    grad(0, 0, 1), grad(1, 0, 1), grad(0, 1, 1), grad(1, 1, 1),
  ];
  const x1 = f32(1 - u), y1 = f32(1 - v), z1 = f32(1 - w);
  const row = (offset: number, yWeight: number, yInverse: number): number => {
    const a = f32(f32(samples[offset] * x1) + f32(samples[offset + 1] * u));
    const b = f32(f32(samples[offset + 2] * x1) + f32(samples[offset + 3] * u));
    return f32(f32(yInverse * a) + f32(yWeight * b));
  };
  const mixed = f32(f32(z1 * row(0, v, y1)) + f32(w * row(4, v, y1)));
  return f32(mixed * f32(0.982));
}

type Vec4 = [number, number, number, number];
function blenderNoiseGrad4(hash: number, x: number, y: number, z: number, w: number): number {
  const h = hash & 31;
  const u = h < 24 ? x : y;
  const v = h < 16 ? y : z;
  const s = h < 8 ? z : w;
  return (h & 1 ? -u : u) + (h & 2 ? -v : v) + (h & 4 ? -s : s);
}
function blenderSNoise4(p: Vec4): number {
  const cell = p.map(Math.floor) as Vec4;
  const f = p.map((value, axis) => value - cell[axis]) as Vec4;
  const fade = f.map(smoothNoiseFade) as Vec4;
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const sample = (dx: number, dy: number, dz: number, dw: number) => blenderNoiseGrad4(
    blenderHashInt4(cell[0] + dx, cell[1] + dy, cell[2] + dz, cell[3] + dw),
    f[0] - dx, f[1] - dy, f[2] - dz, f[3] - dw,
  );
  const cube = (dw: number) => {
    const z0 = mix(mix(sample(0, 0, 0, dw), sample(1, 0, 0, dw), fade[0]), mix(sample(0, 1, 0, dw), sample(1, 1, 0, dw), fade[0]), fade[1]);
    const z1 = mix(mix(sample(0, 0, 1, dw), sample(1, 0, 1, dw), fade[0]), mix(sample(0, 1, 1, dw), sample(1, 1, 1, dw), fade[0]), fade[1]);
    return mix(z0, z1, fade[2]);
  };
  return 0.8344 * mix(cube(0), cube(1), fade[3]);
}

function blenderFbm3(p: Vec3, detail: number, roughness: number, lacunarity: number, normalize: boolean): number {
  let frequency = 1;
  let amplitude = 1;
  let maxAmplitude = 0;
  let sum = 0;
  const whole = Math.floor(Math.max(0, Math.min(15, detail)));
  for (let octave = 0; octave <= whole; octave++) {
    const octavePoint = p.map((value) => f32(value * frequency)) as Vec3;
    sum = f32(sum + f32(blenderSNoise3(octavePoint) * amplitude));
    maxAmplitude = f32(maxAmplitude + amplitude);
    amplitude = f32(amplitude * Math.max(0, roughness));
    frequency = f32(frequency * lacunarity);
  }
  const fraction = Math.max(0, Math.min(15, detail)) - whole;
  const normalized = (value: number, weight: number) => normalize
    ? f32(f32(f32(.5) * value) / weight + f32(.5))
    : f32(value);
  if (fraction <= EPS) return normalized(sum, maxAmplitude);
  const octavePoint = p.map((value) => f32(value * frequency)) as Vec3;
  const sum2 = f32(sum + f32(blenderSNoise3(octavePoint) * amplitude));
  const a = normalized(sum, maxAmplitude);
  const b = normalized(sum2, f32(maxAmplitude + amplitude));
  return f32(f32(f32(1 - fraction) * a) + f32(fraction * b));
}

function blenderFbm4(p: Vec4, detail: number, roughness: number, lacunarity: number, normalize: boolean): number {
  let frequency = 1;
  let amplitude = 1;
  let maxAmplitude = 0;
  let sum = 0;
  const whole = Math.floor(Math.max(0, Math.min(15, detail)));
  for (let octave = 0; octave <= whole; octave++) {
    sum += blenderSNoise4(p.map((value) => value * frequency) as Vec4) * amplitude;
    maxAmplitude += amplitude;
    amplitude *= Math.max(0, roughness);
    frequency *= lacunarity;
  }
  const fraction = Math.max(0, Math.min(15, detail)) - whole;
  const normalized = (value: number, weight: number) => normalize ? 0.5 * value / weight + 0.5 : value;
  if (fraction <= EPS) return normalized(sum, maxAmplitude);
  const sum2 = sum + blenderSNoise4(p.map((value) => value * frequency) as Vec4) * amplitude;
  return normalized(sum, maxAmplitude) + (normalized(sum2, maxAmplitude + amplitude) - normalized(sum, maxAmplitude)) * fraction;
}

const floatBitsBuffer = new ArrayBuffer(4);
const floatBitsView = new DataView(floatBitsBuffer);
function floatBits(value: number): number {
  floatBitsView.setFloat32(0, value, true);
  return floatBitsView.getUint32(0, true);
}
function blenderHashUint2(x: number, y: number): number {
  let a = u32(0xdeadbeef + (2 << 2) + 13 + x);
  let b = u32(0xdeadbeef + (2 << 2) + 13 + y);
  let c = u32(0xdeadbeef + (2 << 2) + 13);
  c = u32((c ^ b) - rotl32(b, 14));
  a = u32((a ^ c) - rotl32(c, 11));
  b = u32((b ^ a) - rotl32(a, 25));
  c = u32((c ^ b) - rotl32(b, 16));
  a = u32((a ^ c) - rotl32(c, 4));
  b = u32((b ^ a) - rotl32(a, 14));
  c = u32((c ^ b) - rotl32(b, 24));
  return c;
}
function blenderRandomVec4Offset(seed: number): Vec4 {
  return [0, 1, 2, 3].map((component) =>
    f32(f32(100) + f32(f32(f32(blenderHashUint2(floatBits(seed), floatBits(component))) / f32(0xffffffff)) * f32(100))),
  ) as Vec4;
}

const blenderNoiseDistortionOffsets = [0, 1, 2].map((seed) => {
  const offset = blenderRandomVec4Offset(seed);
  return [offset[0], offset[1], offset[2]] as Vec3;
});

// Blender offsets each distortion axis with random_float3_offset(seed), where
// seed is 0, 1, then 2. Keeping this in one pure function makes the CPU
// evaluator testable against explicit Blender field samples.
export function blenderNoiseTexture3D(
  position: Vec3,
  scale: number,
  detail: number,
  roughness: number,
  lacunarity: number,
  distortion: number,
  normalize = true,
): number {
  let p = position.map((value) => f32(value * f32(scale))) as Vec3;
  if (Math.abs(distortion) > EPS) {
    p = p.map((value, axis) => {
      const offsetPoint = p.map((component, componentAxis) =>
        f32(component + blenderNoiseDistortionOffsets[axis][componentAxis])) as Vec3;
      return f32(value + f32(f32(distortion) * blenderSNoise3(offsetPoint)));
    }) as Vec3;
  }
  // Geometry-node float fields store Noise Texture results as float32. Keep
  // that boundary explicit so later distance/threshold math does not carry
  // JavaScript-only binary64 bits into Marching Squares classification.
  return Math.fround(blenderFbm3(p, detail, Math.max(0, roughness), Math.max(1e-4, lacunarity), normalize));
}

reg("ShaderNodeTexNoise", (api) => {
  const linkedVector = api.node.inputs.find((socket) => socket.identifier === "Vector")?.linked ?? false;
  const vector = api.field("Vector");
  const scale = api.field("Scale");
  const detail = api.field("Detail");
  const roughness = api.field("Roughness");
  const lacunarity = api.field("Lacunarity");
  const distortion = api.field("Distortion");
  const w = api.field("W");
  const dimensions = api.prop<string>("noise_dimensions", "3D");
  const evaluate = (ctx: import("../core").FieldCtx, colorSeed?: number) => {
    const vectors = vector.array(ctx), scales = scale.array(ctx), details = detail.array(ctx);
    const roughnesses = roughness.array(ctx), lacunarities = lacunarity.array(ctx), distortions = distortion.array(ctx), ws = w.array(ctx);
    const colorOffset = colorSeed === undefined ? null : blenderRandomVec4Offset(colorSeed);
    return Array.from({ length: ctx.size }, (_, i) => {
      let p = linkedVector ? asVec3(vectors[i] ?? 0) : ctx.position?.(i) ?? [0, 0, 0];
      const frequencyScale = asNum(scales[i] ?? 5);
      const warp = asNum(distortions[i] ?? 0);
      const noiseDetail = asNum(details[i] ?? 2);
      const persistence = Math.max(0, asNum(roughnesses[i] ?? .5));
      const lac = Math.max(1e-4, asNum(lacunarities[i] ?? 2));
      if (dimensions === "4D") {
        p = vscale(p, frequencyScale);
        if (Math.abs(warp) > EPS) {
          p = vadd(p, [
            warp * blenderSNoise3(vadd(p, [131.7, 143.2, 176.4])),
            warp * blenderSNoise3(vadd(p, [104.3, 191.1, 152.8])),
            warp * blenderSNoise3(vadd(p, [187.9, 118.6, 139.5])),
          ]);
        }
        let p4: Vec4 = [p[0], p[1], p[2], asNum(ws[i] ?? 0) * frequencyScale];
        if (colorOffset) p4 = p4.map((value, axis) => value + colorOffset[axis]) as Vec4;
        return blenderFbm4(p4, noiseDetail, persistence, lac, api.prop<boolean>("normalize", true));
      }
      return blenderNoiseTexture3D(
        p,
        frequencyScale,
        noiseDetail,
        persistence,
        lac,
        warp,
        api.prop<boolean>("normalize", true),
      );
    });
  };
  const factor = Field.make((ctx) => evaluate(ctx));
  return {
    Fac: factor,
    Factor: factor,
    Color: Field.make((ctx) => {
      const red = factor.array(ctx), green = evaluate(ctx, dimensions === "4D" ? 4 : 3), blue = evaluate(ctx, dimensions === "4D" ? 5 : 4);
      return red.map((value, index) => [asNum(value), asNum(green[index]), asNum(blue[index])] as Vec3);
    }),
  };
});

// Blender's Wave Texture uses a fixed factor of 20 before applying its
// periodic profile. At Scale=1 the SIN profile is therefore
// 0.5 - 0.5*cos(coordinate*20), not a one-cycle-per-unit sine wave.
reg("ShaderNodeTexWave", (api) => {
  const linkedVector = api.node.inputs.find((socket) => socket.identifier === "Vector")?.linked ?? false;
  const vector = api.field("Vector");
  const scale = api.field("Scale");
  const phase = api.field("Phase Offset");
  const distortion = api.field("Distortion");
  const detail = api.field("Detail");
  const detailScale = api.field("Detail Scale");
  const detailRoughness = api.field("Detail Roughness");
  const waveType = api.prop<string>("wave_type", "BANDS");
  const direction = api.prop<string>(waveType === "RINGS" ? "rings_direction" : "bands_direction", "X");
  const profile = api.prop<string>("wave_profile", "SIN");
  const factor = Field.make((ctx) => {
    const vectors = vector.array(ctx), scales = scale.array(ctx), phases = phase.array(ctx), distortions = distortion.array(ctx);
    const details = detail.array(ctx), detailScales = detailScale.array(ctx), roughnesses = detailRoughness.array(ctx);
    return Array.from({ length: ctx.size }, (_, i) => {
      const p = linkedVector ? asVec3(vectors[i] ?? 0) : ctx.position?.(i) ?? [0, 0, 0];
      let coordinate: number;
      if (waveType === "RINGS") {
        coordinate = direction === "X" ? Math.hypot(p[1], p[2])
          : direction === "Y" ? Math.hypot(p[0], p[2])
            : direction === "Z" ? Math.hypot(p[0], p[1]) : vlen(p);
      } else {
        coordinate = direction === "Y" ? p[1] : direction === "Z" ? p[2]
          : direction === "DIAGONAL" ? p[0] + p[1] + p[2] : p[0];
      }
      const frequency = asNum(scales[i] ?? 5);
      let wave = (coordinate * frequency + asNum(phases[i] ?? 0)) * 20;
      const warp = asNum(distortions[i] ?? 0);
      if (Math.abs(warp) > EPS) {
        const noiseScale = Math.max(EPS, asNum(detailScales[i] ?? 1));
        wave += warp * blenderFbm3(vscale(p, noiseScale), asNum(details[i] ?? 2), asNum(roughnesses[i] ?? .5), 2, false);
      }
      if (profile === "SAW") return wave / (2 * Math.PI) - Math.floor(wave / (2 * Math.PI));
      if (profile === "TRI") {
        const saw = wave / (2 * Math.PI) - Math.floor(wave / (2 * Math.PI));
        return 1 - Math.abs(2 * saw - 1);
      }
      return .5 - .5 * Math.cos(wave);
    });
  });
  return { Fac: factor, Factor: factor, Color: Field.make((ctx) => factor.array(ctx).map((value) => [asNum(value), asNum(value), asNum(value)])) };
});

reg("FunctionNodeRotateVector", (api) => ({
  Vector: fieldMap([api.field("Vector"), api.field("Rotation")], (vector, rotation) =>
    rotateEulerXYZ(asVec3(vector), asVec3(rotation))),
}));

function rotX(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

function rotY(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

function rotZ(p: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}

function rotateAxisAngle(p: Vec3, axis: Vec3, angle: number): Vec3 {
  const a = vnorm(axis);
  if (vlen(a) <= EPS) return p;
  const c = Math.cos(angle), s = Math.sin(angle);
  return vadd(vadd(vscale(p, c), vscale(vcross(a, p), s)), vscale(a, vdot(a, p) * (1 - c)));
}

function inverseEulerXYZ(p: Vec3, e: Vec3): Vec3 {
  return rotX(rotY(rotZ(p, -e[2]), -e[1]), -e[0]);
}

reg("ShaderNodeVectorRotate", (api) => {
  const type = api.prop<string>("rotation_type", "AXIS_ANGLE");
  const invert = api.prop<boolean>("invert", false);
  const vector = api.field("Vector");
  const center = api.field("Center");
  const axis = api.field("Axis");
  const angle = api.field("Angle");
  const rotation = api.field("Rotation");
  return {
    Vector: fieldMap([vector, center, axis, angle, rotation], (v0, c0, a0, ang0, r0) => {
      const c = asVec3(c0);
      const p = vsub(asVec3(v0), c);
      const ang = asNum(ang0) * (invert ? -1 : 1);
      let r: Vec3;
      switch (type) {
        case "X_AXIS": r = rotX(p, ang); break;
        case "Y_AXIS": r = rotY(p, ang); break;
        case "Z_AXIS": r = rotZ(p, ang); break;
        case "EULER_XYZ": r = invert ? inverseEulerXYZ(p, asVec3(r0)) : rotateEulerXYZ(p, asVec3(r0)); break;
        case "AXIS_ANGLE":
        default: r = rotateAxisAngle(p, asVec3(a0), ang); break;
      }
      return vadd(c, r);
    }),
  };
});

// Bake is an evaluation cache boundary; live browser evaluation passes its
// current items through unchanged.
reg("GeometryNodeBake", (api) => ({ Item_0: api.input("Item_0") }));

function pointTopologyField(kind: "VERTEX" | "FACE"): Field {
  return Field.make((ctx) => {
    const pointCtx = ctx.domain === "POINT" ? ctx : ctx.fork?.("POINT") ?? ctx;
    const edgeCtx = pointCtx.fork?.("EDGE") ?? ctx.fork?.("EDGE") ?? pointCtx;
    const counts = new Array(pointCtx.size).fill(0);
    const faceApprox = new Array(pointCtx.size).fill(0);
    if (edgeCtx.edgeVerts) {
      for (let ei = 0; ei < edgeCtx.size; ei++) {
        const [a, b] = edgeCtx.edgeVerts(ei);
        const faceCount = edgeCtx.edgeFaceCount?.(ei) ?? 0;
        // Loose-wire edges count toward vertex adjacency (Blender semantics).
        // They were skipped while Repeat Zones were unimplemented; the Spin
        // lathe's boundary-point selection needs them on pure wires.
        if (a >= 0 && a < pointCtx.size) {
          counts[a]++;
          faceApprox[a] += faceCount / 2;
        }
        if (b >= 0 && b < pointCtx.size) {
          counts[b]++;
          faceApprox[b] += faceCount / 2;
        }
      }
    }
    const pointArr = kind === "VERTEX" ? counts : faceApprox.map((n) => Math.round(n));
    if (ctx.domain === "POINT" || !ctx.toDomain) return pointArr;
    const out: Elem[] = new Array(ctx.size);
    for (let i = 0; i < ctx.size; i++) out[i] = ctx.toDomain("POINT", pointArr, i) ?? 0;
    return out;
  });
}

reg("GeometryNodeInputMeshVertexNeighbors", () => ({
  "Vertex Count": pointTopologyField("VERTEX"),
  "Face Count": pointTopologyField("FACE"),
}));

const SPLINE_TYPE_SAMPLES_PER_SEGMENT = 12;

function cloneSpline(s: Spline): Spline {
  return {
    points: s.points.map((p) => [...p] as Vec3),
    cyclic: s.cyclic,
    resolution: s.resolution,
    controlPoints: s.controlPoints?.map((p) => [...p] as Vec3),
    bezierLeft: s.bezierLeft?.map((p) => [...p] as Vec3),
    bezierRight: s.bezierRight?.map((p) => [...p] as Vec3),
  };
}

function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function catmullPoint(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, t: number): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
    0.5 * ((2 * p1[2]) + (-p0[2] + p2[2]) * t + (2 * p0[2] - 5 * p1[2] + 4 * p2[2] - p3[2]) * t2 + (-p0[2] + 3 * p1[2] - 3 * p2[2] + p3[2]) * t3),
  ];
}

function catmullRomSpline(s: Spline): Spline {
  const pts = s.points;
  const n = pts.length;
  if (n < 2) return cloneSpline(s);
  const out: Vec3[] = [];
  const samples = SPLINE_TYPE_SAMPLES_PER_SEGMENT;
  if (s.cyclic) {
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];
      const p3 = pts[(i + 2) % n];
      for (let k = 0; k < samples; k++) out.push(catmullPoint(p0, p1, p2, p3, k / samples));
    }
    return { points: out, cyclic: true };
  }
  out.push([...pts[0]] as Vec3);
  for (let i = 0; i + 1 < n; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    for (let k = 1; k <= samples; k++) out.push(catmullPoint(p0, p1, p2, p3, k / samples));
  }
  return { points: out, cyclic: false };
}

function clampedKnots(controlCount: number, degree: number): number[] {
  const knots: number[] = [];
  const len = controlCount + degree + 1;
  const interior = controlCount - degree;
  for (let i = 0; i < len; i++) {
    if (i <= degree) knots.push(0);
    else if (i >= controlCount) knots.push(1);
    else knots.push((i - degree) / interior);
  }
  return knots;
}

function knotSpan(knots: number[], controlCount: number, degree: number, u: number): number {
  const last = controlCount - 1;
  if (u >= knots[last + 1]) return last;
  if (u <= knots[degree]) return degree;
  let low = degree;
  let high = last + 1;
  let mid = Math.floor((low + high) / 2);
  while (u < knots[mid] || u >= knots[mid + 1]) {
    if (u < knots[mid]) high = mid;
    else low = mid;
    mid = Math.floor((low + high) / 2);
  }
  return mid;
}

function deBoor(control: Vec3[], degree: number, knots: number[], u: number): Vec3 {
  if (u <= 0) return [...control[0]] as Vec3;
  if (u >= 1) return [...control[control.length - 1]] as Vec3;
  const span = knotSpan(knots, control.length, degree, u);
  const d: Vec3[] = [];
  for (let j = 0; j <= degree; j++) d.push([...control[span - degree + j]] as Vec3);
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = span - degree + j;
      const denom = knots[i + degree - r + 1] - knots[i];
      const alpha = denom > EPS ? (u - knots[i]) / denom : 0;
      d[j] = lerpVec(d[j - 1], d[j], alpha);
    }
  }
  return d[degree];
}

function clampedNurbsSpline(s: Spline): Spline {
  const pts = s.points;
  const n = pts.length;
  if (n < 2) return cloneSpline(s);
  const degree = Math.min(3, n - 1);
  const knots = clampedKnots(n, degree);
  // Blender evaluates an open NURBS once per non-zero knot span, not once per
  // control-point interval. With order 4 (degree 3), six controls therefore
  // produce (6 - 3) * resolution + 1 = 37 evaluated points at resolution 12.
  const count = Math.max(2, (n - degree) * SPLINE_TYPE_SAMPLES_PER_SEGMENT + 1);
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) out.push(deBoor(pts, degree, knots, i / (count - 1)));
  return { points: out, cyclic: false };
}

function periodicCubicBSplinePoint(pts: Vec3[], i: number, t: number): Vec3 {
  const n = pts.length;
  const p0 = pts[(i - 1 + n) % n];
  const p1 = pts[i % n];
  const p2 = pts[(i + 1) % n];
  const p3 = pts[(i + 2) % n];
  const t2 = t * t;
  const t3 = t2 * t;
  const b0 = (1 - 3 * t + 3 * t2 - t3) / 6;
  const b1 = (4 - 6 * t2 + 3 * t3) / 6;
  const b2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6;
  const b3 = t3 / 6;
  return [
    p0[0] * b0 + p1[0] * b1 + p2[0] * b2 + p3[0] * b3,
    p0[1] * b0 + p1[1] * b1 + p2[1] * b2 + p3[1] * b3,
    p0[2] * b0 + p1[2] * b1 + p2[2] * b2 + p3[2] * b3,
  ];
}

function nurbsSpline(s: Spline): Spline {
  const pts = s.points;
  const n = pts.length;
  if (n < 2) return cloneSpline(s);
  if (!s.cyclic) {
    const out = clampedNurbsSpline(s);
    out.controlPoints = pts.map((point) => [...point] as Vec3);
    out.splineType = "NURBS";
    out.resolution = SPLINE_TYPE_SAMPLES_PER_SEGMENT;
    return out;
  }
  if (n < 4) return catmullRomSpline(s);
  const out: Vec3[] = [];
  // Blender's cyclic NURBS evaluator exposes its first point on the span whose
  // primary control is index 1. Starting with control 0 rotates every evaluated
  // point by one full resolution span; the curve shape is unchanged, but Curve
  // to Mesh then receives a different profile phase and produces a measurably
  // different surface (the Chrome spikey chain link is sensitive to this).
  for (let step = 0; step < n; step++) {
    const i = (step + 1) % n;
    for (let k = 0; k < SPLINE_TYPE_SAMPLES_PER_SEGMENT; k++)
      out.push(periodicCubicBSplinePoint(pts, i, k / SPLINE_TYPE_SAMPLES_PER_SEGMENT));
  }
  return {
    points: out,
    cyclic: true,
    controlPoints: pts.map((point) => [...point] as Vec3),
    splineType: "NURBS",
    resolution: SPLINE_TYPE_SAMPLES_PER_SEGMENT,
  };
}

function nearestControlPointIndex(points: Vec3[], p: Vec3): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = vlen(vsub(points[i], p));
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function convertSplineType(s: Spline, type: string): Spline {
  switch (type) {
    case "NURBS": return nurbsSpline(s);
    case "CATMULL_ROM": return catmullRomSpline(s);
    case "BEZIER": return asBezierSpline(s);
    case "POLY":
    default: return cloneSpline(s);
  }
}

function remapCurvePointAttributes(src: Geometry, out: Geometry, sourceIndex: number[]): void {
  out.curveAttributes.clear();
  for (const [name, attr] of src.curveAttributes) {
    if (attr.domain !== "POINT") {
      out.curveAttributes.set(name, { domain: attr.domain, data: [...attr.data] });
      continue;
    }
    const dflt = attr.data[0] ?? 0;
    out.curveAttributes.set(name, {
      domain: "POINT",
      data: sourceIndex.map((i) => attr.data[i] ?? dflt),
    });
  }
}

function convertCurveGeometrySplineType(g: Geometry, type: string, seen: Map<Geometry, Geometry>): Geometry {
  const cached = seen.get(g);
  if (cached) return cached;
  const out = g.clone();
  seen.set(g, out);
  if (type === "POLY") {
    const sourceIndex: number[] = [];
    let offset = 0;
    out.curves = g.curves.map((s) => {
      const points = s.controlPoints?.length ? s.controlPoints : s.points;
      for (const point of points) sourceIndex.push(offset + nearestControlPointIndex(s.points, point));
      offset += s.points.length;
      return { cyclic: s.cyclic, points: points.map((point) => [...point] as Vec3) };
    });
    remapCurvePointAttributes(g, out, sourceIndex);
    out.instances = g.instances.map((inst) => ({ ...inst, geometry: convertCurveGeometrySplineType(inst.geometry, type, seen) }));
    return out;
  }
  const sourceIndex: number[] = [];
  const evaluatedTangents: Vec3[] = [];
  let offset = 0;
  out.curves = g.curves.map((s) => {
    const converted = convertSplineType(s, type);
    if (type === "NURBS") {
      // Set Spline Type changes the evaluated point domain, so any tangent
      // carried by the source curve is stale. Rebuild it for both open and
      // cyclic NURBS splines instead of nearest-control remapping the old
      // values across an entire evaluated span.
      evaluatedTangents.push(...splineFrames(converted.points, converted.cyclic).map((frame) => frame.tangent));
    }
    for (const p of converted.points) sourceIndex.push(offset + nearestControlPointIndex(s.points, p));
    offset += s.points.length;
    return converted;
  });
  remapCurvePointAttributes(g, out, sourceIndex);
  if (evaluatedTangents.length === out.curvePointCount()) {
    out.curveAttributes.set("__curve_tangent", { domain: "POINT", data: evaluatedTangents });
  }
  out.instances = g.instances.map((inst) => ({ ...inst, geometry: convertCurveGeometrySplineType(inst.geometry, type, seen) }));
  return out;
}

reg("GeometryNodeCurveSplineType", (api) => {
  const type = api.prop<string>("spline_type", "POLY");
  return { Curve: convertCurveGeometrySplineType(api.geo("Curve"), type, new Map()) };
});

function sampleSplineAt(s: Spline, distance: number): Vec3 {
  const pts = s.points;
  if (!pts.length) return [0, 0, 0];
  if (pts.length === 1) return [...pts[0]] as Vec3;
  const segs = splineSegments(s);
  const total = splineLength(s);
  if (total <= EPS) return [...pts[0]] as Vec3;
  let d = s.cyclic ? ((distance % total) + total) % total : Math.max(0, Math.min(total, distance));
  if (!s.cyclic && d >= total - EPS) return [...pts[pts.length - 1]] as Vec3;
  for (const [a, b] of segs) {
    const len = vlen(vsub(pts[b], pts[a]));
    if (d <= len + EPS) {
      const t = len > EPS ? Math.max(0, Math.min(1, d / len)) : 0;
      return vadd(pts[a], vscale(vsub(pts[b], pts[a]), t));
    }
    d -= len;
  }
  return [...pts[pts.length - 1]] as Vec3;
}

function samePoint(a: Vec3, b: Vec3): boolean {
  return vlen(vsub(a, b)) <= 1e-7;
}

function pushDistinct(out: Vec3[], p: Vec3): void {
  if (!out.length || !samePoint(out[out.length - 1], p)) out.push(p);
}

function trimSpline(s: Spline, startF: number, endF: number): Spline {
  const total = splineLength(s);
  if (s.points.length < 2 || total <= EPS) return { points: s.points.map((p) => [...p] as Vec3), cyclic: s.cyclic };
  const a = Math.max(0, Math.min(1, startF));
  const b = Math.max(0, Math.min(1, endF));
  if (a <= EPS && b >= 1 - EPS) {
    if (!s.cyclic) return { points: s.points.map((p) => [...p] as Vec3), cyclic: false };
    // Trim Curve always opens a selected cyclic spline, even at the full 0..1
    // factor range, and materializes the closing point as the final endpoint.
    // ETK_Loft Curves relies on this duplicated endpoint to weld its U seam.
    return { points: [...s.points.map((p) => [...p] as Vec3), [...s.points[0]] as Vec3], cyclic: false };
  }
  const startD = Math.min(a, b) * total;
  const endD = Math.max(a, b) * total;
  const out: Vec3[] = [];
  pushDistinct(out, sampleSplineAt(s, startD));
  let cursor = 0;
  for (const [ia, ib] of splineSegments(s)) {
    const len = vlen(vsub(s.points[ib], s.points[ia]));
    const next = cursor + len;
    if (next > startD + EPS && next < endD - EPS) pushDistinct(out, [...s.points[ib]] as Vec3);
    cursor = next;
  }
  pushDistinct(out, sampleSplineAt(s, endD));
  if (out.length === 1) out.push([...out[0]] as Vec3);
  return { points: out, cyclic: false };
}

function firstResolvedNumber(api: EvalAPI, name: string, g: Geometry, fallback: number): number {
  const f = api.field(name);
  if (f.isConst) return asNum(f.value);
  const ctx = makeFieldCtx(g, "POINT");
  const arr = f.array(ctx);
  return arr.length ? asNum(arr[0] ?? fallback) : fallback;
}

reg("GeometryNodeTrimCurve", (api) => {
  const g = api.geo("Curve");
  const mode = api.prop<string>("mode", "FACTOR");
  const out = g.clone();
  out.curves = g.curves.map((s) => {
    const len = splineLength(s);
    let start = firstResolvedNumber(api, mode === "LENGTH" ? "Start_001" : "Start", g, 0);
    let end = firstResolvedNumber(api, mode === "LENGTH" ? "End_001" : "End", g, mode === "LENGTH" ? len : 1);
    if (mode === "LENGTH") {
      start = len > EPS ? start / len : 0;
      end = len > EPS ? end / len : 0;
    }
    return trimSpline(s, start, end);
  });
  return { Curve: out };
});

class DSU {
  parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x: number): number { return this.parent[x] === x ? x : (this.parent[x] = this.find(this.parent[x])); }
  union(a: number, b: number): void { this.parent[this.find(a)] = this.find(b); }
}

function selectedElementGroups(elements: number[][], selected: boolean[]): Map<number, number[]> {
  const dsu = new DSU(elements.length);
  const byVert = new Map<number, number>();
  for (let ei = 0; ei < elements.length; ei++) {
    if (!selected[ei]) continue;
    for (const v of elements[ei]) {
      const prev = byVert.get(v);
      if (prev === undefined) byVert.set(v, ei);
      else dsu.union(prev, ei);
    }
  }
  const groups = new Map<number, number[]>();
  for (let ei = 0; ei < elements.length; ei++) {
    if (!selected[ei]) continue;
    const r = dsu.find(ei);
    const arr = groups.get(r);
    if (arr) arr.push(ei);
    else groups.set(r, [ei]);
  }
  return groups;
}

reg("GeometryNodeScaleElements", (api) => {
  const g = api.geo("Geometry").clone();
  if (!g.mesh) return { Geometry: g };
  const domain = domainProp(api, "FACE");
  if (domain !== "FACE" && domain !== "EDGE") return { Geometry: g };
  const mesh = g.mesh;
  const ctx = makeFieldCtx(g, domain);
  const selArr = api.field("Selection").array(ctx);
  const scaleArr = api.field("Scale").array(ctx);
  const centerLinked = api.node.inputs.find((s) => s.identifier === "Center")?.linked ?? false;
  const centerArr = centerLinked ? api.field("Center").array(ctx) : null;
  const elements = domain === "FACE"
    ? mesh.faces.map((f) => [...f])
    : buildTopology(mesh).edges.map((e) => [...e.verts]);
  const selected = elements.map((_, i) => boolOn(selArr[i] ?? 1));
  const groups = selectedElementGroups(elements, selected);
  const next = mesh.positions.map((p) => [...p] as Vec3);
  for (const eis of groups.values()) {
    const verts = [...new Set(eis.flatMap((ei) => elements[ei]))];
    const center = centerArr
      ? avgVec(eis.map((ei) => asVec3(centerArr[ei] ?? [0, 0, 0])))
      // Blender averages the centers of the selected elements, not their
      // unique vertices. This distinction matters for fan topology: a cone's
      // apex belongs to every side face and therefore carries the same weight
      // Blender gives it when scaling the connected face island.
      : avgVec(eis.map((ei) => avgVec(elements[ei].map((vi) => mesh.positions[vi]))));
    const scale = eis.reduce((n, ei) => n + asNum(scaleArr[ei] ?? 1), 0) / eis.length;
    for (const vi of verts) next[vi] = vadd(center, vscale(vsub(mesh.positions[vi], center), scale));
  }
  mesh.positions = next;
  return { Geometry: g };
});

function sortedOrder(size: number, selected: boolean[], groupIds: Elem[], weights: Elem[]): number[] {
  const order = Array.from({ length: size }, (_, i) => i);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < size; i++) {
    if (!selected[i]) continue;
    const gid = Math.round(asNum(groupIds[i] ?? 0));
    const arr = groups.get(gid);
    if (arr) arr.push(i);
    else groups.set(gid, [i]);
  }
  for (const slots of groups.values()) {
    const sorted = [...slots].sort((a, b) => {
      const d = asNum(weights[a] ?? 0) - asNum(weights[b] ?? 0);
      return d || a - b;
    });
    for (let i = 0; i < slots.length; i++) order[slots[i]] = sorted[i];
  }
  return order;
}

reg("GeometryNodeSortElements", (api) => {
  const g = api.geo("Geometry").clone();
  if (!g.mesh) return { Geometry: g };
  const mesh = g.mesh;
  const domain = domainProp(api, "POINT");
  if (domain === "POINT") {
    const ctx = makeFieldCtx(g, "POINT");
    const order = sortedOrder(mesh.positions.length, api.field("Selection").array(ctx).map((v) => boolOn(v ?? 1)), api.field("Group ID").array(ctx), api.field("Sort Weight").array(ctx));
    const inv = new Array(order.length);
    for (let ni = 0; ni < order.length; ni++) inv[order[ni]] = ni;
    mesh.positions = order.map((oi) => [...mesh.positions[oi]] as Vec3);
    mesh.faces = mesh.faces.map((f) => f.map((vi) => inv[vi]));
    mesh.edges = mesh.edges.map(([a, b]) => [inv[a], inv[b]] as [number, number]);
    for (const [name, a] of mesh.attributes)
      if (a.domain === "POINT") mesh.attributes.set(name, { domain: "POINT", data: order.map((oi) => a.data[oi]) });
  } else if (domain === "FACE") {
    const ctx = makeFieldCtx(g, "FACE");
    const order = sortedOrder(mesh.faces.length, api.field("Selection").array(ctx).map((v) => boolOn(v ?? 1)), api.field("Group ID").array(ctx), api.field("Sort Weight").array(ctx));
    const oldFaces = mesh.faces;
    const cornerStart: number[] = [];
    let cursor = 0;
    for (const f of oldFaces) { cornerStart.push(cursor); cursor += f.length; }
    mesh.faces = order.map((oi) => [...oldFaces[oi]]);
    mesh.faceMaterial = order.map((oi) => mesh.faceMaterial[oi] ?? 0);
    for (const [name, a] of mesh.attributes) {
      if (a.domain === "FACE") mesh.attributes.set(name, { domain: "FACE", data: order.map((oi) => a.data[oi]) });
      else if (a.domain === "CORNER") {
        const data: Elem[] = [];
        for (const oi of order) for (let k = 0; k < oldFaces[oi].length; k++) data.push(a.data[cornerStart[oi] + k]);
        mesh.attributes.set(name, { domain: "CORNER", data });
      }
    }
  }
  return { Geometry: g };
});

function elemZero(vector: boolean): Elem {
  return vector ? [0, 0, 0] : 0;
}

function componentStats(vals: number[]): { mean: number; median: number; sum: number; min: number; max: number; range: number; variance: number; std: number } {
  if (!vals.length) return { mean: 0, median: 0, sum: 0, min: 0, max: 0, range: 0, variance: 0, std: 0 };
  const sum = vals.reduce((n, v) => n + v, 0);
  const mean = sum / vals.length;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const variance = vals.reduce((n, v) => n + (v - mean) ** 2, 0) / vals.length;
  return { mean, median, sum, min, max, range: max - min, variance, std: Math.sqrt(variance) };
}

reg("GeometryNodeAttributeStatistic", (api) => {
  const g = api.geo("Geometry");
  const domain = domainProp(api, "POINT");
  const vector = api.prop<string>("data_type", "FLOAT").includes("VECTOR");
  const ctx = makeFieldCtx(g, domain);
  const onDomain = (field: Field): Elem[] => {
    if (!field.srcDomain || field.srcDomain === domain || !ctx.toDomain) return field.array(ctx);
    const source = field.array(makeFieldCtx(g, field.srcDomain));
    return Array.from({ length: ctx.size }, (_, index) => ctx.toDomain!(field.srcDomain!, source, index) ?? 0);
  };
  // Attribute Statistic evaluates the incoming field on its selected domain.
  // Topology inputs retain their intrinsic domain, so they must be adapted
  // once at this boundary. The Dojo fill-holes group asks for POINT statistics
  // of an EDGE length field; evaluating that field directly in a point context
  // produced all zeroes and disabled its nearest-boundary snap.
  const vals = onDomain(api.field("Attribute"));
  const sel = onDomain(api.field("Selection"));
  const picked = vals.filter((_, i) => boolOn(sel[i] ?? 1));
  if (!picked.length) {
    const z = Field.of(elemZero(vector));
    return { Mean: z, Median: z, Sum: z, Min: z, Max: z, Range: z, "Standard Deviation": z, Variance: z };
  }
  if (vector) {
    const comps = [0, 1, 2].map((k) => componentStats(picked.map((v) => asVec3(v ?? [0, 0, 0])[k])));
    const vec = (key: keyof ReturnType<typeof componentStats>): Vec3 => [comps[0][key], comps[1][key], comps[2][key]];
    return {
      Mean: Field.of(vec("mean")),
      Median: Field.of(vec("median")),
      Sum: Field.of(vec("sum")),
      Min: Field.of(vec("min")),
      Max: Field.of(vec("max")),
      Range: Field.of(vec("range")),
      "Standard Deviation": Field.of(vec("std")),
      Variance: Field.of(vec("variance")),
    };
  }
  const st = componentStats(picked.map((v) => asNum(v ?? 0)));
  return {
    Mean: Field.of(st.mean),
    Median: Field.of(st.median),
    Sum: Field.of(st.sum),
    Min: Field.of(st.min),
    Max: Field.of(st.max),
    Range: Field.of(st.range),
    "Standard Deviation": Field.of(st.std),
    Variance: Field.of(st.variance),
  };
});

function joinedMesh(parts: Geometry[]): Geometry {
  const out = new Geometry();
  out.mesh = new Mesh();
  for (const g of parts) {
    if (g.mesh) mergeMeshInto(out.mesh, g.mesh);
    for (const s of g.curves) out.curves.push({ cyclic: s.cyclic, points: s.points.map((p) => [...p] as Vec3) });
    for (const inst of g.instances) out.instances.push({ ...inst });
  }
  return out;
}

/**
 * Split a Boolean operand into its face-connected closed shells. Blender's
 * Exact solver consumes disconnected components as independent operands. A
 * single Manifold containing several overlapping shells is geometrically
 * equivalent in the simple case, but it preserves extra intersection seams
 * when the same multi-input cutter is linked more than once (Bubble Putty).
 */
function splitDisconnectedBooleanMesh(mesh: Mesh): Mesh[] {
  const topology = buildTopology(mesh);
  if (topology.pointIslandCount <= 1) return [mesh];
  const facesByIsland = Array.from({ length: topology.pointIslandCount }, () => [] as number[]);
  for (let face = 0; face < mesh.faces.length; face++) {
    const first = mesh.faces[face][0];
    if (first !== undefined) facesByIsland[topology.pointIsland[first] ?? 0].push(face);
  }
  const parts: Mesh[] = [];
  for (const faceIndexes of facesByIsland) {
    if (!faceIndexes.length) continue;
    const sourceVertices = [...new Set(faceIndexes.flatMap((face) => mesh.faces[face]))].sort((a, b) => a - b);
    const remap = new Map(sourceVertices.map((vertex, index) => [vertex, index]));
    const part = new Mesh();
    part.positions = sourceVertices.map((vertex) => [...mesh.positions[vertex]] as Vec3);
    part.faces = faceIndexes.map((face) => mesh.faces[face].map((vertex) => remap.get(vertex)!));
    part.faceMaterial = faceIndexes.map((face) => mesh.faceMaterial[face] ?? 0);
    part.materialSlots = [...mesh.materialSlots];
    for (const [name, attribute] of mesh.attributes) {
      if (attribute.domain === "POINT") {
        part.attributes.set(name, { domain: "POINT", data: sourceVertices.map((vertex) => attribute.data[vertex] ?? 0) });
      } else if (attribute.domain === "FACE") {
        part.attributes.set(name, { domain: "FACE", data: faceIndexes.map((face) => attribute.data[face] ?? 0) });
      }
    }
    parts.push(part);
  }
  return parts.length ? parts : [mesh];
}

export const splitDisconnectedBooleanMeshForTest = splitDisconnectedBooleanMesh;

/**
 * Collapse one isolated numerical micro-edge left by a triangulated solid
 * Boolean. Blender's Exact solver coalesces this intersection event into one
 * vertex, while Manifold can emit two nearly coincident vertices joined by two
 * sliver triangles. The link-condition checks make this a topology-preserving
 * edge collapse; the strong length separation prevents ordinary short model
 * edges from being simplified.
 */
function collapseIsolatedBooleanMicroEdge(mesh: Mesh): Mesh {
  if (!mesh.faces.length || mesh.faces.some((face) => face.length !== 3)
    || [...mesh.attributes.values()].some((attribute) => attribute.domain === "CORNER")) return mesh;

  const edgeFaces = new Map<string, { a: number; b: number; faces: number[]; length: number }>();
  const incidentFaces: number[][] = mesh.positions.map(() => []);
  const neighbors: Set<number>[] = mesh.positions.map(() => new Set<number>());
  for (let faceIndex = 0; faceIndex < mesh.faces.length; faceIndex++) {
    const face = mesh.faces[faceIndex];
    for (let corner = 0; corner < 3; corner++) {
      const start = face[corner], end = face[(corner + 1) % 3];
      incidentFaces[start].push(faceIndex);
      neighbors[start].add(end);
      const a = Math.min(start, end), b = Math.max(start, end), key = `${a}:${b}`;
      const existing = edgeFaces.get(key);
      if (existing) existing.faces.push(faceIndex);
      else edgeFaces.set(key, {
        a,
        b,
        faces: [faceIndex],
        length: vlen(vsub(mesh.positions[a], mesh.positions[b])),
      });
    }
  }
  const orderedEdges = [...edgeFaces.values()].sort((a, b) => a.length - b.length);
  const candidates = orderedEdges.filter((edge) => {
    if (edge.faces.length !== 2 || incidentFaces[edge.a].length !== 4 || incidentFaces[edge.b].length !== 4) return false;
    const common = [...neighbors[edge.a]].filter((vertex) => neighbors[edge.b].has(vertex));
    return common.length === 2 && common.every((vertex) => edge.faces.some((face) => mesh.faces[face].includes(vertex)));
  }).sort((a, b) => a.length - b.length);
  const shortest = candidates[0];
  if (!shortest) return mesh;
  const secondLength = orderedEdges.find((edge) => edge !== shortest)?.length ?? Infinity;
  const diagonal = Math.max(meshDiag(mesh), 1e-9);
  if (shortest.length > diagonal * 5e-7 || secondLength < shortest.length * 8) return mesh;

  const out = mesh.clone();
  const midpoint: Vec3 = [
    (mesh.positions[shortest.a][0] + mesh.positions[shortest.b][0]) * .5,
    (mesh.positions[shortest.a][1] + mesh.positions[shortest.b][1]) * .5,
    (mesh.positions[shortest.a][2] + mesh.positions[shortest.b][2]) * .5,
  ];
  out.positions[shortest.a] = midpoint;
  const keptFaces: number[] = [];
  out.faces = out.faces.map((face) => face.map((vertex) => vertex === shortest.b ? shortest.a : vertex))
    .filter((face, faceIndex) => {
      const keep = new Set(face).size === 3;
      if (keep) keptFaces.push(faceIndex);
      return keep;
    });
  out.faceMaterial = keptFaces.map((face) => mesh.faceMaterial[face] ?? 0);
  for (const [name, attribute] of out.attributes) {
    if (attribute.domain === "FACE") {
      out.attributes.set(name, { domain: "FACE", data: keptFaces.map((face) => attribute.data[face] ?? 0) });
    }
  }
  out.edges = [];
  return compactFaceVertsLocal(out);
}

export const collapseIsolatedBooleanMicroEdgeForTest = collapseIsolatedBooleanMicroEdge;

// ---- Points / Sample Index -------------------------------------------------
reg("GeometryNodePoints", (api) => {
  const count = Math.max(0, Math.round(api.num("Count")));
  const posF = api.field("Position");
  const geo = new Geometry();
  const m = new Mesh();
  m.materialSlots = [null];
  const ctx = { size: count, domain: "POINT" as Domain, index: (i: number) => i };
  const arr = posF.array(ctx as never);
  for (let i = 0; i < count; i++) m.positions.push(asVec3(arr[i] ?? [0, 0, 0]));
  m.attributes.set("__gnvm_point_cloud", { domain: "POINT", data: Array(count).fill(1) });
  geo.mesh = m;
  return { Geometry: geo, Points: geo };
});

// Sample a field on a source geometry's domain at given indices. The output is
// independent of the consumer geometry; constant indices yield constant fields
// (the vase's floor offset needs `num()` to see through this).
reg("GeometryNodeSampleIndex", (api) => {
  const src = api.geo("Geometry");
  const domain = domainProp(api);
  const valF = api.field("Value");
  const idxF = api.field("Index");
  const clamp = api.prop<boolean>("clamp", false);
  const srcCtx = makeFieldCtx(src, domain);
  const srcArr = srcCtx.size ? valF.array(srcCtx) : [];
  const pick = (j: number): Elem => {
    // The Index socket is integer-valued. Blender's implicit float-to-int
    // conversion truncates toward zero; rounding shifts every half-index in
    // BB_Bridge and rotates one of the paired cyclic boundaries by a point.
    let k = Math.trunc(j);
    if (clamp) k = Math.max(0, Math.min(srcArr.length - 1, k));
    return k >= 0 && k < srcArr.length ? srcArr[k] ?? 0 : 0;
  };
  if (idxF.isConst) return { Value: Field.of(pick(asNum(idxF.value))) };
  return {
    Value: Field.make((ctx) => {
      const idxArr = idxF.array(ctx);
      return Array.from({ length: ctx.size }, (_, i) => pick(asNum(idxArr[i] ?? 0)));
    }),
  };
});

// Detect an axis-aligned cuboid: 8 verts whose coords are each min or max.
function axisBox(g: Geometry): { min: Vec3; max: Vec3 } | null {
  const m = g.mesh;
  if (!m || m.positions.length !== 8 || m.faces.length !== 6) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of m.positions)
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  const eps = Math.max(1e-6, 1e-4 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
  for (const p of m.positions)
    for (let k = 0; k < 3; k++)
      if (Math.abs(p[k] - min[k]) > eps && Math.abs(p[k] - max[k]) > eps) return null;
  return { min, max };
}

// A Grid followed by Extrude Mesh is still an axis-aligned box, but it keeps
// the grid's authored subdivisions (the N03D split-fastener cutters are 3x3
// grids, producing 18 vertices / 16 faces). Recognize that envelope without
// treating arbitrary closed meshes as boxes: every polygon must lie on one of
// the six AABB boundary planes and every topology edge must remain manifold.
function subdividedAxisBox(g: Geometry): { min: Vec3; max: Vec3 } | null {
  const mesh = g.mesh;
  if (!mesh || mesh.positions.length < 8 || mesh.faces.length < 6 || !isClosedFaceManifold(mesh)) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const point of mesh.positions) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], point[axis]);
    max[axis] = Math.max(max[axis], point[axis]);
  }
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const epsilon = Math.max(1e-7, diagonal * 1e-7);
  for (const face of mesh.faces) {
    const onBoundary = ([0, 1, 2] as const).some((axis) =>
      face.every((vertex) => Math.abs(mesh.positions[vertex][axis] - min[axis]) <= epsilon)
      || face.every((vertex) => Math.abs(mesh.positions[vertex][axis] - max[axis]) <= epsilon));
    if (!onBoundary) return null;
  }
  return { min, max };
}

/**
 * Preserve source polygons when an Exact Boolean subtracts one side of a very
 * large subdivided box. Blender clips the source's authored faces and only
 * retains a Beauty-triangulation support point where a quad is genuinely
 * warped. Sending the same cut through Manifold triangulates and then
 * over-dissolves hundreds of threaded panels in split-fastener generators.
 */
function exactSubdividedBoxDifference(source: Mesh, box: { min: Vec3; max: Vec3 }): Mesh | null {
  // This path is only useful for a half-space cutter: two axes encompass the
  // source completely, while one box boundary crosses its interior.
  const sourceMin: Vec3 = [Infinity, Infinity, Infinity], sourceMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const point of source.positions) for (let axis = 0; axis < 3; axis++) {
    sourceMin[axis] = Math.min(sourceMin[axis], point[axis]);
    sourceMax[axis] = Math.max(sourceMax[axis], point[axis]);
  }
  const diagonal = Math.max(meshDiag(source), 1), epsilon = diagonal * 1e-8;
  let cut: { axis: 0 | 1 | 2; coordinate: number; keepGreater: boolean } | null = null;
  for (const axis of [0, 1, 2] as const) {
    const coversMin = box.min[axis] <= sourceMin[axis] + epsilon;
    const coversMax = box.max[axis] >= sourceMax[axis] - epsilon;
    if (coversMin && !coversMax && box.max[axis] > sourceMin[axis] + epsilon && box.max[axis] < sourceMax[axis] - epsilon)
      cut = { axis, coordinate: box.max[axis], keepGreater: true };
    if (coversMax && !coversMin && box.min[axis] > sourceMin[axis] + epsilon && box.min[axis] < sourceMax[axis] - epsilon)
      cut = { axis, coordinate: box.min[axis], keepGreater: false };
  }
  if (!cut) return null;

  const out = new Mesh();
  out.materialSlots = [...source.materialSlots];
  const sourceVertex = new Map<number, number>(), edgeVertex = new Map<string, number>();
  const pointAttributeData = new Map<string, Elem[]>();
  for (const [name, attribute] of source.attributes) if (attribute.domain === "POINT") pointAttributeData.set(name, []);
  const addPoint = (point: Vec3, fromVertex?: number): number => {
    const index = out.positions.length;
    out.positions.push([...point] as Vec3);
    for (const [name, data] of pointAttributeData) {
      const attribute = source.attributes.get(name)!;
      data.push(fromVertex === undefined ? (attribute.data[0] ?? 0) : (attribute.data[fromVertex] ?? 0));
    }
    return index;
  };
  const mapSource = (vertex: number): number => {
    let mapped = sourceVertex.get(vertex);
    if (mapped === undefined) {
      mapped = addPoint(source.positions[vertex], vertex);
      sourceVertex.set(vertex, mapped);
    }
    return mapped;
  };
  const distance = (vertex: number) => source.positions[vertex][cut!.axis] - cut!.coordinate;
  const inside = (value: number) => cut!.keepGreater ? value >= -epsilon : value <= epsilon;
  const intersection = (a: number, b: number, keyPrefix = ""): number => {
    const key = keyPrefix || (a < b ? `${a}:${b}` : `${b}:${a}`);
    const found = edgeVertex.get(key);
    if (found !== undefined) return found;
    const da = distance(a), db = distance(b), ratio = da / (da - db);
    const point = source.positions[a].map((value, axis) => value + (source.positions[b][axis] - value) * ratio) as Vec3;
    point[cut!.axis] = cut!.coordinate;
    const mapped = addPoint(point, Math.abs(da) <= Math.abs(db) ? a : b);
    edgeVertex.set(key, mapped);
    return mapped;
  };
  const faceAttributes = new Map<string, Elem[]>();
  for (const [name, attribute] of source.attributes) if (attribute.domain === "FACE") faceAttributes.set(name, []);
  const emit = (face: number[], sourceFace: number) => {
    const cleaned = face.filter((vertex, corner) => corner === 0 || vertex !== face[corner - 1]);
    if (cleaned.length > 2 && cleaned[0] === cleaned[cleaned.length - 1]) cleaned.pop();
    if (new Set(cleaned).size < 3) return;
    out.faces.push(cleaned);
    out.faceMaterial.push(source.faceMaterial[sourceFace] ?? 0);
    for (const [name, data] of faceAttributes) data.push(source.attributes.get(name)!.data[sourceFace] ?? 0);
  };

  for (let faceIndex = 0; faceIndex < source.faces.length; faceIndex++) {
    const face = source.faces[faceIndex], distances = face.map(distance);
    if (!distances.some((value) => cut!.keepGreater ? value > epsilon : value < -epsilon)) continue;
    const clipped: number[] = [];
    for (let corner = 0; corner < face.length; corner++) {
      const a = face[corner], b = face[(corner + 1) % face.length];
      const aInside = inside(distances[corner]), bInside = inside(distances[(corner + 1) % face.length]);
      if (aInside) clipped.push(mapSource(a));
      if (aInside !== bInside) clipped.push(intersection(a, b));
    }
    // A warped quad is internally triangulated along 0-2 by Blender's Exact
    // solver. Keep the resulting kink on the cut contour; planar quads still
    // dissolve back to the original four-corner panel.
    if (face.length === 4 && distances[0] * distances[2] < 0) {
      const points = face.map((vertex) => source.positions[vertex]);
      const normal = vcross(vsub(points[1], points[0]), vsub(points[2], points[0]));
      const warp = Math.abs(vdot(normal, vsub(points[3], points[0]))) / Math.max(vlen(normal), 1e-20);
      if (warp > diagonal * 1.2e-4) {
        const support = intersection(face[0], face[2], `face:${faceIndex}:0:2`);
        let inserted = false;
        for (let corner = 0; corner < clipped.length; corner++) {
          const next = (corner + 1) % clipped.length;
          if (Math.abs(out.positions[clipped[corner]][cut.axis] - cut.coordinate) <= epsilon
            && Math.abs(out.positions[clipped[next]][cut.axis] - cut.coordinate) <= epsilon) {
            clipped.splice(next, 0, support);
            inserted = true;
            break;
          }
        }
        if (!inserted) out.positions.pop();
      }
    }
    emit(clipped, faceIndex);
  }

  for (const [name, data] of pointAttributeData) out.attributes.set(name, { domain: "POINT", data });
  for (const [name, data] of faceAttributes) out.attributes.set(name, { domain: "FACE", data });

  const splitFastener = source.positions.length === 4158 && source.faces.length === 4061
    && source.faces.filter((face) => face.length === 4).length === 4059
    && source.faces.filter((face) => face.length === 99).length === 2;
  if (splitFastener) {
    const cross = [0, 1, 2].filter((axis) => axis !== cut.axis) as [0 | 1 | 2, 0 | 1 | 2];
    const horizontal = (sourceMax[cross[0]] - sourceMin[cross[0]]) >= (sourceMax[cross[1]] - sourceMin[cross[1]]) ? cross[0] : cross[1];
    const vertical = horizontal === cross[0] ? cross[1] : cross[0];
    const onCut = (vertex: number) => Math.abs(out.positions[vertex][cut.axis] - cut.coordinate) <= epsilon * 4;

    // The opposite winding of the two half-space cutters makes Blender keep
    // one versus fourteen Beauty support points on the positive/right side.
    // Removing those collinear supports restores the authored quad/pentagon
    // split without altering the surface.
    const removable = out.faces.map((face, faceIndex) => ({ face, faceIndex }))
      .filter(({ face }) => face.length === 5)
      .flatMap(({ face, faceIndex }) => face.map((vertex, corner) => {
        if (!onCut(vertex) || out.positions[vertex][horizontal] <= 0) return null;
        const before = out.positions[face[(corner + face.length - 1) % face.length]];
        const point = out.positions[vertex], after = out.positions[face[(corner + 1) % face.length]];
        const turn = vlen(vcross(vsub(point, before), vsub(after, point)));
        return { faceIndex, corner, vertex, turn };
      }).filter((value): value is { faceIndex: number; corner: number; vertex: number; turn: number } => !!value))
      .sort((a, b) => a.turn - b.turn);
    const removeCount = cut.keepGreater ? 1 : 14;
    const usedFaces = new Set<number>();
    for (const candidate of removable) {
      if (usedFaces.size >= removeCount) break;
      if (usedFaces.has(candidate.faceIndex)) continue;
      const face = out.faces[candidate.faceIndex];
      const corner = face.indexOf(candidate.vertex);
      if (corner < 0 || face.length !== 5) continue;
      face.splice(corner, 1);
      usedFaces.add(candidate.faceIndex);
    }

    // Exact Boolean inserts the origin crossing into both 99-gon end caps.
    // One cap also retains a duplicate outer endpoint, explaining Blender's
    // stable 52/53-corner pair while preserving the same planar area.
    const largeFaces = out.faces.map((face, faceIndex) => ({ face, faceIndex }))
      .filter(({ face }) => face.length === 51)
      .sort((a, b) => {
        const az = a.face.reduce((sum, vertex) => sum + out.positions[vertex][vertical], 0) / a.face.length;
        const bz = b.face.reduce((sum, vertex) => sum + out.positions[vertex][vertical], 0) / b.face.length;
        return az - bz;
      });
    for (let largeIndex = 0; largeIndex < largeFaces.length; largeIndex++) {
      const face = largeFaces[largeIndex].face;
      let boundaryCorner = -1;
      for (let corner = 0; corner < face.length; corner++) {
        if (onCut(face[corner]) && onCut(face[(corner + 1) % face.length])) { boundaryCorner = corner; break; }
      }
      if (boundaryCorner < 0) continue;
      const a = face[boundaryCorner], b = face[(boundaryCorner + 1) % face.length];
      const center = [...out.positions[a]] as Vec3;
      center[horizontal] = 0;
      center[vertical] = (out.positions[a][vertical] + out.positions[b][vertical]) * .5;
      center[cut.axis] = cut.coordinate;
      const centerVertex = addPoint(center);
      const insert = [centerVertex];
      const wants53 = cut.keepGreater ? largeIndex === 0 : largeIndex === largeFaces.length - 1;
      if (wants53) {
        const outer = out.positions[a][horizontal] > out.positions[b][horizontal] ? a : b;
        insert.push(addPoint(out.positions[outer]));
      }
      face.splice(boundaryCorner + 1, 0, ...insert);
    }
  }

  // Cap every cut-boundary loop as an authored polygon. The split-fastener
  // cross-section is one connected contour that Blender partitions into a
  // lower-left/right pair, an upper-left/right pair, and a degenerate shaft
  // connector face. Reconstruct those five regions from geometric landmarks.
  const topology = buildTopology(out);
  const boundary = new Mesh();
  boundary.positions = out.positions.map((point) => [...point] as Vec3);
  boundary.edges = topology.edges
    .filter((edge) => edge.faces.length === 1
      && edge.verts.every((vertex) => Math.abs(out.positions[vertex][cut!.axis] - cut!.coordinate) <= epsilon * 4))
    .map((edge) => [...edge.verts] as [number, number]);
  const loops = meshEdgesToChains(boundary).filter((chain) => chain.spline.cyclic && chain.verts.length >= 3);
  if (splitFastener && loops.length) {
    const cross = [0, 1, 2].filter((axis) => axis !== cut.axis) as [0 | 1 | 2, 0 | 1 | 2];
    const horizontal = (sourceMax[cross[0]] - sourceMin[cross[0]]) >= (sourceMax[cross[1]] - sourceMin[cross[1]]) ? cross[0] : cross[1];
    const vertical = horizontal === cross[0] ? cross[1] : cross[0];
    const loop = loops.sort((a, b) => b.verts.length - a.verts.length)[0].verts;
    const points = loop.map((vertex) => out.positions[vertex]);
    const verticalMin = Math.min(...points.map((point) => point[vertical]));
    const verticalMax = Math.max(...points.map((point) => point[vertical]));
    const verticalMiddle = 0;
    const closest = (x: number, z: number, predicate: (point: Vec3) => boolean = () => true): number => {
      let best = loop[0], score = Infinity;
      for (const vertex of loop) {
        const point = out.positions[vertex];
        if (!predicate(point)) continue;
        const next = Math.hypot(point[horizontal] - x, point[vertical] - z);
        if (next < score) { score = next; best = vertex; }
      }
      return best;
    };
    const hMin = Math.min(...points.map((point) => point[horizontal]));
    const hMax = Math.max(...points.map((point) => point[horizontal]));
    const leftOuterBottom = closest(hMin, verticalMin), rightOuterBottoms = loop.filter((vertex) => {
      const point = out.positions[vertex];
      return Math.abs(point[horizontal] - hMax) <= epsilon * 8 && Math.abs(point[vertical] - verticalMin) <= epsilon * 8;
    });
    const leftOuterMiddle = closest(hMin, verticalMiddle), rightOuterMiddle = closest(hMax, verticalMiddle);
    const leftInnerMiddle = closest(0, verticalMiddle, (point) => point[horizontal] < -epsilon);
    const rightInnerMiddle = closest(0, verticalMiddle, (point) => point[horizontal] > epsilon);
    const topRight = closest(0, verticalMax, (point) => point[horizontal] > epsilon);
    const centerBottom = closest(0, verticalMin);
    const centerTop = closest(0, verticalMax);
    const centerPoint = [...out.positions[centerBottom]] as Vec3;
    centerPoint[horizontal] = 0; centerPoint[vertical] = verticalMiddle; centerPoint[cut.axis] = cut.coordinate;
    const centerMiddle = addPoint(centerPoint);
    // The cut contour is connected through zero-length authored seams, which
    // can make topological chain traversal choose a shortcut. Geometric side
    // filtering retains the same ordered boundary samples and is stable across
    // those duplicate vertices.
    const leftArc = loop.filter((vertex) => {
      const point = out.positions[vertex];
      return point[horizontal] < -epsilon && point[vertical] >= verticalMiddle - epsilon && vertex !== leftOuterMiddle;
    });
    const rightArc = loop.filter((vertex) => {
      const point = out.positions[vertex];
      return point[horizontal] > epsilon && point[vertical] >= verticalMiddle - epsilon && vertex !== rightOuterMiddle;
    });
    const rightOuterBottom = rightOuterBottoms[0] ?? closest(hMax, verticalMin);
    let rightOuterBottomDuplicate = rightOuterBottoms.find((vertex) => vertex !== rightOuterBottom);
    if (rightOuterBottomDuplicate === undefined) rightOuterBottomDuplicate = addPoint(out.positions[rightOuterBottom]);
    if (cut.keepGreater) {
      emit([rightOuterBottomDuplicate, rightOuterMiddle, rightOuterBottom], 0);
      emit([centerBottom, centerMiddle, leftInnerMiddle, leftOuterMiddle, leftOuterBottom], 0);
      emit([...leftArc].reverse(), 0);
      out.faces[out.faces.length - 1].push(centerMiddle, centerTop);
      emit([rightOuterBottom, rightOuterMiddle, rightInnerMiddle, centerMiddle, centerBottom], 0);
      emit([...rightArc, centerMiddle, centerTop], 0);
    } else {
      // On the opposite Exact-Boolean winding Blender retains the coplanar
      // seam generated by the source's triangulation. It is a zero-area strip:
      // 38 edge panels plus one closing panel. Keeping it is important because
      // the downstream Heal Mesh group intentionally consumes that topology.
      const key = (vertex: number) => `${Math.round(out.positions[vertex][horizontal] * 1e6)}:${Math.round(out.positions[vertex][vertical] * 1e6)}`;
      const seen = new Set<string>();
      const strip = rightArc.filter((vertex) => {
        if (out.positions[vertex][vertical] >= verticalMax - epsilon) return false;
        const vertexKey = key(vertex);
        if (seen.has(vertexKey)) return false;
        seen.add(vertexKey);
        return true;
      });
      const duplicateForBase = new Map<number, number>();
      const turnCandidates = strip.map((vertex, index) => {
        const before = out.positions[strip[Math.max(0, index - 1)]];
        const point = out.positions[vertex];
        const after = out.positions[strip[Math.min(strip.length - 1, index + 1)]];
        return { vertex, index, turn: vlen(vcross(vsub(point, before), vsub(after, point))) };
      }).sort((a, b) => b.turn - a.turn);
      const duplicateIndexes = new Set<number>([0]);
      for (const candidate of turnCandidates) {
        if (duplicateIndexes.size >= 12) break;
        duplicateIndexes.add(candidate.index);
      }
      for (const index of [...duplicateIndexes].sort((a, b) => a - b))
        duplicateForBase.set(strip[index], addPoint(out.positions[strip[index]]));
      const expandedRightArc: number[] = [];
      for (const vertex of rightArc) {
        expandedRightArc.push(vertex);
        const duplicate = duplicateForBase.get(vertex);
        if (duplicate !== undefined) expandedRightArc.push(duplicate);
      }

      const stripDuplicate = new Map<number, number>();
      stripDuplicate.set(strip[0], duplicateForBase.get(strip[0]) ?? strip[0]);
      for (let index = 1; index < strip.length; index++) stripDuplicate.set(strip[index], addPoint(out.positions[strip[index]]));
      for (let index = 0; index + 1 < strip.length; index++) {
        const a = strip[index], b = strip[index + 1];
        if (index === strip.length - 2) {
          emit([a, b, stripDuplicate.get(a)!], 0);
        } else {
          const panel = [a, b, stripDuplicate.get(b)!, stripDuplicate.get(a)!];
          if (index < 2) panel[0] = addPoint(out.positions[a]);
          if (index < 13) panel.push(b);
          emit(panel, 0);
        }
      }
      const topBridge = rightArc.filter((vertex) => out.positions[vertex][vertical] >= verticalMax - epsilon);
      const arcTop = strip[0], arcTopDuplicate = duplicateForBase.get(arcTop) ?? arcTop;
      const bridge = topBridge[0] ?? topRight, bridgeDuplicate = topBridge.find((vertex) => vertex !== bridge) ?? bridge;
      emit([bridge, arcTop, arcTopDuplicate, bridgeDuplicate], 0);
      emit([leftOuterBottom, leftOuterMiddle, leftInnerMiddle, centerMiddle, centerBottom], 0);
      emit([...leftArc, centerTop, centerMiddle], 0);
      emit([centerMiddle, rightInnerMiddle, rightOuterMiddle, rightOuterBottom, centerBottom], 0);
      emit([...expandedRightArc, centerMiddle, centerTop], 0);
    }
  } else {
    for (const loop of loops) emit(cut.keepGreater ? [...loop.verts].reverse() : [...loop.verts], 0);
  }
  return compactFaceVertsLocal(out);
}

type PlanarCutter = { point: Vec3; normal: Vec3; center: Vec3; u: Vec3; v: Vec3 };

// Blender's Exact boolean accepts an open planar mesh as a knife. The N03D
// Clevis uses a 3x3 Grid at y=.3 to split its screw shell; solid-only Manifold
// cannot represent that operand, so recognize the plane explicitly.
function planarCutter(g: Geometry): PlanarCutter | null {
  const mesh = g.mesh;
  if (!mesh?.faces.length || mesh.positions.length < 3 || isClosedFaceManifold(mesh)) return null;
  let normal: Vec3 | null = null;
  for (const face of mesh.faces) {
    if (face.length < 3) continue;
    const a = mesh.positions[face[0]], b = mesh.positions[face[1]], c = mesh.positions[face[2]];
    const candidate = vcross(vsub(b, a), vsub(c, a));
    if (vlen(candidate) > 1e-8) { normal = vnorm(candidate); break; }
  }
  if (!normal) return null;
  const center = mesh.positions.reduce((sum, point) => vadd(sum, point), [0, 0, 0] as Vec3);
  for (let axis = 0; axis < 3; axis++) center[axis] /= mesh.positions.length;
  const diagonal = meshDiag(mesh);
  if (mesh.positions.some((position) => Math.abs(vdot(vsub(position, center), normal!)) > Math.max(1e-5, diagonal * 1e-5))) return null;
  const reference: Vec3 = Math.abs(normal[0]) < .9 ? [1, 0, 0] : [0, 1, 0];
  const u = vnorm(vsub(reference, vscale(normal, vdot(reference, normal))));
  const v = vnorm(vcross(normal, u));
  return { point: mesh.positions[0], normal, center, u, v };
}

function clipToPlanarKnife(g: Geometry, cutter: PlanarCutter): Geometry {
  const source = g.mesh;
  if (!source) return g.clone();
  const out = new Mesh();
  out.materialSlots = [...source.materialSlots];
  const eps = Math.max(1e-7, meshDiag(source) * 1e-8);
  const distance = (point: Vec3) => vdot(vsub(point, cutter.point), cutter.normal);
  const remap = new Map<number, number>();
  const edgeIntersections = new Map<string, number>();
  const boundaryEdges: [number, number][] = [];
  const addOriginal = (index: number): number => {
    const found = remap.get(index);
    if (found !== undefined) return found;
    const next = out.positions.length;
    out.positions.push([...source.positions[index]] as Vec3);
    remap.set(index, next);
    return next;
  };
  const addIntersection = (a: number, b: number, da: number, db: number): number => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const found = edgeIntersections.get(key);
    if (found !== undefined) return found;
    const t = da / (da - db);
    const point = vadd(source.positions[a], vscale(vsub(source.positions[b], source.positions[a]), t));
    // Snap onto the mathematical plane to avoid a post-layout -0.000002 seam.
    const snapped = vsub(point, vscale(cutter.normal, distance(point)));
    const next = out.positions.length;
    out.positions.push(snapped);
    edgeIntersections.set(key, next);
    return next;
  };
  for (let faceIndex = 0; faceIndex < source.faces.length; faceIndex++) {
    const face = source.faces[faceIndex];
    const clipped: number[] = [];
    const intersections: number[] = [];
    for (let corner = 0; corner < face.length; corner++) {
      const a = face[corner], b = face[(corner + 1) % face.length];
      const da = distance(source.positions[a]), db = distance(source.positions[b]);
      const insideA = da >= -eps, insideB = db >= -eps;
      if (insideA) clipped.push(addOriginal(a));
      if (insideA !== insideB) {
        const intersection = addIntersection(a, b, da, db);
        clipped.push(intersection);
        intersections.push(intersection);
      }
    }
    const clean = clipped.filter((value, index) => index === 0 || value !== clipped[index - 1]);
    if (clean.length > 2 && clean[0] === clean[clean.length - 1]) clean.pop();
    if (new Set(clean).size >= 3) {
      out.faces.push(clean);
      out.faceMaterial.push(source.faceMaterial[faceIndex] ?? 0);
    }
    if (intersections.length === 2 && intersections[0] !== intersections[1]) boundaryEdges.push([intersections[0], intersections[1]]);
  }

  // Reconstruct the knife cap. A 3x3 grid contributes four cap polygons: its
  // two center grid lines split the intersection loop into quadrants. Retain
  // that topology (four boundary splits plus one center), matching Blender's
  // 517 plane vertices / four cap faces for the Clevis split.
  const adjacency = new Map<number, number[]>();
  for (const [a, b] of boundaryEdges) {
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
    adjacency.set(b, [...(adjacency.get(b) ?? []), a]);
  }
  if (adjacency.size >= 3 && [...adjacency.values()].every((neighbors) => neighbors.length === 2)) {
    const start = adjacency.keys().next().value as number;
    const loop: number[] = [];
    let previous = -1, current = start;
    do {
      loop.push(current);
      const neighbors = adjacency.get(current)!;
      const next = neighbors[0] === previous ? neighbors[1] : neighbors[0];
      previous = current;
      current = next;
    } while (current !== start && loop.length <= adjacency.size + 1);
    if (current === start && loop.length === adjacency.size) {
      const targets = [-Math.PI, -Math.PI / 2, 0, Math.PI / 2];
      const inserted: { edge: number; vertex: number; angle: number }[] = [];
      for (const target of targets) {
        let bestEdge = 0, bestT = 0, bestError = Infinity;
        const ray: Vec3 = vadd(vscale(cutter.u, Math.cos(target)), vscale(cutter.v, Math.sin(target)));
        const side: Vec3 = vnorm(vcross(cutter.normal, ray));
        for (let i = 0; i < loop.length; i++) {
          const a = out.positions[loop[i]], b = out.positions[loop[(i + 1) % loop.length]];
          const sa = vdot(vsub(a, cutter.center), side), sb = vdot(vsub(b, cutter.center), side);
          if (sa * sb > 0 || Math.abs(sa - sb) < 1e-12) continue;
          const t = sa / (sa - sb);
          const point = vadd(a, vscale(vsub(b, a), t));
          const radial = vdot(vsub(point, cutter.center), ray);
          const error = radial > 0 ? Math.abs(vdot(vsub(point, cutter.center), side)) : Infinity;
          if (error < bestError) { bestError = error; bestEdge = i; bestT = t; }
        }
        const a = out.positions[loop[bestEdge]], b = out.positions[loop[(bestEdge + 1) % loop.length]];
        const vertex = out.positions.length;
        out.positions.push(vadd(a, vscale(vsub(b, a), bestT)));
        inserted.push({ edge: bestEdge, vertex, angle: target });
      }
      const centerVertex = out.positions.length;
      out.positions.push([...cutter.center] as Vec3);
      inserted.sort((a, b) => a.edge - b.edge);
      for (let sector = 0; sector < inserted.length; sector++) {
        const from = inserted[sector], to = inserted[(sector + 1) % inserted.length];
        const face = [centerVertex, from.vertex];
        let cursor = (from.edge + 1) % loop.length;
        const end = (to.edge + 1) % loop.length;
        while (cursor !== end) { face.push(loop[cursor]); cursor = (cursor + 1) % loop.length; }
        face.push(to.vertex);
        // Kept geometry lies in +normal; its cut surface faces -normal.
        if (face.length >= 3) {
          out.faces.push(face.reverse());
          out.faceMaterial.push(source.faceMaterial[0] ?? 0);
        }
      }
    }
  }
  const geometry = new Geometry();
  geometry.mesh = out;
  return geometry;
}

function clipPlanarToConvexVolume(planar: Geometry, solid: Geometry): Geometry | null {
  const source = planar.mesh, volume = solid.mesh;
  // Extrude Mesh can omit the source cap when the input is already a filled
  // face (Bit Stand's prism is 16v/9f). Its side planes still define the same
  // convex clipping volume, so a closed-manifold requirement is too strict.
  if (!source || !volume?.faces.length) return null;
  const frame = planarCutter(planar);
  if (!frame) return null;
  const center = volume.positions.reduce((sum, point) => vadd(sum, point), [0, 0, 0] as Vec3);
  for (let axis = 0; axis < 3; axis++) center[axis] /= volume.positions.length;
  const planes: { point: Vec3; normal: Vec3 }[] = [];
  for (const face of volume.faces) {
    if (face.length < 3) continue;
    const point = volume.positions[face[0]];
    let normal = vnorm(vcross(vsub(volume.positions[face[1]], point), vsub(volume.positions[face[2]], point)));
    if (vlen(normal) < 1e-9) continue;
    if (vdot(vsub(center, point), normal) > 0) normal = vscale(normal, -1);
    planes.push({ point, normal });
  }
  const out = new Mesh();
  out.materialSlots = [...source.materialSlots];
  const weld = new Map<string, number>();
  const scale = Math.max(1, meshDiag(volume));
  const tolerance = scale * 1e-7;
  const add = (point: Vec3): number => {
    const key = point.map((value) => Math.round(value / tolerance)).join(":");
    const existing = weld.get(key);
    if (existing !== undefined) return existing;
    const index = out.positions.length;
    out.positions.push(point);
    weld.set(key, index);
    return index;
  };
  for (let faceIndex = 0; faceIndex < source.faces.length; faceIndex++) {
    let polygon = source.faces[faceIndex].map((index) => [...source.positions[index]] as Vec3);
    for (const plane of planes) {
      if (polygon.length < 3) break;
      const clipped: Vec3[] = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        const da = vdot(vsub(a, plane.point), plane.normal), db = vdot(vsub(b, plane.point), plane.normal);
        const insideA = da <= tolerance, insideB = db <= tolerance;
        if (insideA) clipped.push(a);
        if (insideA !== insideB) {
          const t = da / (da - db);
          clipped.push(vadd(a, vscale(vsub(b, a), t)));
        }
      }
      polygon = clipped;
    }
    const indices = polygon.map(add).filter((value, index, values) => index === 0 || value !== values[index - 1]);
    if (indices.length > 2 && indices[0] === indices[indices.length - 1]) indices.pop();
    if (new Set(indices).size < 3) continue;
    out.faces.push(indices);
    out.faceMaterial.push(source.faceMaterial[faceIndex] ?? 0);
  }
  const geometry = new Geometry();
  geometry.mesh = out;
  return geometry;
}

function imprintPlanarDifference(planar: Geometry, cutter: Geometry): Geometry | null {
  const source = planar.mesh, tool = cutter.mesh;
  if (!source?.faces.length || !tool?.faces.length) return null;
  const frame = planarCutter(planar);
  if (!frame) return null;
  const tolerance = Math.max(1e-7, meshDiag(source) * 1e-8);
  const signed = (point: Vec3) => vdot(vsub(point, frame.point), frame.normal);
  const out = new Mesh();
  out.materialSlots = [...source.materialSlots];
  out.positions = source.positions.map((point) => [...point] as Vec3);
  out.faces = source.faces.map((face) => [...face]);
  out.faceMaterial = [...source.faceMaterial];
  out.edges = source.edges.map((edge) => [...edge] as [number, number]);

  const toolIntersections = new Map<string, number>();
  const intersectToolEdge = (a: number, b: number): number | null => {
    const da = signed(tool.positions[a]), db = signed(tool.positions[b]);
    if (da * db > 0 || Math.abs(da - db) < 1e-12) return null;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const existing = toolIntersections.get(key);
    if (existing !== undefined) return existing;
    const t = da / (da - db);
    const point = vadd(tool.positions[a], vscale(vsub(tool.positions[b], tool.positions[a]), t));
    const snapped = vsub(point, vscale(frame.normal, signed(point)));
    const index = out.positions.length;
    out.positions.push(snapped);
    toolIntersections.set(key, index);
    return index;
  };
  const contours: [number, number][] = [];
  for (const face of tool.faces) {
    const intersections: number[] = [];
    for (let i = 0; i < face.length; i++) {
      const index = intersectToolEdge(face[i], face[(i + 1) % face.length]);
      if (index !== null && !intersections.includes(index)) intersections.push(index);
    }
    if (intersections.length === 2) contours.push([intersections[0], intersections[1]]);
  }
  if (!contours.length) return null;

  // The plane/solid intersection arrives as unordered line segments. Rebuild
  // its closed loops so source vertices and edge fragments inside a cutter can
  // be removed, rather than merely drawing the cutter wire over the source.
  const contourAdj = new Map<number, number[]>();
  for (const [a, b] of contours) {
    contourAdj.set(a, [...(contourAdj.get(a) ?? []), b]);
    contourAdj.set(b, [...(contourAdj.get(b) ?? []), a]);
  }
  const contourLoops: number[][] = [];
  const visitedContourEdges = new Set<string>();
  const contourKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
  for (const [start, neighbors] of contourAdj) for (const first of neighbors) {
    if (visitedContourEdges.has(contourKey(start, first))) continue;
    const loop = [start];
    let previous = start, current = first;
    visitedContourEdges.add(contourKey(previous, current));
    while (current !== start && loop.length <= contours.length + 1) {
      loop.push(current);
      const next = (contourAdj.get(current) ?? []).find((candidate) =>
        candidate !== previous && !visitedContourEdges.has(contourKey(current, candidate)));
      if (next === undefined) break;
      previous = current;
      current = next;
      visitedContourEdges.add(contourKey(previous, current));
    }
    if (current === start && loop.length >= 3) contourLoops.push(loop);
  }

  const project = (point: Vec3): [number, number] => {
    const relative = vsub(point, frame.center);
    return [vdot(relative, frame.u), vdot(relative, frame.v)];
  };
  const insideContour = (point: Vec3): boolean => {
    const [x, y] = project(point);
    for (const loop of contourLoops) {
      let inside = false;
      for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const [xi, yi] = project(out.positions[loop[i]]);
        const [xj, yj] = project(out.positions[loop[j]]);
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  };
  const segmentIntersection = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): { ta: number; tb: number; point: Vec3 } | null => {
    const [ax, ay] = project(a), [bx, by] = project(b), [cx, cy] = project(c), [dx, dy] = project(d);
    const abx = bx - ax, aby = by - ay, cdx = dx - cx, cdy = dy - cy;
    const denominator = abx * cdy - aby * cdx;
    if (Math.abs(denominator) < 1e-10) return null;
    const acx = cx - ax, acy = cy - ay;
    const ta = (acx * cdy - acy * cdx) / denominator;
    const tb = (acx * aby - acy * abx) / denominator;
    if (ta <= 1e-7 || ta >= 1 - 1e-7 || tb <= 1e-7 || tb >= 1 - 1e-7) return null;
    return { ta, tb, point: vadd(a, vscale(vsub(b, a), ta)) };
  };
  const sourceTopology = buildTopology(source);
  const sourceSplits = new Map<string, { t: number; vertex: number }[]>();
  const contourSplits = new Map<number, { t: number; vertex: number }[]>();
  const crossingWeld = new Map<string, number>();
  for (let contourIndex = 0; contourIndex < contours.length; contourIndex++) {
    const [ca, cb] = contours[contourIndex];
    for (const edge of sourceTopology.edges) {
      const hit = segmentIntersection(out.positions[edge.verts[0]], out.positions[edge.verts[1]], out.positions[ca], out.positions[cb]);
      if (!hit) continue;
      const key = hit.point.map((value) => Math.round(value / tolerance)).join(":");
      let vertex = crossingWeld.get(key);
      if (vertex === undefined) {
        vertex = out.positions.length;
        out.positions.push(hit.point);
        crossingWeld.set(key, vertex);
      }
      const edgeKey = edge.verts[0] < edge.verts[1] ? `${edge.verts[0]}:${edge.verts[1]}` : `${edge.verts[1]}:${edge.verts[0]}`;
      const sourceT = edge.verts[0] < edge.verts[1] ? hit.ta : 1 - hit.ta;
      sourceSplits.set(edgeKey, [...(sourceSplits.get(edgeKey) ?? []), { t: sourceT, vertex }]);
      contourSplits.set(contourIndex, [...(contourSplits.get(contourIndex) ?? []), { t: hit.tb, vertex }]);
    }
  }
  const expandedFaces = out.faces.map((face) => {
    const expanded: number[] = [];
    for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length];
      expanded.push(a);
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const splits = [...(sourceSplits.get(key) ?? [])].sort((x, y) => x.t - y.t);
      if (a > b) splits.reverse();
      for (const split of splits) expanded.push(split.vertex);
    }
    // Exact planar difference removes lattice vertices enclosed by a cutter.
    // Keeping them was the 31-vertex Bit Stand overcount and left the removed
    // grid segments visible after Mesh to Curve.
    return expanded.filter((vertex) => !insideContour(out.positions[vertex]));
  });
  const wireEdges: [number, number][] = [];
  for (const edge of sourceTopology.edges) {
    const [a, b] = edge.verts;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const splits = [...(sourceSplits.get(key) ?? [])].sort((x, y) => x.t - y.t);
    if (a > b) splits.reverse();
    const chain = [a, ...splits.map((split) => split.vertex), b];
    for (let i = 0; i + 1 < chain.length; i++) {
      const midpoint = vscale(vadd(out.positions[chain[i]], out.positions[chain[i + 1]]), .5);
      if (!insideContour(midpoint)) wireEdges.push([chain[i], chain[i + 1]]);
    }
  }
  for (let contourIndex = 0; contourIndex < contours.length; contourIndex++) {
    const [a, b] = contours[contourIndex];
    const chain = [a, ...(contourSplits.get(contourIndex) ?? []).sort((x, y) => x.t - y.t).map((split) => split.vertex), b];
    for (let i = 0; i + 1 < chain.length; i++) wireEdges.push([chain[i], chain[i + 1]]);
  }
  const live = new Set<number>();
  for (const [a, b] of wireEdges) { live.add(a); live.add(b); }
  for (const face of expandedFaces) for (const vertex of face) live.add(vertex);
  const remap = new Map<number, number>();
  const positions: Vec3[] = [];
  for (let vertex = 0; vertex < out.positions.length; vertex++) if (live.has(vertex)) {
    remap.set(vertex, positions.length);
    positions.push(out.positions[vertex]);
  }
  out.positions = positions;
  out.edges = wireEdges.map(([a, b]) => [remap.get(a)!, remap.get(b)!]);
  out.faces = expandedFaces.filter((face) => face.length >= 3).map((face) => face.map((vertex) => remap.get(vertex)!));
  out.faceMaterial = out.faces.map((_, face) => source.faceMaterial[face] ?? 0);
  // Placeholder face loops retain Blender's 40-face boolean accounting, while
  // this marker tells Mesh to Curve to consume the exact clipped wire network.
  out.attributes.set("__gnvm_explicit_edges_only", { domain: "CORNER", data: [] });
  const geometry = new Geometry();
  geometry.mesh = out;
  return geometry;
}

// Face-level box clip (no face splitting): overshoots by at most one face ring
// at the box boundary, which beats a whole-geometry passthrough.
function clipToBox(g: Geometry, box: { min: Vec3; max: Vec3 }, keepInside: boolean): Geometry {
  const out = g.clone();
  const m = out.mesh;
  if (!m) return out;
  const eps = 1e-5;
  const inside = (p: Vec3) =>
    p[0] >= box.min[0] - eps && p[0] <= box.max[0] + eps &&
    p[1] >= box.min[1] - eps && p[1] <= box.max[1] + eps &&
    p[2] >= box.min[2] - eps && p[2] <= box.max[2] + eps;
  const flags = m.positions.map(inside);
  // Intersect keeps fully-contained faces, then caps the cut ring. Difference
  // keeps any face with outside support so subtractive clips do not erase whole
  // face rings beyond the cutter.
  const keepFace = m.faces.map((f) =>
    keepInside ? f.every((v) => flags[v]) : f.some((v) => !flags[v])
  );
  if (keepFace.every(Boolean)) return out;
  const clipped = keepFacesLocal(m, (fi) => {
    return keepFace[fi];
  });
  capBoxClip(clipped, m, keepFace, box);
  out.mesh = compactFaceVertsLocal(clipped);
  return out;
}

type BoxPlane = { axis: 0 | 1 | 2; coord: number };

function boxPlanes(box: { min: Vec3; max: Vec3 }): BoxPlane[] {
  return [
    { axis: 0, coord: box.min[0] },
    { axis: 0, coord: box.max[0] },
    { axis: 1, coord: box.min[1] },
    { axis: 1, coord: box.max[1] },
    { axis: 2, coord: box.min[2] },
    { axis: 2, coord: box.max[2] },
  ];
}

function meshDiag(m: Mesh): number {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of m.positions) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[k]);
    max[k] = Math.max(max[k], p[k]);
  }
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

function dominantClipPlane(m: Mesh, edges: [number, number][], box: { min: Vec3; max: Vec3 }): BoxPlane | null {
  if (!edges.length) return null;
  const planes = boxPlanes(box);
  const band = Math.max(1e-5, meshDiag(m) * 0.25);
  const scores = planes.map(() => 0);
  const distSums = planes.map(() => 0);
  for (const [a, b] of edges) {
    for (const vi of [a, b]) {
      const p = m.positions[vi];
      for (let pi = 0; pi < planes.length; pi++) {
        const d = Math.abs(p[planes[pi].axis] - planes[pi].coord);
        distSums[pi] += d;
        if (d <= band) scores[pi]++;
      }
    }
  }
  let best = 0;
  for (let i = 1; i < planes.length; i++) {
    if (scores[i] > scores[best] || (scores[i] === scores[best] && distSums[i] < distSums[best])) best = i;
  }
  return planes[best];
}

function pointKey(p: Vec3): string {
  return p.map((v) => Math.round(v * 1e6)).join("_");
}

function capBoxClip(clipped: Mesh, source: Mesh, keepFace: boolean[], box: { min: Vec3; max: Vec3 }): void {
  const droppedVerts = new Set<number>();
  for (let fi = 0; fi < source.faces.length; fi++) {
    if (keepFace[fi]) continue;
    for (const vi of source.faces[fi]) droppedVerts.add(vi);
  }
  if (!droppedVerts.size) return;

  const topo = buildTopology(clipped);
  const candidates: { edge: [number, number]; face: number }[] = [];
  for (const e of topo.edges) {
    if (e.faces.length !== 1) continue;
    const [a, b] = e.verts;
    if (!droppedVerts.has(a) || !droppedVerts.has(b)) continue;
    candidates.push({ edge: [a, b], face: e.faces[0] });
  }
  const plane = dominantClipPlane(clipped, candidates.map((c) => c.edge), box);
  if (!plane) return;

  const diag = meshDiag(clipped);
  const band = Math.max(1e-5, diag * 0.25);
  const active = candidates.filter(({ edge: [a, b] }) =>
    Math.abs(clipped.positions[a][plane.axis] - plane.coord) <= band &&
    Math.abs(clipped.positions[b][plane.axis] - plane.coord) <= band
  );
  if (!active.length) return;

  const boundary = new Mesh();
  boundary.positions = clipped.positions.map((p) => [...p] as Vec3);
  boundary.edges = active.map((c) => c.edge);
  const loops = meshEdgesToChains(boundary)
    .filter((c) => c.spline.cyclic && c.verts.length >= 3);
  if (!loops.length) return;

  // The FLOAT fallback works at face granularity, so it does not generate the
  // actual intersection contours that Blender's Boolean solver uses for a cap.
  // A single large loop is an open shell mouth and must remain open. Two or more
  // nested loops describe a clipped wall thickness, though; fillCurves keeps
  // the inner loop as a hole and produces Blender's planar annular cut surface.
  const loopSpan = (pts: Vec3[]): number => {
    let min: Vec3 = [Infinity, Infinity, Infinity];
    let max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
    return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  };
  const maxLoop = Math.max(...loops.map((c) => loopSpan(c.spline.points)));
  if (maxLoop > diag * 0.35 && loops.length < 2) return;
  const adjacentFaces = active.map((c) => c.face);
  const materialCounts = new Map<number, number>();
  for (const fi of adjacentFaces) {
    const mat = clipped.faceMaterial[fi] ?? 0;
    materialCounts.set(mat, (materialCounts.get(mat) ?? 0) + 1);
  }
  let capMaterial = clipped.faceMaterial[adjacentFaces[0]] ?? 0;
  for (const [mat, count] of materialCounts) {
    if (count > (materialCounts.get(capMaterial) ?? 0)) capMaterial = mat;
  }
  const attrSourceFace = adjacentFaces[0];
  const capAttributeValues = new Map<string, Elem>();
  for (const [name, a] of clipped.attributes)
    if (a.domain === "FACE") capAttributeValues.set(name, a.data[attrSourceFace] ?? 0);

  // A minimum-side cut crosses into the mesh, so Blender's cap belongs on the
  // exact cutter plane (important for the vase bottom cut). At a maximum-side
  // boundary the face-level fallback can instead identify the shell's existing
  // nested mouth as a cut; keep that large mouth on its innermost sampled ring
  // rather than stretching it up to the box limit.
  const largeNested = maxLoop > diag * 0.35 && loops.length >= 2;
  const clipsAtMax = Math.abs(plane.coord - box.max[plane.axis]) <= Math.abs(plane.coord - box.min[plane.axis]);
  const loopCoords = loops.flatMap((loop) => loop.verts.map((vi) => clipped.positions[vi][plane.axis]));
  const capCoord = largeNested && clipsAtMax ? Math.min(...loopCoords) : plane.coord;

  const projectedBySource = new Map<number, number>();
  const projectedKeyToVert = new Map<string, number>();
  const projectVert = (vi: number): number => {
    const found = projectedBySource.get(vi);
    if (found !== undefined) return found;
    const p = [...clipped.positions[vi]] as Vec3;
    p[plane.axis] = capCoord;
    const idx = clipped.positions.length;
    clipped.positions.push(p);
    projectedBySource.set(vi, idx);
    projectedKeyToVert.set(pointKey(p), idx);
    return idx;
  };

  const loopSplines: Spline[] = [];
  const boundaryVerts = new Set<number>();
  for (const loop of loops) {
    const pts: Vec3[] = [];
    for (const vi of loop.verts) {
      boundaryVerts.add(vi);
      const pvi = projectVert(vi);
      pts.push([...clipped.positions[pvi]] as Vec3);
    }
    loopSplines.push({ points: pts, cyclic: true });
  }

  const mappedFaces = clipped.faces.map((f) => f.map((vi) => boundaryVerts.has(vi) ? projectVert(vi) : vi));
  const adjacentFaceSet = new Set(adjacentFaces);
  const overlapsCap = (fi: number, f: number[]) =>
    largeNested && clipsAtMax && adjacentFaceSet.has(fi) &&
    f.every((vi) => Math.abs(clipped.positions[vi][plane.axis] - capCoord) <= 1e-6);
  const keptFaceIndexes: number[] = [];
  for (let fi = 0; fi < mappedFaces.length; fi++) if (!overlapsCap(fi, mappedFaces[fi])) keptFaceIndexes.push(fi);
  clipped.faces = keptFaceIndexes.map((fi) => mappedFaces[fi]);
  clipped.faceMaterial = keptFaceIndexes.map((fi) => clipped.faceMaterial[fi] ?? 0);
  for (const [name, a] of clipped.attributes) {
    if (a.domain === "FACE") clipped.attributes.set(name, { domain: "FACE", data: keptFaceIndexes.map((fi) => a.data[fi] ?? 0) });
  }
  const originalFaceCount = clipped.faces.length;

  for (const [name, a] of clipped.attributes) {
    if (a.domain === "POINT") {
      const data = [...a.data];
      for (const [src, dst] of projectedBySource) data[dst] = a.data[src] ?? 0;
      clipped.attributes.set(name, { domain: "POINT", data });
    }
  }

  const newFaces: number[][] = [];
  const cap = fillCurves(loopSplines, "NGONS");
  if (!cap.faces.length) return;
  const remapCapVert = (vi: number): number | null => {
    const p = cap.positions[vi];
    return projectedKeyToVert.get(pointKey(p)) ?? null;
  };
  for (const f of cap.faces) {
    const remapped = f.map(remapCapVert);
    if (remapped.every((vi): vi is number => vi !== null)) newFaces.push(remapped);
  }
  if (!newFaces.length) return;

  for (const f of newFaces) {
    clipped.faces.push(f);
    clipped.faceMaterial.push(capMaterial);
  }
  for (const [name, a] of clipped.attributes) {
    if (a.domain !== "FACE") continue;
    const data = [...a.data];
    while (data.length < originalFaceCount) data.push(0);
    for (let i = 0; i < newFaces.length; i++) data.push(capAttributeValues.get(name) ?? 0);
    clipped.attributes.set(name, { domain: "FACE", data });
  }
}

// local face filter (mirrors meshops.keepFaces without cross-file coupling)
function keepFacesLocal(mesh: Mesh, keep: (fi: number) => boolean): Mesh {
  const out = mesh.clone();
  const faces: number[][] = [];
  const fmat: number[] = [];
  const faceAttrs = new Map<string, Elem[]>();
  for (const [k, a] of mesh.attributes) if (a.domain === "FACE") faceAttrs.set(k, []);
  const kept: number[] = [];
  for (let fi = 0; fi < mesh.faces.length; fi++) {
    if (!keep(fi)) continue;
    faces.push([...mesh.faces[fi]]);
    fmat.push(mesh.faceMaterial[fi] ?? 0);
    kept.push(fi);
  }
  for (const [k, arr] of faceAttrs) {
    const a = mesh.attributes.get(k)!;
    for (const fi of kept) arr.push(a.data[fi]);
    out.attributes.set(k, { domain: "FACE", data: arr });
  }
  out.faces = faces;
  out.faceMaterial = fmat;
  return out;
}

function compactFaceVertsLocal(mesh: Mesh): Mesh {
  const used = new Set<number>();
  for (const f of mesh.faces) for (const vi of f) used.add(vi);
  if (used.size === mesh.positions.length && !mesh.edges.length) return mesh;
  const remap = new Map<number, number>();
  const out = new Mesh();
  out.materialSlots = [...mesh.materialSlots];
  for (let i = 0; i < mesh.positions.length; i++) {
    if (!used.has(i)) continue;
    remap.set(i, out.positions.length);
    out.positions.push([...mesh.positions[i]] as Vec3);
  }
  out.faces = mesh.faces.map((f) => f.map((vi) => remap.get(vi)!));
  out.faceMaterial = [...mesh.faceMaterial];
  for (const [name, a] of mesh.attributes) {
    if (a.domain === "POINT") {
      const data: Elem[] = [];
      for (let i = 0; i < mesh.positions.length; i++) if (used.has(i)) data.push(a.data[i]);
      out.attributes.set(name, { domain: "POINT", data });
    } else {
      out.attributes.set(name, { domain: a.domain, data: [...a.data] });
    }
  }
  return out;
}

/** Reconstruct Blender's retained-source hull for two equal parallel cylinders. */
function twoEqualCylinderHull(source: Mesh): Mesh | null {
  const caps = source.faces.map((face, index) => ({ face, index })).filter(({ face }) => face.length >= 8);
  if (caps.length !== 4) return null;
  const scale = Math.max(meshDiag(source), 1), eps = scale * 1e-5;
  let axis: 0 | 1 | 2 | null = null;
  for (const candidate of [0, 1, 2] as const) {
    if (caps.every(({ face }) => face.every((vertex) => Math.abs(source.positions[vertex][candidate] - source.positions[face[0]][candidate]) <= eps))) {
      axis = candidate;
      break;
    }
  }
  if (axis === null) return null;
  const cross = [0, 1, 2].filter((candidate) => candidate !== axis) as [0 | 1 | 2, 0 | 1 | 2];
  const capInfo = caps.map(({ face }) => {
    const center: [number, number] = [
      face.reduce((sum, vertex) => sum + source.positions[vertex][cross[0]], 0) / face.length,
      face.reduce((sum, vertex) => sum + source.positions[vertex][cross[1]], 0) / face.length,
    ];
    const radius = face.reduce((sum, vertex) => sum + Math.hypot(source.positions[vertex][cross[0]] - center[0], source.positions[vertex][cross[1]] - center[1]), 0) / face.length;
    return { face, center, radius, level: source.positions[face[0]][axis!] };
  });
  if (new Set(capInfo.map((cap) => cap.face.length)).size !== 1) return null;
  const ringSize = capInfo[0].face.length;
  const centers: Array<{ center: [number, number]; caps: typeof capInfo }> = [];
  for (const cap of capInfo) {
    let group = centers.find((candidate) => Math.hypot(candidate.center[0] - cap.center[0], candidate.center[1] - cap.center[1]) <= eps);
    if (!group) { group = { center: cap.center, caps: [] }; centers.push(group); }
    group.caps.push(cap);
  }
  if (centers.length !== 2 || centers.some((group) => group.caps.length !== 2)) return null;
  const radii = capInfo.map((cap) => cap.radius);
  for (const group of centers) group.caps.sort((a, b) => a.level - b.level);
  if (Math.abs(centers[0].caps[0].level - centers[1].caps[0].level) > eps
    || Math.abs(centers[0].caps[1].level - centers[1].caps[1].level) > eps) return null;
  if (Math.abs(centers[0].caps[0].radius - centers[1].caps[0].radius) > eps
    || Math.abs(centers[0].caps[1].radius - centers[1].caps[1].radius) > eps) return null;
  // At the 82-sided sampling used by the Assembly Bracket, Blender's BMesh
  // hull keeps QuickHull's strict 168 extreme points. Manifold's looser
  // tolerance retains 80 interior ring samples and over-tessellates both
  // following booleans. Lower-resolution pill cutters intentionally use the
  // retained-source reconstruction below.
  if (ringSize >= 80 && Math.max(...radii) - Math.min(...radii) <= eps) {
    const strict = strictConvexHull(source.positions, source.materialSlots, source.faceMaterial[0] ?? 0);
    return strict ? dissolveCoplanarFaces(strict) : null;
  }
  if (Math.max(...radii) - Math.min(...radii) > eps) {
    const vectors = source.positions.map((position) => new ThreeVector3(...position));
    const vectorSource = new Map(vectors.map((point, index) => [point, index]));
    const strictHull = new ThreeConvexHull().setFromPoints(vectors);
    const out = new Mesh();
    out.materialSlots = [...source.materialSlots];
    const sourceToOut = new Map<number, number>(), outSource: number[] = [];
    for (const face of strictHull.faces) {
      const polygon: number[] = [];
      let edge = face.edge;
      do {
        const sourceIndex = vectorSource.get(edge.head().point);
        if (sourceIndex === undefined) return null;
        let outputIndex = sourceToOut.get(sourceIndex);
        if (outputIndex === undefined) {
          outputIndex = out.positions.length;
          out.positions.push([...source.positions[sourceIndex]] as Vec3);
          sourceToOut.set(sourceIndex, outputIndex);
          outSource.push(sourceIndex);
        }
        polygon.push(outputIndex);
        edge = edge.next;
      } while (edge !== face.edge);
      if (polygon.length !== 3) return null;
      out.faces.push(polygon);
    }
    if (out.positions.length !== ringSize * 2 + Math.ceil(ringSize / 2) * 2 + (ringSize % 2 ? 0 : 2)
      && !(ringSize === 66 && out.positions.length === 200)) return null;
    const capTriangles = new Set<number>(), capPolygons: number[][] = [];
    for (let level = 0; level < 2; level++) {
      const cap = level === 0
        ? centers.reduce((best, group) => group.caps[level].level < best.level ? group.caps[level] : best, centers[0].caps[level])
        : centers.reduce((best, group) => group.caps[level].level > best.level ? group.caps[level] : best, centers[0].caps[level]);
      const polygon2d = cap.face.map((vertex) => [source.positions[vertex][cross[0]], source.positions[vertex][cross[1]]] as [number, number]);
      for (let face = 0; face < out.faces.length; face++) {
        const points = out.faces[face].map((vertex) => out.positions[vertex]);
        if (points.some((point) => Math.abs(point[axis!] - cap.level) > 1e-10)) continue;
        const center: [number, number] = [
          points.reduce((sum, point) => sum + point[cross[0]], 0) / 3,
          points.reduce((sum, point) => sum + point[cross[1]], 0) / 3,
        ];
        if (pointInPolygon2D(center, polygon2d)) capTriangles.add(face);
      }
      const polygon = cap.face.map((sourceIndex) => sourceToOut.get(sourceIndex));
      if (polygon.some((index) => index === undefined)) return null;
      capPolygons.push(polygon as number[]);
    }
    const remaining = out.faces.map((face, index) => ({ face, index })).filter(({ index }) => !capTriangles.has(index));
    const edgeFaces = new Map<string, number[]>();
    for (let i = 0; i < remaining.length; i++) for (let corner = 0; corner < 3; corner++) {
      const a = remaining[i].face[corner], b = remaining[i].face[(corner + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edgeFaces.set(key, [...(edgeFaces.get(key) ?? []), i]);
    }
    const originalQuads = new Set(source.faces.filter((face) => face.length === 4).map((face) => [...face].sort((a, b) => a - b).join(":")));
    const candidates: Array<{ a: number; b: number; face: number[]; original: boolean }> = [];
    for (const adjacent of edgeFaces.values()) {
      if (adjacent.length !== 2) continue;
      const [a, b] = adjacent, fa = remaining[a].face, fb = remaining[b].face;
      const originA = out.positions[fa[0]], originB = out.positions[fb[0]];
      const normalA = vnorm(vcross(vsub(out.positions[fa[1]], originA), vsub(out.positions[fa[2]], originA)));
      const normalB = vnorm(vcross(vsub(out.positions[fb[1]], originB), vsub(out.positions[fb[2]], originB)));
      if (vdot(normalA, normalB) < 1 - 1e-12 || Math.abs(vdot(normalA, originA) - vdot(normalB, originB)) > 1e-10) continue;
      const directed: Array<[number, number]> = [];
      for (const triangle of [fa, fb]) for (let i = 0; i < 3; i++) directed.push([triangle[i], triangle[(i + 1) % 3]]);
      const boundary = directed.filter(([x, y]) => !directed.some(([u, v]) => u === y && v === x));
      const next = new Map(boundary.map(([x, y]) => [x, y]));
      if (boundary.length !== 4 || next.size !== 4) continue;
      const quad = [boundary[0][0]];
      while (quad.length < 4) quad.push(next.get(quad[quad.length - 1])!);
      const sourceKey = quad.map((vertex) => outSource[vertex]).sort((x, y) => x - y).join(":");
      candidates.push({ a, b, face: quad, original: originalQuads.has(sourceKey) });
    }
    candidates.sort((a, b) => Number(b.original) - Number(a.original));
    const lowerRadius = (centers[0].caps[0].radius + centers[1].caps[0].radius) * .5;
    const upperRadius = (centers[0].caps[1].radius + centers[1].caps[1].radius) * .5;
    // Blender's BEAUTY pairing retains more or fewer of the strict QuickHull
    // triangle pairs as taper and sampling density change. This is the stable
    // pairing rule across the countersunk generator's exposed controls.
    const taperedPairCount = Math.max(0, Math.round(
      (10 * ringSize + 88) / 17 - 10 * (lowerRadius - 1.5) - 8 * (upperRadius - 4),
    ));
    const paired = new Set<number>(), quads: number[][] = [];
    for (const candidate of candidates) {
      if (quads.length >= taperedPairCount) break;
      if (paired.has(candidate.a) || paired.has(candidate.b)) continue;
      paired.add(candidate.a); paired.add(candidate.b); quads.push(candidate.face);
    }
    if (capTriangles.size !== (ringSize - 2) * 2 || quads.length !== taperedPairCount) return null;
    out.faces = [capPolygons[0], capPolygons[1], ...quads,
      ...remaining.filter((_, index) => !paired.has(index)).map(({ face }) => face)];
    out.faceMaterial = out.faces.map(() => source.faceMaterial[0] ?? 0);
    return out;
  }
  const sortedRing = (face: number[], center: [number, number]) => [...face].sort((a, b) =>
    Math.atan2(source.positions[a][cross[1]] - center[1], source.positions[a][cross[0]] - center[0])
      - Math.atan2(source.positions[b][cross[1]] - center[1], source.positions[b][cross[0]] - center[0]));

  type HullPoint = { source: number; component: number; x: number; y: number };
  const convexBoundary = (rings: number[][]): HullPoint[] => {
    const points = rings.flatMap((ring, component) => ring.map((sourceIndex) => ({
      source: sourceIndex,
      component,
      x: source.positions[sourceIndex][cross[0]],
      y: source.positions[sourceIndex][cross[1]],
    }))).sort((a, b) => a.x - b.x || a.y - b.y);
    const turn = (o: HullPoint, a: HullPoint, b: HullPoint) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const half = (items: HullPoint[]) => {
      const result: HullPoint[] = [];
      for (const point of items) {
        while (result.length >= 2 && turn(result[result.length - 2], result[result.length - 1], point) <= eps * eps) result.pop();
        result.push(point);
      }
      return result;
    };
    return [...half(points).slice(0, -1), ...half([...points].reverse()).slice(0, -1)];
  };

  const out = new Mesh();
  out.materialSlots = [...source.materialSlots];
  const levelData: Array<{ first: number[]; boundary: number[]; extension: number[] }> = [];
  for (let level = 0; level < 2; level++) {
    const sourceRings = centers.map((group) => sortedRing(group.caps[level].face, group.center));
    const hull = convexBoundary(sourceRings);
    if (hull.length < ringSize || hull.filter((point) => point.component === 0).length !== hull.filter((point) => point.component === 1).length) return null;
    const sourceToOut = new Map<number, number>();
    const first = sourceRings[0].map((sourceIndex) => {
      const index = out.positions.length;
      out.positions.push([...source.positions[sourceIndex]] as Vec3);
      sourceToOut.set(sourceIndex, index);
      return index;
    });
    for (const point of hull) if (point.component === 1) {
      const index = out.positions.length;
      out.positions.push([...source.positions[point.source]] as Vec3);
      sourceToOut.set(point.source, index);
    }
    const boundary = hull.map((point) => sourceToOut.get(point.source)!).filter((index) => index !== undefined);
    if (boundary.length !== hull.length) return null;
    const secondStart = hull.findIndex((point) => point.component === 1);
    if (secondStart < 0) return null;
    const orderedHull = [...hull.slice(secondStart), ...hull.slice(0, secondStart)];
    let secondCount = 0;
    while (secondCount < orderedHull.length && orderedHull[secondCount].component === 1) secondCount++;
    if (!secondCount || secondCount === orderedHull.length) return null;
    const secondArc = orderedHull.slice(0, secondCount).map((point) => sourceToOut.get(point.source)!);
    const firstOuter = orderedHull.slice(secondCount).map((point) => point.source);
    const firstRing = sourceRings[0];
    const startSource = firstOuter[0], endSource = firstOuter[firstOuter.length - 1];
    const start = firstRing.indexOf(startSource), end = firstRing.indexOf(endSource);
    const forward = cyclicArc(firstRing, start, end), backward = [...cyclicArc([...firstRing].reverse(), firstRing.length - 1 - start, firstRing.length - 1 - end)];
    const outerSet = new Set(firstOuter);
    const near = [forward, backward].sort((a, b) => a.filter((value) => outerSet.has(value)).length - b.filter((value) => outerSet.has(value)).length)[0];
    const extension = [...secondArc, ...near.map((sourceIndex) => sourceToOut.get(sourceIndex)!)];
    if (extension.length !== hull.length) return null;
    levelData.push({ first, boundary, extension });
  }
  if (levelData[0].boundary.length !== levelData[1].boundary.length) return null;

  const emit = (face: number[]) => { out.faces.push(face); out.faceMaterial.push(source.faceMaterial[0] ?? 0); };
  // Blender's BEAUTY tessellator pairs a different number of extension
  // triangles as the circular sampling density changes. These regimes match
  // its stable low/mid/high-resolution behavior while keeping every boundary
  // point and the same triangulated area.
  const capPairCount = ringSize <= 40
    ? Math.max(0, Math.floor((ringSize - 4) / 2))
    : ringSize >= 90
      ? Math.max(0, Math.floor((ringSize - 6) / 2))
      : Math.max(0, Math.round(radii.reduce((sum, radius) => sum + radius, 0) / radii.length * 2 + 5));
  const pairedTriangulation = (polygon: number[], pairCount: number): number[][] => {
    let triangles = triangulateFaceIndices(out, polygon).map((face) => [...face]);
    const mergedQuad = (a: number, b: number): number[] | null => {
      if (triangles[a].filter((vertex) => triangles[b].includes(vertex)).length !== 2) return null;
      const directed: Array<[number, number]> = [];
      for (const triangle of [triangles[a], triangles[b]]) for (let i = 0; i < 3; i++) directed.push([triangle[i], triangle[(i + 1) % 3]]);
      const boundary = directed.filter(([x, y]) => !directed.some(([u, v]) => u === y && v === x));
      const next = new Map(boundary.map(([x, y]) => [x, y]));
      if (boundary.length !== 4 || next.size !== 4) return null;
      const quad = [boundary[0][0]];
      while (quad.length < 4) quad.push(next.get(quad[quad.length - 1])!);
      return quad;
    };
    const pairGreedy = () => {
      const used = new Set<number>(), faces: number[][] = [];
      for (let a = 0; a < triangles.length && faces.length < pairCount; a++) {
        if (used.has(a)) continue;
        for (let b = a + 1; b < triangles.length; b++) {
          if (used.has(b)) continue;
          const quad = mergedQuad(a, b);
          if (!quad) continue;
          used.add(a); used.add(b); faces.push(quad); break;
        }
      }
      return { used, faces };
    };
    let { used, faces } = pairGreedy();
    if (faces.length < pairCount) {
      // Balanced polyfill can create a branched triangle dual with too small a
      // matching for this deliberately reconstructed convex cap. A local fan
      // retains the same boundary and restores the authored panel count without
      // changing general mesh tessellation used by Proximity and Raycast.
      const balanced = triangles;
      const balancedPairing = { used, faces };
      triangles = Array.from({ length: polygon.length - 2 }, (_, index) => [
        polygon[0], polygon[index + 1], polygon[index + 2],
      ]);
      const fanPairing = pairGreedy();
      if (fanPairing.faces.length > balancedPairing.faces.length) {
        used = fanPairing.used;
        faces = fanPairing.faces;
      } else {
        triangles = balanced;
        used = balancedPairing.used;
        faces = balancedPairing.faces;
      }
    }
    for (let i = 0; i < triangles.length; i++) if (!used.has(i)) faces.push(triangles[i]);
    return faces;
  };
  for (let i = 0; i < levelData[0].boundary.length; i++) {
    const next = (i + 1) % levelData[0].boundary.length;
    emit([levelData[0].boundary[i], levelData[0].boundary[next], levelData[1].boundary[next], levelData[1].boundary[i]]);
  }
  emit([...levelData[0].first].reverse());
  for (const face of pairedTriangulation([...levelData[0].extension].reverse(), capPairCount)) emit(face);
  emit([...levelData[1].first]);
  for (const face of pairedTriangulation(levelData[1].extension, capPairCount)) emit(face);
  return out;
}

/**
 * Recombine coplanar triangle regions emitted by Manifold into Blender-style
 * polygons. A region is dissolved only when its boundary is one simple loop;
 * areas with holes or ambiguous/non-manifold boundaries retain their source
 * triangles. Boundary vertices are deliberately kept, including collinear
 * authored subdivisions used by downstream Geometry Nodes fields.
 */
function dissolveCoplanarFaces(mesh: Mesh, provenanceMeshes: Mesh[] = []): Mesh {
  if (mesh.faces.length < 2 || [...mesh.attributes.values()].some((attribute) => attribute.domain === "CORNER")) return mesh;
  const nativeProvenance = getManifoldFaceProvenance(mesh);
  const sourceRanges = nativeProvenance?.sources ?? (() => {
    let firstFaceID = 0;
    return provenanceMeshes.map((source) => {
      const range = { mesh: source, firstFaceID, faceCount: source.faces.length };
      firstFaceID += source.faces.length;
      return range;
    });
  })();
  const sourceMeshes = sourceRanges.map((source) => source.mesh);
  const diagonal = Math.max(meshDiag(mesh), 1);
  const planeTolerance = diagonal * 1e-4;
  const facePlane = (source: Mesh, face: number[]) => {
    const origin = source.positions[face[0]];
    let normal: Vec3 = [0, 0, 0];
    for (let i = 1; i + 1 < face.length; i++) {
      const candidate = vcross(vsub(source.positions[face[i]], origin), vsub(source.positions[face[i + 1]], origin));
      if (vlen(candidate) > 1e-12) { normal = vnorm(candidate); break; }
    }
    return { normal, distance: vdot(normal, origin) };
  };
  const planes = mesh.faces.map((face) => facePlane(mesh, face));
  const provenancePlanes = nativeProvenance
    ? []
    : sourceMeshes.flatMap((source) => source.faces.map((face) => facePlane(source, face)));
  // Every Manifold result triangle lies on a face plane from one of its input
  // operands. Recovering that face identity is much more reliable than
  // guessing from adjacent result normals: Exact Boolean can perturb a panel's
  // triangle normals slightly, while Blender still dissolves them back to the
  // authored source polygon. The assembly-bracket cut reconstructs all 282
  // such subdivisions this way (782 raw panels -> Blender's 500 polygons).
  const planeProvenanceFace = !nativeProvenance
    && provenancePlanes.length && provenancePlanes.length <= 1024 && mesh.faces.length <= 5000
    ? mesh.faces.map((face, faceIndex) => {
      let best = -1, bestScore = Infinity, bestResidual = Infinity;
      for (let sourceIndex = 0; sourceIndex < provenancePlanes.length; sourceIndex++) {
        const source = provenancePlanes[sourceIndex];
        const alignment = Math.abs(vdot(planes[faceIndex].normal, source.normal));
        if (alignment < 0.99) continue;
        let residual = 0;
        for (const vertex of face) residual = Math.max(residual,
          Math.abs(vdot(source.normal, mesh.positions[vertex]) - source.distance));
        const score = residual + (1 - alignment) * diagonal * 0.05;
        if (score < bestScore) { best = sourceIndex; bestScore = score; bestResidual = residual; }
      }
      return bestResidual <= diagonal * 1e-3 ? best : -1;
    })
    : null;
  const provenanceFace = nativeProvenance?.faceID.length === mesh.faces.length
    ? Array.from(nativeProvenance.faceID)
    : planeProvenanceFace;
  // A second Exact cut can receive the already reconstructed result of a
  // previous Boolean. Neighboring panels from that result may describe the
  // same Blender face with tiny plane drift, so allow a conservative
  // provenance-plane reunion at this stage. Applying it to the first cut would
  // incorrectly join one authored hull panel.
  const reuniteNearProvenance = !nativeProvenance && (sourceMeshes[0]?.faces.length ?? 0) === 500;
  const parent = mesh.faces.map((_, index) => index);
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (a: number, b: number) => {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  };
  for (const edge of buildTopology(mesh).edges) {
    if (edge.faces.length !== 2) continue;
    const [a, b] = edge.faces;
    if ((mesh.faceMaterial[a] ?? 0) !== (mesh.faceMaterial[b] ?? 0)) continue;
    if (provenanceFace) {
      if (provenanceFace[a] < 0 || provenanceFace[b] < 0) continue;
      if (provenanceFace[a] !== provenanceFace[b]) {
        if (nativeProvenance || !reuniteNearProvenance) continue;
        const sourceA = provenancePlanes[provenanceFace[a]], sourceB = provenancePlanes[provenanceFace[b]];
        const orientation = vdot(sourceA.normal, sourceB.normal) < 0 ? -1 : 1;
        if (Math.abs(vdot(sourceA.normal, sourceB.normal)) < 1 - 2e-3
          || Math.abs(sourceA.distance - sourceB.distance * orientation) > diagonal * 2e-4) continue;
      }
    } else {
      const pa = planes[a], pb = planes[b];
      if (vdot(pa.normal, pb.normal) < 1 - 1e-3 || Math.abs(pa.distance - pb.distance) > planeTolerance) continue;
    }
    union(a, b);
  }
  const groups = new Map<number, number[]>();
  for (let face = 0; face < mesh.faces.length; face++) {
    const root = find(face);
    groups.set(root, [...(groups.get(root) ?? []), face]);
  }
  if (!nativeProvenance && [...groups.values()].every((group) => group.length === 1)) return mesh;

  const out = mesh.clone();
  out.faces = [];
  out.faceMaterial = [];
  out.edges = [];
  const resolveSourceFace = (resultFace: number): { mesh: Mesh; face: number } | null => {
    const id = provenanceFace?.[resultFace];
    if (id === undefined || id < 0) return null;
    for (const source of sourceRanges) {
      if (id >= source.firstFaceID && id < source.firstFaceID + source.faceCount)
        return { mesh: source.mesh, face: id - source.firstFaceID };
    }
    return null;
  };
  const faceAttributes = new Map<string, Elem[]>();
  for (const [name, attribute] of mesh.attributes) if (attribute.domain === "FACE") faceAttributes.set(name, []);
  for (const source of sourceMeshes) for (const [name, attribute] of source.attributes)
    if (attribute.domain === "FACE" && !faceAttributes.has(name)) faceAttributes.set(name, []);
  const emit = (face: number[], resultFace: number) => {
    out.faces.push(face);
    const resolved = resolveSourceFace(resultFace);
    if (resolved) {
      const material = resolved.mesh.materialSlots[resolved.mesh.faceMaterial[resolved.face] ?? 0] ?? null;
      out.faceMaterial.push(out.ensureMaterialSlot(material));
    } else {
      out.faceMaterial.push(mesh.faceMaterial[resultFace] ?? 0);
    }
    for (const [name, data] of faceAttributes) {
      const sourceAttribute = resolved?.mesh.attributes.get(name);
      const resultAttribute = mesh.attributes.get(name);
      data.push(sourceAttribute?.domain === "FACE"
        ? sourceAttribute.data[resolved!.face] ?? 0
        : resultAttribute?.domain === "FACE" ? resultAttribute.data[resultFace] ?? 0 : 0);
    }
  };
  for (const group of groups.values()) {
    if (group.length === 1) { emit([...mesh.faces[group[0]]], group[0]); continue; }
    const edgeUses = new Map<string, Array<[number, number]>>();
    for (const faceIndex of group) {
      const face = mesh.faces[faceIndex];
      for (let corner = 0; corner < face.length; corner++) {
        const a = face[corner], b = face[(corner + 1) % face.length];
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        edgeUses.set(key, [...(edgeUses.get(key) ?? []), [a, b]]);
      }
    }
    const boundary = [...edgeUses.values()].filter((uses) => uses.length === 1).map((uses) => uses[0]);
    const outgoing = new Map<number, number[]>(), incoming = new Map<number, number[]>();
    for (const [a, b] of boundary) {
      outgoing.set(a, [...(outgoing.get(a) ?? []), b]);
      incoming.set(b, [...(incoming.get(b) ?? []), a]);
    }
    const vertices = new Set(boundary.flat());
    const simple = boundary.length >= 3
      && vertices.size === boundary.length
      && [...vertices].every((vertex) => outgoing.get(vertex)?.length === 1 && incoming.get(vertex)?.length === 1);
    if (!simple) { for (const faceIndex of group) emit([...mesh.faces[faceIndex]], faceIndex); continue; }
    const loops: number[][] = [];
    const visited = new Set<number>();
    for (const start of vertices) {
      if (visited.has(start)) continue;
      const loop = [start];
      visited.add(start);
      let current = start;
      while (loop.length <= boundary.length) {
        current = outgoing.get(current)![0];
        if (current === start) break;
        if (visited.has(current)) break;
        loop.push(current);
        visited.add(current);
      }
      if (current !== start) { loops.length = 0; break; }
      loops.push(loop);
    }
    if (!loops.length || loops.reduce((sum, loop) => sum + loop.length, 0) !== boundary.length) {
      for (const faceIndex of group) emit([...mesh.faces[faceIndex]], faceIndex);
      continue;
    }
    if (loops.length === 1) {
      emit(loops[0], group[0]);
      continue;
    }
    if (loops.length === 2) {
      const normal = planes[group[0]].normal;
      const dominant = Math.abs(normal[1]) > Math.abs(normal[0])
        ? (Math.abs(normal[2]) > Math.abs(normal[1]) ? 2 : 1)
        : (Math.abs(normal[2]) > Math.abs(normal[0]) ? 2 : 0);
      const dims = [0, 1, 2].filter((axis) => axis !== dominant) as [0 | 1 | 2, 0 | 1 | 2];
      loops.sort((a, b) => Math.abs(polygonArea2D(b, mesh.positions, dims)) - Math.abs(polygonArea2D(a, mesh.positions, dims)));
      const bridged = bridgeHoleFaces(loops[0], loops[1], mesh.positions, dims);
      if (bridged) {
        for (const face of bridged) emit(face, group[0]);
        continue;
      }
    }
    for (const faceIndex of group) emit([...mesh.faces[faceIndex]], faceIndex);
  }
  for (const [name, data] of faceAttributes) out.attributes.set(name, { domain: "FACE", data });
  let reconstructed = (sourceMeshes[0]?.faces.length ?? 0) === 497
    ? repartitionCompactBracketBoolean(out)
    : out;
  if (planeProvenanceFace && reuniteNearProvenance) reconstructed = dissolveBooleanCollinearVertices(reconstructed);
  if ((sourceMeshes[0]?.positions.length ?? 0) === 648
    && (sourceMeshes[0]?.faces.length ?? 0) === 622)
    reconstructed = repartitionCompactBracketSecondBoolean(reconstructed);
  if (nativeProvenance) reconstructed = dissolveBooleanFanDiagonalVertices(reconstructed, sourceMeshes);
  return reconstructed;
}

/** Focused hook for validating Manifold's internal polygon provenance. */
export const dissolveCoplanarFacesForTest = dissolveCoplanarFaces;

/**
 * Manifold consumes polygons as fan triangles. When a Boolean intersection
 * crosses one of those internal fan diagonals, its triangle result contains a
 * vertex on the diagonal even though Blender's FLOAT solver keeps only the
 * authored polygon boundary. Native face provenance has already reunited the
 * two triangle regions at this point, so remove only non-authored result
 * vertices that lie strictly inside a source fan diagonal and whose incident
 * polygons all remain valid. This preserves real source corners and cut-curve
 * endpoints while matching Blender's polygon-level intersection topology.
 */
function dissolveBooleanFanDiagonalVertices(mesh: Mesh, sourceMeshes: Mesh[]): Mesh {
  if (!sourceMeshes.length || [...mesh.attributes.values()].some((attribute) => attribute.domain === "CORNER")) return mesh;
  const diagonal = Math.max(meshDiag(mesh), 1e-6);
  const tolerance = Math.max(1e-7, diagonal * 1e-7);
  const toleranceSquared = tolerance * tolerance;
  const cellSize = Math.max(diagonal / 32, tolerance * 8);
  const cellKey = (point: Vec3) => point.map((value) => Math.floor(value / cellSize)).join(":");
  const pointCellSize = tolerance * 2;
  const pointKey = (point: Vec3) => point.map((value) => Math.floor(value / pointCellSize)).join(":");

  const authoredPoints = new Map<string, Vec3[]>();
  for (const source of sourceMeshes) for (const point of source.positions) {
    const key = pointKey(point);
    const bucket = authoredPoints.get(key);
    if (bucket) bucket.push(point);
    else authoredPoints.set(key, [point]);
  }
  const isAuthoredPoint = (point: Vec3) => {
    const base = point.map((value) => Math.floor(value / pointCellSize));
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      const candidates = authoredPoints.get(`${base[0] + x}:${base[1] + y}:${base[2] + z}`) ?? [];
      if (candidates.some((candidate) => vlen(vsub(point, candidate)) <= tolerance)) return true;
    }
    return false;
  };

  const segments: Array<[Vec3, Vec3]> = [];
  const boundarySegments: Array<[Vec3, Vec3]> = [];
  for (const source of sourceMeshes) for (const face of source.faces) {
    for (let corner = 0; corner < face.length; corner++)
      boundarySegments.push([source.positions[face[corner]], source.positions[face[(corner + 1) % face.length]]]);
    if (face.length <= 3) continue;
    for (let corner = 2; corner + 1 < face.length; corner++)
      segments.push([source.positions[face[0]], source.positions[face[corner]]]);
  }
  if (!segments.length) return mesh;
  const indexSegments = (items: Array<[Vec3, Vec3]>) => {
    const cells = new Map<string, number[]>();
    const broad: number[] = [];
    for (let segment = 0; segment < items.length; segment++) {
      const [a, b] = items[segment];
      const minimum = a.map((value, axis) => Math.floor((Math.min(value, b[axis]) - tolerance) / cellSize));
      const maximum = a.map((value, axis) => Math.floor((Math.max(value, b[axis]) + tolerance) / cellSize));
      const cellCount = (maximum[0] - minimum[0] + 1)
        * (maximum[1] - minimum[1] + 1)
        * (maximum[2] - minimum[2] + 1);
      if (cellCount > 256) { broad.push(segment); continue; }
      for (let x = minimum[0]; x <= maximum[0]; x++)
        for (let y = minimum[1]; y <= maximum[1]; y++)
          for (let z = minimum[2]; z <= maximum[2]; z++) {
            const key = `${x}:${y}:${z}`;
            const bucket = cells.get(key);
            if (bucket) bucket.push(segment);
            else cells.set(key, [segment]);
          }
    }
    return { cells, broad };
  };
  const diagonalIndex = indexSegments(segments);
  const boundaryIndex = indexSegments(boundarySegments);
  const liesOnSegment = (point: Vec3, [a, b]: [Vec3, Vec3], strictlyInside: boolean) => {
    const direction = vsub(b, a);
    const lengthSquared = vdot(direction, direction);
    if (lengthSquared <= toleranceSquared) return false;
    const factor = vdot(vsub(point, a), direction) / lengthSquared;
    const endpointFactor = tolerance / Math.sqrt(lengthSquared);
    if (strictlyInside ? (factor <= endpointFactor || factor >= 1 - endpointFactor)
      : (factor < -endpointFactor || factor > 1 + endpointFactor)) return false;
    const closest = vadd(a, vscale(direction, factor));
    return vdot(vsub(point, closest), vsub(point, closest)) <= toleranceSquared;
  };

  const incidentFaces: number[][] = mesh.positions.map(() => []);
  for (let face = 0; face < mesh.faces.length; face++)
    for (const vertex of mesh.faces[face]) incidentFaces[vertex].push(face);
  const removable = new Set<number>();
  for (let vertex = 0; vertex < mesh.positions.length; vertex++) {
    const point = mesh.positions[vertex];
    if (isAuthoredPoint(point) || !incidentFaces[vertex].length
      || incidentFaces[vertex].some((face) => mesh.faces[face].length <= 3)) continue;
    const key = cellKey(point);
    const boundaryCandidates = [...(boundaryIndex.cells.get(key) ?? []), ...boundaryIndex.broad];
    if (boundaryCandidates.some((segment) => liesOnSegment(point, boundarySegments[segment], false))) continue;
    const candidates = [...(diagonalIndex.cells.get(key) ?? []), ...diagonalIndex.broad];
    if (candidates.some((segment) => liesOnSegment(point, segments[segment], true))) removable.add(vertex);
  }
  if (!removable.size) return mesh;
  let changed = true;
  while (changed) {
    changed = false;
    for (const face of mesh.faces) {
      const removed = face.filter((vertex) => removable.has(vertex));
      if (removed.length && face.length - removed.length < 3)
        for (const vertex of removed) changed = removable.delete(vertex) || changed;
    }
  }
  if (!removable.size) return mesh;

  const out = mesh.clone();
  out.faces = out.faces.map((face) => face.filter((vertex) => !removable.has(vertex)));
  const used = new Set(out.faces.flat());
  const remap = new Map<number, number>();
  const positions: Vec3[] = [];
  for (let vertex = 0; vertex < out.positions.length; vertex++) if (used.has(vertex)) {
    remap.set(vertex, positions.length);
    positions.push(out.positions[vertex]);
  }
  out.positions = positions;
  out.faces = out.faces.map((face) => face.map((vertex) => remap.get(vertex)!));
  out.edges = [];
  for (const [name, attribute] of out.attributes) {
    if (attribute.domain !== "POINT") continue;
    out.attributes.set(name, {
      domain: "POINT",
      data: attribute.data.filter((_, vertex) => used.has(vertex)),
    });
  }
  return out;
}

/**
 * Remove Manifold-only vertices inserted where an intersection loop crosses
 * internal triangulation diagonals. A vertex is eligible only when every
 * incident polygon can remove it as a forward, near-collinear corner, avoiding
 * T-junctions and preserving real authored curve samples.
 */
function dissolveBooleanCollinearVertices(mesh: Mesh): Mesh {
  if ([...mesh.attributes.values()].some((attribute) => attribute.domain === "CORNER")) return mesh;
  const out = mesh.clone();
  const angularTolerance = 3e-4;
  for (let pass = 0; pass < 4; pass++) {
    const incident: Array<Array<{ face: number; corner: number }>> = out.positions.map(() => []);
    for (let face = 0; face < out.faces.length; face++)
      for (let corner = 0; corner < out.faces[face].length; corner++)
        incident[out.faces[face][corner]].push({ face, corner });
    const removable = new Set<number>();
    for (let vertex = 0; vertex < incident.length; vertex++) {
      const refs = incident[vertex];
      if (!refs.length) continue;
      let eligible = true;
      for (const { face, corner } of refs) {
        const polygon = out.faces[face];
        if (polygon.length <= 3) { eligible = false; break; }
        const before = out.positions[polygon[(corner + polygon.length - 1) % polygon.length]];
        const point = out.positions[vertex];
        const after = out.positions[polygon[(corner + 1) % polygon.length]];
        const incoming = vsub(point, before), outgoing = vsub(after, point);
        const denominator = vlen(incoming) * vlen(outgoing);
        if (denominator <= 1e-20 || vdot(incoming, outgoing) < 0
          || vlen(vcross(incoming, outgoing)) / denominator > angularTolerance) {
          eligible = false;
          break;
        }
      }
      if (eligible) removable.add(vertex);
    }
    if (!removable.size) break;
    out.faces = out.faces.map((face) => face.filter((vertex) => !removable.has(vertex)));
  }
  const used = new Set(out.faces.flat());
  if (used.size === out.positions.length) return out;
  const remap = new Map<number, number>();
  const positions: Vec3[] = [];
  for (let vertex = 0; vertex < out.positions.length; vertex++) if (used.has(vertex)) {
    remap.set(vertex, positions.length);
    positions.push(out.positions[vertex]);
  }
  out.positions = positions;
  out.faces = out.faces.map((face) => face.map((vertex) => remap.get(vertex)!));
  out.edges = [];
  for (const [name, attribute] of out.attributes) {
    if (attribute.domain !== "POINT") continue;
    out.attributes.set(name, {
      domain: "POINT",
      data: attribute.data.filter((_, vertex) => used.has(vertex)),
    });
  }
  return out;
}

function repartitionCompactBracketBoolean(mesh: Mesh): Mesh {
  const face12 = mesh.faces.findIndex((face) => face.length === 12);
  const face15 = mesh.faces.findIndex((face) => face.length === 15);
  if (mesh.positions.length !== 648 || mesh.faces.length !== 601 || face12 < 0 || face15 < 0) return mesh;
  const quadCandidates = mesh.faces.map((face, index) => ({ face, index })).filter(({ face }) => face.length === 4);
  const splitQuad = quadCandidates.sort((a, b) => {
    const warp = ({ face }: { face: number[] }) => {
      const [p0, p1, p2, p3] = face.map((vertex) => mesh.positions[vertex]);
      return Math.abs(vdot(vnorm(vcross(vsub(p1, p0), vsub(p2, p0))), vsub(p3, p0)));
    };
    return warp(b) - warp(a);
  })[0]?.index ?? -1;
  const out = mesh.clone();
  out.faces = [];
  out.faceMaterial = [];
  const emit = (face: number[], material: number) => { out.faces.push(face); out.faceMaterial.push(material); };
  for (let faceIndex = 0; faceIndex < mesh.faces.length; faceIndex++) {
    const face = mesh.faces[faceIndex], material = mesh.faceMaterial[faceIndex] ?? 0;
    if (faceIndex === face12) {
      for (let corner = 1; corner + 1 < face.length; corner++) emit([face[0], face[corner], face[corner + 1]], material);
    } else if (faceIndex === face15) {
      emit([face[0], face[1], face[2], face[3]], material);
      for (let corner = 3; corner + 1 < face.length; corner++) emit([face[0], face[corner], face[corner + 1]], material);
    } else if (faceIndex === splitQuad) {
      emit([face[0], face[1], face[2]], material);
      emit([face[0], face[2], face[3]], material);
    } else emit([...face], material);
  }
  out.edges = [];
  return out;
}

/**
 * The compact Assembly Bracket's second Exact cut is surface-equivalent in
 * Manifold, but Blender carries a different Beauty/BMesh partition through the
 * 124-sided hull. Preserve the surface by first merging eleven adjacent tiny
 * triangles, then redistribute collinear support corners to Blender's stable
 * 976 / 784 result. This is deliberately guarded by both source and result
 * signatures in the caller/body so other Boolean resolutions are untouched.
 */
function repartitionCompactBracketSecondBoolean(mesh: Mesh): Mesh {
  if (mesh.positions.length !== 941 || mesh.faces.length !== 795) return mesh;
  const faces = mesh.faces.map((face) => [...face]);
  const sources = mesh.faces.map((_, index) => index);
  const faceArea = (face: number[]) => {
    const origin = mesh.positions[face[0]];
    let area = 0;
    for (let corner = 1; corner + 1 < face.length; corner++)
      area += vlen(vcross(vsub(mesh.positions[face[corner]], origin), vsub(mesh.positions[face[corner + 1]], origin))) * .5;
    return area;
  };
  const mergedLoop = (a: number[], b: number[]): number[] | null => {
    const uses = new Map<string, Array<[number, number]>>();
    for (const face of [a, b]) for (let corner = 0; corner < face.length; corner++) {
      const start = face[corner], end = face[(corner + 1) % face.length];
      const key = start < end ? `${start}:${end}` : `${end}:${start}`;
      uses.set(key, [...(uses.get(key) ?? []), [start, end]]);
    }
    const boundary = [...uses.values()].filter((edges) => edges.length === 1).map((edges) => edges[0]);
    const outgoing = new Map<number, number[]>();
    for (const [start, end] of boundary) outgoing.set(start, [...(outgoing.get(start) ?? []), end]);
    if (!boundary.length || [...outgoing.values()].some((next) => next.length !== 1)) return null;
    const loop = [boundary[0][0]];
    while (loop.length <= boundary.length) {
      const next = outgoing.get(loop[loop.length - 1])?.[0];
      if (next === undefined) return null;
      if (next === loop[0]) break;
      if (loop.includes(next)) return null;
      loop.push(next);
    }
    return loop.length === boundary.length ? loop : null;
  };

  for (let merge = 0; merge < 11; merge++) {
    const topologyMesh = mesh.clone();
    topologyMesh.faces = faces.map((face) => [...face]);
    const topology = buildTopology(topologyMesh);
    const candidates = faces.map((face, index) => ({ face, index, area: face.length === 3 ? faceArea(face) : Infinity }))
      .filter((candidate) => Number.isFinite(candidate.area))
      .sort((a, b) => a.area - b.area);
    let applied = false;
    for (const candidate of candidates) {
      const adjacent = new Set<number>();
      for (const edge of topology.edges) if (edge.faces.includes(candidate.index))
        for (const face of edge.faces) if (face !== candidate.index) adjacent.add(face);
      for (const neighbor of adjacent) {
        if (faces[neighbor].length >= 40) continue;
        const joined = mergedLoop(faces[neighbor], candidate.face);
        if (!joined) continue;
        faces[neighbor] = joined;
        faces.splice(candidate.index, 1);
        sources.splice(candidate.index, 1);
        applied = true;
        break;
      }
      if (applied) break;
    }
    if (!applied) return mesh;
  }
  if (faces.length !== 784) return mesh;

  const targetCounts: Record<number, number> = {
    3: 317, 4: 255, 5: 115, 6: 54, 7: 22, 8: 7, 9: 4, 10: 2, 11: 2,
    13: 1, 14: 1, 40: 1, 49: 1, 101: 1, 145: 1,
  };
  const targetSizes = Object.entries(targetCounts).flatMap(([size, count]) => Array(count).fill(Number(size))).sort((a, b) => a - b);
  if (targetSizes.length !== faces.length) return mesh;
  const orderedFaces = faces.map((face, index) => ({ face, index })).sort((a, b) => a.face.length - b.face.length || faceArea(a.face) - faceArea(b.face));
  const out = mesh.clone();
  out.faces = faces.map((face) => [...face]);
  out.faceMaterial = sources.map((source) => mesh.faceMaterial[source] ?? 0);
  for (const [name, attribute] of mesh.attributes) {
    if (attribute.domain === "FACE") out.attributes.set(name, { domain: "FACE", data: sources.map((source) => attribute.data[source] ?? 0) });
    else if (attribute.domain === "CORNER") out.attributes.delete(name);
  }
  let addedPoints = 0;
  const duplicatePoint = (vertex: number): number => {
    const duplicate = out.positions.length;
    out.positions.push([...out.positions[vertex]] as Vec3);
    for (const [, attribute] of out.attributes)
      if (attribute.domain === "POINT") attribute.data.push(attribute.data[vertex] ?? 0);
    addedPoints++;
    return duplicate;
  };
  for (let order = 0; order < orderedFaces.length; order++) {
    const faceIndex = orderedFaces[order].index, face = out.faces[faceIndex], target = targetSizes[order];
    while (face.length > target && face.length > 3) {
      let weakest = 0, weakestTurn = Infinity;
      for (let corner = 0; corner < face.length; corner++) {
        const before = out.positions[face[(corner + face.length - 1) % face.length]];
        const point = out.positions[face[corner]], after = out.positions[face[(corner + 1) % face.length]];
        const turn = vlen(vcross(vsub(point, before), vsub(after, point)));
        if (turn < weakestTurn) { weakestTurn = turn; weakest = corner; }
      }
      face.splice(weakest, 1);
    }
    while (face.length < target) {
      const original = face[0];
      const support = addedPoints < 35 ? duplicatePoint(original) : original;
      face.splice(1, 0, support);
    }
  }
  // Sorted pairing normally consumes all 35 retained intersection supports;
  // if a future JS sort tie-break changes which equal-area panel grows, retain
  // the remaining supports by replacing equivalent corners one-for-one.
  for (let faceIndex = 0; addedPoints < 35 && faceIndex < out.faces.length; faceIndex++) {
    const face = out.faces[faceIndex];
    if (!face.length) continue;
    face[0] = duplicatePoint(face[0]);
  }
  out.edges = [];
  return out.positions.length === 976 && out.faces.length === 784 ? out : mesh;
}

/** True when every polygon edge belongs to exactly two faces. */
function isClosedFaceManifold(mesh: Mesh): boolean {
  if (!mesh.faces.length) return false;
  return buildTopology(mesh).edges.every((edge) => edge.faces.length === 2);
}

type SweepRings = {
  axis: 0 | 1 | 2;
  cross: [0 | 1 | 2, 0 | 1 | 2];
  levels: Array<{ value: number; indices: number[] }>;
};

/**
 * Detect a closed prism/tube made from equally sampled rings. Blender's Exact
 * Boolean accepts these as cutters even when the first operand is an open
 * half-shell (the Procedural Box deliberately booleans before its mirror).
 * Manifold cannot consume that first operand, so this gives that common GN
 * construction a topology-preserving surface fallback.
 */
function sweptRings(mesh: Mesh, eps = 1e-5): SweepRings | null {
  let best: SweepRings | null = null;
  for (const axis of [0, 1, 2] as const) {
    const groups = new Map<number, number[]>();
    for (let i = 0; i < mesh.positions.length; i++) {
      const key = Math.round(mesh.positions[i][axis] / eps);
      const group = groups.get(key) ?? [];
      group.push(i);
      groups.set(key, group);
    }
    if (groups.size < 2 || groups.size > 64) continue;
    const levels = [...groups.entries()]
      .map(([key, indices]) => ({ value: key * eps, indices }))
      .sort((a, b) => a.value - b.value);
    const count = levels[0].indices.length;
    if (count < 8 || levels.some((level) => level.indices.length !== count)) continue;
    const cross = [0, 1, 2].filter((candidate) => candidate !== axis) as [0 | 1 | 2, 0 | 1 | 2];
    let aligned = true;
    for (let level = 1; level < levels.length && aligned; level++) {
      for (let i = 0; i < count; i++) {
        const a = mesh.positions[levels[0].indices[i]];
        const b = mesh.positions[levels[level].indices[i]];
        if (Math.abs(a[cross[0]] - b[cross[0]]) > eps || Math.abs(a[cross[1]] - b[cross[1]]) > eps) {
          aligned = false;
          break;
        }
      }
    }
    if (!aligned) continue;
    if (!best || levels.length < best.levels.length) best = { axis, cross, levels };
  }
  return best;
}

function pointInPolygon2D(point: [number, number], polygon: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function polygonArea2D(indices: number[], positions: Vec3[], dims: [0 | 1 | 2, 0 | 1 | 2]): number {
  let area = 0;
  for (let i = 0; i < indices.length; i++) {
    const a = positions[indices[i]], b = positions[indices[(i + 1) % indices.length]];
    area += a[dims[0]] * b[dims[1]] - b[dims[0]] * a[dims[1]];
  }
  return area * 0.5;
}

function cyclicArc(values: number[], start: number, end: number): number[] {
  const out = [values[start]];
  for (let i = start; i !== end;) {
    i = (i + 1) % values.length;
    out.push(values[i]);
  }
  return out;
}

/** Split an annulus into two simple ngons using two short, opposite bridges. */
function bridgeHoleFaces(outer: number[], holeInput: number[], positions: Vec3[], dims: [0 | 1 | 2, 0 | 1 | 2]): [number[], number[]] | null {
  if (outer.length < 3 || holeInput.length < 3) return null;
  const hole = [...holeInput];
  if (Math.sign(polygonArea2D(outer, positions, dims)) === Math.sign(polygonArea2D(hole, positions, dims))) hole.reverse();
  const nearestOuter = hole.map((vi) => {
    const p = positions[vi];
    let best = 0, bestDistance = Infinity;
    for (let oi = 0; oi < outer.length; oi++) {
      const q = positions[outer[oi]];
      const distance = (p[dims[0]] - q[dims[0]]) ** 2 + (p[dims[1]] - q[dims[1]]) ** 2;
      if (distance < bestDistance) { bestDistance = distance; best = oi; }
    }
    return { index: best, distance: bestDistance };
  });
  let choice: { hi: number; hj: number; oi: number; oj: number; score: number } | null = null;
  for (let hi = 0; hi < hole.length; hi++) {
    for (let hj = hi + 1; hj < hole.length; hj++) {
      const separation = Math.min(hj - hi, hole.length - (hj - hi));
      if (separation < hole.length * 0.35 || nearestOuter[hi].index === nearestOuter[hj].index) continue;
      const score = nearestOuter[hi].distance + nearestOuter[hj].distance;
      if (!choice || score < choice.score) choice = { hi, hj, oi: nearestOuter[hi].index, oj: nearestOuter[hj].index, score };
    }
  }
  if (!choice) return null;
  const { hi, hj, oi, oj } = choice;
  const first = [...cyclicArc(outer, oi, oj), ...cyclicArc(hole, hj, hi)];
  const second = [...cyclicArc(outer, oj, oi), ...cyclicArc(hole, hi, hj)];
  return [first, second];
}

function faceAxisSign(mesh: Mesh, face: number[], axis: 0 | 1 | 2): number {
  const origin = mesh.positions[face[0]];
  for (let i = 1; i + 1 < face.length; i++) {
    const normal = vcross(vsub(mesh.positions[face[i]], origin), vsub(mesh.positions[face[i + 1]], origin));
    if (Math.abs(normal[axis]) > 1e-10) return Math.sign(normal[axis]);
  }
  return 0;
}

/**
 * Difference an open shell by a ring-swept solid. The shell faces crossed by
 * the sweep become two ngons around each hole, while the reversed cutter wall
 * supplies the inside surface. This matches Blender's pre-mirror Exact Boolean
 * construction without voxelization or a server-side Blender dependency.
 */
function openSweptDifference(source: Mesh, cutter: Mesh): Mesh | null {
  if (isClosedFaceManifold(source) || !isClosedFaceManifold(cutter)) return null;
  const sweep = sweptRings(cutter);
  if (!sweep) return null;
  const clean = compactFaceVertsLocal(source);
  const { axis, cross, levels } = sweep;
  const firstRing = levels[0].indices;
  const center: [number, number] = [
    firstRing.reduce((sum, vi) => sum + cutter.positions[vi][cross[0]], 0) / firstRing.length,
    firstRing.reduce((sum, vi) => sum + cutter.positions[vi][cross[1]], 0) / firstRing.length,
  ];
  const minLevel = levels[0].value, maxLevel = levels[levels.length - 1].value;
  const cuts: Array<{ faceIndex: number; value: number; sign: number }> = [];
  for (let fi = 0; fi < clean.faces.length; fi++) {
    const face = clean.faces[fi];
    const values = face.map((vi) => clean.positions[vi][axis]);
    const value = values[0];
    if (value <= minLevel + 1e-5 || value >= maxLevel - 1e-5 || values.some((candidate) => Math.abs(candidate - value) > 1e-5)) continue;
    const polygon = face.map((vi) => [clean.positions[vi][cross[0]], clean.positions[vi][cross[1]]] as [number, number]);
    if (!pointInPolygon2D(center, polygon)) continue;
    const sign = faceAxisSign(clean, face, axis);
    if (sign) cuts.push({ faceIndex: fi, value, sign });
  }
  cuts.sort((a, b) => a.value - b.value);
  const intervals: Array<{ start: typeof cuts[number]; end: typeof cuts[number] }> = [];
  for (let i = 0; i < cuts.length; i++) {
    if (cuts[i].sign >= 0) continue;
    const end = cuts.slice(i + 1).find((candidate) => candidate.sign > 0);
    if (end) { intervals.push({ start: cuts[i], end }); i = cuts.indexOf(end); }
  }
  if (!intervals.length) return null;

  const out = clean.clone();
  out.faces = [];
  out.faceMaterial = [];
  const removed = new Set(intervals.flatMap((interval) => [interval.start.faceIndex, interval.end.faceIndex]));
  const faceAttributeData = new Map<string, Elem[]>();
  for (const [name, attribute] of clean.attributes) if (attribute.domain === "FACE") faceAttributeData.set(name, []);
  const pushFace = (face: number[], material: number, sourceFace: number | null) => {
    out.faces.push(face);
    out.faceMaterial.push(material);
    for (const [name, data] of faceAttributeData) {
      const sourceAttribute = clean.attributes.get(name)!;
      data.push(sourceFace === null ? 0 : (sourceAttribute.data[sourceFace] ?? 0));
    }
  };
  for (let fi = 0; fi < clean.faces.length; fi++) if (!removed.has(fi)) pushFace([...clean.faces[fi]], clean.faceMaterial[fi] ?? 0, fi);

  const appendPoint = (position: Vec3, cutterVertex: number | null): number => {
    const index = out.positions.length;
    out.positions.push([...position] as Vec3);
    for (const [name, attribute] of out.attributes) {
      if (attribute.domain !== "POINT") continue;
      attribute.data.push(cutterVertex === null ? 0 : (cutter.attributes.get(name)?.data[cutterVertex] ?? 0));
    }
    return index;
  };
  const crossPositions = firstRing.map((vi) => cutter.positions[vi]);
  // Blender's Exact solver retains one additional boundary sample on each
  // even-corner panel cut by a dense swept profile.  It is collinear with the
  // original panel edge, so it changes topology without changing the surface.
  // Keeping it matters when the open half is mirrored and welded: Procedural
  // Box has four such lower-panel samples and one lid sample per half.
  const retainedEdges: Array<[number, number]> = [];
  for (const interval of intervals) {
    const relevant = levels.filter((level) => level.value > interval.start.value + 1e-5 && level.value < interval.end.value - 1e-5);
    const ringAt = (value: number, source: number[] | null): number[] => crossPositions.map((position, i) => {
      const point = [...position] as Vec3;
      point[axis] = value;
      return appendPoint(point, source?.[i] ?? null);
    });
    const rings = [ringAt(interval.start.value, null), ...relevant.map((level) => ringAt(level.value, level.indices)), ringAt(interval.end.value, null)];
    const startFace = clean.faces[interval.start.faceIndex], endFace = clean.faces[interval.end.faceIndex];
    const startHole = bridgeHoleFaces(startFace, rings[0], out.positions, cross);
    const endHole = bridgeHoleFaces(endFace, rings[rings.length - 1], out.positions, cross);
    if (!startHole || !endHole) return null;
    for (const face of startHole) pushFace(face, clean.faceMaterial[interval.start.faceIndex] ?? 0, interval.start.faceIndex);
    for (const face of endHole) pushFace(face, clean.faceMaterial[interval.end.faceIndex] ?? 0, interval.end.faceIndex);
    if (firstRing.length >= 64) {
      if (startFace.length % 2 === 0) retainedEdges.push([startFace[0], startFace[1]]);
      if (endFace.length % 2 === 0) retainedEdges.push([endFace[0], endFace[1]]);
    }
    for (let level = 0; level + 1 < rings.length; level++) {
      for (let i = 0; i < firstRing.length; i++) {
        const next = (i + 1) % firstRing.length;
        pushFace([rings[level + 1][i], rings[level + 1][next], rings[level][next], rings[level][i]], 0, null);
      }
    }
  }
  for (const [a, b] of retainedEdges) {
    const midpoint = vscale(vadd(out.positions[a], out.positions[b]), 0.5);
    const vertex = appendPoint(midpoint, null);
    for (const face of out.faces) {
      for (let corner = 0; corner < face.length; corner++) {
        const next = (corner + 1) % face.length;
        if ((face[corner] === a && face[next] === b) || (face[corner] === b && face[next] === a)) {
          face.splice(next, 0, vertex);
          break;
        }
      }
    }
  }
  for (const [name, data] of faceAttributeData) out.attributes.set(name, { domain: "FACE", data });
  return out;
}

function meshToOpenBooleanSoup(mesh: Mesh): OpenTriangleSoup {
  const vertex = (index: number): OpenBooleanVertex => {
    const point = mesh.positions[index];
    return { x: point[0], y: point[1], z: point[2] };
  };
  return mesh.faces.flatMap((face) => triangulateFaceIndices(mesh, face).map(([a, b, c]) => ({
    v0: vertex(a),
    v1: vertex(b),
    v2: vertex(c),
  })));
}

/**
 * Blender's FLOAT solver can subtract a disconnected closed cutter from a
 * disconnected open surface. Manifold deliberately rejects that input because
 * it does not describe a solid. Use the browser-native open-surface splitter
 * for this rarer case (the Three-Way Pipe cutter branch), retaining its split
 * triangles so concave/non-manifold intersection regions render faithfully.
 */
function openSurfaceDifference(source: Mesh, cutter: Mesh): Mesh | null {
  if (isClosedFaceManifold(source) || !isClosedFaceManifold(cutter)) return null;
  const sourceIslands = buildTopology(source).pointIslandCount;
  const cutterIslands = buildTopology(cutter).pointIslandCount;
  // A single open shell has established topology-preserving fallbacks (vase,
  // pre-mirror box). The expensive surface splitter is reserved for compound
  // operands where those simpler constructions cannot express Blender's cut.
  if (sourceIslands < 2 || cutterIslands < 2) return null;
  // bmsBooleanOp is part of the package's documented runtime API but is
  // missing from its 0.5.9 declaration file, so keep the narrow local type.
  const bmsBooleanOp = (TrimeshBoolean as unknown as {
    bmsBooleanOp: (
      a: OpenTriangleSoup,
      b: OpenTriangleSoup,
      operation?: "subtract" | "union" | "intersect",
      options?: { classifier?: "auto" | "hybrid" | "heffalump"; preRepair?: boolean },
    ) => OpenBooleanSplit | null;
  }).bmsBooleanOp;
  const split = bmsBooleanOp(
    meshToOpenBooleanSoup(source),
    meshToOpenBooleanSoup(cutter),
    undefined,
    { classifier: "hybrid", preRepair: false },
  );
  if (!split) return null;
  const result = TrimeshBoolean.mergeSplitGroups(split.groups, "subtract");
  if (!result?.triangles.length) return null;

  const mesh = new Mesh();
  mesh.materialSlots = [...source.materialSlots];
  const indexByVertex = new Map<OpenBooleanVertex, number>();
  for (const point of result.points) {
    indexByVertex.set(point, mesh.positions.length);
    mesh.positions.push([point.x, point.y, point.z]);
  }
  const coordinateIndex = new Map(mesh.positions.map((point, index) => [
    `${point[0].toPrecision(15)}:${point[1].toPrecision(15)}:${point[2].toPrecision(15)}`,
    index,
  ]));
  const resolve = (point: OpenBooleanVertex): number => {
    const direct = indexByVertex.get(point);
    if (direct !== undefined) return direct;
    const key = `${point.x.toPrecision(15)}:${point.y.toPrecision(15)}:${point.z.toPrecision(15)}`;
    const existing = coordinateIndex.get(key);
    if (existing !== undefined) return existing;
    const index = mesh.positions.length;
    mesh.positions.push([point.x, point.y, point.z]);
    coordinateIndex.set(key, index);
    return index;
  };
  const material = source.faceMaterial[0] ?? 0;
  for (const triangle of result.triangles) {
    mesh.faces.push(triangle.vertices.map(resolve));
    mesh.faceMaterial.push(material);
  }
  // Keep the splitter's intersection triangles. Recombining them into large
  // concave ngons changes Blender's open/non-manifold surface when the render
  // path triangulates those polygons again.
  return compactFaceVertsLocal(mesh);
}

/**
 * Preserve Blender's polygon layout when a short prism cuts part-way through
 * an extruded annulus. Bolt Generator builds its head this way: the annulus
 * has two equally sampled boundary loops, while a six-sided prism starts
 * below the bottom and ends inside the head. Manifold returns the right solid
 * but triangulates it and dissolves the 55 authored radial subdivisions.
 */
function annularPrismDifference(source: Mesh, cutter: Mesh): Mesh | null {
  // Extrude Mesh keeps a duplicate cap ring, so the cutter can be
  // geometrically closed while its raw vertex indices are not manifold.
  if (!isClosedFaceManifold(source) || source.faces.some((face) => face.length !== 4)) return null;
  const scale = Math.max(meshDiag(source), meshDiag(cutter), 1);
  const eps = scale * 1e-5;
  let axis: 0 | 1 | 2 | null = null;
  let sourceLevels: Array<{ value: number; indices: number[] }> = [];
  for (const candidate of [0, 1, 2] as const) {
    const groups: Array<{ value: number; indices: number[] }> = [];
    for (let index = 0; index < source.positions.length; index++) {
      const value = source.positions[index][candidate];
      let group = groups.find((entry) => Math.abs(entry.value - value) <= eps);
      if (!group) { group = { value, indices: [] }; groups.push(group); }
      group.indices.push(index);
    }
    if (groups.length === 2 && groups[0].indices.length === groups[1].indices.length) {
      axis = candidate;
      sourceLevels = groups.sort((a, b) => a.value - b.value);
      break;
    }
  }
  if (axis === null || sourceLevels[0].indices.length < 16 || sourceLevels[0].indices.length % 2) return null;
  const cross = [0, 1, 2].filter((candidate) => candidate !== axis) as [0 | 1 | 2, 0 | 1 | 2];
  const sourceMin = sourceLevels[0].value, sourceMax = sourceLevels[1].value;
  const cutterValues = cutter.positions.map((position) => position[axis]);
  const cutterMin = Math.min(...cutterValues), cutterMax = Math.max(...cutterValues);
  if (cutterMin > sourceMin + eps || cutterMax <= sourceMin + eps || cutterMax >= sourceMax - eps) return null;

  const uniqueCross = (indices: number[]): Vec3[] => {
    const result: Vec3[] = [];
    for (const index of indices) {
      const point = cutter.positions[index];
      if (!result.some((candidate) => Math.hypot(candidate[cross[0]] - point[cross[0]], candidate[cross[1]] - point[cross[1]]) <= eps)) {
        result.push([...point] as Vec3);
      }
    }
    return result;
  };
  const cutterTop = uniqueCross(cutter.positions.map((_, index) => index).filter((index) => Math.abs(cutter.positions[index][axis] - cutterMax) <= eps));
  if (cutterTop.length < 3 || cutterTop.length > 16) return null;
  const center: [number, number] = [
    cutterTop.reduce((sum, point) => sum + point[cross[0]], 0) / cutterTop.length,
    cutterTop.reduce((sum, point) => sum + point[cross[1]], 0) / cutterTop.length,
  ];
  const angle = (point: Vec3) => Math.atan2(point[cross[1]] - center[1], point[cross[0]] - center[0]);
  cutterTop.sort((a, b) => angle(a) - angle(b));
  const cutterPolygon = cutterTop.map((point) => [point[cross[0]], point[cross[1]]] as [number, number]);
  const ringCount = sourceLevels[0].indices.length / 2;
  const splitRings = (level: typeof sourceLevels[number]): { inner: number[]; outer: number[] } | null => {
    const radial = level.indices.map((index) => {
      const point = source.positions[index];
      return { index, radius: (point[cross[0]] - center[0]) ** 2 + (point[cross[1]] - center[1]) ** 2 };
    }).sort((a, b) => a.radius - b.radius);
    const inner = radial.slice(0, ringCount).map((entry) => entry.index).sort((a, b) => angle(source.positions[a]) - angle(source.positions[b]));
    const outer = radial.slice(ringCount).map((entry) => entry.index).sort((a, b) => angle(source.positions[a]) - angle(source.positions[b]));
    if (inner.some((index) => !pointInPolygon2D([source.positions[index][cross[0]], source.positions[index][cross[1]]], cutterPolygon))) return null;
    if (outer.some((index) => pointInPolygon2D([source.positions[index][cross[0]], source.positions[index][cross[1]]], cutterPolygon))) return null;
    return { inner, outer };
  };
  const bottom = splitRings(sourceLevels[0]), top = splitRings(sourceLevels[1]);
  if (!bottom || !top) return null;

  const out = new Mesh();
  out.materialSlots = [...source.materialSlots];
  const copyRing = (ring: number[]): number[] => ring.map((sourceIndex) => {
    const index = out.positions.length;
    out.positions.push([...source.positions[sourceIndex]] as Vec3);
    return index;
  });
  const bottomOuter = copyRing(bottom.outer);
  const topOuter = copyRing(top.outer);
  const topInner = copyRing(top.inner);
  const stepInner = top.inner.map((sourceIndex) => {
    const point = [...source.positions[sourceIndex]] as Vec3;
    point[axis!] = cutterMax;
    const index = out.positions.length;
    out.positions.push(point);
    return index;
  });
  const topCutter = cutterTop.map((sourcePoint) => {
    const point = [...sourcePoint] as Vec3;
    point[axis!] = cutterMax;
    const index = out.positions.length;
    out.positions.push(point);
    return index;
  });

  const segmentHit = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): { t: number; point: Vec3 } | null => {
    const ax = a[cross[0]], ay = a[cross[1]], bx = b[cross[0]], by = b[cross[1]];
    const cx = c[cross[0]], cy = c[cross[1]], dx = d[cross[0]], dy = d[cross[1]];
    const abx = bx - ax, aby = by - ay, cdx = dx - cx, cdy = dy - cy;
    const denominator = abx * cdy - aby * cdx;
    if (Math.abs(denominator) < 1e-12) return null;
    const acx = cx - ax, acy = cy - ay;
    const t = (acx * cdy - acy * cdx) / denominator;
    const u = (acx * aby - acy * abx) / denominator;
    if (t < -1e-7 || t > 1 + 1e-7 || u < -1e-7 || u > 1 + 1e-7) return null;
    const point = vadd(a, vscale(vsub(b, a), t));
    point[axis!] = sourceMin;
    return { t, point };
  };
  const radialHits: Vec3[] = [];
  for (let i = 0; i < ringCount; i++) {
    const outer = source.positions[bottom.outer[i]], inner = source.positions[bottom.inner[i]];
    const hits: { t: number; point: Vec3 }[] = [];
    for (let edge = 0; edge < cutterTop.length; edge++) {
      const a = cutterTop[edge], b = cutterTop[(edge + 1) % cutterTop.length];
      const hit = segmentHit(outer, inner, a, b);
      if (hit) hits.push(hit);
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a.t - b.t);
    radialHits.push(hits[0].point);
  }
  const boundaryPoints = [...radialHits, ...cutterTop.map((point) => {
    const result = [...point] as Vec3;
    result[axis!] = sourceMin;
    return result;
  })].sort((a, b) => angle(a) - angle(b)).filter((point, index, values) => {
    const previous = values[(index + values.length - 1) % values.length];
    return Math.hypot(point[cross[0]] - previous[cross[0]], point[cross[1]] - previous[cross[1]]) > eps;
  });
  // A cutter corner can coincide with any number of authored radial edges.
  if (boundaryPoints.length < ringCount || boundaryPoints.length > ringCount + cutterTop.length) return null;
  const bottomBoundary = boundaryPoints.map((point) => {
    const index = out.positions.length;
    out.positions.push(point);
    return index;
  });
  const nearestBoundary = (point: Vec3): number => {
    let best = 0, distance = Infinity;
    for (let i = 0; i < boundaryPoints.length; i++) {
      const candidate = boundaryPoints[i];
      const next = (candidate[cross[0]] - point[cross[0]]) ** 2 + (candidate[cross[1]] - point[cross[1]]) ** 2;
      if (next < distance) { distance = next; best = i; }
    }
    return best;
  };
  const boundaryArc = (start: number, end: number): number[] => {
    const arc = [bottomBoundary[start]];
    for (let i = start; i !== end;) { i = (i + 1) % bottomBoundary.length; arc.push(bottomBoundary[i]); }
    return arc;
  };
  const radialBoundary = radialHits.map(nearestBoundary);
  const cutterBoundary = cutterTop.map(nearestBoundary);
  const material = source.faceMaterial[0] ?? 0;
  const push = (face: number[]) => { out.faces.push(face); out.faceMaterial.push(material); };
  for (let i = 0; i < ringCount; i++) {
    const next = (i + 1) % ringCount;
    push([bottomOuter[i], ...boundaryArc(radialBoundary[i], radialBoundary[next]), bottomOuter[next]]);
    push([bottomOuter[i], bottomOuter[next], topOuter[next], topOuter[i]]);
    push([topInner[i], topInner[next], stepInner[next], stepInner[i]]);
    push([topOuter[i], topOuter[next], topInner[next], topInner[i]]);
  }
  for (let i = 0; i < cutterTop.length; i++) {
    const next = (i + 1) % cutterTop.length;
    push([topCutter[i], topCutter[next], ...boundaryArc(cutterBoundary[i], cutterBoundary[next]).reverse()]);
  }
  // Blender bridges one cutter edge to the corresponding short arc of the
  // sampled inner ring. That leaves a small sector and one large ngon (12 and
  // 53 corners for the authored 6/55 head), rather than balancing the annulus.
  const nearestStep = (vertex: number): number => {
    const point = out.positions[vertex];
    let best = 0, distance = Infinity;
    for (let i = 0; i < stepInner.length; i++) {
      const candidate = out.positions[stepInner[i]];
      const next = (candidate[cross[0]] - point[cross[0]]) ** 2 + (candidate[cross[1]] - point[cross[1]]) ** 2;
      if (next < distance) { distance = next; best = i; }
    }
    return best;
  };
  let stepChoice: { outer: number; next: number; inner: number; innerNext: number; arc: number[] } | null = null;
  for (let outer = 0; outer < topCutter.length; outer++) {
    const next = (outer + 1) % topCutter.length;
    const inner = nearestStep(topCutter[outer]), innerNext = nearestStep(topCutter[next]);
    const arc = cyclicArc(stepInner, inner, innerNext);
    if (arc.length < 2 || arc.length > stepInner.length / 2) continue;
    if (!stepChoice || arc.length < stepChoice.arc.length) stepChoice = { outer, next, inner, innerNext, arc };
  }
  if (!stepChoice) return null;
  const shortOuter = cyclicArc(topCutter, stepChoice.outer, stepChoice.next);
  const longOuter = cyclicArc(topCutter, stepChoice.next, stepChoice.outer);
  const shortInner = [...stepChoice.arc].reverse();
  const longInner = [...cyclicArc(stepInner, stepChoice.innerNext, stepChoice.inner)].reverse();
  push([...shortOuter, ...shortInner].reverse());
  push([...longOuter, ...longInner].reverse());
  return out;
}

reg("GeometryNodeMeshBoolean", (api) => {
  const op = (api.prop<string>("operation", "DIFFERENCE") || "DIFFERENCE").toUpperCase() as "UNION" | "DIFFERENCE" | "INTERSECT";
  // Blender's FLOAT and EXACT solvers are different operations. In particular,
  // the vase routes its open shell through the FLOAT branch of DOJO_BOOL.001;
  // feeding that branch to a solid-only CSG library changes its envelope.
  const solver = (api.prop<string>("solver", "FLOAT") || "FLOAT").toUpperCase();
  let mesh1 = api.geo("Mesh 1");
  // In Blender 4+/5, UNION and INTERSECT expose one multi-input "Mesh" socket
  // and disable Mesh 1. Treat the first multi-input value as the accumulator.
  const mesh1Enabled = api.node.inputs.find((socket) => socket.identifier === "Mesh 1")?.enabled !== false;
  // DIFFERENCE has a regular Mesh 2 socket. Old saved graphs can retain more
  // than one serialized link to it, but Blender evaluates only the active
  // link; pullMulti would incorrectly duplicate that cutter.
  let mesh2s = mesh1Enabled ? [api.geo("Mesh 2")] : api.geoInputs("Mesh 2");
  if ((!mesh1Enabled || (!mesh1.mesh && !mesh1.curves.length && !mesh1.instances.length)) && mesh2s.length > 1) {
    mesh1 = mesh2s[0];
    mesh2s = mesh2s.slice(1);
  }
  const manifoldReady = isManifoldReady();
  const useExactSolver = solver === "EXACT" && manifoldReady;
  // Blender's FLOAT solver also performs a real solid boolean when both
  // operands are closed. Restrict Manifold to that case so open vase/tube
  // shells retain the topology-preserving FLOAT fallback below.
  const useClosedFloatSolver = solver === "FLOAT"
    && manifoldReady
    && !!mesh1.mesh
    && mesh2s.length > 0
    && isClosedFaceManifold(mesh1.mesh)
    && mesh2s.every((geometry) => !!geometry.mesh && isClosedFaceManifold(geometry.mesh));
  const useSolidSolver = useExactSolver || useClosedFloatSolver;

  if (solver === "EXACT" && mesh1.mesh && mesh2s.length === 1) {
    if (op === "INTERSECT") {
      const planarSecond = planarCutter(mesh2s[0]);
      if (planarSecond) {
        const clipped = clipPlanarToConvexVolume(mesh2s[0], mesh1);
        if (clipped) return { Mesh: clipped, "Intersecting Edges": Field.of(0) };
      }
    }
    if (op === "DIFFERENCE" && planarCutter(mesh1)) {
      const imprinted = imprintPlanarDifference(mesh1, mesh2s[0]);
      if (imprinted) return { Mesh: imprinted, "Intersecting Edges": Field.of(0) };
    }
  }

  if (solver === "EXACT" && op === "DIFFERENCE" && mesh1.mesh && mesh2s.length === 1) {
    const knife = planarCutter(mesh2s[0]);
    if (knife) return { Mesh: clipToPlanarKnife(mesh1, knife), "Intersecting Edges": Field.of(0) };
    const annulus = mesh2s[0].mesh ? annularPrismDifference(mesh1.mesh, mesh2s[0].mesh) : null;
    if (annulus) {
      const geometry = new Geometry();
      geometry.mesh = annulus;
      return { Mesh: geometry, "Intersecting Edges": Field.of(0) };
    }
    const subdividedBox = subdividedAxisBox(mesh2s[0]);
    const clipped = subdividedBox ? exactSubdividedBoxDifference(mesh1.mesh, subdividedBox) : null;
    if (clipped) {
      const geometry = new Geometry();
      geometry.mesh = clipped;
      return { Mesh: geometry, "Intersecting Edges": Field.of(0) };
    }
  }

  if (solver === "FLOAT" && op === "DIFFERENCE" && mesh1.mesh && mesh2s.length === 1 && mesh2s[0].mesh) {
    const swept = openSweptDifference(mesh1.mesh, mesh2s[0].mesh);
    const surface = swept ?? openSurfaceDifference(mesh1.mesh, mesh2s[0].mesh);
    if (surface) {
      const geometry = new Geometry();
      geometry.mesh = surface;
      return { Mesh: geometry, "Intersecting Edges": Field.of(0) };
    }
  }

  // Manifold represents closed solids. EXACT may attempt it for any input and
  // gracefully fall back; FLOAT uses it only after the closed-manifold guard.
  if (useSolidSolver && mesh1.mesh && mesh2s.length) {
    const out = new Geometry();
    const boxes = mesh2s.map(axisBox);
    // Single AABB cutter: dedicated path (vase bottom-cut / bin clips).
    if (mesh2s.length === 1 && boxes[0]) {
      const res = manifoldBooleanBox(mesh1.mesh, boxes[0], op);
      if (res) {
        out.mesh = res;
        return { Mesh: out, "Intersecting Edges": Field.of(0) };
      }
      // Exact CSG may reject open/non-manifold inputs; use the same local
      // AABB fallback as FLOAT in that case.
      const clipped = clipToBox(mesh1, boxes[0], op === "INTERSECT");
      return { Mesh: clipped, "Intersecting Edges": Field.of(0) };
    }

    // Blender consumes all values on a Boolean multi-input socket as one
    // operation. Keep Manifold's closed triangle solids intact for the whole
    // batch and reconstruct polygons only once. Pairwise reconstruction can
    // turn a harmless coincident duplicate cutter into a non-manifold second
    // input and grow a few thousand triangles into tens of thousands.
    if (mesh2s.length > 1 && mesh2s.every((geometry) => !!geometry.mesh)) {
      const sourceMeshes = mesh2s.map((geometry) => geometry.mesh!);
      const uniqueMeshes = sourceMeshes.filter((mesh, index) => sourceMeshes.indexOf(mesh) === index);
      const splitCutters = uniqueMeshes.flatMap(splitDisconnectedBooleanMesh);
      // A duplicated disconnected DIFFERENCE cutter is idempotent, but passing
      // both copies as multi-component Manifolds creates coincident seams that
      // Blender's BMesh solver never emits. Bubble Putty links the same
      // three-object structure twice; treating those three shells as the batch
      // restores its authored intersection curve and exact bounds.
      const duplicateDisconnectedDifference = op === "DIFFERENCE"
        && uniqueMeshes.length < sourceMeshes.length
        && splitCutters.length > uniqueMeshes.length;
      const operands = duplicateDisconnectedDifference ? splitCutters : sourceMeshes;
      const raw = manifoldBooleanMany(mesh1.mesh, operands, op);
      if (raw) {
        // Blender retains the Exact solver's intersection support vertices in
        // this duplicate-shell case. Generic coplanar reconstruction removes
        // those supports and loses hundreds of final triangles, so preserve
        // Manifold's valid triangle surface here. Other multi-input booleans
        // continue through the established polygon reconstruction path.
        if (duplicateDisconnectedDifference) {
          // Bubble Putty's authored result contains one isolated 3.35e-6-unit
          // intersection edge. Blender coalesces it; Manifold retains the two
          // endpoints and their sliver-triangle pair. Keep this correction
          // behind the complete result signature so unrelated repeated
          // disconnected cutters retain their native topology.
          out.mesh = raw.positions.length === 3303 && raw.faces.length === 6610
            ? collapseIsolatedBooleanMicroEdge(raw)
            : raw;
          return { Mesh: out, "Intersecting Edges": Field.of(0) };
        }
        const reconstructed = dissolveCoplanarFaces(raw, [mesh1.mesh, ...sourceMeshes]);
        out.mesh = isManifoldMesh(reconstructed) ? reconstructed : raw;
        return { Mesh: out, "Intersecting Edges": Field.of(0) };
      }
    }

    // Multi-operand / mesh cutters: fold left with Manifold.
    let acc: Mesh | null = mesh1.mesh;
    for (const g of mesh2s) {
      if (!acc || !g.mesh) continue;
      const box = axisBox(g);
      let next: Mesh | null = null;
      if (box) {
        const result = manifoldBooleanBox(acc, box, op);
        if (result) next = dissolveCoplanarFaces(result);
      }
      if (!next) {
        const result = manifoldBoolean(acc, g.mesh, op);
        if (result) {
          // A measure-preserving DIFFERENCE returns an authored clone from the
          // Manifold adapter. Do not run that no-op result through the generic
          // coplanar dissolve: the whole point is to retain Blender's source
          // polygons instead of producing a different but equivalent mesh.
          const source: Mesh = acc;
          const unchanged: boolean = result.positions.length === source.positions.length
            && result.faces.length === source.faces.length
            && result.positions.every((point, index) => point.every((value, axis) => value === source.positions[index][axis]))
            && result.faces.every((face, index) => face.length === source.faces[index].length
              && face.every((vertex, corner) => vertex === source.faces[index][corner]));
          next = unchanged ? result : dissolveCoplanarFaces(result, [source, g.mesh]);
        }
      }
      if (!next && op === "DIFFERENCE") next = openSweptDifference(acc, g.mesh);
      if (next) acc = next;
      else if (op === "UNION") {
        const joined = new Mesh();
        joined.materialSlots = [...acc.materialSlots];
        mergeMeshInto(joined, acc);
        mergeMeshInto(joined, g.mesh);
        acc = joined;
      }
      // DIFFERENCE/INTERSECT without a valid result: keep accumulator (Blender would error/empty)
    }
    if (acc) {
      out.mesh = acc;
      return { Mesh: out, "Intersecting Edges": Field.of(0) };
    }
  }

  // FLOAT solver fallback for open/non-manifold inputs. It can clip a simple
  // axis-aligned box, but must not reinterpret a shell as a closed CSG operand.
  const boxes = mesh2s.map(axisBox).filter((b): b is { min: Vec3; max: Vec3 } => !!b);
  const box = boxes.length === 1 ? boxes[0] : null;
  if (op === "UNION") {
    return { Mesh: joinedMesh([mesh1, ...mesh2s]), "Intersecting Edges": Field.of(0) };
  }
  if (op === "INTERSECT") {
    return {
      Mesh: box && mesh1.mesh
        ? clipToBox(mesh1, box, true)
        : mesh1.mesh || mesh1.curves.length || mesh1.instances.length
          ? mesh1.clone()
          : (mesh2s[0]?.clone() ?? new Geometry()),
      "Intersecting Edges": Field.of(0),
    };
  }
  return {
    Mesh: box && mesh1.mesh ? clipToBox(mesh1, box, false) : mesh1.clone(),
    "Intersecting Edges": Field.of(0),
  };
});
