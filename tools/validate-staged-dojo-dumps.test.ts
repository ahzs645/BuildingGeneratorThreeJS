import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  auditStagedDumps,
  compareDumpPair,
  type DumpDeclaration,
} from "./validate-staged-dojo-dumps";

function group(annotation?: string) {
  return {
    name: "Root",
    type: "GeometryNodeTree",
    nodes: [{
      name: "Input",
      type: "GeometryNodeInputMesh",
      label: null,
      inputs: [],
      outputs: [],
      props: { evaluated_topology: { faces: [[0, 1, 2]] } },
    }],
    links: [],
    interface: [],
    ...(annotation ? { annotation } : {}),
  };
}

function annotation(point: number[] = [1, 2, 0, 1, 1]) {
  return {
    name: "Notes",
    layers: [{
      name: "Note",
      color: [0.1, 0.2, 0.3],
      opacity: 1,
      thickness: 3,
      frames: [{ number: 1, strokes: [{ flags: 0, space: "VIEW2D", cyclic: false, thickness: 3, points: [point] }] }],
    }],
  };
}

function dump() {
  return {
    blender_version: "5.1.2",
    node_groups: { Root: group("Notes") },
    annotations: { Notes: annotation() },
    objects: [{
      name: "Target",
      evaluated_mesh: { verts: [], faces: [] },
      modifiers: [{ type: "NODES", node_group: "Root" }],
    }],
    materials: { Mat: group() },
    fonts: { Font: { name: "Font", glyphs: {} } },
    dependency_objects: ["Dependency"],
    extraction_metadata: {
      schema_version: 1,
      extractor: { name: "dump_blend.py", version: "1", blender_version: "5.1.2" },
      source: { filename: "lesson.blend", fingerprint_sha256: "old" },
      dependencies: [],
    },
  };
}

test("semantic comparison reports catalog and special-payload losses even when aggregate counts can match", () => {
  const current = dump();
  const staged = structuredClone(current);
  staged.objects = [{ name: "Replacement", modifiers: [{ type: "NODES", node_group: "Other" }] }] as typeof staged.objects;
  staged.node_groups = { Other: group() };
  staged.materials = { OtherMat: group() };
  staged.annotations = {};
  staged.fonts = {};
  staged.dependency_objects = [];
  staged.extraction_metadata.source = { filename: "lesson.blend", fingerprint_sha256: "new" };

  const report = compareDumpPair({
    file: "dojo/lesson/dump.json",
    current,
    staged,
    catalogAssets: [{ id: "lesson", object: "Target", dump: "dojo/lesson/dump.json" }],
  });
  const codes = new Set(report.findings.map((finding) => finding.code));
  assert.ok(codes.has("OBJECTS_LOST"));
  assert.ok(codes.has("NODE_GROUPS_LOST"));
  assert.ok(codes.has("MATERIALS_LOST"));
  assert.ok(codes.has("ANNOTATIONS_LOST"));
  assert.ok(codes.has("EVALUATED_MESH_LOST"));
  assert.ok(codes.has("EVALUATED_TOPOLOGY_LOST"));
  assert.ok(codes.has("FONTS_LOST"));
  assert.ok(codes.has("DEPENDENCIES_LOST"));
  assert.ok(codes.has("CATALOG_TARGET_LOST"));
  assert.ok(codes.has("SOURCE_METADATA_CHANGED"));
  assert.ok(report.findings.filter((finding) => finding.kind === "dangerous-loss").length >= 9);
});

test("annotation integrity rejects dangling references and non-finite points", () => {
  const current = dump();
  const staged = structuredClone(current);
  staged.node_groups.Root.annotation = "Missing";
  staged.annotations.Notes = annotation([Number.NaN, 2, 0, 1, 1]);
  const report = compareDumpPair({ file: "dump.json", current, staged });
  assert.ok(report.findings.some((finding) => finding.code === "DANGLING_ANNOTATION_REFERENCE"));
  assert.ok(report.findings.some((finding) => finding.code === "ANNOTATION_POINT_INVALID"));
  assert.equal(report.findings.filter((finding) => finding.kind === "integrity-error").length, 2);
});

test("declarations distinguish expected annotation/source additions from undeclared additions", () => {
  const current = dump();
  delete current.annotations;
  delete current.node_groups.Root.annotation;
  const staged = dump();
  staged.extraction_metadata.source.fingerprint_sha256 = "new";
  const declaration: DumpDeclaration = {
    additions: ["annotations"],
    sourceMetadataChanges: true,
    note: "annotation-aware re-export",
  };
  const report = compareDumpPair({ file: "dump.json", current, staged, declaration });
  assert.ok(report.findings.some((finding) => finding.code === "ANNOTATIONS_DECLARED_ADDITION"));
  assert.ok(report.findings.some((finding) => finding.code === "SOURCE_METADATA_DECLARED_CHANGE"));
  assert.equal(report.findings.some((finding) => finding.kind === "addition" && finding.category === "annotations"), false);
});

test("directory audit catches an omitted shared dump and evaluates all catalog targets", async () => {
  const root = await mkdtemp(join(tmpdir(), "staged-dump-audit-"));
  const currentRoot = join(root, "current");
  const stagedRoot = join(root, "staged");
  await mkdir(join(currentRoot, "dojo/shared"), { recursive: true });
  await mkdir(stagedRoot, { recursive: true });
  await writeFile(join(currentRoot, "dojo/shared/dump.json"), JSON.stringify(dump()));
  const catalogPath = join(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify([
    { id: "variant-a", object: "Target", dump: "dojo/shared/dump.json" },
    { id: "variant-b", object: "Target", dump: "dojo/shared/dump.json" },
  ]));
  const report = await auditStagedDumps({ currentRoot, stagedRoot, catalogPath });
  assert.equal(report.summary.catalogAssets, 2);
  assert.equal(report.summary.dangerousLosses, 1);
  assert.equal(report.files[0].findings[0].code, "DUMP_LOST");
});
