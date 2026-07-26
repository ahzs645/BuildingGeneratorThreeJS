// Evaluate the same reusable group cases as blender_group_parity_probe.py.
// Usage:
//   node --import tsx tools/gnvm-group-parity.ts \
//     CASES.json ASSET_SLUG DUMP.json BLENDER.json OUT.json
import { readFile, writeFile } from "node:fs/promises";
import { runNodeGroup, type Dump, type GroupGeometrySeed } from "../src/gnvm/index";

type Case = {
  name: string;
  inputs?: Record<string, unknown>;
};

type Suite = {
  group: string;
  profile?: string;
  output?: string;
  geometryInput?: string;
  seed?: "cube";
  seedObject?: string;
  activeObject?: string;
  cases?: Case[];
};

type Asset = {
  slug: string;
  suites: Suite[];
};

type CaseResult = {
  name: string;
  inputs: Record<string, unknown>;
  status: "ok" | "error";
  verts?: number;
  faces?: number;
  triangles?: number;
  bbox?: { min: [number, number, number]; max: [number, number, number] };
  elapsedMs?: number;
  error?: string;
};

const [, , casesPath, assetSlug, dumpPath, blenderPath, outPath] = process.argv;
if (!casesPath || !assetSlug || !dumpPath || !blenderPath || !outPath) {
  throw new Error(
    "usage: CASES.json ASSET_SLUG DUMP.json BLENDER.json OUT.json",
  );
}

const manifest = JSON.parse(await readFile(casesPath, "utf8")) as {
  profiles?: Record<string, Case[]>;
  assets: Asset[];
};
const asset = manifest.assets.find((candidate) => candidate.slug === assetSlug);
if (!asset) throw new Error(`asset not found in cases manifest: ${assetSlug}`);
const dump = JSON.parse(await readFile(dumpPath, "utf8")) as Dump;
const blender = JSON.parse(await readFile(blenderPath, "utf8")) as {
  suites: Array<{ group: string; cases: CaseResult[] }>;
};

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function bounds(positions: Float32Array): {
  min: [number, number, number];
  max: [number, number, number];
} {
  if (!positions.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[offset + axis]);
      max[axis] = Math.max(max[axis], positions[offset + axis]);
    }
  }
  return {
    min: min.map(round6) as [number, number, number],
    max: max.map(round6) as [number, number, number],
  };
}

function maxBoundsDelta(
  left: CaseResult["bbox"],
  right: CaseResult["bbox"],
): number | null {
  if (!left || !right) return null;
  let result = 0;
  for (const key of ["min", "max"] as const)
    for (let axis = 0; axis < 3; axis++)
      result = Math.max(result, Math.abs(left[key][axis] - right[key][axis]));
  return result;
}

const suites = [];
let passed = 0;
let failed = 0;
for (const suite of asset.suites) {
  const suiteCases = suite.cases ?? (
    suite.profile ? manifest.profiles?.[suite.profile] : undefined
  );
  if (!suiteCases?.length)
    throw new Error(`suite has no cases or valid profile: ${assetSlug} / ${suite.group}`);
  const cases: Array<CaseResult & {
    comparison: {
      blenderStatus: string;
      countsExact: boolean;
      bboxMaxAbsDelta: number | null;
      bboxWithinTolerance: boolean;
      pass: boolean;
    };
  }> = [];
  const blenderSuite = blender.suites.find((candidate) => candidate.group === suite.group);
  for (const testCase of suiteCases) {
    const started = performance.now();
    let result: CaseResult;
    try {
      const seed: GroupGeometrySeed | undefined = suite.seedObject
        ? { kind: "object", object: suite.seedObject }
        : suite.seed === "cube"
          ? { kind: "cube", size: 1 }
          : undefined;
      const run = await runNodeGroup(dump, {
        group: suite.group,
        output: suite.output,
        geometryInput: suite.geometryInput,
        seed,
        activeObject: suite.activeObject,
        overrides: testCase.inputs ?? {},
      });
      result = {
        name: testCase.name,
        inputs: testCase.inputs ?? {},
        status: "ok",
        verts: run.soup.stats.verts,
        faces: run.soup.stats.faces,
        triangles: run.soup.stats.tris,
        bbox: bounds(run.soup.positions),
        elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
      };
    } catch (error) {
      result = {
        name: testCase.name,
        inputs: testCase.inputs ?? {},
        status: "error",
        elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      };
    }
    const blenderCase = blenderSuite?.cases.find(
      (candidate) => candidate.name === testCase.name,
    );
    const bboxMaxAbsDelta = maxBoundsDelta(blenderCase?.bbox, result.bbox);
    const countsExact = result.status === "ok"
      && blenderCase?.status === "ok"
      && result.verts === blenderCase.verts
      && result.faces === blenderCase.faces
      && result.triangles === blenderCase.triangles;
    const bboxWithinTolerance = bboxMaxAbsDelta != null && bboxMaxAbsDelta <= 1e-4;
    const pass = countsExact && bboxWithinTolerance;
    if (pass) passed++;
    else failed++;
    cases.push({
      ...result,
      comparison: {
        blenderStatus: blenderCase?.status ?? "missing",
        countsExact,
        bboxMaxAbsDelta,
        bboxWithinTolerance,
        pass,
      },
    });
  }
  suites.push({
    group: suite.group,
    output: suite.output,
    profile: suite.profile,
    seed: suite.seed,
    seedObject: suite.seedObject,
    cases,
  });
}

const payload = {
  schemaVersion: 1,
  runtime: "gnvm",
  asset: assetSlug,
  dump: dumpPath,
  blender: blenderPath,
  summary: { cases: passed + failed, passed, failed },
  suites,
};
await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`GNVM_GROUP_PARITY_OK ${assetSlug}: ${passed}/${passed + failed} exact`);
