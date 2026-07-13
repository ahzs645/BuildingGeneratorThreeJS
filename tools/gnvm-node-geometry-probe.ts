// Export one intermediate geometry-node socket from a GN-VM evaluation.
// Usage: node --import tsx tools/gnvm-node-geometry-probe.ts DUMP OBJECT [GROUP] NODE SOCKET OUT.json [OVERRIDES.json]
import { readFileSync, writeFileSync } from "node:fs";
import { runGenerator, type Dump } from "../src/gnvm/index";
import { GEOMETRY_PROBE } from "../src/gnvm/evaluator";

const args = process.argv.slice(2);
if (args.length < 5 || args.length > 7) throw new Error("usage: DUMP OBJECT [GROUP] NODE SOCKET OUT.json [OVERRIDES.json]");
const [dumpPath, objectName, ...rest] = args;
// The optional override form is intentionally paired with an explicit group
// name so it remains unambiguous with the legacy six-argument group form.
const overridesPath = rest.length === 5 ? rest.pop() : undefined;
const target = rest;
const [groupName, nodeName, socketName, outPath] = target.length === 4
  ? target
  : [null, target[0], target[1], target[2]];
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
GEOMETRY_PROBE.group = groupName;
GEOMETRY_PROBE.node = nodeName;
GEOMETRY_PROBE.socket = socketName;
GEOMETRY_PROBE.geometry = null;
const rawOverrides = overridesPath ? JSON.parse(readFileSync(overridesPath, "utf8")) : {};
const overrides = Array.isArray(rawOverrides) ? rawOverrides[0]?.overrides ?? {} : rawOverrides;
await runGenerator(dump, { object: objectName, overrides });
const geometry = GEOMETRY_PROBE.geometry;
GEOMETRY_PROBE.group = null;
GEOMETRY_PROBE.node = null;
GEOMETRY_PROBE.socket = null;
if (!geometry) throw new Error(`no geometry captured from ${nodeName}:${socketName}`);
const positions = geometry.mesh?.positions ?? geometry.curves.flatMap((curve) => curve.points);
const faces = geometry.mesh?.faces ?? [];
const instance_payloads = geometry.instances.map((instance) => ({
  verts: instance.geometry.mesh?.positions.length ?? 0,
  faces: instance.geometry.mesh?.faces.length ?? 0,
  curves: instance.geometry.curves.length,
  instances: instance.geometry.instances.length,
  position: instance.position,
  rotation: instance.rotation,
  scale: instance.scale,
}));
const attributes = Object.fromEntries([...(geometry.mesh?.attributes ?? [])].map(([name, attribute]) => [name, {
  domain: attribute.domain,
  count: attribute.data.length,
  sample: attribute.data.slice(0, 8),
}]));
const curve_attributes = Object.fromEntries([...geometry.curveAttributes].map(([name, attribute]) => [name, {
  domain: attribute.domain,
  count: attribute.data.length,
  sample: attribute.data.slice(0, 8),
}]));
writeFileSync(outPath, `${JSON.stringify({ positions, edges: geometry.mesh?.edges ?? [], faces, attributes, curves: geometry.curves.length, curve_lengths: geometry.curves.map((curve) => curve.points.length), curve_attributes, instances: geometry.instances.length, instance_payloads }, null, 2)}\n`);
console.log(`GNVM_NODE_GEOMETRY_PROBE_OK ${positions.length}v/${faces.length}f ${geometry.curves.length}c/${geometry.instances.length}i -> ${outPath}`);
