// Print geometry-bearing nodes from a full GN-VM run, scoped by an optional
// case-insensitive substring. Useful when a mesh-diff identifies a local error.
// Usage: npx tsx tools/gnvm-trace.ts <dump.json> [ObjectName] [filter] [overrides.json]
import { readFileSync } from "node:fs";
import { runGenerator, Dump } from "../src/gnvm/index";
import { TRACE } from "../src/gnvm/evaluator";

const [, , dumpPath, objectName, filter, overridesPath] = process.argv;
if (!dumpPath) throw new Error("usage: npx tsx tools/gnvm-trace.ts <dump.json> [ObjectName] [filter]");

const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
TRACE.on = true;
TRACE.log = [];
const overrides = overridesPath
  ? JSON.parse(readFileSync(overridesPath, "utf8"))[0]?.overrides ?? {}
  : undefined;
const result = await runGenerator(dump, { object: objectName, overrides });
TRACE.on = false;

const needle = filter?.toLowerCase();
const entries = TRACE.log.filter((entry) => !needle || `${entry.group} ${entry.node} ${entry.type}`.toLowerCase().includes(needle));
for (const entry of entries) {
  console.log(`${entry.group} :: ${entry.node} [${entry.type}] ${entry.out} — ${entry.verts}v ${entry.faces}f ${entry.curves}c ${entry.inst}i ${entry.bbox ?? "-"}`);
}
console.log(`TRACE_OK geometry=${result.soup.stats.verts}v/${result.soup.stats.faces}f entries=${entries.length}/${TRACE.log.length}`);
