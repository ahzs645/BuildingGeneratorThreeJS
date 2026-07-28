/**
 * Print the struct catalogue a `.blend` file was written with.
 *
 * Usage: tsx tools/blend-introspect.ts <file.blend> [structName …]
 */
import { readFile } from "node:fs/promises";
import { decompressBlend } from "../src/blend/decompress";
import { readBlendFile } from "../src/blend/blend-file";

const [path, ...requested] = process.argv.slice(2);
if (!path) {
  console.error("Usage: tsx tools/blend-introspect.ts <file.blend> [structName …]");
  process.exit(2);
}

const raw = new Uint8Array(await readFile(path));
const { bytes, envelope } = await decompressBlend(raw);
const file = readBlendFile(bytes);

console.log(`${path}`);
console.log(`  envelope=${envelope} bytes=${raw.length} -> ${bytes.length}`);
console.log(`  header=${JSON.stringify(file.header)}`);
console.log(`  blocks=${file.blocks.length} structs=${file.sdna.structs.length} types=${file.sdna.types.length}`);

const codes = new Map<string, number>();
for (const block of file.blocks) codes.set(block.code, (codes.get(block.code) ?? 0) + 1);
console.log(`  codes: ${[...codes].sort((a, b) => b[1] - a[1]).map(([code, count]) => `${code}=${count}`).join(" ")}`);

for (const name of requested) {
  if (name.endsWith("*")) {
    const prefix = name.slice(0, -1).toLowerCase();
    console.log(`\nstructs starting with "${prefix}":`);
    for (const struct of file.sdna.structs) {
      if (!struct.name.toLowerCase().startsWith(prefix)) continue;
      console.log(`  ${struct.name} {${struct.fields.map((field) => `${field.typeName} ${field.declaration}`).join("; ")}}`);
    }
    continue;
  }
  const struct = file.sdna.structByName.get(name);
  if (!struct) {
    const near = file.sdna.structs.filter((entry) => entry.name.toLowerCase().includes(name.toLowerCase()));
    console.log(`\n${name}: not present. Similar: ${near.map((entry) => entry.name).join(", ") || "none"}`);
    continue;
  }
  console.log(`\nstruct ${struct.name} (index ${struct.index}, ${struct.size} bytes)`);
  for (const field of struct.fields) {
    console.log(`  +${String(field.offset).padStart(5)} ${String(field.size).padStart(5)}  ${field.typeName} ${field.declaration}`);
  }
}
