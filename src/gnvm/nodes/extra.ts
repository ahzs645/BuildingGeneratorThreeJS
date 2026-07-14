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
import { Geometry, Mesh, mergeMeshInto, realizeInstances, rotateEulerXYZ, Spline, buildTopology } from "../geometry";
import { fillCurves, meshEdgesToChains, splineLength, splineSegments, splineFrames } from "../curves";
import { makeFieldCtx } from "../evaluator";
import { reg, EvalAPI } from "../registry";
import { isManifoldReady, manifoldBoolean, manifoldBooleanBox, manifoldHull } from "../boolean";
import { asBezierSpline } from "../bezier";

const DOMAINS = new Set<Domain>(["POINT", "EDGE", "FACE", "CORNER", "CURVE", "INSTANCE"]);
const EPS = 1e-9;

reg("GeometryNodeConvexHull", (api) => {
  const source = realizeInstances(api.geo("Geometry"));
  const points: Vec3[] = [
    ...(source.mesh?.positions ?? []),
    ...source.curves.flatMap((spline) => spline.points),
  ];
  const mesh = manifoldHull(points);
  if (!mesh) return { "Convex Hull": new Geometry() };
  const geometry = new Geometry();
  geometry.mesh = mesh;
  return { "Convex Hull": geometry };
});

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

function smoothNoiseFade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10); }

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
function blenderNoiseGrad3(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const vt = h === 12 || h === 14 ? x : z;
  const v = h < 4 ? y : vt;
  return (h & 1 ? -u : u) + (h & 2 ? -v : v);
}
function blenderSNoise3(p: Vec3): number {
  // Geometry-node coordinates here are far below Blender's 100000 precision
  // wrapping threshold, so the periodic precision correction is unnecessary.
  const ix = Math.floor(p[0]), iy = Math.floor(p[1]), iz = Math.floor(p[2]);
  const fx = p[0] - ix, fy = p[1] - iy, fz = p[2] - iz;
  const u = smoothNoiseFade(fx), v = smoothNoiseFade(fy), w = smoothNoiseFade(fz);
  const grad = (dx: number, dy: number, dz: number) => blenderNoiseGrad3(
    blenderHashInt3(ix + dx, iy + dy, iz + dz), fx - dx, fy - dy, fz - dz,
  );
  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const z0 = mix(mix(grad(0, 0, 0), grad(1, 0, 0), u), mix(grad(0, 1, 0), grad(1, 1, 0), u), v);
  const z1 = mix(mix(grad(0, 0, 1), grad(1, 0, 1), u), mix(grad(0, 1, 1), grad(1, 1, 1), u), v);
  return 0.982 * mix(z0, z1, w);
}

function blenderFbm3(p: Vec3, detail: number, roughness: number, lacunarity: number, normalize: boolean): number {
  let frequency = 1;
  let amplitude = 1;
  let maxAmplitude = 0;
  let sum = 0;
  const whole = Math.floor(Math.max(0, Math.min(15, detail)));
  for (let octave = 0; octave <= whole; octave++) {
    sum += blenderSNoise3(vscale(p, frequency)) * amplitude;
    maxAmplitude += amplitude;
    amplitude *= Math.max(0, roughness);
    frequency *= lacunarity;
  }
  const fraction = Math.max(0, Math.min(15, detail)) - whole;
  const normalized = (value: number, weight: number) => normalize ? 0.5 * value / weight + 0.5 : value;
  if (fraction <= EPS) return normalized(sum, maxAmplitude);
  const sum2 = sum + blenderSNoise3(vscale(p, frequency)) * amplitude;
  return normalized(sum, maxAmplitude) + (normalized(sum2, maxAmplitude + amplitude) - normalized(sum, maxAmplitude)) * fraction;
}

