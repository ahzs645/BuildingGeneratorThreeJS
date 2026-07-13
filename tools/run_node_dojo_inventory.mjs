// Generate one active Geometry Nodes root report per project using Blender.
// Usage: node tools/run_node_dojo_inventory.mjs [project-id ...]
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const pack = "/Users/ahmadjalil/Library/CloudStorage/GoogleDrive-ahzs645@gmail.com/My Drive/Downloads Backup/New Folder With Items 7";
const blender = "/Applications/Blender.app/Contents/MacOS/Blender";
const projects = JSON.parse(readFileSync(resolve(import.meta.dirname, "node-dojo-projects.json"), "utf8"));
const selected = new Set(process.argv.slice(2));
const outDir = resolve(repo, "public/dojo/inventory");
mkdirSync(outDir, { recursive: true });

for (const project of projects) {
  if (selected.size && !selected.has(project.id)) continue;
  const source = resolve(pack, project.path);
  const output = resolve(outDir, `${project.id}.json`);
  process.stdout.write(`INVENTORY ${project.id}\n`);
  const result = spawnSync(blender, [
    "--background", source,
    "--python", resolve(repo, "tools/rank_modifier_roots.py"),
    "--", output,
  ], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 });
  const marker = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").find((line) => line.includes("RANK_ROOTS_OK"));
  if (result.status !== 0) {
    process.stderr.write(`FAILED ${project.id}: ${result.error?.message ?? `exit ${result.status}`}\n`);
    process.stderr.write((result.stderr ?? "").slice(-2000));
    process.exitCode = 1;
  } else {
    process.stdout.write(`  ${marker ?? `wrote ${output}`}\n`);
  }
}
