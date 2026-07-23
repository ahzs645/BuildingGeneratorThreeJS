// Critical-path coverage probe for bin + bubble-vase dumps.
// Run: npx tsx tools/gnvm-coverage-probe.ts
import fs from "fs";
import { analyzeProgramCapabilities, runGenerator, type Dump } from "../src/gnvm/index";

function findRoot(dump: Dump, objectName?: string): string {
  for (const o of dump.objects ?? []) {
    if (objectName && o.name !== objectName) continue;
    for (const m of o.modifiers ?? []) {
      if (m.type === "NODES" && m.node_group) return m.node_group;
    }
  }
  throw new Error(`no NODES modifier found${objectName ? ` on ${objectName}` : ""}`);
}

async function probe(label: string, path: string, object?: string) {
  const dump = JSON.parse(fs.readFileSync(path, "utf8")) as Dump;
  const root = findRoot(dump, object);
  const capabilities = analyzeProgramCapabilities(dump.node_groups, root);
  const missing = capabilities.unsupportedNodeTypes;
  console.log(`\n=== ${label} ===`);
  console.log(`root=${root}`);
  console.log(`reachable_groups=${capabilities.reachableGroups.length}`);
  console.log(`missing_groups=${capabilities.missingGroups.length}`);
  for (const missingGroup of capabilities.missingGroups)
    console.log(`  MISSING GROUP ${missingGroup.group} (from ${missingGroup.referencedByGroup ?? "root"})`);
  console.log(`missing_critical_path=${missing.length}`);
  if (missing.length) {
    for (const m of missing) console.log(`  MISSING ${m.count} ${m.type}`);
  } else {
    console.log("  (none)");
  }
  const result = await runGenerator(dump, { object });
  const verts = result.soup.stats.verts;
  const faces = result.soup.stats.faces;
  const curves = result.geometry.curvePointCount();
  const inst = result.geometry.instances.length;
  console.log(`runGenerator ok verts=${verts} faces=${faces} curves=${curves} inst=${inst}`);
  console.log(`coverage.missingTypes (eval fallbacks)=${result.coverage.missingTypes.length}`);
  if (result.coverage.missingTypes.length) {
    for (const m of result.coverage.missingTypes.slice(0, 20)) {
      console.log(`  FALLBACK ${m.count} ${m.type}`);
    }
  }
  const ok =
    capabilities.missingGroups.length === 0 &&
    missing.length === 0 &&
    (verts > 0 || curves > 0 || inst > 0);
  console.log(ok ? `PROBE_OK ${label}` : `PROBE_FAIL ${label}`);
  return ok;
}

async function main() {
  const binOk = await probe("bin", "public/dojo/dump_bin.json");
  const vaseOk = await probe("vase", "public/dojo/dump_bubble.json", "BUBBLE VASE");
  console.log(binOk && vaseOk ? "\nCOVERAGE_PROBE_OK" : "\nCOVERAGE_PROBE_FAIL");
  process.exit(binOk && vaseOk ? 0 : 1);
}
main();
