// Point-distribution, random-field, and point-instancing primitives.
import { Domain, Elem, Field, Vec3, asNum, asVec3, vcross, vlen, vnorm, vsub } from "../core";
import { Geometry, Mesh, realizeInstances } from "../geometry";
import { makeFieldCtx } from "../evaluator";
import { meshIcoSphere } from "../primitives";
import { reg } from "../registry";

function hash32(value: number): number {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

function random01(id: number, seed: number, channel = 0): number {
  return hash32(hash32(id | 0) ^ hash32((seed | 0) + Math.imul(channel + 1, 0x9e3779b9))) / 0x1_0000_0000;
}

// Blender's Random Value node uses BLI's Jenkins lookup3 hash. Keep this
// separate from the distribution sampler above: changing that sampler would
// also change point counts and placement for unrelated node trees.
function rot(value: number, amount: number): number {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

function hashMix(a: number, b: number, c: number): [number, number, number] {
  a = (a - c) >>> 0; a = (a ^ rot(c, 4)) >>> 0; c = (c + b) >>> 0;
  b = (b - a) >>> 0; b = (b ^ rot(a, 6)) >>> 0; a = (a + c) >>> 0;
  c = (c - b) >>> 0; c = (c ^ rot(b, 8)) >>> 0; b = (b + a) >>> 0;
  a = (a - c) >>> 0; a = (a ^ rot(c, 16)) >>> 0; c = (c + b) >>> 0;
  b = (b - a) >>> 0; b = (b ^ rot(a, 19)) >>> 0; a = (a + c) >>> 0;
  c = (c - b) >>> 0; c = (c ^ rot(b, 4)) >>> 0; b = (b + a) >>> 0;
  return [a, b, c];
}

function hashFinal(a: number, b: number, c: number): [number, number, number] {
  c = (c ^ b) >>> 0; c = (c - rot(b, 14)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 11)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 25)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 16)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 4)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 14)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 24)) >>> 0;
  return [a, b, c];
}

function blenderHash(...values: number[]): number {
  const count = values.length;
  let a = (0xdeadbeef + (count << 2) + 13) >>> 0;
  let b = a;
  let c = a;
  if (count === 1) {
    a = (a + (values[0] >>> 0)) >>> 0;
  } else if (count === 2) {
    b = (b + (values[1] >>> 0)) >>> 0;
    a = (a + (values[0] >>> 0)) >>> 0;
  } else if (count === 3) {
    c = (c + (values[2] >>> 0)) >>> 0;
    b = (b + (values[1] >>> 0)) >>> 0;
    a = (a + (values[0] >>> 0)) >>> 0;
  } else if (count === 4) {
    [a, b, c] = hashMix(
      (a + (values[0] >>> 0)) >>> 0,
      (b + (values[1] >>> 0)) >>> 0,
      (c + (values[2] >>> 0)) >>> 0,
    );
    a = (a + (values[3] >>> 0)) >>> 0;
  } else {
    return 0;
  }
  return hashFinal(a, b, c)[2];
}

function blenderHashToFloat(...values: number[]): number {
  return Math.fround(blenderHash(...values) / 0xffff_ffff);
}

reg("FunctionNodeRandomValue", (api) => {
  const dataType = api.prop<string>("data_type", "FLOAT");
  const id = api.field("ID"), seed = api.field("Seed");
  const idIsLinked = api.node.inputs.find((socket) => socket.identifier === "ID" || socket.name === "ID")?.linked === true;
  const elementIdAt = (ids: Elem[], index: number, contextIndex?: (index: number) => number): number => (
    idIsLinked
      ? Math.round(asNum(ids[index] ?? 0))
      : Math.round(contextIndex?.(index) ?? index)
  );
  const build = (minField: Field, maxField: Field, vector: boolean, integer = false): Field => Field.make((ctx) => {
    const mins = minField.array(ctx), maxs = maxField.array(ctx), ids = id.array(ctx), seeds = seed.array(ctx);
    return Array.from({ length: ctx.size }, (_, i) => {
      const elementId = elementIdAt(ids, i, ctx.index);
      const elementSeed = Math.round(asNum(seeds[i] ?? 0));
      if (vector) {
        const lo = asVec3(mins[i] ?? [0, 0, 0]), hi = asVec3(maxs[i] ?? [1, 1, 1]);
        return [0, 1, 2].map((channel) => Math.fround(
          lo[channel] + (hi[channel] - lo[channel]) * blenderHashToFloat(elementSeed, elementId, channel),
        )) as Vec3;
      }
      const lo = asNum(mins[i] ?? 0), hi = asNum(maxs[i] ?? 1);
      if (integer) {
        const min = Math.min(Math.round(lo), Math.round(hi));
        const max = Math.max(Math.round(lo), Math.round(hi));
        return min + (blenderHash(elementId, elementSeed) % (max - min + 1));
      }
      return Math.fround(lo + (hi - lo) * blenderHashToFloat(elementSeed, elementId));
    });
  });
  if (dataType === "FLOAT_VECTOR") {
    const value = build(api.field("Min"), api.field("Max"), true);
    return { Value: value, Value_001: value, Value_002: value, Value_003: value };
  }
  if (dataType === "BOOLEAN") {
    const probability = api.field("Probability");
    const value = Field.make((ctx) => {
      const probabilities = probability.array(ctx), ids = id.array(ctx), seeds = seed.array(ctx);
      return Array.from({ length: ctx.size }, (_, i) => (
        blenderHashToFloat(elementIdAt(ids, i, ctx.index), Math.round(asNum(seeds[i] ?? 0))) <= asNum(probabilities[i] ?? .5) ? 1 : 0
      ));
    });
    return { Value: value, Value_003: value };
  }
  const integer = dataType === "INT";
  const value = build(api.field(integer ? "Min_002" : "Min_001"), api.field(integer ? "Max_002" : "Max_001"), false, integer);
  return { Value: value, Value_001: value, Value_002: value, Value_003: value };
});

