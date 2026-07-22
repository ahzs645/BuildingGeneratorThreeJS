// Run the parameter-space parity sweep through the GN-VM.
// Usage:
//   node --import tsx tools/gnvm-sweep.ts DUMP.json VM.json [BLENDER.json] [VM_EXPORT_DIR] [OBJECT] [CASES.json]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  export?: string;
  error?: string;
}

interface SweepPayload {
  source: string;
  results: SweepResult[];
  [key: string]: unknown;
}

const defaultCases: Combo[] = [
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
  console.error("usage: node --import tsx tools/gnvm-sweep.ts DUMP.json VM.json [BLENDER.json] [VM_EXPORT_DIR] [OBJECT] [CASES.json]");
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

function caseFilename(index: number, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${String(index).padStart(2, "0")}-${slug}.json`;
}

async function runVmSweep(dump: Dump, combos: Combo[], objectName: string, exportDir?: string): Promise<SweepResult[]> {
  const out: SweepResult[] = [];
  if (exportDir) mkdirSync(exportDir, { recursive: true });
  const object = (dump.objects as any[] | undefined)?.find((candidate) => candidate.name === objectName);
  for (const [caseIndex, combo] of combos.entries()) {
    const started = Date.now();
    try {
      const result = await runGenerator(dump, { object: objectName, overrides: combo.overrides });
      const sweepResult: SweepResult = {
        combo,
        status: "ok",
        verts: result.soup.stats.verts,
        faces: result.soup.stats.faces,
        bbox: bbox(result.soup.positions),
        elapsed_ms: Date.now() - started,
      };
      if (exportDir) {
        const filename = caseFilename(caseIndex, combo.name);
        writeFileSync(`${exportDir}/${filename}`, JSON.stringify({
          positions: Array.from(result.soup.positions),
          normals: Array.from(result.soup.normals),
          indices: Array.from(result.soup.indices),
          groups: result.soup.groups,
          stats: result.soup.stats,
          object: object ? {
            name: object.name,
            location: object.location,
            rotation: object.rotation,
            scale: object.scale,
          } : null,
          overrides: combo.overrides,
        }));
        sweepResult.export = filename;
      }
      out.push(sweepResult);
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

const [, , dumpPath, vmOutPath, blenderPath, exportDir, objectArg, casesPath] = process.argv;
if (!dumpPath || !vmOutPath) usage();

const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
const graphOverrides = JSON.parse(process.env.NODE_DOJO_PROBE_GRAPH_OVERRIDES ?? "[]") as Array<{
  group: string;
  node: string;
  inputs: Record<string, unknown>;
}>;
for (const override of graphOverrides) {
  const node = dump.node_groups?.[override.group]?.nodes.find((candidate) => candidate.name === override.node);
  if (!node) throw new Error(`invalid graph override: ${JSON.stringify(override)}`);
  for (const [name, value] of Object.entries(override.inputs)) {
    const socket = node.inputs.find((candidate) => candidate.name === name || candidate.identifier === name);
    if (!socket) throw new Error(`invalid graph override input: ${override.group}.${override.node}.${name}`);
    socket.value = value as never;
  }
}
const graphRoutes = JSON.parse(process.env.NODE_DOJO_PROBE_GRAPH_ROUTES ?? "[]") as Array<{
  group: string;
  node: string;
  socket: string;
  output?: string;
}>;
for (const route of graphRoutes) {
  const group = dump.node_groups?.[route.group];
  const output = group?.nodes.find((node) => node.type === "NodeGroupOutput");
  const target = output?.inputs.find((socket) => socket.type === "NodeSocketGeometry"
    && (!route.output || socket.name === route.output || socket.identifier === route.output));
  const sourceNode = group?.nodes.find((node) => node.name === route.node);
  const source = sourceNode?.outputs.find((socket) => socket.name === route.socket || socket.identifier === route.socket);
  if (!group || !output || !target || !source) throw new Error(`invalid graph route: ${JSON.stringify(route)}`);
  group.links = group.links.filter((link) => link.to_node !== output.name || link.to_socket !== target.identifier);
  group.links.push({ from_node: sourceNode.name, from_socket: source.identifier, to_node: output.name, to_socket: target.identifier });
}
const objectName = objectArg || "Procedural Drawer";
const cases = casesPath ? JSON.parse(readFileSync(casesPath, "utf8")) as Combo[] : defaultCases;
const vmPayload: SweepPayload = {
  source: "gnvm",
  dump: dumpPath,
  object: objectName,
  results: await runVmSweep(dump, cases, objectName, exportDir),
};

writeFileSync(vmOutPath, `${JSON.stringify(vmPayload, null, 2)}\n`);
console.log("GNVM_SWEEP_OK ->", vmOutPath);

if (blenderPath) {
  const blenderPayload = JSON.parse(readFileSync(blenderPath, "utf8")) as SweepPayload;
  console.log(compare(blenderPayload, vmPayload));
}
