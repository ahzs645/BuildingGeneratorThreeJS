import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { auditMaterialXDocument } from "../materialx/capabilities";
import { prepareLiveMaterialXGeometry } from "../materialx/live-geometry";

const materialXAsset = (path: string): string => fs.readFileSync(
  new URL(`../../public/materialx/${path}`, import.meta.url),
  "utf8",
);

test("catalog metal index preserves source constants and geometry-property contracts", () => {
  const index = JSON.parse(materialXAsset("catalog-metal-surfaces.json"));
  assert.equal(index.schemaVersion, 1);
  assert.deepEqual(Object.keys(index.assets), [
    "geometry-nodes-001",
    "chain-and-mace",
    "soft-pixel-marker",
    "type-pixel-brush",
    "blunt-metal-marker",
    "text-soup",
  ]);
  assert.deepEqual(index.assets["geometry-nodes-001"], {
    label: "3D Chrome Grill Crayon",
    sourceMaterial: "chrome",
    shader: "CatalogChromeGrill",
    baseColor: [0.2508697211742401, 0.2508697211742401, 0.2508697211742401],
    metalness: 1,
    perceptualRoughness: 0.26104414463043213,
    geometryProperties: [],
  });
  assert.deepEqual(index.assets["chain-and-mace"].geometryProperties, [
    { name: "rough", type: "float", domain: "vertex" },
  ]);
  assert.equal(index.assets["chain-and-mace"].perceptualRoughness, "rough / 15");
  assert.deepEqual(index.assets["soft-pixel-marker"].geometryProperties, [
    { name: "rough", type: "float", domain: "vertex" },
  ]);
  assert.equal(index.assets["type-pixel-brush"].shader, "CatalogChrome002RoughAttribute");
  assert.equal(index.assets["blunt-metal-marker"].shader, "CatalogChrome002MissingRough");
  assert.match(index.assets["blunt-metal-marker"].missingPropertyResolution, /returns zero/);
  assert.equal(index.assets["text-soup"].perceptualRoughness, 0);
  assert.match(index.assets["text-soup"].missingPropertyResolution, /returns zero/);
  assert.match(index.scope, /complete shader graphs are not redistributed/);
});

test("catalog standard surfaces compile through official PREFILTER ESSL", () => {
  const source = materialXAsset("catalog-metal-surfaces.mtlx");
  const audit = auditMaterialXDocument(source, { implementation: "official-essl" });
  assert.deepEqual(audit.unsupportedElements, []);
  assert.equal(audit.materialCount, 3);
  assert.match(source, /<geompropvalue name="rough_property" type="float">/);
  assert.match(source, /value="0\.06666666666666667"/);

  const manifest = JSON.parse(materialXAsset("generated/catalog-metals/manifest.json"));
  assert.equal(manifest.generator.materialx, "1.39.4");
  assert.equal(manifest.generator.specularEnvironment, "PREFILTER");
  assert.deepEqual(Object.keys(manifest.shaders).sort(), [
    "CatalogChrome002MissingRough",
    "CatalogChrome002RoughAttribute",
    "CatalogChromeGrill",
  ]);
  assert.deepEqual(
    manifest.shaders.CatalogChrome002RoughAttribute.geometryBindings.properties,
    [{ attribute: "a_geomprop_rough", default: "0", name: "rough", required: true, type: "float" }],
  );
  for (const shader of Object.keys(manifest.shaders)) {
    const fragment = materialXAsset(`generated/catalog-metals/${shader}.frag`);
    assert.match(fragment, /mx_latlong_alpha_to_lod\(avgAlpha\)/, shader);
    assert.match(fragment, /mx_roughness_anisotropy\(/, shader);
    assert.doesNotMatch(fragment, /for \(int i = 0; i < envRadianceSamples; i\+\+\)/, shader);
  }
});

test("catalog entries are opt-in previews on exact live assets", () => {
  const catalog = JSON.parse(fs.readFileSync(
    new URL("../../public/dojo/chrome-assets/catalog.json", import.meta.url),
    "utf8",
  ));
  for (const id of [
    "geometry-nodes-001",
    "chain-and-mace",
    "soft-pixel-marker",
    "type-pixel-brush",
    "blunt-metal-marker",
    "text-soup",
  ]) {
    const asset = catalog.find((entry: { id: string }) => entry.id === id);
    const preview = asset.controls.find((control: { name: string }) => control.name === "__materialPreview");
    assert.equal(preview.value, "authored", id);
    assert.ok(
      preview.options.some((option: { value: string }) => option.value === "materialx-prefilter"),
      id,
    );
    assert.match(asset.note, /opt-in MaterialX preview/, id);
  }
});

test("live MaterialX geometry validates property cardinality and creates tangents", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -1, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ], 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute([
    0, 0, 1,
    0, 0, 1,
    0, 0, 1,
  ], 3));
  geometry.setAttribute("rough", new THREE.Float32BufferAttribute([0, 2, 2], 1));
  const contract = prepareLiveMaterialXGeometry(
    geometry,
    [{ name: "rough", type: "float", domain: "vertex" }],
  );
  assert.deepEqual(contract, {
    bounds: { space: "object", min: [-1, 0, 0], max: [1, 1, 0] },
    geometryProperties: [{ name: "rough", type: "float", domain: "vertex" }],
  });
  assert.equal(geometry.getAttribute("tangent").count, 3);

  geometry.deleteAttribute("rough");
  assert.throws(
    () => prepareLiveMaterialXGeometry(
      geometry,
      [{ name: "rough", type: "float", domain: "vertex" }],
    ),
    /one rough value per GPU vertex/,
  );
});