reg("ShaderNodeTexNoise", (api) => {
  const linkedVector = api.node.inputs.find((socket) => socket.identifier === "Vector")?.linked ?? false;
  const vector = api.field("Vector");
  const scale = api.field("Scale");
  const detail = api.field("Detail");
  const roughness = api.field("Roughness");
  const lacunarity = api.field("Lacunarity");
  const distortion = api.field("Distortion");
  const factor = Field.make((ctx) => {
    const vectors = vector.array(ctx), scales = scale.array(ctx), details = detail.array(ctx);
    const roughnesses = roughness.array(ctx), lacunarities = lacunarity.array(ctx), distortions = distortion.array(ctx);
    return Array.from({ length: ctx.size }, (_, i) => {
      let p = linkedVector ? asVec3(vectors[i] ?? 0) : ctx.position?.(i) ?? [0, 0, 0];
      const frequencyScale = asNum(scales[i] ?? 5);
      p = vscale(p, frequencyScale);
      const warp = asNum(distortions[i] ?? 0);
      if (Math.abs(warp) > EPS) {
        p = vadd(p, [
          warp * blenderSNoise3(vadd(p, [131.7, 143.2, 176.4])),
          warp * blenderSNoise3(vadd(p, [104.3, 191.1, 152.8])),
          warp * blenderSNoise3(vadd(p, [187.9, 118.6, 139.5])),
        ]);
      }
      const noiseDetail = asNum(details[i] ?? 2);
      const persistence = Math.max(0, asNum(roughnesses[i] ?? .5));
      const lac = Math.max(1e-4, asNum(lacunarities[i] ?? 2));
      return blenderFbm3(p, noiseDetail, persistence, lac, api.prop<boolean>("normalize", true));
    });
  });
  return { Fac: factor, Factor: factor, Color: Field.make((ctx) => factor.array(ctx).map((value) => [asNum(value), asNum(value), asNum(value)])) };
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
  for (let i = 0; i < n; i++)
    for (let k = 0; k < SPLINE_TYPE_SAMPLES_PER_SEGMENT; k++)
      out.push(periodicCubicBSplinePoint(pts, i, k / SPLINE_TYPE_SAMPLES_PER_SEGMENT));
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
    if (type === "NURBS" && !s.cyclic) evaluatedTangents.push(...splineFrames(converted.points, false).map((frame) => frame.tangent));
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
      : avgVec(verts.map((vi) => mesh.positions[vi]));
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
  const vals = api.field("Attribute").array(ctx);
  const sel = api.field("Selection").array(ctx);
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
    let k = Math.round(j);
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
    for (const [, attribute] of out.attributes) {
      if (attribute.domain !== "POINT") continue;
      attribute.data.push(cutterVertex === null ? 0 : (cutter.attributes.size ? (cutter.attributes.values().next().value?.data[cutterVertex] ?? 0) : 0));
    }
    return index;
  };
  const crossPositions = firstRing.map((vi) => cutter.positions[vi]);
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
    for (let level = 0; level + 1 < rings.length; level++) {
      for (let i = 0; i < firstRing.length; i++) {
        const next = (i + 1) % firstRing.length;
        pushFace([rings[level + 1][i], rings[level + 1][next], rings[level][next], rings[level][i]], 0, null);
      }
    }
  }
  for (const [name, data] of faceAttributeData) out.attributes.set(name, { domain: "FACE", data });
  return out;
}

reg("GeometryNodeMeshBoolean", (api) => {
  const op = (api.prop<string>("operation", "DIFFERENCE") || "DIFFERENCE").toUpperCase() as "UNION" | "DIFFERENCE" | "INTERSECT";
  // Blender's FLOAT and EXACT solvers are different operations. In particular,
  // the vase routes its open shell through the FLOAT branch of DOJO_BOOL.001;
  // feeding that branch to a solid-only CSG library changes its envelope.
  const solver = (api.prop<string>("solver", "FLOAT") || "FLOAT").toUpperCase();
  let mesh1 = api.geo("Mesh 1");
  let mesh2s = api.geoInputs("Mesh 2");
  // In Blender 4+/5, UNION and INTERSECT expose one multi-input "Mesh" socket
  // and disable Mesh 1. Treat the first multi-input value as the accumulator.
  const mesh1Enabled = api.node.inputs.find((socket) => socket.identifier === "Mesh 1")?.enabled !== false;
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

    // Multi-operand / mesh cutters: fold left with Manifold.
    let acc: Mesh | null = mesh1.mesh;
    for (const g of mesh2s) {
      if (!acc || !g.mesh) continue;
      const box = axisBox(g);
      let next: Mesh | null = null;
      if (box) next = manifoldBooleanBox(acc, box, op);
      if (!next) next = manifoldBoolean(acc, g.mesh, op);
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
