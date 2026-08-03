import * as THREE from "three";

// Clean-room, MIT-licensed implementations of Blender node semantics. No GLSL
// in this module is copied from Blender's GPL-licensed shader sources.

export type FilamentWaveConfig = {
  distortion: number;
  detail: number;
  detailScale: number;
  detailRoughness: number;
  direction: "X" | "Z" | "DIAGONAL";
  phaseOffset?: number;
};

export type FilamentBumpGlslConfig = {
  prefix: string;
  coordinate: string;
  heightFunction: (coordinate: string) => string;
  strength: number;
  distance: number;
  filterWidth: number;
  invert: boolean;
  baseNormal?: string;
};

export type FilamentBounds = { min: [number, number, number]; max: [number, number, number] };
type IndexGroup = { start: number; count: number; material: string | null };

export type Octave = { amplitude: number; frequency: number };
export type OctavePlan = {
  fullOctaves: Octave[];
  fractionalOctave: Octave;
  remainderWeight: number;
};

export type FbmConfig = {
  detail: number;
  roughness: number;
  lacunarity: number;
  normalize: boolean;
  baseFrequency?: number;
};

function glsl(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : `${value}`;
}

function glslValue(value: number | string): string {
  return typeof value === "number" ? glsl(value) : value;
}

/** Plan Blender Noise/Wave octaves, including the blended final octave. */
export function planOctaves(detail: number, roughness: number, lacunarity: number): OctavePlan {
  const safeDetail = Math.max(0, Math.min(15, Number.isFinite(detail) ? detail : 0));
  const whole = Math.floor(safeDetail);
  const fullOctaves = Array.from({ length: whole + 1 }, (_, octave) => ({
    amplitude: roughness ** octave,
    frequency: lacunarity ** octave,
  }));
  return {
    fullOctaves,
    fractionalOctave: {
      amplitude: roughness ** (whole + 1),
      frequency: lacunarity ** (whole + 1),
    },
    remainderWeight: safeDetail - whole,
  };
}

