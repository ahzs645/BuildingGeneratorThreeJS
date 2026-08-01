import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;

export type AdditionCategory =
  | "annotations"
  | "dependencies"
  | "evaluated_mesh"
  | "evaluated_topology"
  | "fonts"
  | "materials"
  | "node_groups"
  | "objects"
  | "source_metadata";

export type DumpDeclaration = {
  additions?: AdditionCategory[];
  sourceMetadataChanges?: boolean;
  note?: string;
};

export type DumpDeclarations = Record<string, DumpDeclaration>;

export type StagedDumpFinding = {
  severity: "error" | "warning" | "info";
  kind: "dangerous-loss" | "integrity-error" | "declared-addition" | "addition" | "change";
  code: string;
  file: string;
  path?: string;
  asset?: string;
  category?: AdditionCategory;
  message: string;
};

export type DumpCounts = {
  objects: number;
  nodeGroups: number;
  materials: number;
  annotations: number;
  annotationStrokes: number;
  annotationPoints: number;
  evaluatedMeshes: number;
  evaluatedTopologyHints: number;
  fonts: number;
  dependencies: number;
};

export type StagedDumpFileReport = {
  file: string;
  current?: DumpCounts;
  staged?: DumpCounts;
  declaration?: DumpDeclaration;
  findings: StagedDumpFinding[];
};

export type StagedDumpReport = {
  currentRoot: string;
  stagedRoot: string;
  catalog: string;
  declarations?: string;
  files: StagedDumpFileReport[];
  summary: {
    currentFiles: number;
    stagedFiles: number;
    comparedFiles: number;
    catalogAssets: number;
    errors: number;
    warnings: number;
    info: number;
    dangerousLosses: number;
    integrityErrors: number;
    declaredAdditions: number;
    undeclaredAdditions: number;
  };
};

type CatalogAsset = { id: string; object: string; dump: string };

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const recordAt = (value: unknown): JsonObject => isObject(value) ? value : {};
const arrayAt = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const stringAt = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const publicPath = (path: string): string => path.split(sep).join("/").replace(/^\.\//, "");

function namedRecord(value: unknown): Record<string, JsonObject> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, JsonObject] => isObject(entry[1])));
}

function objectMap(dump: JsonObject): Map<string, JsonObject> {
  const objects = new Map<string, JsonObject>();
  for (const candidate of arrayAt(dump.objects)) {
    if (!isObject(candidate) || typeof candidate.name !== "string") continue;
    objects.set(candidate.name, candidate);
  }
  return objects;
}

function annotationStats(dump: JsonObject): { annotations: number; strokes: number; points: number } {
  const annotations = namedRecord(dump.annotations);
  let strokes = 0;
  let points = 0;
  for (const annotation of Object.values(annotations)) {
    for (const layer of arrayAt(annotation.layers)) {
      for (const frame of arrayAt(recordAt(layer).frames)) {
        for (const stroke of arrayAt(recordAt(frame).strokes)) {
          strokes += 1;
          points += arrayAt(recordAt(stroke).points).length;
        }
      }
    }
  }
  return { annotations: Object.keys(annotations).length, strokes, points };
}

function topologyPaths(dump: JsonObject): Set<string> {
  const paths = new Set<string>();
  for (const [groupName, group] of Object.entries(namedRecord(dump.node_groups))) {
    for (const node of arrayAt(group.nodes)) {
      const nodeObject = recordAt(node);
      const name = stringAt(nodeObject.name) ?? "<unnamed>";
      if (nodeObject.evaluated_topology !== undefined)
        paths.add(`node_groups.${groupName}.nodes.${name}.evaluated_topology`);
      if (recordAt(nodeObject.props).evaluated_topology !== undefined)
        paths.add(`node_groups.${groupName}.nodes.${name}.props.evaluated_topology`);
    }
  }
  return paths;
}

