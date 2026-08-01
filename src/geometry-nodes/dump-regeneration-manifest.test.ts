import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

type Entry = {
  output: string;
  project: string;
  targets: string[];
  root_groups: string[];
  shared_catalog_ids: string[];
  preprocessors?: string[];
  postprocessors: string[];
};

const repo = resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(readFileSync(
  resolve(repo, "tools/node-dojo-dump-regeneration-manifest.json"),
  "utf8",
)) as { schema_version: number; entries: Entry[] };
const projects = JSON.parse(readFileSync(
  resolve(repo, "tools/node-dojo-projects.json"),
  "utf8",
)) as { id: string }[];
const catalog = JSON.parse(readFileSync(
  resolve(repo, "public/dojo/chrome-assets/catalog.json"),
  "utf8",
)) as { id: string }[];

function dumpArtifacts(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...dumpArtifacts(path));
    else if (/^dump.*\.json$/i.test(entry.name)) result.push(relative(repo, path));
  }
  return result.sort();
}

test("dump regeneration manifest covers every saved artifact and catalog target", () => {
  assert.equal(manifest.schema_version, 1);
  const outputs = manifest.entries.map((entry) => entry.output).sort();
  assert.equal(new Set(outputs).size, outputs.length);
  assert.deepEqual(outputs, dumpArtifacts(resolve(repo, "public/dojo")));
  assert.equal(outputs.length, 80);

  const projectIds = new Set(projects.map((project) => project.id));
  const catalogIds = new Set(catalog.map((asset) => asset.id));
  const manifestedCatalogIds = new Set<string>();

  for (const entry of manifest.entries) {
    assert.ok(projectIds.has(entry.project), `${entry.output}: unknown project ${entry.project}`);
    const dump = JSON.parse(readFileSync(resolve(repo, entry.output), "utf8")) as {
      objects?: { name: string }[];
      node_groups?: Record<string, unknown>;
    };
    const objects = new Set((dump.objects ?? []).map((object) => object.name));
    for (const target of entry.targets) assert.ok(objects.has(target), `${entry.output}: missing ${target}`);
    for (const group of entry.root_groups) {
      assert.ok(dump.node_groups?.[group], `${entry.output}: missing ${group}`);
    }
    for (const id of entry.shared_catalog_ids) {
      assert.ok(catalogIds.has(id), `${entry.output}: unknown catalog id ${id}`);
      assert.ok(!manifestedCatalogIds.has(id), `${entry.output}: duplicate catalog id ${id}`);
      manifestedCatalogIds.add(id);
    }
    for (const processor of [...(entry.preprocessors ?? []), ...entry.postprocessors]) {
      assert.ok(existsSync(resolve(repo, processor)), `${entry.output}: missing processor ${processor}`);
    }
  }

  assert.deepEqual([...manifestedCatalogIds].sort(), [...catalogIds].sort());
});