reg("GeometryNodeMeshIcoSphere", (api) => ({
  Mesh: meshIcoSphere(api.num("Radius") || 1, api.num("Subdivisions") || 1),
  "UV Map": Field.of([0, 0, 0]),
}));

type Triangle = { a: Vec3; b: Vec3; c: Vec3; normal: Vec3; area: number; weight: number };

function normalRotation(normal: Vec3): Vec3 {
  // Minimal XYZ rotation that maps local +Z onto the sampled face normal.
  return [Math.atan2(-normal[1], normal[2]), Math.atan2(normal[0], Math.hypot(normal[1], normal[2])), 0];
}

reg("GeometryNodeDistributePointsOnFaces", (api) => {
  const source = realizeInstances(api.geo("Mesh"));
  const mesh = source.mesh;
  const points = new Geometry();
  points.mesh = new Mesh();
  if (!mesh?.faces.length) return { Points: points, Normal: Field.of([0, 0, 1]), Rotation: Field.of([0, 0, 0]) };

  const faceContext = makeFieldCtx(source, "FACE");
  const selection = api.field("Selection").array(faceContext);
  const density = api.field("Density").array(faceContext);
  const densityFactor = api.field("Density Factor").array(faceContext);
  const densityMax = api.field("Density Max").array(faceContext);
  const distanceMin = api.field("Distance Min").array(faceContext);
  const seed = Math.round(api.num("Seed"));
  const poisson = api.prop<string>("distribute_method", "RANDOM") === "POISSON";
  const triangles: Triangle[] = [];
  let totalWeight = 0;
  for (let faceIndex = 0; faceIndex < mesh.faces.length; faceIndex++) {
    if (asNum(selection[faceIndex] ?? 1) <= 0) continue;
    const face = mesh.faces[faceIndex];
    if (face.length < 3) continue;
    const faceDensity = poisson
      ? asNum(densityMax[faceIndex] ?? 10) * asNum(densityFactor[faceIndex] ?? 1)
      : asNum(density[faceIndex] ?? 10) * asNum(densityFactor[faceIndex] ?? 1);
    for (let corner = 1; corner + 1 < face.length; corner++) {
      const a = mesh.positions[face[0]], b = mesh.positions[face[corner]], c = mesh.positions[face[corner + 1]];
      const cross = vcross(vsub(b, a), vsub(c, a));
      const area = vlen(cross) / 2;
      if (area <= 1e-12 || faceDensity <= 0) continue;
      const weight = area * faceDensity;
      totalWeight += weight;
      triangles.push({ a, b, c, normal: vnorm(cross), area, weight });
    }
  }
  if (!triangles.length || totalWeight <= 0) return { Points: points, Normal: Field.of([0, 0, 1]), Rotation: Field.of([0, 0, 0]) };

  const fractional = random01(0, seed, 7);
  const target = Math.min(200_000, Math.max(0, Math.floor(totalWeight) + (fractional < totalWeight % 1 ? 1 : 0)));
  const minDistance = poisson ? Math.max(0, asNum(distanceMin[0] ?? 0)) : 0;
  const normals: Elem[] = [];
  const rotations: Elem[] = [];
  const attempts = poisson ? Math.max(target * 20, 100) : target;
  let accepted = 0;
  for (let attempt = 0; attempt < attempts && accepted < target; attempt++) {
    let pick = random01(attempt, seed, 0) * totalWeight;
    let triangle = triangles[triangles.length - 1];
    for (const candidate of triangles) {
      pick -= candidate.weight;
      if (pick <= 0) { triangle = candidate; break; }
    }
    const u = Math.sqrt(random01(attempt, seed, 1));
    const v = random01(attempt, seed, 2);
    const wa = 1 - u, wb = u * (1 - v), wc = u * v;
    const position: Vec3 = [
      triangle.a[0] * wa + triangle.b[0] * wb + triangle.c[0] * wc,
      triangle.a[1] * wa + triangle.b[1] * wb + triangle.c[1] * wc,
      triangle.a[2] * wa + triangle.b[2] * wb + triangle.c[2] * wc,
    ];
    if (minDistance > 0 && points.mesh.positions.some((other) => vlen(vsub(position, other)) < minDistance)) continue;
    points.mesh.positions.push(position);
    normals.push(triangle.normal);
    rotations.push(normalRotation(triangle.normal));
    accepted++;
  }
  points.mesh.attributes.set("normal", { domain: "POINT" as Domain, data: normals });
  points.mesh.attributes.set("rotation", { domain: "POINT" as Domain, data: rotations });
  points.mesh.attributes.set("__gnvm_point_cloud", { domain: "POINT" as Domain, data: points.mesh.positions.map(() => 1) });
  return {
    Points: points,
    Normal: Field.perElem((index) => normals[index] ?? [0, 0, 1]),
    Rotation: Field.perElem((index) => rotations[index] ?? [0, 0, 0]),
  };
});