function evaluatedMeshNames(dump: JsonObject): Set<string> {
  return new Set([...objectMap(dump)].filter(([, object]) => object.evaluated_mesh !== undefined).map(([name]) => name));
}

function dependencyKeys(dump: JsonObject): Set<string> {
  const result = new Set<string>();
  for (const name of arrayAt(dump.dependency_objects)) {
    if (typeof name === "string") result.add(`object:${name}`);
  }
  const metadata = recordAt(dump.extraction_metadata);
  for (const candidate of arrayAt(metadata.dependencies)) {
    const dependency = recordAt(candidate);
    const target = recordAt(dependency.target);
    const kind = stringAt(dependency.kind) ?? "unknown";
    const name = stringAt(target.name);
    if (name) result.add(`${kind}:${name}`);
  }
  return result;
}

export function summarizeDump(dump: unknown): DumpCounts {
  const value = recordAt(dump);
  const annotations = annotationStats(value);
  return {
    objects: objectMap(value).size,
    nodeGroups: Object.keys(namedRecord(value.node_groups)).length,
    materials: Object.keys(namedRecord(value.materials)).length,
    annotations: annotations.annotations,
    annotationStrokes: annotations.strokes,
    annotationPoints: annotations.points,
    evaluatedMeshes: evaluatedMeshNames(value).size,
    evaluatedTopologyHints: topologyPaths(value).size,
    fonts: Object.keys(namedRecord(value.fonts)).length,
    dependencies: dependencyKeys(value).size,
  };
}

function finding(
  file: string,
  severity: StagedDumpFinding["severity"],
  kind: StagedDumpFinding["kind"],
  code: string,
  message: string,
  extra: Partial<Pick<StagedDumpFinding, "path" | "asset" | "category">> = {},
): StagedDumpFinding {
  return { severity, kind, code, file, message, ...extra };
}

function validateAnnotations(file: string, dump: JsonObject): StagedDumpFinding[] {
  const findings: StagedDumpFinding[] = [];
  const annotationsValue = dump.annotations;
  if (annotationsValue !== undefined && !isObject(annotationsValue)) {
    findings.push(finding(file, "error", "integrity-error", "ANNOTATIONS_NOT_OBJECT", "annotations must be an object", { path: "$.annotations" }));
    return findings;
  }
  const annotations = namedRecord(annotationsValue);
  for (const [groupName, group] of Object.entries(namedRecord(dump.node_groups))) {
    if (group.annotation === undefined) continue;
    if (typeof group.annotation !== "string" || !annotations[group.annotation]) {
      findings.push(finding(
        file,
        "error",
        "integrity-error",
        "DANGLING_ANNOTATION_REFERENCE",
        `node group '${groupName}' references missing annotation '${String(group.annotation)}'`,
        { path: `$.node_groups[${JSON.stringify(groupName)}].annotation` },
      ));
    }
  }
  for (const [annotationName, annotation] of Object.entries(annotations)) {
    if (!Array.isArray(annotation.layers)) {
      findings.push(finding(file, "error", "integrity-error", "ANNOTATION_LAYERS_NOT_ARRAY", `annotation '${annotationName}' has no layers array`, { path: `$.annotations[${JSON.stringify(annotationName)}].layers` }));
      continue;
    }
    for (const [layerIndex, layerValue] of annotation.layers.entries()) {
      const layer = recordAt(layerValue);
      const color = layer.color;
      if (!Array.isArray(color) || color.length !== 3 || color.some((component) => !Number.isFinite(component))) {
        findings.push(finding(file, "error", "integrity-error", "ANNOTATION_COLOR_INVALID", `annotation '${annotationName}' layer ${layerIndex} has a non-finite RGB color`, { path: `$.annotations[${JSON.stringify(annotationName)}].layers[${layerIndex}].color` }));
      }
      if (!Array.isArray(layer.frames)) {
        findings.push(finding(file, "error", "integrity-error", "ANNOTATION_FRAMES_NOT_ARRAY", `annotation '${annotationName}' layer ${layerIndex} has no frames array`, { path: `$.annotations[${JSON.stringify(annotationName)}].layers[${layerIndex}].frames` }));
        continue;
      }
      for (const [frameIndex, frameValue] of layer.frames.entries()) {
        const frame = recordAt(frameValue);
        if (!Number.isFinite(frame.number)) {
          findings.push(finding(file, "error", "integrity-error", "ANNOTATION_FRAME_INVALID", `annotation '${annotationName}' has a non-finite frame number`, { path: `$.annotations[${JSON.stringify(annotationName)}].layers[${layerIndex}].frames[${frameIndex}].number` }));
        }
        if (!Array.isArray(frame.strokes)) {
          findings.push(finding(file, "error", "integrity-error", "ANNOTATION_STROKES_NOT_ARRAY", `annotation '${annotationName}' frame ${frameIndex} has no strokes array`, { path: `$.annotations[${JSON.stringify(annotationName)}].layers[${layerIndex}].frames[${frameIndex}].strokes` }));
          continue;
        }
        for (const [strokeIndex, strokeValue] of frame.strokes.entries()) {
          const stroke = recordAt(strokeValue);
          if (!Array.isArray(stroke.points)) {
            findings.push(finding(file, "error", "integrity-error", "ANNOTATION_POINTS_NOT_ARRAY", `annotation '${annotationName}' stroke ${strokeIndex} has no points array`, { path: `$.annotations[${JSON.stringify(annotationName)}].layers[${layerIndex}].frames[${frameIndex}].strokes[${strokeIndex}].points` }));
            continue;
          }
          const invalidPoint = stroke.points.findIndex((point) =>
            !Array.isArray(point) || point.length < 5 || point.some((component) => !Number.isFinite(component)));
          if (invalidPoint >= 0) {
            findings.push(finding(file, "error", "integrity-error", "ANNOTATION_POINT_INVALID", `annotation '${annotationName}' contains a malformed or non-finite point`, { path: `$.annotations[${JSON.stringify(annotationName)}].layers[${layerIndex}].frames[${frameIndex}].strokes[${strokeIndex}].points[${invalidPoint}]` }));
          }
        }
      }
    }
  }
  return findings;
}

