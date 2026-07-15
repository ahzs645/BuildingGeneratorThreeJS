import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Dump } from "../gnvm";
import { resolveEditorRootGroup } from "../react/geometry-nodes/editor-config";

const loadDump = async (relativeUrl: string): Promise<Dump> => JSON.parse(await readFile(
  fileURLToPath(new URL(relativeUrl, import.meta.url)),
  "utf8",
)) as Dump;

const crayonDump = await loadDump("../../public/dojo/crayon/dump.json");
const typePixelBrushDump = await loadDump("../../public/dojo/chrome-assets/type-pixel-brush/dump.json");

test("resolves each configured asset to its exact modifier root", () => {
  assert.equal(resolveEditorRootGroup(crayonDump, {
    objectName: "CHROME CRAYON OBJECT",
    rootGroupName: "CHROME CRAYON 3D _4.3_DEC2024",
  }), "CHROME CRAYON 3D _4.3_DEC2024");
  assert.equal(resolveEditorRootGroup(typePixelBrushDump, {
    objectName: "Type Pixel Brush Chrome",
    rootGroupName: "soft pixel marker.001",
  }), "soft pixel marker.001");
});

test("object selection deterministically falls back to its first valid modifier", () => {
  assert.equal(resolveEditorRootGroup(typePixelBrushDump, {
    objectName: "Type Pixel Brush Chrome",
  }), "soft pixel marker.001");
});

test("rejects missing objects and roots that are not assigned to the selected object", () => {
  assert.throws(() => resolveEditorRootGroup(typePixelBrushDump, {
    objectName: "missing",
    rootGroupName: "soft pixel marker.001",
  }), /object not found: missing/);
  assert.throws(() => resolveEditorRootGroup(typePixelBrushDump, {
    objectName: "Type Pixel Brush Chrome",
    rootGroupName: "material menu",
  }), /is not assigned to Type Pixel Brush Chrome/);
});
