/**
 * Merge raw-SDNA annotation data into a Blender RNA bridge dump.
 *
 * Blender's RNA API exposes converted annotation coordinates but may omit
 * original per-point pressure/strength/time. The direct .blend decoder keeps
 * those fields, so staged exports use the bridge for geometry/dependencies and
 * replace only annotation/view metadata from the raw dump.
 *
 * Usage:
 *   tsx tools/merge-raw-annotations.ts <bridge.json> <raw.json> <output.json>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Dump, DumpAnnotation } from "../src/gnvm/dump-schema";

const [bridgePath, rawPath, outputPath] = process.argv.slice(2);
if (!bridgePath || !rawPath || !outputPath) {
  console.error("Usage: tsx tools/merge-raw-annotations.ts <bridge.json> <raw.json> <output.json>");
  process.exit(2);
}

const bridge = JSON.parse(await readFile(resolve(bridgePath), "utf8")) as Dump;
const raw = JSON.parse(await readFile(resolve(rawPath), "utf8")) as Dump;
const merged: Dump = structuredClone(bridge);
const annotations: Record<string, DumpAnnotation> = {};

let referencedGroups = 0;
let mergedGroups = 0;
let strokes = 0;
let points = 0;

for (const [groupName, group] of Object.entries(merged.node_groups)) {
  const rawGroup = raw.node_groups[groupName];
  if (!rawGroup) continue;
  if (rawGroup.view_center) group.view_center = structuredClone(rawGroup.view_center);
  if (!rawGroup.annotation) continue;
  referencedGroups += 1;
  const annotation = raw.annotations?.[rawGroup.annotation];
  if (!annotation) {
    throw new Error(`${groupName} references missing raw annotation ${rawGroup.annotation}.`);
  }
  group.annotation = rawGroup.annotation;
  annotations[rawGroup.annotation] ??= structuredClone(annotation);
  mergedGroups += 1;
}

for (const annotation of Object.values(annotations)) {
  for (const layer of annotation.layers) {
    for (const frame of layer.frames) {
      strokes += frame.strokes.length;
      for (const stroke of frame.strokes) points += stroke.points.length;
    }
  }
}

if (referencedGroups !== mergedGroups) {
  throw new Error(`Merged ${mergedGroups}/${referencedGroups} referenced annotation groups.`);
}

merged.annotations = annotations;
if (raw.node_editor_views) merged.node_editor_views = structuredClone(raw.node_editor_views);

const destination = resolve(outputPath);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(merged, null, 1)}\n`);
console.log(
  `ANNOTATIONS_MERGED groups=${mergedGroups} blocks=${Object.keys(annotations).length}`
  + ` strokes=${strokes} points=${points} -> ${destination}`,
);
