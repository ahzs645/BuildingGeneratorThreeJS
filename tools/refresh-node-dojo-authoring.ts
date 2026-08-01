/**
 * Refresh Blender-authored graph presentation data in every checked-in dump.
 *
 * The committed corpus contains curated geometry snapshots, font atlases,
 * topology hints, and graph edits that must survive extractor upgrades. This
 * command therefore starts from each committed dump and overlays only data for
 * which the original .blend is authoritative: node/frame layout, labels,
 * parent relationships, tree view centers, and raw annotation strokes.
 *
 * Usage:
 *   tsx tools/refresh-node-dojo-authoring.ts \
 *     --manifest tools/node-dojo-export-manifest.json \
 *     --pack-root /path/to/New\ Folder\ With\ Items\ 7 \
 *     --out /tmp/node-dojo-authoring-refresh
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { decodeBlend } from "../src/blend/index";
import type { Dump, DumpAnnotation } from "../src/gnvm/dump-schema";

type ManifestEntry = {
  output: string;
  project: string;
  mode: "target" | "full";
  targets: string[];
  postprocessors: string[];
  notes?: string;
};

type Manifest = { schema_version: 1; entries: ManifestEntry[] };
type Project = { id: string; path: string };

const args = process.argv.slice(2);
function value(flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${flag}.`);
  return args[index + 1];
}

const repo = resolve(import.meta.dirname, "..");
const manifestPath = resolve(value("--manifest"));
const packRoot = resolve(value("--pack-root"));
const outRoot = resolve(value("--out"));
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
const projects = JSON.parse(
  await readFile(resolve(import.meta.dirname, "node-dojo-projects.json"), "utf8"),
) as Project[];
const projectById = new Map(projects.map((project) => [project.id, project]));

if (manifest.schema_version !== 1 || !Array.isArray(manifest.entries)) {
  throw new Error(`Unsupported export manifest: ${manifestPath}`);
}

const outputs = new Set<string>();
for (const entry of manifest.entries) {
  if (outputs.has(entry.output)) throw new Error(`Duplicate manifest output: ${entry.output}`);
  outputs.add(entry.output);
  if (!projectById.has(entry.project)) throw new Error(`Unknown project ${entry.project} for ${entry.output}.`);
}

type RefreshStats = {
  output: string;
  project: string;
  source_sha256: string;
  groups: number;
  groups_missing_in_source: string[];
  nodes_updated: number;
  nodes_missing_in_source: number;
  annotation_blocks: number;
  annotation_strokes: number;
  annotation_points: number;
  bytes_before: number;
  bytes_after: number;
};

const report: { schema_version: 1; generated_at: string; entries: RefreshStats[] } = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  entries: [],
};

function finiteAnnotations(annotations: Record<string, DumpAnnotation>): void {
  for (const [annotationName, annotation] of Object.entries(annotations)) {
    for (const layer of annotation.layers) {
      if (!Number.isFinite(layer.opacity) || !Number.isFinite(layer.thickness)) {
        throw new Error(`${annotationName}/${layer.name} has non-finite layer styling.`);
      }
      for (const frame of layer.frames) {
        if (!Number.isFinite(frame.number)) throw new Error(`${annotationName} has a non-finite frame.`);
        for (const stroke of frame.strokes) {
          for (const point of stroke.points) {
            if (!point.every((component) => component === undefined || Number.isFinite(component))) {
              throw new Error(`${annotationName} has a non-finite annotation point.`);
            }
          }
        }
      }
    }
  }
}

function refreshDump(current: Dump, raw: Dump, entry: ManifestEntry, sourceSha: string): { dump: Dump; stats: RefreshStats } {
  const refreshed = structuredClone(current);
  const annotations: Record<string, DumpAnnotation> = structuredClone(current.annotations ?? {});
  const groupsMissing: string[] = [];
  let nodesUpdated = 0;
  let nodesMissing = 0;

  for (const [groupName, group] of Object.entries(refreshed.node_groups)) {
    const rawGroup = raw.node_groups[groupName];
    if (!rawGroup) {
      groupsMissing.push(groupName);
      continue;
    }
    if (rawGroup.view_center) group.view_center = structuredClone(rawGroup.view_center);
    if (rawGroup.annotation) {
      const annotation = raw.annotations?.[rawGroup.annotation];
      if (!annotation) throw new Error(`${entry.output}: missing annotation ${rawGroup.annotation}.`);
      group.annotation = rawGroup.annotation;
      annotations[rawGroup.annotation] = structuredClone(annotation);
    }

    const rawNodes = new Map(rawGroup.nodes.map((node) => [node.name, node]));
    for (const node of group.nodes) {
      const rawNode = rawNodes.get(node.name);
      if (!rawNode || rawNode.type !== node.type) {
        nodesMissing += 1;
        continue;
      }
      const dimensions = node.ui?.dimensions;
      node.ui = { ...(node.ui ?? {}), ...structuredClone(rawNode.ui ?? {}) };
      if (dimensions && !rawNode.ui?.dimensions) node.ui.dimensions = dimensions;
      node.label = rawNode.label;
      if (node.type === "NodeFrame") {
        const rawProps = rawNode.props as Record<string, unknown> | undefined;
        const props = (node.props ??= {}) as Record<string, unknown>;
        if (rawProps?.label_size !== undefined) props.label_size = rawProps.label_size;
        if (rawProps?.shrink !== undefined) props.shrink = rawProps.shrink;
      }
      nodesUpdated += 1;
    }
  }

  finiteAnnotations(annotations);
  refreshed.annotations = annotations;
  if (raw.node_editor_views) refreshed.node_editor_views = structuredClone(raw.node_editor_views);
  (refreshed as Dump & { authoring_refresh?: unknown }).authoring_refresh = {
    schema_version: 1,
    source_project: entry.project,
    source_sha256: sourceSha,
    decoder: "src/blend/to-dump.ts",
    fields: ["node-layout", "frame-parenting", "view-center", "annotations"],
  };

  let annotationStrokes = 0;
  let annotationPoints = 0;
  for (const annotation of Object.values(annotations)) {
    for (const layer of annotation.layers) {
      for (const frame of layer.frames) {
        annotationStrokes += frame.strokes.length;
        for (const stroke of frame.strokes) annotationPoints += stroke.points.length;
      }
    }
  }

  return {
    dump: refreshed,
    stats: {
      output: entry.output,
      project: entry.project,
      source_sha256: sourceSha,
      groups: Object.keys(refreshed.node_groups).length,
      groups_missing_in_source: groupsMissing,
      nodes_updated: nodesUpdated,
      nodes_missing_in_source: nodesMissing,
      annotation_blocks: Object.keys(annotations).length,
      annotation_strokes: annotationStrokes,
      annotation_points: annotationPoints,
      bytes_before: 0,
      bytes_after: 0,
    },
  };
}

await mkdir(outRoot, { recursive: true });
const entriesByProject = new Map<string, ManifestEntry[]>();
for (const entry of manifest.entries) {
  const entries = entriesByProject.get(entry.project) ?? [];
  entries.push(entry);
  entriesByProject.set(entry.project, entries);
}
for (const [projectId, entries] of entriesByProject) {
  const project = projectById.get(projectId)!;
  const sourcePath = resolve(packRoot, project.path);
  const sourceBytes = new Uint8Array(await readFile(sourcePath));
  const sourceSha = createHash("sha256").update(sourceBytes).digest("hex");
  const { dump: raw, gaps } = await decodeBlend(sourceBytes, { filename: project.path.split("/").at(-1) });
  console.log(`SOURCE ${projectId}: ${Object.keys(raw.node_groups).length} groups, ${gaps.length} gaps`);

  for (const entry of entries) {
    const currentPath = resolve(repo, entry.output);
    const currentText = await readFile(currentPath, "utf8");
    const current = JSON.parse(currentText) as Dump;
    const { dump, stats } = refreshDump(current, raw as Dump, entry, sourceSha);
    const outputPath = join(outRoot, entry.output);
    const outputText = `${JSON.stringify(dump, null, 1)}\n`;
    stats.bytes_before = Buffer.byteLength(currentText);
    stats.bytes_after = Buffer.byteLength(outputText);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, outputText);
    report.entries.push(stats);
    console.log(
      `  ${entry.output}: layout=${stats.nodes_updated}, missing=${stats.nodes_missing_in_source},`
      + ` annotations=${stats.annotation_strokes}/${stats.annotation_points}`,
    );
  }
}

await writeFile(join(outRoot, "authoring-refresh-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`REFRESHED ${report.entries.length} dumps -> ${outRoot}`);
