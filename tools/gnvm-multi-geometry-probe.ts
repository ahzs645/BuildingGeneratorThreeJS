// Capture several intermediate geometry sockets in one GN-VM evaluation.
// Usage: node --import tsx tools/gnvm-multi-geometry-probe.ts DUMP OBJECT SPECS.json OUT.json
import { readFileSync, writeFileSync } from "node:fs";
import { runGenerator, type Dump } from "../src/gnvm/index";
import { GEOMETRY_PROBES } from "../src/gnvm/evaluator";

const [, , dumpPath, objectName, specsPath, outPath] = process.argv;
if (!dumpPath || !objectName || !specsPath || !outPath) {
  throw new Error("usage: DUMP OBJECT SPECS.json OUT.json");
}

const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
const targets = JSON.parse(readFileSync(specsPath, "utf8")) as {
  id: string;
  group: string;
  node: string;
  socket: string;
}[];
GEOMETRY_PROBES.targets = targets;
GEOMETRY_PROBES.geometries = new Map();
await runGenerator(dump, { object: objectName });

const output = Object.fromEntries(targets.map((target) => {
  const key = `${target.group}\u0000${target.node}\u0000${target.socket}`;
  const geometries = GEOMETRY_PROBES.geometries.get(key) ?? [];
  return [target.id, geometries.map((geometry) => ({
    positions: geometry.mesh?.positions ?? geometry.curves.flatMap((curve) => curve.points),
    faces: geometry.mesh?.faces ?? [],
    edges: geometry.mesh?.edges ?? [],
    curves: geometry.curves.length,
    instances: geometry.instances.length,
  }))];
}));

GEOMETRY_PROBES.targets = [];
GEOMETRY_PROBES.geometries = new Map();
writeFileSync(outPath, `${JSON.stringify(output)}\n`);
console.log(`GNVM_MULTI_GEOMETRY_PROBE_OK targets=${targets.length} -> ${outPath}`);
