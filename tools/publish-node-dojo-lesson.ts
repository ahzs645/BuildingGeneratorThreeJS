/**
 * Publish a graph-first Node Dojo lesson from the Blender bridge dump while
 * replacing its lossy Blender-5 annotation points with raw SDNA data.
 *
 * Usage:
 *   tsx tools/publish-node-dojo-lesson.ts <bridge.json> <raw.json> <output.json>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Dump } from "../src/gnvm/dump-schema";

const [bridgePath, rawPath, outputPath] = process.argv.slice(2);
if (!bridgePath || !rawPath || !outputPath) {
  console.error("Usage: tsx tools/publish-node-dojo-lesson.ts <bridge.json> <raw.json> <output.json>");
  process.exit(2);
}

const objectName = "Cube.010";
const groupName = "Geometry Nodes.005";
const bridge = JSON.parse(await readFile(resolve(bridgePath), "utf8")) as Dump;
const raw = JSON.parse(await readFile(resolve(rawPath), "utf8")) as Dump;
const group = bridge.node_groups[groupName];
const rawGroup = raw.node_groups[groupName];
const object = bridge.objects?.find((candidate) => candidate.name === objectName);
if (!group || !rawGroup || !object) throw new Error(`${objectName} / ${groupName} is missing from an input dump.`);
if (!(object.modifiers ?? []).some((modifier) => modifier.type === "NODES" && modifier.node_group === groupName)) {
  throw new Error(`${groupName} is not assigned to ${objectName}.`);
}
const annotationName = rawGroup.annotation;
const annotation = annotationName ? raw.annotations?.[annotationName] : undefined;
if (!annotationName || !annotation) throw new Error(`${groupName} has no raw annotation payload.`);

const published: Dump = structuredClone(bridge);
published.annotations = { [annotationName]: structuredClone(annotation) };
published.node_groups[groupName].annotation = annotationName;
published.node_groups[groupName].view_center = rawGroup.view_center ?? group.view_center;
published.lesson = {
  schema_version: 1,
  id: "course-intro-possibilities",
  title: "Course Intro · The Possibilities",
  object: objectName,
  group: groupName,
  initial_view: {
    center: published.node_groups[groupName].view_center,
    zoom: 0.3,
  },
};

const strokes = annotation.layers.flatMap((layer) => layer.frames)
  .reduce((sum, frame) => sum + frame.strokes.length, 0);
const points = annotation.layers.flatMap((layer) => layer.frames).flatMap((frame) => frame.strokes)
  .reduce((sum, stroke) => sum + stroke.points.length, 0);
if (group.nodes.length !== 19 || group.links.length !== 8 || strokes !== 468 || points !== 11_790) {
  throw new Error(`Unexpected lesson contract: ${group.nodes.length} nodes, ${group.links.length} links, ${strokes} strokes, ${points} points.`);
}

const destination = resolve(outputPath);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(published, null, 1)}\n`);
console.log(`PUBLISHED ${objectName} / ${groupName} -> ${destination}`);
