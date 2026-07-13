// Export one intermediate geometry-node socket from a GN-VM evaluation.
// Usage: node --import tsx tools/gnvm-node-geometry-probe.ts DUMP OBJECT [GROUP] NODE SOCKET OUT.json
import { readFileSync, writeFileSync } from "node:fs";
import { runGenerator, type Dump } from "../src/gnvm/index";
import { GEOMETRY_PROBE } from "../src/gnvm/evaluator";

const args = process.argv.slice(2);
if (args.length !== 5 && args.length !== 6) throw new Error("usage: DUMP OBJECT [GROUP] NODE SOCKET OUT.json");
const [dumpPath, objectName, ...target] = args;
const [groupName, nodeName, socketName, outPath] = target.length === 4
  ? target
  : [null, target[0], target[1], target[2]];
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
GEOMETRY_PROBE.group = groupName;
GEOMETRY_PROBE.node = nodeName;
GEOMETRY_PROBE.socket = socketName;
GEOMETRY_PROBE.geometry = null;
await runGenerator(dump, { object: objectName });
const geometry = GEOMETRY_PROBE.geometry;
GEOMETRY_PROBE.group = null;
GEOMETRY_PROBE.node = null;
GEOMETRY_PROBE.socket = null;
if (!geometry) throw new Error(`no geometry captured from ${nodeName}:${socketName}`);
const positions = geometry.mesh?.positions ?? geometry.curves.flatMap((curve) => curve.points);
const faces = geometry.mesh?.faces ?? [];
writeFileSync(outPath, `${JSON.stringify({ positions, faces, curves: geometry.curves.length, curve_lengths: geometry.curves.map((curve) => curve.points.length), instances: geometry.instances.length }, null, 2)}\n`);
console.log(`GNVM_NODE_GEOMETRY_PROBE_OK ${positions.length}v/${faces.length}f ${geometry.curves.length}c/${geometry.instances.length}i -> ${outPath}`);