function compareNamedSet(
  file: string,
  category: AdditionCategory,
  label: string,
  current: Iterable<string>,
  staged: Iterable<string>,
  declaration: DumpDeclaration | undefined,
): StagedDumpFinding[] {
  const findings: StagedDumpFinding[] = [];
  const before = new Set(current);
  const after = new Set(staged);
  for (const name of [...before].sort()) {
    if (!after.has(name)) findings.push(finding(file, "error", "dangerous-loss", `${category.toUpperCase()}_LOST`, `${label} '${name}' is present in the current dump but missing from staged`, { category }));
  }
  const declared = declaration?.additions?.includes(category) ?? false;
  for (const name of [...after].sort()) {
    if (before.has(name)) continue;
    findings.push(finding(
      file,
      "info",
      declared ? "declared-addition" : "addition",
      declared ? `${category.toUpperCase()}_DECLARED_ADDITION` : `${category.toUpperCase()}_ADDED`,
      `${label} '${name}' was added${declared && declaration?.note ? ` (${declaration.note})` : ""}`,
      { category },
    ));
  }
  return findings;
}

function annotationNames(dump: JsonObject): Set<string> {
  return new Set(Object.keys(namedRecord(dump.annotations)));
}

function annotationDetails(dump: JsonObject, name: string): { strokes: number; points: number } {
  const annotation = namedRecord(dump.annotations)[name];
  if (!annotation) return { strokes: 0, points: 0 };
  const stats = annotationStats({ annotations: { [name]: annotation } });
  return { strokes: stats.strokes, points: stats.points };
}

