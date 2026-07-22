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
const graphOverrides = JSON.parse(process.env.GNVM_PROBE_GRAPH_OVERRIDES ?? "[]") as Array<{
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
const propertyOverrides = JSON.parse(process.env.GNVM_PROBE_NODE_PROPERTIES ?? "[]") as Array<{
  group: string;
  node: string;
  properties: Record<string, unknown>;
}>;
for (const override of propertyOverrides) {
  const node = dump.node_groups?.[override.group]?.nodes.find((candidate) => candidate.name === override.node);
  if (!node) throw new Error(`invalid node property override: ${JSON.stringify(override)}`);
  node.props = { ...node.props, ...override.properties };
}
const rawOverrides = overridesPath ? JSON.parse(readFileSync(overridesPath, "utf8")) : {};
const overrides = Array.isArray(rawOverrides) ? rawOverrides[0]?.overrides ?? {} : rawOverrides;
FIELD_PROBE.node = nodeName;
FIELD_PROBE.socket = socketName;
FIELD_PROBE.group = process.env.GNVM_PROBE_GROUP ?? null;
FIELD_PROBE.batches = [];
const result = await runGenerator(dump, { object: objectName, overrides });
FIELD_PROBE.group = null;
FIELD_PROBE.node = null;
FIELD_PROBE.socket = null;

const batches = FIELD_PROBE.batches.map((batch) => ({
  domain: batch.domain,
  positions: batch.positions,
  values: batch.values,
  rotation_quaternions: batch.values.map((value) =>
    Array.isArray(value)
      ? (value as unknown as { [key: symbol]: [number, number, number, number] })[Symbol.for("gnvm.rotationQuaternion")] ?? null
      : null),
  targets: batch.targets,
}));
writeFileSync(outPath, `${JSON.stringify({ node: nodeName, socket: socketName, overrides, batches }, null, 2)}\n`);
console.log(`GNVM_FIELD_PROBE_OK batches=${batches.length} mesh=${result.soup.stats.verts}v/${result.soup.stats.faces}f -> ${outPath}`);
