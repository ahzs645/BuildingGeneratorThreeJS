import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { libraryAssetCategory, libraryAssetCompareHref, type LibraryAsset } from "./asset-library-model";

const repo = new URL("../../../", import.meta.url);
const catalog = JSON.parse(readFileSync(new URL(
  "public/dojo/chrome-assets/catalog.json",
  repo,
), "utf8")) as LibraryAsset[];

test("Recursive Bin is one catalog asset with its dedicated parity destination", () => {
  const recursive = catalog.find((asset) => asset.id === "recursive-bin");
  assert.ok(recursive);
  assert.equal(recursive.object, "Procedural Drawer");
  assert.equal(recursive.dump, "dojo/dump_bin.json");
  assert.equal(libraryAssetCompareHref(recursive), "/bin");
  assert.equal(existsSync(new URL(`public/${recursive.reference}`, repo)), true);
});

test("Recursive Bin reference keeps its Blender provenance and exact authored counts", () => {
  const recursive = catalog.find((asset) => asset.id === "recursive-bin");
  assert.ok(recursive);

  const metadata = JSON.parse(readFileSync(new URL(
    "public/dojo/references/recursive-bin.json",
    repo,
  ), "utf8")) as {
    referenceSha256: string;
    geometry: { verts: number; faces: number };
  };
  const reference = readFileSync(new URL(`public/${recursive.reference}`, repo));

  assert.equal(metadata.geometry.verts, recursive.blenderStats.verts);
  assert.equal(metadata.geometry.faces, recursive.blenderStats.faces);
  assert.equal(
    createHash("sha256").update(reference).digest("hex"),
    metadata.referenceSha256,
  );
});

test("the two bin catalog entries remain distinct Blender graphs", () => {
  const bins = catalog.filter((asset) => /bin/i.test(`${asset.id} ${asset.title}`));
  assert.deepEqual(bins.map((asset) => ({
    id: asset.id,
    object: asset.object,
    dump: asset.dump,
  })), [
    {
      id: "recursive-bin",
      object: "Procedural Drawer",
      dump: "dojo/dump_bin.json",
    },
    {
      id: "n03d-stackable-bin",
      object: "BIN_ Stackable Gridfinity 31MAY2024",
      dump: "dojo/n03d/stackable-bin/dump.json",
    },
  ]);
});

test("ordinary catalog assets keep the generic comparison route", () => {
  const stackable = catalog.find((asset) => asset.id === "n03d-stackable-bin");
  assert.ok(stackable);
  assert.equal(libraryAssetCompareHref(stackable), "/chrome-assets?asset=n03d-stackable-bin");
});

test("catalog assets receive stable discovery categories", () => {
  assert.equal(libraryAssetCategory(catalog.find((asset) => asset.id === "type-pixel-brush")!), "Drawing");
  assert.equal(libraryAssetCategory(catalog.find((asset) => asset.id === "outline-sticker")!), "Stickers");
  assert.equal(libraryAssetCategory(catalog.find((asset) => asset.id === "typewriter")!), "Text");
  assert.equal(libraryAssetCategory(catalog.find((asset) => asset.id === "recursive-bin")!), "Fabrication");
});
