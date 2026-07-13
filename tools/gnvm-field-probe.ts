// Evaluate one GN-VM field socket under optional modifier overrides.
// Usage: node --import tsx tools/gnvm-field-probe.ts DUMP OBJECT NODE SOCKET OUT.json [OVERRIDES.json]
import { readFileSync, writeFileSync } from "node:fs";
import { runGenerator, type Dump } from "../src/gnvm/index";
import { FIELD_PROBE } from "../src/gnvm/evaluator";

const [, , dumpPath, objectName, nodeName, socketName, outPath, overridesPath] = process.argv;
if (!dumpPath || !objectName || !nodeName || !socketName || !outPath) {
  throw new Error("usage: node --import tsx tools/gnvm-field-probe.ts DUMP OBJECT NODE SOCKET OUT.json [OVERRIDES.json]");
}

const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
const rawOverrides = overridesPath ? JSON.parse(readFileSync(overridesPath, "utf8")) : {};
const overrides = Array.isArray(rawOverrides) ? rawOverrides[0]?.overrides ?? {} : rawOverrides;
FIELD_PROBE.node = nodeName;
FIELD_PROBE.socket = socketName;
FIELD_PROBE.batches = [];
const result = await runGenerator(dump, { object: objectName, overrides });
FIELD_PROBE.node = null;
FIELD_PROBE.socket = null;

const batches = FIELD_PROBE.batches.map((batch) => ({
  domain: batch.domain,
  positions: batch.positions,
  values: batch.values,
  targets: batch.targets,
}));
writeFileSync(outPath, `${JSON.stringify({ node: nodeName, socket: socketName, overrides, batches }, null, 2)}\n`);
console.log(`GNVM_FIELD_PROBE_OK batches=${batches.length} mesh=${result.soup.stats.verts}v/${result.soup.stats.faces}f -> ${outPath}`);