function compareAnnotations(file: string, current: JsonObject, staged: JsonObject, declaration?: DumpDeclaration): StagedDumpFinding[] {
  const findings = compareNamedSet(file, "annotations", "annotation", annotationNames(current), annotationNames(staged), declaration);
  for (const name of annotationNames(current)) {
    if (!annotationNames(staged).has(name)) continue;
    const before = annotationDetails(current, name);
    const after = annotationDetails(staged, name);
    if (after.strokes < before.strokes || after.points < before.points) {
      findings.push(finding(file, "error", "dangerous-loss", "ANNOTATION_CONTENT_LOST", `annotation '${name}' shrank from ${before.strokes} strokes/${before.points} points to ${after.strokes} strokes/${after.points} points`, { category: "annotations" }));
    } else if (after.strokes > before.strokes || after.points > before.points) {
      const declared = declaration?.additions?.includes("annotations") ?? false;
      findings.push(finding(file, "info", declared ? "declared-addition" : "addition", declared ? "ANNOTATION_CONTENT_DECLARED_ADDITION" : "ANNOTATION_CONTENT_ADDED", `annotation '${name}' grew from ${before.strokes} strokes/${before.points} points to ${after.strokes} strokes/${after.points} points`, { category: "annotations" }));
    }
  }
  return findings;
}

function metadataValue(metadata: JsonObject, path: string[]): unknown {
  let cursor: unknown = metadata;
  for (const key of path) cursor = recordAt(cursor)[key];
  return cursor;
}

function compareSourceMetadata(file: string, current: JsonObject, staged: JsonObject, declaration?: DumpDeclaration): StagedDumpFinding[] {
  const findings: StagedDumpFinding[] = [];
  const before = recordAt(current.extraction_metadata);
  const after = recordAt(staged.extraction_metadata);
  const beforePresent = isObject(current.extraction_metadata);
  const afterPresent = isObject(staged.extraction_metadata);
  if (beforePresent && !afterPresent) {
    findings.push(finding(file, "error", "dangerous-loss", "EXTRACTION_METADATA_LOST", "staged dump lost extraction_metadata", { category: "source_metadata" }));
    return findings;
  }
  if (!beforePresent && afterPresent) {
    const declared = declaration?.additions?.includes("source_metadata") ?? false;
    findings.push(finding(file, "info", declared ? "declared-addition" : "addition", declared ? "EXTRACTION_METADATA_DECLARED_ADDITION" : "EXTRACTION_METADATA_ADDED", "staged dump adds extraction_metadata", { category: "source_metadata" }));
  }
  const fields: [string, string[]][] = [
    ["schema version", ["schema_version"]],
    ["source filename", ["source", "filename"]],
    ["source fingerprint", ["source", "fingerprint_sha256"]],
    ["extractor name", ["extractor", "name"]],
    ["extractor version", ["extractor", "version"]],
    ["extractor Blender version", ["extractor", "blender_version"]],
  ];
  for (const [label, path] of fields) {
    const oldValue = metadataValue(before, path);
    const newValue = metadataValue(after, path);
    if (oldValue === undefined || oldValue === newValue) continue;
    const jsonPath = `$.extraction_metadata.${path.join(".")}`;
    if (newValue === undefined) {
      findings.push(finding(file, "error", "dangerous-loss", "SOURCE_METADATA_FIELD_LOST", `${label} '${String(oldValue)}' is missing from staged`, { path: jsonPath, category: "source_metadata" }));
    } else {
      const declared = declaration?.sourceMetadataChanges === true;
      findings.push(finding(file, declared ? "info" : "warning", "change", declared ? "SOURCE_METADATA_DECLARED_CHANGE" : "SOURCE_METADATA_CHANGED", `${label} changed from '${String(oldValue)}' to '${String(newValue)}'${declared && declaration?.note ? ` (${declaration.note})` : ""}`, { path: jsonPath, category: "source_metadata" }));
    }
  }
  if (current.blender_version !== undefined && staged.blender_version === undefined) {
    findings.push(finding(file, "error", "dangerous-loss", "BLENDER_VERSION_LOST", `Blender version '${String(current.blender_version)}' is missing from staged`, { path: "$.blender_version", category: "source_metadata" }));
  } else if (current.blender_version !== undefined && current.blender_version !== staged.blender_version) {
    const declared = declaration?.sourceMetadataChanges === true;
    findings.push(finding(file, declared ? "info" : "warning", "change", declared ? "BLENDER_VERSION_DECLARED_CHANGE" : "BLENDER_VERSION_CHANGED", `Blender version changed from '${String(current.blender_version)}' to '${String(staged.blender_version)}'`, { path: "$.blender_version", category: "source_metadata" }));
  }
  return findings;
}