/** Blender's Generated coordinates use the bounds of the shaded geometry component. */
export function filamentGroupBounds(geometry: THREE.BufferGeometry, group: IndexGroup): FilamentBounds | null {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  if (!position || group.count <= 0) return null;
  const end = Math.min(group.start + group.count, index?.count ?? position.count);
  if (group.start < 0 || group.start >= end) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let offset = group.start; offset < end; offset++) {
    const vertex = index ? index.getX(offset) : offset;
    for (let axis = 0; axis < 3; axis++) {
      const value = position.getComponent(vertex, axis);
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return min.every(Number.isFinite) && max.every(Number.isFinite) ? { min, max } : null;
}

/** Vertex-side normalization used by Blender Generated-coordinate adapters. */
export function generatedCoordinateGlsl(
  prefix: string,
  bounds: { min: readonly number[]; max: readonly number[]; epsilon?: number },
): string {
  const epsilon = bounds.epsilon ?? 1e-20;
  const extent = bounds.max.map((value, axis) => Math.max(value - bounds.min[axis], epsilon));
  return `${prefix}Generated = (position - vec3(${bounds.min.map(glsl).join(", ")})) / vec3(${extent.map(glsl).join(", ")});`;
}

function rotateLeft32(value: number, amount: number): number {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

function finalizeHash(a: number, b: number, c: number): [number, number, number] {
  c = ((c ^ b) - rotateLeft32(b, 14)) >>> 0;
  a = ((a ^ c) - rotateLeft32(c, 11)) >>> 0;
  b = ((b ^ a) - rotateLeft32(a, 25)) >>> 0;
  c = ((c ^ b) - rotateLeft32(b, 16)) >>> 0;
  a = ((a ^ c) - rotateLeft32(c, 4)) >>> 0;
  b = ((b ^ a) - rotateLeft32(a, 14)) >>> 0;
  c = ((c ^ b) - rotateLeft32(b, 24)) >>> 0;
  return [a, b, c];
}

function mixHash(a: number, b: number, c: number): [number, number, number] {
  a = (a - c) >>> 0; a = (a ^ rotateLeft32(c, 4)) >>> 0; c = (c + b) >>> 0;
  b = (b - a) >>> 0; b = (b ^ rotateLeft32(a, 6)) >>> 0; a = (a + c) >>> 0;
  c = (c - b) >>> 0; c = (c ^ rotateLeft32(b, 8)) >>> 0; b = (b + a) >>> 0;
  a = (a - c) >>> 0; a = (a ^ rotateLeft32(c, 16)) >>> 0; c = (c + b) >>> 0;
  b = (b - a) >>> 0; b = (b ^ rotateLeft32(a, 19)) >>> 0; a = (a + c) >>> 0;
  c = (c - b) >>> 0; c = (c ^ rotateLeft32(b, 4)) >>> 0; b = (b + a) >>> 0;
  return [a, b, c];
}

function hashLattice3(x: number, y: number, z: number): number {
  const seed = (0xdeadbeef + (3 << 2) + 13) >>> 0;
  return finalizeHash((seed + (x >>> 0)) >>> 0, (seed + (y >>> 0)) >>> 0, (seed + (z >>> 0)) >>> 0)[2];
}

function hashLattice4(x: number, y: number, z: number, w: number): number {
  const seed = (0xdeadbeef + (4 << 2) + 13) >>> 0;
  const mixed = mixHash((seed + (x >>> 0)) >>> 0, (seed + (y >>> 0)) >>> 0, (seed + (z >>> 0)) >>> 0);
  return finalizeHash((mixed[0] + (w >>> 0)) >>> 0, mixed[1], mixed[2])[2];
}

function float32Bits(value: number): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setFloat32(0, Math.fround(value), true);
  return view.getUint32(0, true);
}

/** Blender-compatible 3D White Noise Color, keyed by exact float32 bits. */
export function filamentWhiteNoise3(point: readonly number[]): [number, number, number] {
  const [x, y, z] = point.map(float32Bits);
  const denominator = 0xffffffff;
  return [
    hashLattice3(x, y, z) / denominator,
    hashLattice4(x, y, z, float32Bits(1)) / denominator,
    hashLattice4(x, y, z, float32Bits(2)) / denominator,
  ];
}

function fade(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function gradient(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return (h & 1 ? -u : u) + (h & 2 ? -v : v);
}

/** Blender-normalized signed 3D gradient noise; also a CPU shader oracle. */
export function filamentSignedNoise3(point: readonly number[]): number {
  const cell = point.map(Math.floor);
  const local = point.map((value, axis) => value - cell[axis]);
  const weight = local.map(fade);
  const sample = (dx: number, dy: number, dz: number): number => gradient(
    hashLattice3(cell[0] + dx, cell[1] + dy, cell[2] + dz),
    local[0] - dx, local[1] - dy, local[2] - dz,
  );
  const mix = (a: number, b: number, amount: number): number => a + (b - a) * amount;
  const z0 = mix(mix(sample(0, 0, 0), sample(1, 0, 0), weight[0]),
    mix(sample(0, 1, 0), sample(1, 1, 0), weight[0]), weight[1]);
  const z1 = mix(mix(sample(0, 0, 1), sample(1, 0, 1), weight[0]),
    mix(sample(0, 1, 1), sample(1, 1, 1), weight[0]), weight[1]);
  return 0.982 * mix(z0, z1, weight[2]);
}

function fbm3(point: readonly number[], config: FbmConfig, signedNormalized: boolean): number {
  const plan = planOctaves(config.detail, config.roughness, config.lacunarity);
  let sum = 0;
  let maximum = 0;
  for (const octave of plan.fullOctaves) {
    const frequency = (config.baseFrequency ?? 1) * octave.frequency;
    sum += octave.amplitude * filamentSignedNoise3(point.map((value) => value * frequency));
    maximum += octave.amplitude;
  }
  const normalize = (value: number, weight: number): number => signedNormalized
    ? value / weight
    : config.normalize ? 0.5 * value / weight + 0.5 : value;
  const full = normalize(sum, maximum);
  if (plan.remainderWeight === 0) return full;
  const nextFrequency = (config.baseFrequency ?? 1) * plan.fractionalOctave.frequency;
  const next = sum + plan.fractionalOctave.amplitude * filamentSignedNoise3(
    point.map((value) => value * nextFrequency),
  );
  const fractional = normalize(next, maximum + plan.fractionalOctave.amplitude);
  return full + (fractional - full) * plan.remainderWeight;
}

/** CPU oracle for Blender's normalized or raw 3D fBM Noise Texture. */
export function filamentFbm3(point: readonly number[], config: FbmConfig): number {
  return fbm3(point, config, false);
}

function fbmExpressionGlsl(
  prefix: string,
  point: string,
  config: FbmConfig,
  signedNormalized = false,
): string {
  const plan = planOctaves(config.detail, config.roughness, config.lacunarity);
  const terms = plan.fullOctaves.map((octave) =>
    `${glsl(octave.amplitude)} * ${prefix}Noise(${point} * ${glsl((config.baseFrequency ?? 1) * octave.frequency)})`);
  const sum = terms.join("\n    + ");
  const maximum = plan.fullOctaves.reduce((total, octave) => total + octave.amplitude, 0);
  const normalize = (expression: string, weight: number): string => signedNormalized
    ? `(${expression}) / ${glsl(weight)}`
    : config.normalize ? `0.5 * (${expression}) / ${glsl(weight)} + 0.5` : `(${expression})`;
  const full = normalize(sum, maximum);
  if (plan.remainderWeight === 0) return full;
  const nextFrequency = (config.baseFrequency ?? 1) * plan.fractionalOctave.frequency;
  const next = `(${sum}) + ${glsl(plan.fractionalOctave.amplitude)} * ${prefix}Noise(${point} * ${glsl(nextFrequency)})`;
  return `mix(${full}, ${normalize(next, maximum + plan.fractionalOctave.amplitude)}, ${glsl(plan.remainderWeight)})`;
}

/** GLSL function for Blender's normalized or raw 3D fBM Noise Texture. */
export function filamentFbmGlsl(prefix: string, functionName: string, config: FbmConfig): string {
  return `float ${functionName}(vec3 coordinate) {\n  return ${fbmExpressionGlsl(prefix, "coordinate", config)};\n}`;
}

/** Shared clean-room GLSL primitives for Blender-compatible gradient/white noise. */
export function filamentNoiseGlsl(prefix: string, includeWhiteNoise = false): string {
  const hash4 = includeWhiteNoise ? `
uvec3 ${prefix}MixHash(uvec3 value) {
  value.x -= value.z; value.x ^= ${prefix}Rotl(value.z, 4u); value.z += value.y;
  value.y -= value.x; value.y ^= ${prefix}Rotl(value.x, 6u); value.x += value.z;
  value.z -= value.y; value.z ^= ${prefix}Rotl(value.y, 8u); value.y += value.x;
  value.x -= value.z; value.x ^= ${prefix}Rotl(value.z, 16u); value.z += value.y;
  value.y -= value.x; value.y ^= ${prefix}Rotl(value.x, 19u); value.x += value.z;
  value.z -= value.y; value.z ^= ${prefix}Rotl(value.y, 4u); value.y += value.x;
  return value;
}
uint ${prefix}Hash4(uvec4 key) {
  uvec3 value = uvec3(0xdeadbeefu + 16u + 13u) + key.xyz;
  value = ${prefix}MixHash(value); value.x += key.w;
  return ${prefix}FinalizeHash(value).z;
}
vec3 ${prefix}WhiteNoise3(vec3 point) {
  uvec3 key = floatBitsToUint(point); float denominator = float(0xFFFFFFFFu);
  return vec3(float(${prefix}Hash3(key)) / denominator,
    float(${prefix}Hash4(uvec4(key, floatBitsToUint(1.0)))) / denominator,
    float(${prefix}Hash4(uvec4(key, floatBitsToUint(2.0)))) / denominator);
}` : "";
  return `uint ${prefix}Rotl(uint value, uint amount) { return (value << amount) | (value >> (32u - amount)); }
uvec3 ${prefix}FinalizeHash(uvec3 value) {
  value.z = (value.z ^ value.y) - ${prefix}Rotl(value.y, 14u);
  value.x = (value.x ^ value.z) - ${prefix}Rotl(value.z, 11u);
  value.y = (value.y ^ value.x) - ${prefix}Rotl(value.x, 25u);
  value.z = (value.z ^ value.y) - ${prefix}Rotl(value.y, 16u);
  value.x = (value.x ^ value.z) - ${prefix}Rotl(value.z, 4u);
  value.y = (value.y ^ value.x) - ${prefix}Rotl(value.x, 14u);
  value.z = (value.z ^ value.y) - ${prefix}Rotl(value.y, 24u);
  return value;
}
uint ${prefix}Hash3(uvec3 key) { return ${prefix}FinalizeHash(uvec3(0xdeadbeefu + 12u + 13u) + key).z; }
uint ${prefix}Hash(uvec3 key) { return ${prefix}Hash3(key); }
float ${prefix}Fade(float value) { return value * value * value * (value * (value * 6.0 - 15.0) + 10.0); }
float ${prefix}Gradient(uint hash, vec3 point) {
  uint h = hash & 15u; float u = h < 8u ? point.x : point.y;
  float v = h < 4u ? point.y : ((h == 12u || h == 14u) ? point.x : point.z);
  return ((h & 1u) != 0u ? -u : u) + ((h & 2u) != 0u ? -v : v);
}
float ${prefix}Noise(vec3 point) {
  ivec3 cell = ivec3(floor(point)); vec3 local = fract(point);
  vec3 w = vec3(${prefix}Fade(local.x), ${prefix}Fade(local.y), ${prefix}Fade(local.z));
  float n000 = ${prefix}Gradient(${prefix}Hash(uvec3(cell + ivec3(0, 0, 0))), local);
  float n100 = ${prefix}Gradient(${prefix}Hash(uvec3(cell + ivec3(1, 0, 0))), local - vec3(1, 0, 0));
  float n010 = ${prefix}Gradient(${prefix}Hash(uvec3(cell + ivec3(0, 1, 0))), local - vec3(0, 1, 0));
  float n110 = ${prefix}Gradient(${prefix}Hash(uvec3(cell + ivec3(1, 1, 0))), local - vec3(1, 1, 0));
  float n001 = ${prefix}Gradient(${prefix}Hash(uvec3(cell + ivec3(0, 0, 1))), local - vec3(0, 0, 1));
  float n101 = ${prefix}Gradient(${prefix}Hash(uvec3(cell + ivec3(1, 0, 1))), local - vec3(1, 0, 1));
  float n011 = ${prefix}Gradient(${prefix}Hash(uvec3(cell + ivec3(0, 1, 1))), local - vec3(0, 1, 1));
  float n111 = ${prefix}Gradient(${prefix}Hash(uvec3(cell + ivec3(1, 1, 1))), local - vec3(1, 1, 1));
  return 0.982 * mix(mix(mix(n000, n100, w.x), mix(n010, n110, w.x), w.y),
    mix(mix(n001, n101, w.x), mix(n011, n111, w.x), w.y), w.z);
}${hash4}`;
}

export function filamentWaveHeightAtCoordinate(
  coordinate: readonly number[],
  scale: number,
  config: FilamentWaveConfig,
): number {
  const point = coordinate.map((value) => (value * scale + 1e-6) * 0.999999);
  const noise = fbm3(point, {
    detail: config.detail,
    roughness: config.detailRoughness,
    lacunarity: 2,
    normalize: false,
    baseFrequency: config.detailScale,
  }, true);
  const phase = (config.direction === "DIAGONAL"
    ? 10 * (point[0] + point[1] + point[2])
    : 20 * point[config.direction === "X" ? 0 : 2])
    + config.distortion * noise + (config.phaseOffset ?? 0);
  return 0.5 + 0.5 * Math.sin(phase - Math.PI / 2);
}

export function filamentWaveFunctionGlsl(prefix: string, functionName: string, config: FilamentWaveConfig): string {
  const phase = config.direction === "DIAGONAL" ? "10.0 * (point.x + point.y + point.z)"
    : config.direction === "X" ? "20.0 * point.x" : "20.0 * point.z";
  const noise = fbmExpressionGlsl(prefix, "point", {
    detail: config.detail,
    roughness: config.detailRoughness,
    lacunarity: 2,
    normalize: false,
    baseFrequency: config.detailScale,
  }, true);
  return `float ${functionName}(vec3 coordinate, float scale) {
  vec3 point = (coordinate * scale + vec3(0.000001)) * 0.999999;
  float noise = ${noise};
  float phase = ${phase} + ${glsl(config.distortion)} * noise + ${glsl(config.phaseOffset ?? 0)};
  return 0.5 + 0.5 * sin(phase - 1.5707963267948966);
}`;
}

/** Blender ShaderNodeBump derivative core. */
export function filamentBumpGlsl(config: FilamentBumpGlslConfig): string {
  const baseNormal = config.baseNormal ?? "normal";
  return `float ${config.prefix}H0 = ${config.heightFunction(config.coordinate)};
float ${config.prefix}Hx = ${config.heightFunction(`${config.coordinate} + dFdx(${config.coordinate}) * ${glsl(config.filterWidth)}`)};
float ${config.prefix}Hy = ${config.heightFunction(`${config.coordinate} + dFdy(${config.coordinate}) * ${glsl(config.filterWidth)}`)};
vec3 ${config.prefix}P = -vViewPosition;
vec3 ${config.prefix}DPdx = dFdx(${config.prefix}P), ${config.prefix}DPdy = dFdy(${config.prefix}P);
vec3 ${config.prefix}Rx = cross(${config.prefix}DPdy, ${baseNormal}), ${config.prefix}Ry = cross(${baseNormal}, ${config.prefix}DPdx);
float ${config.prefix}Det = dot(${config.prefix}DPdx, ${config.prefix}Rx);
vec3 ${config.prefix}Surfgrad = (${config.prefix}Hx - ${config.prefix}H0) * ${config.prefix}Rx + (${config.prefix}Hy - ${config.prefix}H0) * ${config.prefix}Ry;
float ${config.prefix}Distance = ${config.invert ? "-" : ""}${glsl(config.distance)} * (gl_FrontFacing ? 1.0 : -1.0);
vec3 ${config.prefix}Perturbed = normalize(${glsl(config.filterWidth)} * abs(${config.prefix}Det) * ${baseNormal}
  - ${config.prefix}Distance * sign(${config.prefix}Det) * ${config.prefix}Surfgrad);
normal = normalize(mix(${baseNormal}, ${config.prefix}Perturbed, max(${glsl(config.strength)}, 0.0)));`;
}

const f32 = Math.fround;
const PCG_MULTIPLIER = 1664525;
const PCG_INCREMENT = 1013904223;
const INT31_INVERSE = f32(1 / 0x7fffffff);

/** Signed PCG3D cell hash used by Blender's GPU Voronoi implementation. */
export function blenderPcg3d(cell: readonly number[]): [number, number, number] {
  let x = (Math.imul(cell[0] | 0, PCG_MULTIPLIER) + PCG_INCREMENT) | 0;
  let y = (Math.imul(cell[1] | 0, PCG_MULTIPLIER) + PCG_INCREMENT) | 0;
  let z = (Math.imul(cell[2] | 0, PCG_MULTIPLIER) + PCG_INCREMENT) | 0;
  x = (x + Math.imul(y, z)) | 0; y = (y + Math.imul(z, x)) | 0; z = (z + Math.imul(x, y)) | 0;
  x = (x ^ (x >> 16)) | 0; y = (y ^ (y >> 16)) | 0; z = (z ^ (z >> 16)) | 0;
  x = (x + Math.imul(y, z)) | 0; y = (y + Math.imul(z, x)) | 0; z = (z + Math.imul(x, y)) | 0;
  return [x, y, z].map((value) => f32(f32(value & 0x7fffffff) * INT31_INVERSE)) as [number, number, number];
}

export type VoronoiFeature = "F1" | "SMOOTH_F1";
export type VoronoiOptions = { feature: VoronoiFeature; randomness: number; smoothness?: number };

/** CPU oracle for Blender's 27-cell F1 and 125-cell Smooth F1 Voronoi kernels. */
export function voronoiDistance3(coordinate: readonly number[], options: VoronoiOptions): number {
  const cell = coordinate.map(Math.floor);
  const local = coordinate.map((value, axis) => f32(value - cell[axis]));
  const radius = options.feature === "F1" ? 1 : 2;
  let result = options.feature === "F1" ? f32(2) : f32(0);
  let first = true;
  const smoothness = f32(Math.max(0, Math.min(0.5, (options.smoothness ?? 0) / 2)));
  for (let z = -radius; z <= radius; z++) for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
    const offset = [x, y, z];
    const hashed = blenderPcg3d(cell.map((value, axis) => value + offset[axis]));
    const randomness = options.feature === "F1" ? Math.max(0, Math.min(1, options.randomness)) : options.randomness;
    const point = offset.map((value, axis) => f32(value + f32(hashed[axis] * randomness)));
    const delta = point.map((value, axis) => f32(value - local[axis]));
    const distance = f32(Math.sqrt(f32(f32(delta[0] * delta[0])
      + f32(delta[1] * delta[1]) + f32(delta[2] * delta[2]))));
    if (options.feature === "F1") result = Math.min(result, distance);
    else {
      const amount = first ? f32(1) : f32(Math.max(0, Math.min(1,
        f32(0.5 + f32(0.5 * f32((result - distance) / smoothness))))));
      const eased = first ? amount : f32(f32(amount * amount) * f32(3 - f32(2 * amount)));
      result = f32(f32(result * f32(1 - eased)) + f32(distance * eased)
        - f32(smoothness * f32(eased * f32(1 - eased))));
      first = false;
    }
  }
  return result;
}

export type VoronoiGlslOptions = { prefix: string; feature: VoronoiFeature; functionName?: string };

/** GLSL generator for Blender ShaderNodeTexVoronoi F1/Smooth F1. */
export function voronoiGlsl(options: VoronoiGlslOptions): string {
  const { prefix, feature } = options;
  const functionName = options.functionName ?? `${prefix}Voronoi`;
  const kernel = feature === "F1" ? `
  float nearest = 2.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec3 offset = ivec3(x, y, z);
    vec3 point = vec3(offset) + ${prefix}HashCell(cell + offset) * clamp(randomness, 0.0, 1.0);
    nearest = min(nearest, length(point - local));
  }
  return nearest;` : `
  float smoothDistance = 0.0; float h = -1.0;
  float effectiveSmoothness = clamp(smoothness / 2.0, 0.0, 0.5);
  for (int z = -2; z <= 2; z++) for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) {
    ivec3 offset = ivec3(x, y, z);
    vec3 point = vec3(offset) + ${prefix}HashCell(cell + offset) * randomness;
    float pointDistance = distance(point, local);
    h = h < 0.0 ? 1.0 : smoothstep(0.0, 1.0,
      0.5 + 0.5 * (smoothDistance - pointDistance) / effectiveSmoothness);
    smoothDistance = mix(smoothDistance, pointDistance, h) - effectiveSmoothness * h * (1.0 - h);
  }
  return smoothDistance;`;
  return `ivec3 ${prefix}Pcg3d(ivec3 value) {
  value = value * 1664525 + 1013904223;
  value.x += value.y * value.z; value.y += value.z * value.x; value.z += value.x * value.y;
  value ^= value >> 16;
  value.x += value.y * value.z; value.y += value.z * value.x; value.z += value.x * value.y;
  return value & ivec3(0x7fffffff);
}
vec3 ${prefix}HashCell(ivec3 cell) { return vec3(${prefix}Pcg3d(cell)) ${feature === "F1" ? "/ 2147483647.0" : "* (1.0 / 2147483647.0)"}; }
float ${functionName}(vec3 coordinate, float randomness, float smoothness) {
  vec3 cellPosition = floor(coordinate); vec3 local = ${feature === "F1" ? "fract(coordinate)" : "coordinate - cellPosition"};
  ivec3 cell = ivec3(cellPosition);${kernel}
}`;
}

export type ColorRampStop = { position: number; color: readonly number[] };
export type ColorRampInterpolation = "CONSTANT" | "LINEAR" | "EASE";

/** GLSL generator mirroring Blender ShaderNodeValToRGB (Color Ramp). */
export function colorRampGlsl(name: string, stops: readonly ColorRampStop[], interpolation: ColorRampInterpolation): string {
  if (!/^[A-Za-z_]\w*$/.test(name) || stops.length === 0) throw new Error("Color Ramp requires a GLSL name and at least one stop");
  const ordered = [...stops].sort((a, b) => a.position - b.position);
  const color = (stop: ColorRampStop) => `vec4(${[0, 1, 2, 3].map((axis) => glsl(stop.color[axis] ?? (axis === 3 ? 1 : 0))).join(", ")})`;
  const lines = [`float amount = clamp(factor, 0.0, 1.0);`];
  for (let index = 1; index < ordered.length; index++) {
    const left = ordered[index - 1], right = ordered[index];
    if (interpolation === "CONSTANT") lines.push(`if (amount < ${glsl(right.position)}) return ${color(left)};`);
    else {
      const ease = interpolation === "EASE" ? " t = t * t * (3.0 - 2.0 * t);" : "";
      const factor = right.position === left.position ? "1.0"
        : `clamp((amount - ${glsl(left.position)}) / ${glsl(right.position - left.position)}, 0.0, 1.0)`;
      lines.push(`if (amount <= ${glsl(right.position)}) { float t = ${factor};${ease} return mix(${color(left)}, ${color(right)}, t); }`);
    }
  }
  lines.push(`return ${color(ordered.at(-1)!)};`);
  return `vec4 ${name}(float factor) {\n  ${lines.join("\n  ")}\n}`;
}

export type MapRangeGlslConfig = {
  name: string;
  fromMin: number | string;
  fromMax: number | string;
  toMin: number | string;
  toMax: number | string;
  clamp?: boolean;
  parameters?: readonly string[];
};

/** GLSL generator mirroring Blender ShaderNodeMapRange in Linear mode. */
export function mapRangeGlsl(config: MapRangeGlslConfig): string {
  if (!/^[A-Za-z_]\w*$/.test(config.name)) throw new Error("Map Range requires a GLSL function name");
  const fromMin = glslValue(config.fromMin), fromMax = glslValue(config.fromMax);
  const toMin = glslValue(config.toMin), toMax = glslValue(config.toMax);
  const result = `${config.name}Result`;
  const parameters = config.parameters?.length ? `, ${config.parameters.join(", ")}` : "";
  return `float ${config.name}(float value${parameters}) {
  float ${result} = ${fromMax} != ${fromMin}
    ? ${toMin} + (value - ${fromMin}) * (${toMax} - ${toMin}) / (${fromMax} - ${fromMin})
    : ${toMin};
  return ${config.clamp ? `clamp(${result}, min(${toMin}, ${toMax}), max(${toMin}, ${toMax}))` : result};
}`;
}

export type MixColorMode = "MIX" | "MULTIPLY" | "COLOR" | "OVERLAY";

/** GLSL generator mirroring Blender's float-factor Mix Color node. */
export function mixColorGlsl(mode: MixColorMode): string {
  if (mode === "MIX") return "vec3 blenderMixColor(float factor, vec3 a, vec3 b) { return mix(a, b, factor); }";
  if (mode === "MULTIPLY") return "vec3 blenderMixColor(float factor, vec3 a, vec3 b) { return mix(a, a * b, factor); }";
  if (mode === "OVERLAY") return `vec3 blenderMixColor(float factor, vec3 a, vec3 b) {
  vec3 blended = mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(vec3(0.5), a));
  return mix(a, blended, factor);
}`;
  return `vec3 blenderRgbToHsv(vec3 color) {
  float maximum = max(max(color.r, color.g), color.b), minimum = min(min(color.r, color.g), color.b);
  float delta = maximum - minimum, hue = 0.0;
  if (delta != 0.0) {
    if (maximum == color.r) hue = mod((color.g - color.b) / delta, 6.0);
    else if (maximum == color.g) hue = (color.b - color.r) / delta + 2.0;
    else hue = (color.r - color.g) / delta + 4.0;
    hue /= 6.0;
  }
  return vec3(hue, maximum == 0.0 ? 0.0 : delta / maximum, maximum);
}
vec3 blenderHsvToRgb(vec3 hsv) {
  float h = fract(hsv.x) * 6.0, c = hsv.z * hsv.y, x = c * (1.0 - abs(mod(h, 2.0) - 1.0));
  vec3 rgb = h < 1.0 ? vec3(c, x, 0.0) : h < 2.0 ? vec3(x, c, 0.0)
    : h < 3.0 ? vec3(0.0, c, x) : h < 4.0 ? vec3(0.0, x, c)
    : h < 5.0 ? vec3(x, 0.0, c) : vec3(c, 0.0, x);
  return rgb + (hsv.z - c);
}
vec3 blenderMixColor(float factor, vec3 a, vec3 b) {
  vec3 hsvA = blenderRgbToHsv(a), hsvB = blenderRgbToHsv(b);
  return mix(a, blenderHsvToRgb(vec3(hsvB.xy, hsvA.z)), factor);
}`;
}
