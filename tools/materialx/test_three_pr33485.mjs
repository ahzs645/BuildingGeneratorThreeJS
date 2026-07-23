import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareThreePr33485, THREE_PR33485_COMMIT } from "./prepare_three_pr33485.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const references = path.join(repoRoot, "docs/materialx-evidence/archive");

async function waitForServer(url, process, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Vite exited before becoming ready (${process.exitCode})`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server has not bound the port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stop(process) {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => process.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

async function capture({ port, output, implementation, packageRoot }) {
  fs.mkdirSync(output, { recursive: true });
  const env = {
    ...process.env,
    VITE_MATERIALX_THREE_IMPLEMENTATION: implementation,
    VITE_MATERIALX_THREE_LABEL: implementation === "r185"
      ? "Three.js 0.185.1 baseline"
      : `Three.js PR #33485 · ${THREE_PR33485_COMMIT.slice(0, 7)} · ${implementation.endsWith("native") ? "native normal" : "local normal adapter"}`,
  };
  if (packageRoot) env.MATERIALX_THREE_ROOT = packageRoot;
  else delete env.MATERIALX_THREE_ROOT;

  const vite = spawn(path.join(repoRoot, "node_modules/.bin/vite"), ["--host", "127.0.0.1", "--port", String(port)], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  vite.stdout.on("data", (chunk) => { log += chunk; });
  vite.stderr.on("data", (chunk) => { log += chunk; });
  try {
    const url = `http://127.0.0.1:${port}`;
    await waitForServer(url, vite);
    const captureProcess = spawn(process.execPath, [
      "tools/materialx/capture_web_references.mjs",
      url,
      output,
      implementation,
    ], { cwd: repoRoot, stdio: "inherit" });
    const code = await new Promise((resolve) => captureProcess.once("exit", resolve));
    if (code !== 0) throw new Error(`Web reference capture failed for ${implementation} (${code})\n${log}`);
  } finally {
    await stop(vite);
  }
}

const packageRoot = prepareThreePr33485();
await capture({ port: 4173, output: path.join(references, "r185"), implementation: "r185" });
await capture({ port: 4174, output: path.join(references, "pr33485"), implementation: "pr33485-native", packageRoot });
await capture({ port: 4175, output: path.join(references, "pr33485-adapter"), implementation: "pr33485-adapter", packageRoot });
fs.writeFileSync(path.join(references, "pr33485/provenance.json"), `${JSON.stringify({
  pullRequest: "https://github.com/mrdoob/three.js/pull/33485",
  commit: THREE_PR33485_COMMIT,
  captureBackend: "WebGPURenderer forced to WebGL2",
}, null, 2)}\n`);
