import { spawn } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runGeometryTarget,
  type Dump,
} from "../src/gnvm/index";
import {
  aggregateCapabilityReportForBlendStudioTarget,
  discoverBlendStudioTargets,
  modifierStackIssuesForBlendStudioTarget,
  type BlendStudioTarget,
} from "../src/blend-studio/model";
import { presetContractForBlendStudioTarget } from "../src/blend-studio/preset-contracts";

type RuntimeStatus = "geometry" | "empty" | "error" | "timeout" | "not-run";

type TargetAudit = {
  file: string;
  targetId: string;
  label: string;
  kind: BlendStudioTarget["kind"];
  groupName: string;
  modifierIndex?: number;
  exact: boolean;
  portable: boolean;
  unsupported: { type: string; count: number }[];
  approximated: { type: string; count: number }[];
  modifierStackIssues: ReturnType<typeof modifierStackIssuesForBlendStudioTarget>;
  contract: ReturnType<typeof presetContractForBlendStudioTarget>;
  runtime: {
    status: RuntimeStatus;
    durationMs?: number;
    verts?: number;
    faces?: number;
    tris?: number;
    points?: number;
    missingTypes?: { type: string; count: number }[];
    approximateTypes?: { type: string; count: number }[];
    error?: string;
  };
};

type ChildResult = TargetAudit["runtime"];

const args = process.argv.slice(2);
const valueAfter = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

function positiveFiniteFlag(flag: string, fallback: number, integer: boolean): number {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const raw = args[index + 1];
  const value = Number(raw);
  if (
    raw === undefined
    || raw.startsWith("--")
    || !Number.isFinite(value)
    || value <= 0
    || (integer && !Number.isInteger(value))
  ) {
    throw new Error(
      `${flag} must be a finite positive ${integer ? "integer" : "number"}`,
    );
  }
  return value;
}

async function loadDump(path: string): Promise<Dump> {
  return JSON.parse(await readFile(path, "utf8")) as Dump;
}

async function runOne(path: string, targetId: string): Promise<ChildResult> {
  const started = performance.now();
  try {
    const dump = await loadDump(path);
    const target = discoverBlendStudioTargets(dump).find((candidate) => candidate.id === targetId);
    if (!target) throw new Error(`target not found: ${targetId}`);
    const contract = presetContractForBlendStudioTarget(dump, target);
    const result = await runGeometryTarget(
      dump,
      target.kind === "object"
        ? {
          kind: "object",
          object: target.objectName,
          group: target.groupName,
          modifierIndex: target.modifierIndex,
          overrides: target.savedInputs,
          seed: contract.mode === "seed" ? contract.recommendedSeed : undefined,
          geometryInput: contract.geometryInput,
        }
        : {
          kind: "group",
          group: target.groupName,
          overrides: target.savedInputs,
          seed: contract.mode === "seed" ? contract.recommendedSeed : undefined,
          geometryInput: contract.geometryInput,
          output: contract.output,
        },
    );
    const { verts, faces, tris } = result.soup.stats;
    const linePoints = result.soup.lines?.stats.evaluatedPoints ?? 0;
    const pointCloudPoints = result.soup.points?.stats.points ?? 0;
    return {
      status: verts || faces || linePoints || pointCloudPoints ? "geometry" : "empty",
      durationMs: Math.round(performance.now() - started),
      verts,
      faces,
      tris,
      points: pointCloudPoints,
      missingTypes: result.coverage.missingTypes,
      approximateTypes: result.coverage.approximateTypes,
    };
  } catch (error) {
    return {
      status: "error",
      durationMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function runChild(path: string, targetId: string, timeoutMs: number): Promise<ChildResult> {
  return new Promise((resolveChild) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      fileURLToPath(import.meta.url),
      "--child",
      path,
      targetId,
    ], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 1_000_000) stderr += chunk.toString("utf8");
    });
    let settled = false;
    const finish = (result: ChildResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveChild(result);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      finish({ status: "timeout", error: `Exceeded ${timeoutMs} ms` });
    }, timeoutMs);
    child.once("error", (error) => finish({ status: "error", error: error.message }));
    child.once("close", () => {
      if (settled) return;
      try {
        const line = stdout.trim().split("\n").at(-1);
        if (!line) throw new Error(stderr.trim() || "Child produced no result");
        finish(JSON.parse(line) as ChildResult);
      } catch (error) {
        finish({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index], index);
    }
  }));
  return results;
}

async function main(): Promise<void> {
  if (args[0] === "--child") {
    const result = await runOne(resolve(args[1]), args[2]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const dumpDirectory = resolve(args[0] ?? "");
  const output = resolve(valueAfter("--output") ?? "no3d-runtime-audit.json");
  const timeoutMs = positiveFiniteFlag("--timeout-ms", 30_000, false);
  const concurrency = positiveFiniteFlag("--concurrency", 3, true);
  const replacements = new Map(
    args.flatMap((arg, index) =>
      arg === "--replace" && args[index + 1]?.includes("=")
        ? [args[index + 1].split("=", 2) as [string, string]]
        : []),
  );

  const jobs: Array<{ path: string; target: BlendStudioTarget; audit: TargetAudit }> = [];
  for (const entry of (await readdir(dumpDirectory)).filter((name) => name.endsWith(".json")).sort()) {
    const stem = entry.replace(/\.json$/i, "");
    const path = resolve(replacements.get(stem) ?? resolve(dumpDirectory, entry));
    const dump = await loadDump(path);
    if (!dump.node_groups) continue;
    for (const target of discoverBlendStudioTargets(dump)) {
      const report = aggregateCapabilityReportForBlendStudioTarget(dump, target);
      const modifierStackIssues = modifierStackIssuesForBlendStudioTarget(dump, target);
      jobs.push({
        path,
        target,
        audit: {
          file: `${stem}.json`,
          targetId: target.id,
          label: target.label,
          kind: target.kind,
          groupName: target.groupName,
          modifierIndex: target.kind === "object" ? target.modifierIndex : undefined,
          exact: report.exact,
          portable: report.portable,
          unsupported: report.unsupportedNodeTypes,
          approximated: report.approximatedNodeTypes,
          modifierStackIssues,
          contract: presetContractForBlendStudioTarget(dump, target),
          runtime: { status: report.portable ? "not-run" : "not-run" },
        },
      });
    }
  }

  const results = await mapConcurrent(jobs, concurrency, async (job, index) => {
    const runtime = job.audit.portable
      ? await runChild(job.path, job.target.id, timeoutMs)
      : { status: "not-run" as const };
    process.stderr.write(
      `[${index + 1}/${jobs.length}] ${job.audit.file} · ${job.target.label}: ${runtime.status}\n`,
    );
    return { ...job.audit, runtime };
  });
  const summary = {
    files: new Set(results.map((result) => result.file)).size,
    targets: results.length,
    exact: results.filter((result) => result.exact).length,
    portable: results.filter((result) => result.portable).length,
    nonportable: results.filter((result) => !result.portable).length,
    geometry: results.filter((result) => result.runtime.status === "geometry").length,
    empty: results.filter((result) => result.runtime.status === "empty").length,
    errors: results.filter((result) => result.runtime.status === "error").length,
    timeouts: results.filter((result) => result.runtime.status === "timeout").length,
    notRun: results.filter((result) => result.runtime.status === "not-run").length,
  };
  await writeFile(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), summary, targets: results }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

await main();
