import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [projectId, script, ...rest] = process.argv.slice(2);
if (!projectId || !script) {
  throw new Error("Usage: run_node_dojo_blender.mjs <project-id> <python-script> [args]");
}
const projects = JSON.parse(fs.readFileSync(
  path.resolve(import.meta.dirname, "../node-dojo-projects.json"),
  "utf8",
));
const project = projects.find((candidate) => candidate.id === projectId);
if (!project) throw new Error(`Unknown Node Dojo project id: ${projectId}`);
const packRoot = process.env.NODE_DOJO_PACK_ROOT
  ?? "/Users/ahmadjalil/Library/CloudStorage/GoogleDrive-ahzs645@gmail.com/My Drive/Downloads Backup/New Folder With Items 7";
const blendFile = path.resolve(packRoot, project.path);
if (!fs.existsSync(blendFile)) {
  throw new Error(`Node Dojo source is missing: ${blendFile}\nSet NODE_DOJO_PACK_ROOT to the extracted pack directory.`);
}
const runner = path.resolve(import.meta.dirname, "run_blender.mjs");
const result = spawnSync(process.execPath, [runner, blendFile, script, ...rest], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
