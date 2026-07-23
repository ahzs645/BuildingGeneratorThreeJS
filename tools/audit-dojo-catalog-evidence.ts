import { access, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

export type AuditFinding = {
  severity: "error" | "warning" | "info";
  code: string;
  asset: string;
  file: string;
  message: string;
};

export type AuditReport = {
  catalog: string;
  assets: number;
  statusFiles: number;
  evidenceFiles: number;
  findings: AuditFinding[];
  summary: { errors: number; warnings: number; info: number };
};

type CatalogAsset = {
  id: string;
  dump: string;
  reference: string;
  shaderMetadata?: string;
  blenderStats: { verts: number; faces: number; triangles?: number };
};

const evidenceName = /(?:parity|comparison|evidence|material).*\.json$/i;
const durablePath = /^(?:public|dojo|tools|docs|src)\//;
const fileExtension = /\.(?:json|png|jpe?g|webp|exr|py|ts|ttf|otf|glb)$/i;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function numberAt(value: unknown, key: string): number | null {
  const record = object(value);
  const number = Number(record?.[key]);
  return Number.isFinite(number) ? number : null;
}

function statusRecord(status: JsonObject, assetId: string): JsonObject | null {
  if (status.id === assetId) return status;
  const variants = Array.isArray(status.variants) ? status.variants : [];
  return variants.map(object).find((variant) => variant?.id === assetId) ?? (status.variants ? null : status);
}

function exactWithoutQualifier(label: string): boolean {
  const lower = label.toLowerCase();
  return lower.includes("exact") && !/(?:near|visual|surface|bounds-near|submillimeter)/.test(lower);
}

function compareCounts(
  findings: AuditFinding[],
  asset: CatalogAsset,
  statusPath: string,
  record: JsonObject,
): void {
  const blender = object(record.blender);
  const gnvm = object(record.gnvm);
  const expected = asset.blenderStats;
  const blenderVerts = numberAt(blender, "verts");
  const blenderFaces = numberAt(blender, "faces");
  const gnvmVerts = numberAt(gnvm, "verts");
  const gnvmFaces = numberAt(gnvm, "faces");
  const expectedGnvmFaces = expected.triangles ?? expected.faces;
  const label = String(record.status ?? "");
  const add = (severity: AuditFinding["severity"], code: string, message: string): void => {
    findings.push({ severity, code, asset: asset.id, file: statusPath, message });
  };

  if (blenderVerts !== null && blenderVerts !== expected.verts)
    add("error", "CATALOG_BLENDER_VERTS_MISMATCH", `catalog=${expected.verts}, status Blender=${blenderVerts}`);
  if (blenderFaces !== null && blenderFaces !== expected.faces)
    add("error", "CATALOG_BLENDER_FACES_MISMATCH", `catalog=${expected.faces}, status Blender=${blenderFaces}`);

  const countMismatch = (blenderVerts !== null && gnvmVerts !== null && blenderVerts !== gnvmVerts)
    || (gnvmFaces !== null && gnvmFaces !== expectedGnvmFaces);
  if (countMismatch && exactWithoutQualifier(label))
    add("error", "EXACT_COUNT_CONTRADICTION", `status '${label}' records Blender ${blenderVerts}/${blenderFaces} but GNVM ${gnvmVerts}/${gnvmFaces}`);
  else if (countMismatch)
    add("info", "RECORDED_COUNT_DELTA", `status '${label}' records Blender ${blenderVerts}/${blenderFaces} and GNVM ${gnvmVerts}/${gnvmFaces}`);

  if (gnvmVerts !== null && gnvmVerts !== expected.verts)
    add("info", "GNVM_DIFFERS_FROM_CATALOG_TRUTH", `catalog Blender verts=${expected.verts}, status GNVM verts=${gnvmVerts}`);
  if (gnvmFaces !== null && gnvmFaces !== expectedGnvmFaces)
    add("info", "GNVM_DIFFERS_FROM_CATALOG_TRUTH", `catalog expected GNVM faces=${expectedGnvmFaces}, status GNVM faces=${gnvmFaces}`);

  if (label.toLowerCase() === "exact") {
    for (const [key, value] of Object.entries(record)) {
      if (/(?:diff|delta)$/i.test(key) && typeof value === "number" && value !== 0)
        add("warning", "EXACT_NONZERO_DELTA", `literal exact status records ${key}=${value}`);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function referencedPaths(value: unknown, paths: { key: string; value: string }[] = [], key = ""): { key: string; value: string }[] {
  if (typeof value === "string") {
    if (value.startsWith("/private/tmp/") || durablePath.test(value) || (fileExtension.test(value) && !/^https?:/.test(value)))
      paths.push({ key, value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => referencedPaths(item, paths, `${key}[${index}]`));
  } else {
    const record = object(value);
    if (record) for (const [childKey, child] of Object.entries(record)) referencedPaths(child, paths, key ? `${key}.${childKey}` : childKey);
  }
  return paths;
}

function resolveEvidencePath(workspaceRoot: string, value: string): string | null {
  if (value.startsWith("/private/tmp/")) return value;
  if (value.startsWith("dojo/")) return join(workspaceRoot, "public", value);
  if (durablePath.test(value)) return join(workspaceRoot, value);
  return null;
}

async function inspectReferences(
  findings: AuditFinding[],
  workspaceRoot: string,
  assetId: string,
  ownerPath: string,
  payload: unknown,
): Promise<void> {
  for (const reference of referencedPaths(payload)) {
    if (reference.value.startsWith("/private/tmp/")) {
      findings.push({
        severity: "warning",
        code: "NON_DURABLE_EVIDENCE",
        asset: assetId,
        file: ownerPath,
        message: `${reference.key} points to ephemeral ${reference.value}`,
      });
      continue;
    }
    const path = resolveEvidencePath(workspaceRoot, reference.value);
    if (path && !(await exists(path))) findings.push({
      severity: "error",
      code: "MISSING_REFERENCED_EVIDENCE",
      asset: assetId,
      file: ownerPath,
      message: `${reference.key} references missing ${reference.value}`,
    });
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function auditCatalogEvidence(options: {
  workspaceRoot?: string;
  catalogPath?: string;
} = {}): Promise<AuditReport> {
  const workspaceRoot = resolve(options.workspaceRoot ?? fileURLToPath(new URL("..", import.meta.url)));
  const catalogPath = resolve(options.catalogPath ?? join(workspaceRoot, "public/dojo/chrome-assets/catalog.json"));
  const catalog = await readJson(catalogPath) as CatalogAsset[];
  const catalogById = new Map(catalog.map((asset) => [asset.id, asset]));
  const findings: AuditFinding[] = [];
  const statusFiles = new Set<string>();
  const inspectedStatusReferences = new Set<string>();
  const evidenceFiles = new Set<string>();

  for (const asset of catalog) {
    for (const [kind, publicPath] of [["dump", asset.dump], ["reference", asset.reference], ["shader metadata", asset.shaderMetadata]] as const) {
      if (!publicPath) continue;
      const path = join(workspaceRoot, "public", publicPath);
      if (!(await exists(path))) findings.push({
        severity: "error",
        code: "MISSING_CATALOG_FILE",
        asset: asset.id,
        file: relative(workspaceRoot, catalogPath),
        message: `${kind} is missing: ${publicPath}`,
      });
    }

    const assetDirectory = join(workspaceRoot, "public", dirname(asset.dump));
    const statusPath = join(assetDirectory, "status.json");
    statusFiles.add(statusPath);
    if (!(await exists(statusPath))) {
      findings.push({ severity: "error", code: "MISSING_STATUS", asset: asset.id, file: relative(workspaceRoot, statusPath), message: "catalog asset has no colocated status.json" });
      continue;
    }

    let status: JsonObject;
    try { status = await readJson(statusPath) as JsonObject; }
    catch (error) {
      findings.push({ severity: "error", code: "INVALID_STATUS_JSON", asset: asset.id, file: relative(workspaceRoot, statusPath), message: String(error) });
      continue;
    }
    const record = statusRecord(status, asset.id);
    if (!record) findings.push({
      severity: "error",
      code: "STATUS_ASSET_UNMATCHED",
      asset: asset.id,
      file: relative(workspaceRoot, statusPath),
      message: "shared status variants do not contain this catalog id",
    });
    else compareCounts(findings, asset, relative(workspaceRoot, statusPath), record);
    if (!inspectedStatusReferences.has(statusPath)) {
      inspectedStatusReferences.add(statusPath);
      await inspectReferences(findings, workspaceRoot, asset.id, relative(workspaceRoot, statusPath), status);
    }

    let entries: string[] = [];
    try { entries = await readdir(assetDirectory); } catch { /* status existence already reports the directory problem */ }
    for (const name of entries.filter((entry) => evidenceName.test(entry))) {
      const evidencePath = join(assetDirectory, name);
      if (evidenceFiles.has(evidencePath)) continue;
      evidenceFiles.add(evidencePath);
      try {
        const payload = await readJson(evidencePath);
        const evidence = object(payload);
        const target = object(evidence?.target);
        const targetId = typeof target?.id === "string" ? target.id : "";
        const evidenceAsset = targetId ? catalogById.get(targetId) : asset;
        const evidenceAssetId = evidenceAsset?.id ?? (targetId || asset.id);
        await inspectReferences(findings, workspaceRoot, evidenceAssetId, relative(workspaceRoot, evidencePath), payload);
        if (targetId && !evidenceAsset) findings.push({
          severity: "error",
          code: "EVIDENCE_TARGET_UNMATCHED",
          asset: targetId,
          file: relative(workspaceRoot, evidencePath),
          message: `evidence target '${targetId}' is not present in the catalog`,
        });
        const geometry = object(evidence?.geometryContract);
        if (geometry && evidenceAsset) {
          const verts = numberAt(geometry, "verts");
          const faces = numberAt(geometry, "faces");
          if (verts !== null && verts !== evidenceAsset.blenderStats.verts) findings.push({ severity: "error", code: "EVIDENCE_VERTS_MISMATCH", asset: evidenceAsset.id, file: relative(workspaceRoot, evidencePath), message: `catalog=${evidenceAsset.blenderStats.verts}, evidence=${verts}` });
          if (faces !== null && faces !== evidenceAsset.blenderStats.faces) findings.push({ severity: "error", code: "EVIDENCE_FACES_MISMATCH", asset: evidenceAsset.id, file: relative(workspaceRoot, evidencePath), message: `catalog=${evidenceAsset.blenderStats.faces}, evidence=${faces}` });
        }
      } catch (error) {
        findings.push({ severity: "error", code: "INVALID_EVIDENCE_JSON", asset: asset.id, file: relative(workspaceRoot, evidencePath), message: String(error) });
      }
    }
  }

  findings.sort((a, b) => a.severity.localeCompare(b.severity) || a.asset.localeCompare(b.asset) || a.code.localeCompare(b.code));
  return {
    catalog: relative(workspaceRoot, catalogPath),
    assets: catalog.length,
    statusFiles: statusFiles.size,
    evidenceFiles: evidenceFiles.size,
    findings,
    summary: {
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning").length,
      info: findings.filter((finding) => finding.severity === "info").length,
    },
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const report = await auditCatalogEvidence();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Node Dojo catalog evidence: ${report.assets} assets, ${report.statusFiles} status files, ${report.evidenceFiles} evidence files`);
    for (const finding of report.findings)
      console.log(`${finding.severity.toUpperCase()} ${finding.code} ${finding.asset} ${finding.file}: ${finding.message}`);
    console.log(`Summary: ${report.summary.errors} errors, ${report.summary.warnings} warnings, ${report.summary.info} informational deltas`);
  }
  if (report.summary.errors) process.exitCode = 1;
}
