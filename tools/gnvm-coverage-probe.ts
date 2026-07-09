// Critical-path coverage probe for bin + bubble-vase dumps.
// Run: npx tsx tools/gnvm-coverage-probe.ts
import fs from "fs";
import { runGenerator, REGISTRY, Dump } from "../src/gnvm/index";

const INFRA = new Set([
  "NodeReroute",
  "NodeFrame",
  "NodeGroupInput",
  "NodeGroupOutput",
  "GeometryNodeGroup",
  "GeometryNodeViewer",
  "GeometryNodeGizmoTransform",
  "NodeUndefined",
  "GeometryNodeRepeatInput",
  "GeometryNodeRepeatOutput",
]);

function reachableGroups(dump: Dump, root: string): Set<string> {
  const reach = new Set<string>();
  const q = [root];
  while (q.length) {
    const g = q.pop()!;
    if (!g || reach.has(g)) continue;
    reach.add(g);
    const def = (dump.node_groups as any)[g];
    if (!def) continue;
    for (const n of def.nodes ?? []) {
      if (n.type === "GeometryNodeGroup" && n.group) q.push(n.group);
    }
  }
  return reach;
}

function missingOnPath(dump: Dump, root: string): { type: string; count: number }[] {
  const reach = reachableGroups(dump, root);
  const miss = new Map<string, number>();
  for (const g of reach) {
    for (const n of (dump.node_groups as any)[g].nodes ?? []) {
      if (INFRA.has(n.type) || REGISTRY.has(n.type)) continue;
      miss.set(n.type, (miss.get(n.type) ?? 0) + 1);
    }
  }
  return [...miss.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
}

function findRoot(dump: Dump, objectName?: string): string {
  for (const o of dump.objects ?? []) {
    if (objectName && o.name !== objectName) continue;
    for (const m of o.modifiers ?? []) {
      if (m.type === "NODES" && m.node_group) return m.node_group;
    }
  }
  throw new Error(`no NODES modifier found${objectName ? ` on ${objectName}` : ""}`);
}

function probe(label: string, path: string, object?: string) {
  const dump = JSON.parse(fs.readFileSync(path, "utf8")) as Dump;
  const root = findRoot(dump, object);
  const missing = missingOnPath(dump, root);
  console.log(`\n=== ${label} ===`);
  console.log(`root=${root}`);
  console.log(`reachable_groups=${reachableGroups(dump, root).size}`);
  console.log(`missing_critical_path=${missing.length}`);
  if (missing.length) {
    for (const m of missing) console.log(`  MISSING ${m.count} ${m.type}`);
  } else {
    console.log("  (none)");
  }
  const result = runGenerator(dump, { object });
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
    missing.length === 0 &&
    (verts > 0 || curves > 0 || inst > 0);
  console.log(ok ? `PROBE_OK ${label}` : `PROBE_FAIL ${label}`);
  return ok;
}

const binOk = probe("bin", "public/dojo/dump_bin.json");
const vaseOk = probe("vase", "public/dojo/dump_bubble.json", "BUBBLE VASE");
console.log(binOk && vaseOk ? "\nCOVERAGE_PROBE_OK" : "\nCOVERAGE_PROBE_FAIL");
process.exit(binOk && vaseOk ? 0 : 1);
