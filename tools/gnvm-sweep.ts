// Run the parameter-space parity sweep through the GN-VM.
// Usage:
//   node --import tsx tools/gnvm-sweep.ts public/dojo/dump_bin.json VM.json [BLENDER.json]
import { readFileSync, writeFileSync } from "node:fs";
import { runGenerator, Dump } from "../src/gnvm/index";

type Numeric = number | boolean;
type Vec3 = [number, number, number];

interface Combo {
  name: string;
  overrides: Record<string, Numeric>;
}

interface BBox {
  min: Vec3;
  max: Vec3;
}

interface SweepResult {
  combo: Combo;
  status: "ok" | "error" | "timeout";
  verts: number | null;
  faces: number | null;
  bbox: BBox | null;
  elapsed_ms: number | null;
  error?: string;
}

interface SweepPayload {
  source: string;
  results: SweepResult[];
  [key: string]: unknown;
}

const cases: Combo[] = [
  ...[0.15, 0.417, 0.85].flatMap((dx) =>
    [0.2, 0.633, 0.9].map((dy) => ({
      name: `divide x=${dx}, divide y=${dy}`,
      overrides: { "divide x": dx, "divide y": dy },
    })),
  ),
  { name: "fillet=0.3", overrides: { fillet: 0.3 } },
  { name: "fillet=2.5", overrides: { fillet: 2.5 } },
  { name: "Bin Select=0", overrides: { "Bin Select": 0 } },
  { name: "Bin Select=11", overrides: { "Bin Select": 11 } },
  { name: "bin wall thiccness=4", overrides: { "bin wall thiccness": 4.0 } },
  { name: "Size X=1.2, Size Y=0.8", overrides: { "Size X": 1.2, "Size Y": 0.8 } },
];

function usage(): never {
  console.error("usage: node --import tsx tools/gnvm-sweep.ts public/dojo/dump_bin.json VM.json [BLENDER.json]");
  process.exit(2);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function bbox(positions: Float32Array): BBox {
  if (!positions.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  const mn: Vec3 = [Infinity, Infinity, Infinity];
  const mx: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis];
      if (value < mn[axis]) mn[axis] = value;
      if (value > mx[axis]) mx[axis] = value;
    }
  }
  return {
    min: [round4(mn[0]), round4(mn[1]), round4(mn[2])],
    max: [round4(mx[0]), round4(mx[1]), round4(mx[2])],
  };
}

async function runVmSweep(dump: Dump): Promise<SweepResult[]> {
  const out: SweepResult[] = [];
  for (const combo of cases) {
    const started = Date.now();
    try {
      const result = await runGenerator(dump, { object: "Procedural Drawer", overrides: combo.overrides });
      out.push({
        combo,
        status: "ok",
        verts: result.soup.stats.verts,
        faces: result.soup.stats.faces,
        bbox: bbox(result.soup.positions),
        elapsed_ms: Date.now() - started,
      });
    } catch (error) {
      out.push({
        combo,
        status: "error",
        verts: null,
        faces: null,
        bbox: null,
        elapsed_ms: Date.now() - started,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    }
  }
  return out;
}

function fmtNum(value: number | null, digits = 1): string {
  return value == null || !Number.isFinite(value) ? "n/a" : value.toFixed(digits);
}

function fmtCount(verts: number | null, faces: number | null): string {
  return verts == null || faces == null ? "n/a" : `${verts}/${faces}`;
}

function maxAbsBboxDiff(a: BBox | null, b: BBox | null): number | null {
  if (!a || !b) return null;
  let diff = 0;
  for (const key of ["min", "max"] as const) {
    for (let i = 0; i < 3; i++) diff = Math.max(diff, Math.abs(a[key][i] - b[key][i]));
  }
  return diff;
}

function vertDeltaPct(blenderVerts: number | null, vmVerts: number | null): number | null {
  if (blenderVerts == null || vmVerts == null || blenderVerts === 0) return null;
  return ((vmVerts - blenderVerts) / blenderVerts) * 100;
}

function compare(blender: SweepPayload, vm: SweepPayload): string {
  const byName = new Map<string, SweepResult>();
  for (const result of blender.results) byName.set(result.combo.name, result);

  const rows = [
    "combo | blender v/f | vm v/f | %vert delta | bbox max-abs diff | flag",
    "--- | ---: | ---: | ---: | ---: | ---",
  ];

  for (const vmResult of vm.results) {
    const blenderResult = byName.get(vmResult.combo.name);
    const pct = vertDeltaPct(blenderResult?.verts ?? null, vmResult.verts);
    const bboxDiff = maxAbsBboxDiff(blenderResult?.bbox ?? null, vmResult.bbox);
    const flags: string[] = [];
    if (pct == null || Math.abs(pct) > 15) flags.push("verts");
    if (bboxDiff == null || bboxDiff > 0.02) flags.push("bbox");
    if (blenderResult?.status !== "ok") flags.push(`blender-${blenderResult?.status ?? "missing"}`);
    if (vmResult.status !== "ok") flags.push(`vm-${vmResult.status}`);
    rows.push(
      [
        vmResult.combo.name,
        fmtCount(blenderResult?.verts ?? null, blenderResult?.faces ?? null),
        fmtCount(vmResult.verts, vmResult.faces),
        pct == null ? "n/a" : fmtNum(pct, 2),
        bboxDiff == null ? "n/a" : fmtNum(bboxDiff, 4),
        flags.length ? flags.join(",") : "",
      ].join(" | "),
    );
  }

  return rows.join("\n");
}

const [, , dumpPath, vmOutPath, blenderPath] = process.argv;
if (!dumpPath || !vmOutPath) usage();

const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
const vmPayload: SweepPayload = {
  source: "gnvm",
  dump: dumpPath,
  object: "Procedural Drawer",
  results: await runVmSweep(dump),
};

writeFileSync(vmOutPath, `${JSON.stringify(vmPayload, null, 2)}\n`);
console.log("GNVM_SWEEP_OK ->", vmOutPath);

if (blenderPath) {
  const blenderPayload = JSON.parse(readFileSync(blenderPath, "utf8")) as SweepPayload;
  console.log(compare(blenderPayload, vmPayload));
}
