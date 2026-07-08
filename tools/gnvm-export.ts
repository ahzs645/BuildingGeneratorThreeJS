// Export a generator's VM result as a JSON tri-soup for viewers/diff tools.
// Usage: node --import tsx tools/gnvm-export.ts <dump.json> <out.json> [ObjectName]
import { readFileSync, writeFileSync } from "node:fs";
import { runGenerator, Dump } from "../src/gnvm/index";

const [, , dumpPath, outPath, objName] = process.argv;
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
const t0 = Date.now();
const res = runGenerator(dump, { object: objName });
const soup = res.soup;
// Include the object's world transform: bakes/GLB exports apply it, the VM
// evaluates in local space — viewers need it to overlay the two.
const obj: any = (dump.objects ?? []).find((o: any) => (objName ? o.name === objName : o.modifiers?.some((m: any) => m.type === "NODES")));
writeFileSync(
  outPath,
  JSON.stringify({
    positions: Array.from(soup.positions),
    normals: Array.from(soup.normals),
    indices: Array.from(soup.indices),
    groups: soup.groups,
    stats: soup.stats,
    object: obj ? { name: obj.name, location: obj.location, rotation: obj.rotation, scale: obj.scale } : null,
  })
);
console.log(`GNVM_EXPORT_OK -> ${outPath} (${soup.stats.verts} verts, ${soup.stats.tris} tris, ${Date.now() - t0} ms)`);
