// Run the GN-VM against a real dumped .blend and print a coverage report.
// Usage: npx tsx tools/gnvm-run.ts <dump.json> [ObjectName]
import { readFileSync } from "node:fs";
import { runGenerator, Dump } from "../src/gnvm/index";

const path = process.argv[2];
const obj = process.argv[3];
const dump = JSON.parse(readFileSync(path, "utf8")) as Dump;

const t0 = Date.now();
const res = await runGenerator(dump, { object: obj });
const ms = Date.now() - t0;

console.log(`\n=== GN-VM run: ${path.split("/").pop()}${obj ? ` [${obj}]` : ""} ===`);
console.log(`eval time: ${ms} ms`);
console.log(`geometry:  ${res.soup.stats.verts} verts, ${res.soup.stats.faces} faces, ${res.soup.stats.tris} tris`);
const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
for (let index = 0; index < res.soup.positions.length; index += 3) {
  for (let axis = 0; axis < 3; axis++) {
    bounds.min[axis] = Math.min(bounds.min[axis], res.soup.positions[index + axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], res.soup.positions[index + axis]);
  }
}
console.log(`bounds:    ${JSON.stringify(bounds)}`);
console.log(`materials: ${res.soup.groups.map((g) => g.material ?? "none").join(", ") || "none"}`);
console.log(`handlers registered: ${res.coverage.handled}`);

const miss = res.coverage.missingTypes;
if (!miss.length) {
  console.log("\nCOVERAGE: 100% — every node type had a handler.");
} else {
  const total = miss.reduce((n, m) => n + m.count, 0);
  console.log(`\nCOVERAGE GAP: ${miss.length} node types unhandled (${total} instances), routed through passthrough fallback:`);
  for (const m of miss) console.log(`   ${String(m.count).padStart(4)}x  ${m.type}`);
}
