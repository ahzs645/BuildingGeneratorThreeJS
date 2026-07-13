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
  if (a <= EPS && b >= 1 - EPS) return { points: s.points.map((p) => [...p] as Vec3), cyclic: s.cyclic };
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

reg("GeometryNodeMeshBoolean", (api) => {
  const op = (api.prop<string>("operation", "DIFFERENCE") || "DIFFERENCE").toUpperCase() as "UNION" | "DIFFERENCE" | "INTERSECT";
  // Blender's FLOAT and EXACT solvers are different operations. In particular,
  // the vase routes its open shell through the FLOAT branch of DOJO_BOOL.001;
  // feeding that branch to a solid-only CSG library changes its envelope.
  const solver = (api.prop<string>("solver", "FLOAT") || "FLOAT").toUpperCase();
  const mesh1 = api.geo("Mesh 1");
  const mesh2s = api.geoInputs("Mesh 2");
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
