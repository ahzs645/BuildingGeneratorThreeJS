// Capture a constant scalar/vector socket from each evaluation of a GN-VM node.
// Usage: node --import tsx tools/gnvm-value-probe.ts DUMP OBJECT GROUP NODE SOCKET OUT.json [OVERRIDES.json]
import { readFileSync, writeFileSync } from "node:fs";
import { runGenerator, type Dump } from "../src/gnvm/index";
import { VALUE_PROBE } from "../src/gnvm/evaluator";

const [, , dumpPath, objectName, groupName, nodeName, socketName, outPath, overridesPath] = process.argv;
if (!dumpPath || !objectName || !groupName || !nodeName || !socketName || !outPath) {
  throw new Error("usage: DUMP OBJECT GROUP NODE SOCKET OUT.json [OVERRIDES.json]");
}

const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
const rawOverrides = overridesPath ? JSON.parse(readFileSync(overridesPath, "utf8")) : {};
const overrides = Array.isArray(rawOverrides) ? rawOverrides[0]?.overrides ?? {} : rawOverrides;
VALUE_PROBE.group = groupName;
VALUE_PROBE.node = nodeName;
VALUE_PROBE.socket = socketName;
VALUE_PROBE.values = [];
await runGenerator(dump, { object: objectName, overrides });
const values = VALUE_PROBE.values;
VALUE_PROBE.group = null;
VALUE_PROBE.node = null;
VALUE_PROBE.socket = null;
writeFileSync(outPath, `${JSON.stringify({ group: groupName, node: nodeName, socket: socketName, values }, null, 2)}\n`);
console.log(`GNVM_VALUE_PROBE_OK ${values.length} value(s) -> ${outPath}`);
