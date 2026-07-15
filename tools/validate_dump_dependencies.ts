import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findModifierGroup, runGenerator, type Dump } from "../src/gnvm/index";
import { resolveObjectDependencyOrder } from "../src/gnvm/dependency-metadata";

const [, , input = "public/dojo/send-nodes-hat/dump.json", objectName = "embroidery crv"] = process.argv;
const path = resolve(input);
const dump = JSON.parse(await readFile(path, "utf8")) as Dump;
const root = findModifierGroup(dump, objectName);
if (!root) throw new Error(`No Geometry Nodes modifier found for ${objectName}`);

const objectNames = new Set((dump.objects ?? []).map((object) => object.name));
const dependencies = resolveObjectDependencyOrder(dump, root.group, root.objectName);
const missing = dependencies.filter((name) => !objectNames.has(name));
if (missing.length) throw new Error(`Missing object payloads: ${missing.join(", ")}`);

for (const descriptor of dump.extraction_metadata?.dependencies ?? []) {
  if (!descriptor.id || !descriptor.kind || !descriptor.target?.name)
    throw new Error(`Malformed dependency descriptor: ${JSON.stringify(descriptor)}`);
  if (descriptor.availability === "embedded" && descriptor.kind === "object" && !objectNames.has(descriptor.target.name))
    throw new Error(`Descriptor ${descriptor.id} marks absent object ${descriptor.target.name} as embedded`);
}

const evaluation = process.argv.includes("--evaluate")
  ? (await runGenerator(dump, { object: root.objectName })).soup.stats
  : undefined;

console.log(JSON.stringify({
  dump: path,
  object: root.objectName,
  root_group: root.group,
  metadata_schema: dump.extraction_metadata?.schema_version ?? null,
  dependency_order: dependencies,
  ...(evaluation ? { evaluation } : {}),
}, null, 2));
