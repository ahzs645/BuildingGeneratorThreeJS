// Report the material and texture payload carried by one or more GLB files.
// Usage: node --import tsx tools/glb-material-audit.ts model.glb [model2.glb ...]
import { readFileSync } from "node:fs";

function readGlb(path: string): { json: any; binary?: Buffer } {
  const buffer = readFileSync(path);
  if (buffer.toString("utf8", 0, 4) !== "glTF") throw new Error(`${path}: not a GLB`);
  let offset = 12;
  let json: any;
  let binary: Buffer | undefined;
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8").trim());
    if (type === 0x004e4942) binary = chunk;
    offset += 8 + length;
  }
  if (!json) throw new Error(`${path}: no JSON chunk`);
  return { json, binary };
}

function compact(value: unknown): string {
  return value == null ? "-" : JSON.stringify(value);
}

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error("usage: node --import tsx tools/glb-material-audit.ts model.glb [model2.glb ...]");
  process.exit(2);
}

for (const path of paths) {
  const { json, binary } = readGlb(path);
  const primitives = (json.meshes ?? []).reduce((sum: number, mesh: any) => sum + (mesh.primitives?.length ?? 0), 0);
  console.log(`\n${path}`);
  console.log(`  meshes=${json.meshes?.length ?? 0} primitives=${primitives} materials=${json.materials?.length ?? 0} textures=${json.textures?.length ?? 0} images=${json.images?.length ?? 0}`);
  const primitiveStats = new Map<number, { primitives: number; triangles: number; vertices: number }>();
  for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
    const material = primitive.material ?? -1;
    const indexAccessor = primitive.indices == null ? null : json.accessors?.[primitive.indices];
    const positionAccessor = json.accessors?.[primitive.attributes?.POSITION];
    const stat = primitiveStats.get(material) ?? { primitives: 0, triangles: 0, vertices: 0 };
    stat.primitives++;
    stat.triangles += Math.floor((indexAccessor?.count ?? positionAccessor?.count ?? 0) / 3);
    stat.vertices += positionAccessor?.count ?? 0;
    primitiveStats.set(material, stat);
  }
  for (const [index, material] of (json.materials ?? []).entries()) {
    const pbr = material.pbrMetallicRoughness ?? {};
    const textureRefs = Object.entries({
      baseColor: pbr.baseColorTexture?.index,
      metallicRoughness: pbr.metallicRoughnessTexture?.index,
      normal: material.normalTexture?.index,
      occlusion: material.occlusionTexture?.index,
      emissive: material.emissiveTexture?.index,
    }).filter(([, value]) => value != null);
    console.log(
      `  [${index}] ${material.name ?? "<unnamed>"}` +
      ` base=${compact(pbr.baseColorFactor ?? [1, 1, 1, 1])}` +
      ` metal=${compact(pbr.metallicFactor ?? 1)}` +
      ` rough=${compact(pbr.roughnessFactor ?? 1)}` +
      ` emissive=${compact(material.emissiveFactor ?? [0, 0, 0])}` +
      ` alpha=${material.alphaMode ?? "OPAQUE"}` +
      ` double=${!!material.doubleSided}` +
      ` unlit=${!!material.extensions?.KHR_materials_unlit}` +
      ` textureRefs=${compact(Object.fromEntries(textureRefs))}`,
    );
    const stat = primitiveStats.get(index);
    if (stat) console.log(`      payload primitives=${stat.primitives} triangles=${stat.triangles} vertices=${stat.vertices}`);
  }
  const unassigned = primitiveStats.get(-1);
  if (unassigned) console.log(`  [none] payload primitives=${unassigned.primitives} triangles=${unassigned.triangles} vertices=${unassigned.vertices}`);
  for (const [index, texture] of (json.textures ?? []).entries()) {
    console.log(`  texture[${index}] source=${texture.source ?? "-"} sampler=${texture.sampler ?? "default"}`);
  }
  for (const [index, image] of (json.images ?? []).entries()) {
    const view = image.bufferView == null ? undefined : json.bufferViews?.[image.bufferView];
    const bytes = view?.byteLength ?? 0;
    let dimensions = "-";
    if (binary && view && image.mimeType === "image/png") {
      const start = view.byteOffset ?? 0;
      dimensions = `${binary.readUInt32BE(start + 16)}x${binary.readUInt32BE(start + 20)}`;
    }
    console.log(`  image[${index}] name=${image.name ?? "-"} mime=${image.mimeType ?? "-"} size=${dimensions} bytes=${bytes} uri=${image.uri ?? "<embedded>"} bufferView=${image.bufferView ?? "-"}`);
  }
}
