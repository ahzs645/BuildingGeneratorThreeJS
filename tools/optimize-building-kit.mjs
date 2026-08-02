import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { NodeIO } from "@gltf-transform/core";

const [, , sourcePath, outputPath] = process.argv;

if (!sourcePath || !outputPath) {
  throw new Error("Usage: node tools/optimize-building-kit.mjs <source.glb> <output.glb>");
}

const source = path.resolve(sourcePath);
const output = path.resolve(outputPath);

if (source === output) {
  throw new Error("Source and output paths must be different so the original asset stays reproducible.");
}

const io = new NodeIO();
const document = await io.read(source);
const root = document.getRoot();

// The runtime replaces every imported material with the separately maintained
// textures in public/textures. Keeping these embedded copies adds ~17 MB to the
// network request without affecting the rendered building.
for (const material of root.listMaterials()) {
  material
    .setBaseColorTexture(null)
    .setMetallicRoughnessTexture(null)
    .setNormalTexture(null)
    .setOcclusionTexture(null)
    .setEmissiveTexture(null);
}

// Remove only the now-unreferenced texture payloads. Do not run a general
// prune pass: the scene intentionally includes empty named nodes that act as
// generator markers and are looked up by the manifest at runtime.
for (const texture of root.listTextures()) {
  texture.dispose();
}

const requiredMaterials = ["floor", "building", "glass"];
const materialNames = new Set(root.listMaterials().map((material) => material.getName()));
for (const name of requiredMaterials) {
  if (!materialNames.has(name)) {
    throw new Error(`Optimized model is missing required material: ${name}`);
  }
}

await mkdir(path.dirname(output), { recursive: true });
const temporaryOutput = `${output}.${process.pid}.tmp.glb`;
await io.write(temporaryOutput, document);
await rename(temporaryOutput, output);

const [before, after] = await Promise.all([stat(source), stat(output)]);
const percentSaved = ((1 - after.size / before.size) * 100).toFixed(1);
console.log(
  `Optimized ${path.relative(process.cwd(), source)}: ` +
    `${(before.size / 1_000_000).toFixed(2)} MB -> ${(after.size / 1_000_000).toFixed(2)} MB ` +
    `(${percentSaved}% smaller).`,
);
