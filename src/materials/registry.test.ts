import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import type { Dump } from "../gnvm";
import {
  AUTHORED_MATERIAL_ADAPTERS,
  authoredMaterialRegistry,
  createAuthoredMaterialRegistry,
  materialNameForGroup,
  type AuthoredMaterialContext,
} from "./registry";

const group = { start: 0, count: 3, material: "Material" };
const geometry = new THREE.BufferGeometry();
const context: AuthoredMaterialContext = {
  asset: {},
  dump: {} as Dump,
  geometry,
  group,
  groups: [group],
  materialName: "Material",
  stipplerDebugMode: 0,
};

test("registry continues only for adapters that report themselves inapplicable", () => {
  const calls: string[] = [];
  const expected = new THREE.MeshBasicMaterial();
  const registry = createAuthoredMaterialRegistry([
    { id: "miss", resolve: () => { calls.push("miss"); return undefined; } },
    { id: "match", resolve: () => { calls.push("match"); return expected; } },
    { id: "late", resolve: () => { calls.push("late"); return new THREE.MeshBasicMaterial(); } },
  ]);
  assert.equal(registry.resolve(context), expected);
  assert.deepEqual(calls, ["miss", "match"]);
  expected.dispose();
});

test("strict adapter rejection is terminal instead of silently falling back", () => {
  const calls: string[] = [];
  const registry = createAuthoredMaterialRegistry([
    { id: "strict", resolve: () => { calls.push("strict"); return null; } },
    { id: "fallback", resolve: () => { calls.push("fallback"); return new THREE.MeshBasicMaterial(); } },
  ]);
  assert.equal(registry.resolve(context), null);
  assert.deepEqual(calls, ["strict"]);
});

test("default registry keeps the authored dispatch order stable", () => {
  assert.deepEqual(AUTHORED_MATERIAL_ADAPTERS.map((adapter) => adapter.id), [
    "preview-workbench",
    "blender-default-surface",
    "unmaterialed-workbench",
    "profile-image-pixel-stippler",
    "profile-chain-mace",
    "profile-chrome-crayon",
    "profile-attribute-emission",
    "attribute-emission",
    "attribute-color-emission",
    "attribute-principled",
    "node-base",
    "simple-noise-bump",
    "node-color-vtext",
    "vtext",
    "knit-thread",
    "filament",
    "cross-section-filament",
    "hat-stitch",
    "lightbulb",
    "mahogany",
    "toon-cycles",
    "toon-outline",
    "grey-ui",
    "basic-blender",
    "packed-sticker",
    "chrome-crayon-fallback",
  ]);
});

test("default and Workbench preview adapters preserve top-level precedence", () => {
  const defaultMaterial = authoredMaterialRegistry.resolve({
    ...context,
    group: { ...group, material: null },
    materialName: "",
  });
  assert.ok(defaultMaterial?.isMeshPhysicalMaterial);
  assert.equal(defaultMaterial?.name, "Blender unassigned material surface");
  defaultMaterial?.dispose();

  const workbenchMaterial = authoredMaterialRegistry.resolve({
    ...context,
    asset: { workbenchColor: [0.1, 0.2, 0.3] },
    group: { ...group, material: null },
    materialName: "",
    previewMode: "workbench",
  });
  assert.ok(workbenchMaterial?.isShaderMaterial);
  assert.equal(workbenchMaterial?.name, "Blender Workbench studio approximation");
  workbenchMaterial?.dispose();
});

test("chain profile retains its evaluated material-slot fallback", () => {
  const groups = [
    { start: 0, count: 3, material: "chrome.002" },
    { start: 3, count: 3, material: null },
  ];
  assert.equal(materialNameForGroup({ material: "chain-mace" }, groups[1], groups), "chrome.002");
  assert.equal(materialNameForGroup({}, groups[1], groups), "");
});

test.after(() => geometry.dispose());