function rootsForObject(object: JsonObject | undefined): string[] {
  if (!object) return [];
  return arrayAt(object.modifiers)
    .map(recordAt)
    .filter((modifier) => modifier.type === "NODES" && typeof modifier.node_group === "string")
    .map((modifier) => modifier.node_group as string);
}

function validateCatalogTargets(file: string, current: JsonObject, staged: JsonObject, assets: CatalogAsset[]): StagedDumpFinding[] {
  const findings: StagedDumpFinding[] = [];
  const beforeObjects = objectMap(current);
  const afterObjects = objectMap(staged);
  const afterGroups = namedRecord(staged.node_groups);
  for (const asset of assets) {
    const before = beforeObjects.get(asset.object);
    const after = afterObjects.get(asset.object);
    const expectedRoots = rootsForObject(before);
    const stagedRoots = rootsForObject(after);
    if (!before || expectedRoots.length === 0) {
      findings.push(finding(file, "warning", "change", "CURRENT_CATALOG_TARGET_INVALID", `current dump does not expose catalog object '${asset.object}' with a Geometry Nodes root`, { asset: asset.id }));
      continue;
    }
    if (!after) {
      findings.push(finding(file, "error", "dangerous-loss", "CATALOG_TARGET_LOST", `catalog object '${asset.object}' is missing from staged`, { asset: asset.id, category: "objects" }));
      continue;
    }
    for (const root of expectedRoots) {
      if (!stagedRoots.includes(root)) findings.push(finding(file, "error", "dangerous-loss", "CATALOG_ROOT_ASSIGNMENT_LOST", `catalog object '${asset.object}' no longer has Geometry Nodes root '${root}'`, { asset: asset.id, category: "node_groups" }));
      if (!afterGroups[root]) findings.push(finding(file, "error", "dangerous-loss", "CATALOG_ROOT_GROUP_LOST", `catalog root '${root}' for object '${asset.object}' is absent from staged node_groups`, { asset: asset.id, category: "node_groups" }));
    }
  }
  return findings;
}

export function compareDumpPair(options: {
  file: string;
  current: unknown;
  staged: unknown;
  catalogAssets?: CatalogAsset[];
  declaration?: DumpDeclaration;
}): StagedDumpFileReport {
  const { file, declaration } = options;
  const current = recordAt(options.current);
  const staged = recordAt(options.staged);
  const findings: StagedDumpFinding[] = [];
  if (!isObject(options.current)) findings.push(finding(file, "error", "integrity-error", "CURRENT_DUMP_NOT_OBJECT", "current JSON root is not an object"));
  if (!isObject(options.staged)) findings.push(finding(file, "error", "integrity-error", "STAGED_DUMP_NOT_OBJECT", "staged JSON root is not an object"));
  if (!isObject(staged.node_groups)) findings.push(finding(file, "error", "integrity-error", "STAGED_NODE_GROUPS_MISSING", "staged dump has no node_groups object", { path: "$.node_groups" }));
  findings.push(...validateAnnotations(file, staged));
  findings.push(...compareNamedSet(file, "objects", "object", objectMap(current).keys(), objectMap(staged).keys(), declaration));
  findings.push(...compareNamedSet(file, "node_groups", "node group", Object.keys(namedRecord(current.node_groups)), Object.keys(namedRecord(staged.node_groups)), declaration));
  findings.push(...compareNamedSet(file, "materials", "material", Object.keys(namedRecord(current.materials)), Object.keys(namedRecord(staged.materials)), declaration));
  findings.push(...compareAnnotations(file, current, staged, declaration));
  findings.push(...compareNamedSet(file, "evaluated_mesh", "evaluated mesh on object", evaluatedMeshNames(current), evaluatedMeshNames(staged), declaration));
  findings.push(...compareNamedSet(file, "evaluated_topology", "evaluated topology hint", topologyPaths(current), topologyPaths(staged), declaration));
  findings.push(...compareNamedSet(file, "fonts", "font atlas", Object.keys(namedRecord(current.fonts)), Object.keys(namedRecord(staged.fonts)), declaration));
  findings.push(...compareNamedSet(file, "dependencies", "dependency", dependencyKeys(current), dependencyKeys(staged), declaration));
  findings.push(...compareSourceMetadata(file, current, staged, declaration));
  findings.push(...validateCatalogTargets(file, current, staged, options.catalogAssets ?? []));
  return { file, current: summarizeDump(current), staged: summarizeDump(staged), declaration, findings };
}