test("catalog evidence preserves exact topology without asserting renderer identity", () => {
  const cases = [
    {
      asset: "geometry-nodes-001",
      slug: "chrome-grill",
      geometry: { vertices: 61_812, faces: 53_892 },
    },
    {
      asset: "chain-and-mace",
      slug: "chain-and-mace",
      geometry: { vertices: 120_727, faces: 214_718 },
    },
    {
      asset: "soft-pixel-marker",
      slug: "soft-pixel-marker",
      geometry: { vertices: 8_455, faces: 5_664 },
    },
    {
      asset: "type-pixel-brush",
      slug: "type-pixel-brush",
      geometry: { vertices: 17_860, faces: 11_296 },
    },
    {
      asset: "blunt-metal-marker",
      slug: "blunt-metal-marker",
      geometry: { vertices: 97_691, faces: 97_669 },
    },
    {
      asset: "text-soup",
      slug: "text-soup",
      geometry: { vertices: 11_971, faces: 11_199 },
    },
  ];
  for (const evidenceCase of cases) {
    const comparison = JSON.parse(fs.readFileSync(
      new URL(
        `../../docs/materialx-evidence/current/catalog-metal-${evidenceCase.slug}-comparison.json`,
        import.meta.url,
      ),
      "utf8",
    ));
    assert.equal(comparison.asset, evidenceCase.asset);
    assert.deepEqual(comparison.geometry.blender, evidenceCase.geometry);
    assert.deepEqual(comparison.geometry.web, comparison.geometry.blender);
    assert.ok(comparison.fullFrame.luminanceCorrelation > 0.5);
    assert.match(comparison.claim, /do not assert renderer identity/);
    assert.ok(fs.statSync(
      new URL(
        `../../docs/materialx-evidence/current/catalog-metal-${evidenceCase.slug}-web.png`,
        import.meta.url,
      ),
    ).size > 10_000);
  }

  const chrome = JSON.parse(fs.readFileSync(
    new URL("../../docs/materialx-evidence/current/catalog-metal-chrome-grill-comparison.json", import.meta.url),
    "utf8",
  ));
  assert.ok(Math.abs(
    chrome.fullFrame.meanLuminance.blender
      - chrome.fullFrame.meanLuminance.web,
  ) < 0.001);
  assert.ok(chrome.foreground.intersectionLuminanceCorrelation < 0.3);
});
