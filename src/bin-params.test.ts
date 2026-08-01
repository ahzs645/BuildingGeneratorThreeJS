import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  binPresetFromSearch,
  binSearchFromValues,
  BIN_DEFAULTS,
  BIN_PARAMETERS,
  BIN_PRESETS,
} from "./bin-params";

const repo = new URL("../", import.meta.url);
const catalog = JSON.parse(readFileSync(new URL(
  "public/dojo/chrome-assets/catalog.json",
  repo,
), "utf8")) as Array<{ id: string; controls?: Array<Record<string, unknown>> }>;
const parity = JSON.parse(readFileSync(new URL(
  "public/dojo/bin-geometry-parity.json",
  repo,
), "utf8")) as {
  browserControlContract: {
    uniquePublishedRangeProbes: number;
    exactBoundsCases: number;
    ranges: Record<string, [number, number]>;
  };
};
const extendedCases = JSON.parse(readFileSync(new URL(
  "tools/bin-parity-extended-cases.json",
  repo,
), "utf8")) as Array<{ overrides: Record<string, unknown> }>;

test("Recursive Bin publishes the same validated controls in Studio and the catalog", () => {
  const asset = catalog.find((candidate) => candidate.id === "recursive-bin");
  assert.ok(asset?.controls);

  for (const parameter of BIN_PARAMETERS) {
    const control = asset.controls.find((candidate) => candidate.name === parameter.name);
    assert.ok(control, `missing catalog control ${parameter.name}`);
    assert.equal(control.value, parameter.defaultValue);
    assert.equal(control.min, parameter.min);
    assert.equal(control.max, parameter.max);
    assert.equal(control.step, parameter.step);
  }
});

test("Recursive Bin parity-sensitive ranges stay tied to Blender evidence", () => {
  const ranges = parity.browserControlContract.ranges;
  const byName = new Map(BIN_PARAMETERS.map((parameter) => [parameter.name, parameter]));

  for (const [name, [min, max]] of Object.entries(ranges)) {
    assert.equal(byName.get(name)?.min, min);
    assert.equal(byName.get(name)?.max, max);
  }
  assert.equal(parity.browserControlContract.uniquePublishedRangeProbes, 44);
  assert.equal(parity.browserControlContract.exactBoundsCases, 44);
});

test("extended Blender sweep exercises every exposed Recursive Bin control", () => {
  const exercised = new Set(extendedCases.flatMap((item) => Object.keys(item.overrides)));
  assert.deepEqual(
    BIN_PARAMETERS.map((parameter) => parameter.name).filter((name) => !exercised.has(name)),
    [],
  );
});

test("Recursive Bin URL presets are precise, bounded, and backward compatible", () => {
  assert.deepEqual(binPresetFromSearch(
    "?fillet=7.9&divide+x=0.15&divide+y=0.9&make+exportable=true&select=11",
  ), {
    fillet: 7.9,
    "divide x": 0.15,
    "divide y": 0.9,
    "Bin Select": 11,
    "make exportable": true,
  });
  assert.deepEqual(binPresetFromSearch(
    "?fillet=100&divide+x=0&divide+y=1&bin+gap+size=50&Bin+Select=20",
  ), {
    "bin gap size": 7,
    fillet: 7.9,
    "divide x": 0.15,
    "divide y": 0.9,
    "Bin Select": 11,
  });
});

test("Recursive Bin presets cover authored, every baked selection, and validated boundaries", () => {
  assert.equal(BIN_PRESETS[0].id, "authored");
  assert.deepEqual(BIN_PRESETS[0].values, BIN_DEFAULTS);
  assert.deepEqual(
    BIN_PRESETS.filter((preset) => preset.id.startsWith("selection-")).map((preset) => preset.values["Bin Select"]),
    Array.from({ length: 12 }, (_, index) => index),
  );
  assert.equal(BIN_PRESETS.find((preset) => preset.id === "gap-boundary")?.values["bin gap size"], 7);
  assert.equal(BIN_PRESETS.find((preset) => preset.id === "fillet-boundary")?.values.fillet, 7.9);
  assert.equal(BIN_PRESETS.find((preset) => preset.id === "export-ready")?.values["make exportable"], true);
});

test("Recursive Bin share URLs reproduce every exact parameter plus workspace state", () => {
  const values = { ...BIN_DEFAULTS, "Size Z": 0.45, "Bin Select": 11, "make exportable": true };
  const search = binSearchFromValues(values, { workspace: "validate", layout: "split" });
  assert.deepEqual(binPresetFromSearch(search), values);
  const query = new URLSearchParams(search);
  assert.equal(query.get("workspace"), "validate");
  assert.equal(query.get("layout"), "split");
});