async function collectDumpPaths(root: string): Promise<Set<string>> {
  const result = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /^dump.*\.json$/i.test(entry.name)) result.add(publicPath(relative(root, path)));
    }
  };
  await visit(root);
  return result;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function auditStagedDumps(options: {
  currentRoot: string;
  stagedRoot: string;
  catalogPath: string;
  declarationsPath?: string;
}): Promise<StagedDumpReport> {
  const currentRoot = resolve(options.currentRoot);
  const stagedRoot = resolve(options.stagedRoot);
  const catalogPath = resolve(options.catalogPath);
  const catalog = await readJson(catalogPath) as CatalogAsset[];
  if (!Array.isArray(catalog)) throw new TypeError(`catalog must be an array: ${catalogPath}`);
  const declarations = options.declarationsPath
    ? await readJson(resolve(options.declarationsPath)) as DumpDeclarations
    : {};
  const currentPaths = await collectDumpPaths(currentRoot);
  const stagedPaths = await collectDumpPaths(stagedRoot);
  for (const asset of catalog) currentPaths.add(publicPath(asset.dump));
  const allPaths = [...new Set([...currentPaths, ...stagedPaths])].sort();
  const assetsByDump = new Map<string, CatalogAsset[]>();
  for (const asset of catalog) {
    const path = publicPath(asset.dump);
    const assets = assetsByDump.get(path) ?? [];
    assets.push(asset);
    assetsByDump.set(path, assets);
  }
  const files: StagedDumpFileReport[] = [];
  for (const file of allPaths) {
    if (!currentPaths.has(file)) {
      const declaration = declarations[file];
      const staged = await readJson(join(stagedRoot, file));
      const declared = declaration !== undefined;
      const findings = [finding(file, "info", declared ? "declared-addition" : "addition", declared ? "DUMP_DECLARED_ADDITION" : "DUMP_ADDED", "dump exists only in staged")];
      findings.push(...validateAnnotations(file, recordAt(staged)));
      files.push({ file, staged: summarizeDump(staged), declaration, findings });
      continue;
    }
    if (!stagedPaths.has(file)) {
      files.push({ file, findings: [finding(file, "error", "dangerous-loss", "DUMP_LOST", "current dump is missing from staged")] });
      continue;
    }
    let current: unknown;
    let staged: unknown;
    try { current = await readJson(join(currentRoot, file)); }
    catch (error) {
      files.push({ file, findings: [finding(file, "error", "integrity-error", "CURRENT_JSON_INVALID", `cannot parse current dump: ${String(error)}`)] });
      continue;
    }
    try { staged = await readJson(join(stagedRoot, file)); }
    catch (error) {
      files.push({ file, current: summarizeDump(current), findings: [finding(file, "error", "integrity-error", "STAGED_JSON_INVALID", `cannot parse staged dump: ${String(error)}`)] });
      continue;
    }
    files.push(compareDumpPair({ file, current, staged, catalogAssets: assetsByDump.get(file), declaration: declarations[file] }));
  }
  const findings = files.flatMap((file) => file.findings);
  return {
    currentRoot,
    stagedRoot,
    catalog: catalogPath,
    declarations: options.declarationsPath ? resolve(options.declarationsPath) : undefined,
    files,
    summary: {
      currentFiles: currentPaths.size,
      stagedFiles: stagedPaths.size,
      comparedFiles: files.filter((file) => file.current && file.staged).length,
      catalogAssets: catalog.length,
      errors: findings.filter((item) => item.severity === "error").length,
      warnings: findings.filter((item) => item.severity === "warning").length,
      info: findings.filter((item) => item.severity === "info").length,
      dangerousLosses: findings.filter((item) => item.kind === "dangerous-loss").length,
      integrityErrors: findings.filter((item) => item.kind === "integrity-error").length,
      declaredAdditions: findings.filter((item) => item.kind === "declared-addition").length,
      undeclaredAdditions: findings.filter((item) => item.kind === "addition").length,
    },
  };
}

