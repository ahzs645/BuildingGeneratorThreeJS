import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditCatalogEvidence } from "./audit-dojo-catalog-evidence";

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test("audits catalog counts, shared status records, and durable evidence without evaluating graphs", async () => {
  const root = await mkdtemp(join(tmpdir(), "dojo-evidence-audit-"));
  const assetDir = join(root, "public/dojo/example");
  await mkdir(assetDir, { recursive: true });
  await writeFile(join(assetDir, "dump.json"), "{}\n");
  await writeFile(join(assetDir, "reference.png"), "fixture");
  await json(join(assetDir, "status.json"), {
    variants: [
      { id: "example", status: "exact", blender: { verts: 8, faces: 6 }, gnvm: { verts: 7, faces: 6 }, scoreDelta: 0.25 },
      { id: "sibling", status: "exact", blender: { verts: 100, faces: 100 }, gnvm: { verts: 100, faces: 100 } },
    ],
  });
  await json(join(assetDir, "material-parity.json"), {
    target: { id: "example" },
    geometryContract: { verts: 9, faces: 6 },
    browserVerification: { capture: "/private/tmp/example.png" },
    comparison: "public/dojo/example/missing-comparison.json",
  });
  const catalogPath = join(root, "public/dojo/catalog.json");
  await json(catalogPath, [
    {
      id: "example",
      dump: "dojo/example/dump.json",
      reference: "dojo/example/reference.png",
      shaderMetadata: "dojo/example/missing-shader.json",
      blenderStats: { verts: 8, faces: 6 },
    },
    {
      id: "sibling",
      dump: "dojo/example/dump.json",
      reference: "dojo/example/reference.png",
      blenderStats: { verts: 100, faces: 100 },
    },
  ]);

  const report = await auditCatalogEvidence({ workspaceRoot: root, catalogPath });
  const codes = report.findings.map((finding) => finding.code);
  assert.equal(report.assets, 2);
  assert.equal(report.statusFiles, 1);
  assert.equal(report.evidenceFiles, 1);
  assert.ok(codes.includes("MISSING_CATALOG_FILE"));
  assert.ok(codes.includes("EXACT_COUNT_CONTRADICTION"));
  assert.ok(codes.includes("EXACT_NONZERO_DELTA"));
  assert.ok(codes.includes("EVIDENCE_VERTS_MISMATCH"));
  assert.ok(codes.includes("NON_DURABLE_EVIDENCE"));
  assert.ok(codes.includes("MISSING_REFERENCED_EVIDENCE"));
  assert.equal(report.findings.some((finding) => finding.asset === "sibling" && finding.code.startsWith("EVIDENCE_")), false);
});
