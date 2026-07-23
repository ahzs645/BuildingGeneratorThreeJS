// Capture every Volume Cube / Volume to Mesh scalar-grid boundary during one
// GN-VM object evaluation. Intended for full-precision Blender parity probes.
// Usage: npx tsx tools/gnvm-volume-grid-probe.ts DUMP OBJECT OUT.json [OVERRIDES_JSON]
import { readFileSync, writeFileSync } from "node:fs";
import { runGenerator, type Dump } from "../src/gnvm/index";
import {
  setVolumeGridDiagnosticSink,
  type VolumeGridDiagnostics,
} from "../src/gnvm/nodes/volume";

const [, , dumpPath, objectName, outputPath, overridesJson] = process.argv;
if (!dumpPath || !objectName || !outputPath) {
  throw new Error("usage: gnvm-volume-grid-probe DUMP OBJECT OUT.json [OVERRIDES_JSON]");
}

const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
const overrides = overridesJson ? JSON.parse(overridesJson) as Record<string, unknown> : undefined;
const events: Array<Omit<VolumeGridDiagnostics, "values"> & { values: number[] }> = [];
setVolumeGridDiagnosticSink((diagnostics) => {
  events.push({ ...diagnostics, values: Array.from(diagnostics.values) });
});
try {
  const result = await runGenerator(dump, { object: objectName, overrides });
  writeFileSync(outputPath, `${JSON.stringify({
    dump: dumpPath,
    object: objectName,
    stats: result.soup.stats,
    events,
  })}\n`);
} finally {
  setVolumeGridDiagnosticSink(null);
}
console.log(`GNVM_VOLUME_GRID_PROBE_OK: ${events.length} events -> ${outputPath}`);