type CliOptions = {
  currentRoot: string;
  stagedRoot?: string;
  catalogPath: string;
  declarationsPath?: string;
  outputPath?: string;
};

function usage(): string {
  return [
    "Usage: tsx tools/validate-staged-dojo-dumps.ts --staged-root <dir> [options]",
    "",
    "Options:",
    "  --current-root <dir>   Current public root (default: public)",
    "  --staged-root <dir>    Staged public root with the same relative paths",
    "  --catalog <file>       Catalog JSON (default: public/dojo/chrome-assets/catalog.json)",
    "  --declarations <file>  Optional map of dump paths to declared additions/source changes",
    "  --output <file>        Write the full JSON report",
  ].join("\n");
}

function parseCli(argv: string[]): CliOptions {
  const workspace = fileURLToPath(new URL("..", import.meta.url));
  const options: CliOptions = {
    currentRoot: join(workspace, "public"),
    catalogPath: join(workspace, "public/dojo/chrome-assets/catalog.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value) throw new TypeError(`${arg} requires a value`);
    if (arg === "--current-root") options.currentRoot = value;
    else if (arg === "--staged-root") options.stagedRoot = value;
    else if (arg === "--catalog") options.catalogPath = value;
    else if (arg === "--declarations") options.declarationsPath = value;
    else if (arg === "--output") options.outputPath = value;
    else throw new TypeError(`unknown argument: ${arg}`);
    index += 1;
  }
  if (!options.stagedRoot) throw new TypeError("--staged-root is required");
  return options;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const report = await auditStagedDumps({
    currentRoot: cli.currentRoot,
    stagedRoot: cli.stagedRoot!,
    catalogPath: cli.catalogPath,
    declarationsPath: cli.declarationsPath,
  });
  if (cli.outputPath) {
    await writeFile(resolve(cli.outputPath), `${JSON.stringify(report, null, 2)}\n`);
  }
  const { summary } = report;
  console.log(`Compared ${summary.comparedFiles}/${summary.currentFiles} current dumps against ${summary.stagedFiles} staged dumps.`);
  console.log(`Catalog assets: ${summary.catalogAssets}; errors: ${summary.errors}; warnings: ${summary.warnings}; dangerous losses: ${summary.dangerousLosses}.`);
  console.log(`Declared additions: ${summary.declaredAdditions}; undeclared additions: ${summary.undeclaredAdditions}.`);
  for (const item of report.files.flatMap((file) => file.findings).filter((item) => item.severity !== "info")) {
    console.error(`${item.severity.toUpperCase()} ${item.code} ${item.file}${item.asset ? ` [${item.asset}]` : ""}: ${item.message}`);
  }
  process.exitCode = summary.errors > 0 ? 1 : 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 2;
  });
}
