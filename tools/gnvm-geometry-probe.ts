// Export the VM's polygon mesh before TriSoup triangulation.
// Usage: tsx tools/gnvm-geometry-probe.ts DUMP OBJECT OUT.json [OVERRIDES.json]
import { readFileSync, writeFileSync } from "node:fs";
import { runGenerator, type Dump } from "../src/gnvm/index";

const [, , dumpPath, objectName, outPath, overridesJson] = process.argv;
if (!dumpPath || !objectName || !outPath) throw new Error("usage: gnvm-geometry-probe DUMP OBJECT OUT.json [OVERRIDES.json]");
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
const overrides = overridesJson ? JSON.parse(overridesJson) : {};
const result = await runGenerator(dump, { object: objectName, overrides });
const mesh = result.geometry.mesh;
writeFileSync(outPath, JSON.stringify({
  positions: mesh?.positions ?? [],
  faces: mesh?.faces ?? [],
  edges: mesh?.edges ?? [],
  attributes: Object.fromEntries([...(mesh?.attributes ?? [])].map(([name, attr]) => [name, attr])),
}));
console.log(`GNVM_GEOMETRY_PROBE_OK: ${mesh?.positions.length ?? 0} verts, ${mesh?.faces.length ?? 0} faces -> ${outPath}`);
