import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const THREE_PR33485_COMMIT = "bce55b294825d273eae3e178aab3191f719594e6";
export const THREE_PR33485_SOURCE = `github:bhouston/three.js#${THREE_PR33485_COMMIT}`;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cacheRoot = path.join(repoRoot, ".cache/materialx/three-pr33485");
const packageRoot = path.join(cacheRoot, "package");
const provenancePath = path.join(cacheRoot, "provenance.json");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  }
  return result.stdout.trim();
}

export function prepareThreePr33485() {
  if (fs.existsSync(path.join(packageRoot, "src/Three.WebGPU.js")) && fs.existsSync(provenancePath)) {
    const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
    if (provenance.commit === THREE_PR33485_COMMIT) return packageRoot;
  }

  fs.rmSync(cacheRoot, { recursive: true, force: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "three-pr33485-"));
  try {
    const archiveName = run("npm", ["pack", THREE_PR33485_SOURCE, "--pack-destination", staging, "--silent"], { cwd: repoRoot })
      .split(/\r?\n/)
      .filter(Boolean)
      .at(-1);
    if (!archiveName) throw new Error("npm pack did not report an archive name");
    run("tar", ["-xzf", path.join(staging, archiveName), "-C", cacheRoot]);
    if (!fs.existsSync(path.join(packageRoot, "examples/jsm/loaders/MaterialXLoader.js"))) {
      throw new Error("Prepared package does not contain MaterialXLoader.js");
    }
    fs.writeFileSync(provenancePath, `${JSON.stringify({
      source: "bhouston/three.js pull request #33485",
      pullRequest: "https://github.com/mrdoob/three.js/pull/33485",
      commit: THREE_PR33485_COMMIT,
      license: "MIT (Three.js LICENSE included in downloaded package)",
      distributed: false,
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return packageRoot;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  console.log(prepareThreePr33485());
}
