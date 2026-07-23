import fs from "node:fs";
import { spawnSync } from "node:child_process";

const [blendFile, script, ...rest] = process.argv.slice(2);
if (!blendFile || !script) throw new Error("Usage: run_blender.mjs <blend-file> <python-script> [args]");
const candidates = [
  process.env.BLENDER_BIN,
  "/Applications/Blender.app/Contents/MacOS/Blender",
  "blender",
].filter(Boolean);
const executable = candidates.find((candidate) => candidate === "blender" || fs.existsSync(candidate));
if (!executable) throw new Error("Blender not found; set BLENDER_BIN");
const result = spawnSync(executable, ["-b", blendFile, "--python-exit-code", "1", "--python", script, ...rest], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
