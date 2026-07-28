/**
 * Decode `.blend` files to portable node dumps with the browser decoder.
 *
 * Usage:
 *   tsx tools/blend-decode.ts <file.blend|directory> [--out <dir>] [--quiet]
 */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { decodeBlend } from "../src/blend/index";

const args = process.argv.slice(2);
const target = args.find((value) => !value.startsWith("--"));
const outIndex = args.indexOf("--out");
const outDir = outIndex >= 0 ? args[outIndex + 1] : "";
const quiet = args.includes("--quiet");

if (!target) {
  console.error("Usage: tsx tools/blend-decode.ts <file.blend|directory> [--out <dir>] [--quiet]");
  process.exit(2);
}

async function blendFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".blend")
    .map((entry) => join(path, entry.name))
    .sort();
}

const files = await blendFiles(resolve(target));
if (outDir) await mkdir(resolve(outDir), { recursive: true });

let failures = 0;
for (const path of files) {
  const name = basename(path);
  try {
    const started = performance.now();
    const bytes = new Uint8Array(await readFile(path));
    const { dump, gaps } = await decodeBlend(bytes, { filename: name });
    const elapsed = performance.now() - started;
    const groups = Object.keys(dump.node_groups as Record<string, unknown>);
    const nodes = groups.reduce(
      (sum, key) => sum + ((dump.node_groups as Record<string, { nodes?: unknown[] }>)[key].nodes?.length ?? 0),
      0,
    );
    const objects = (dump.objects as unknown[]).length;
    const roots = (dump.objects as { modifiers?: { type?: string; node_group?: string }[] }[])
      .filter((object) => (object.modifiers ?? []).some((modifier) => modifier.type === "NODES" && modifier.node_group))
      .length;
    if (!quiet) {
      console.log(
        `${name.padEnd(34)} ${elapsed.toFixed(0).padStart(5)}ms  groups=${String(groups.length).padStart(3)}`
        + `  nodes=${String(nodes).padStart(5)}  objects=${String(objects).padStart(3)}  gn-roots=${roots}`
        + `  gaps=${gaps.length}`,
      );
    }
    if (outDir) {
      await writeFile(
        join(resolve(outDir), `${name.replace(/\.blend$/i, "")}.nodes.json`),
        JSON.stringify({ ...dump, portable_gaps: gaps }, null, 1),
      );
    }
  } catch (error) {
    failures += 1;
    console.log(`${name.padEnd(34)} FAILED  ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${files.length - failures}/${files.length} files decoded.`);
process.exit(failures ? 1 : 0);
