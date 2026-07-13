// Fill one String to Curves output directly and report its portable topology.
// Usage: tsx tools/gnvm-string-to-curves-probe.ts DUMP OBJECT NODE
import { readFileSync } from "node:fs";
import { runGenerator, type Dump } from "../src/gnvm/index";
import { GEOMETRY_PROBE } from "../src/gnvm/evaluator";

const [, , dumpPath, objectName, nodeName] = process.argv;
if (!nodeName) throw new Error("usage: DUMP OBJECT NODE");
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
GEOMETRY_PROBE.node = nodeName;
GEOMETRY_PROBE.socket = "Curve Instances";
GEOMETRY_PROBE.geometry = null;
await runGenerator(dump, { object: objectName });
const captured = GEOMETRY_PROBE.geometry;
GEOMETRY_PROBE.node = null;
GEOMETRY_PROBE.socket = null;
if (!captured) throw new Error(`no geometry captured from ${nodeName}`);
let vertices = 0;
let faces = 0;
let curves = captured.curves.length;
const components = [captured, ...captured.instances.map((instance) => instance.geometry)];
for (const component of components) {
  vertices += component.curves.reduce((total, curve) => total + (curve.cyclic && curve.points.length >= 3 ? curve.points.length : 0), 0);
  faces += component.curves.filter((curve) => curve.cyclic && curve.points.length >= 3).length;
  if (component !== captured) curves += component.curves.length;
}
console.log(`GNVM_STRING_TO_CURVES_PROBE_OK ${vertices}v/${faces}f curves=${curves}`);
