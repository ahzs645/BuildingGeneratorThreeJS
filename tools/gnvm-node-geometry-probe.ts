// Export one intermediate geometry-node socket from a GN-VM evaluation.
// Usage: node --import tsx tools/gnvm-node-geometry-probe.ts DUMP OBJECT NODE SOCKET OUT.json
import { readFileSync, writeFileSync } from "node:fs";
import { runGenerator, type Dump } from "../src/gnvm/index";
import { GEOMETRY_PROBE } from "../src/gnvm/evaluator";

const [, , dumpPath, objectName, nodeName, socketName, outPath] = process.argv;
if (!outPath) throw new Error("usage: DUMP OBJECT NODE SOCKET OUT.json");
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
GEOMETRY_PROBE.node = nodeName;
GEOMETRY_PROBE.socket = socketName;
GEOMETRY_PROBE.geometry = null;
await runGenerator(dump, { object: objectName });
const geometry = GEOMETRY_PROBE.geometry;
GEOMETRY_PROBE.node = null;
GEOMETRY_PROBE.socket = null;
if (!geometry?.mesh) throw new Error(`no mesh captured from ${nodeName}:${socketName}`);
writeFileSync(outPath, `${JSON.stringify({ positions: geometry.mesh.positions, faces: geometry.mesh.faces }, null, 2)}\n`);
console.log(`GNVM_NODE_GEOMETRY_PROBE_OK ${geometry.mesh.positions.length}v/${geometry.mesh.faces.length}f -> ${outPath}`);
