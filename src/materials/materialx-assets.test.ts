import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { auditMaterialXDocument } from "../materialx/capabilities";

const asset = (path: string): string => fs.readFileSync(new URL(`../../public/materialx/${path}`, import.meta.url), "utf8");
const assetUrl = (path: string): URL => new URL(`../../public/materialx/${path}`, import.meta.url);
const evidence = (path: string): string => fs.readFileSync(new URL(`../../docs/materialx-evidence/${path}`, import.meta.url), "utf8");
const evidenceUrl = (path: string): URL => new URL(`../../docs/materialx-evidence/${path}`, import.meta.url);

test("committed native extraction is validated and records exact source graph facts", () => {
  const report = JSON.parse(asset("chrome-crayon-native.report.json"));
  assert.equal(report.blenderVersion, "5.1.2");
  assert.equal(report.sourceMaterial, "chrome.003");
  assert.equal(report.validation.valid, true);
  assert.deepEqual(report.sourceNodeTypes, [
    "ShaderNodeAttribute", "ShaderNodeBsdfPrincipled", "ShaderNodeCombineXYZ", "ShaderNodeMapRange",
    "ShaderNodeMapping", "ShaderNodeMath", "ShaderNodeOutputMaterial", "ShaderNodeTexCoord",
    "ShaderNodeTexNoise", "ShaderNodeValue",
  ]);
  assert.equal(report.sourceNodeTypes.includes("ShaderNodeTexWave"), false);
  assert.equal(report.sourceNodeTypes.includes("ShaderNodeBump"), false);
  assert.equal(report.capability.parityReady, false);
  assert.deepEqual(report.capability.substitutedSemantics.map((item: { kind: string }) => item.kind), [
    "generated-coordinate", "named-geometry-property",
  ]);
});

test("committed MaterialX documents pass Three loader capability preflight", () => {
  for (const path of ["chrome-crayon-native.mtlx", "baked/chrome-crayon-noise-baked.mtlx"]) {
    const audit = auditMaterialXDocument(asset(path));
    assert.deepEqual(audit.unsupportedElements, [], path);
    assert.ok(audit.materialCount >= 1, path);
  }
  const prototype = auditMaterialXDocument(asset("chrome-crayon-prototype.mtlx"), { implementation: "official-essl" });
  assert.deepEqual(prototype.unsupportedElements, []);
  const uiNormalBand = auditMaterialXDocument(asset("ui-normal-band-prototype.mtlx"), { implementation: "official-essl" });
  assert.deepEqual(uiNormalBand.unsupportedElements, []);
});

test("UI normal-band probe is topology-discovered, typed, and explicitly parity-gated", () => {
  const report = JSON.parse(asset("ui-normal-band.report.json"));
  assert.equal(report.source.discovery, "unique active Normal -> Mapping -> CONSTANT ColorRamp mixed with a named color property");
  assert.equal(report.source.sourceBlendAvailable, false);
  assert.deepEqual(report.activeGraph.geometryProperties, [
    { name: "col", type: "color3", domain: "point", required: true },
  ]);
  assert.match(report.diagnosticLowering.rotationConvention, /negating each axis/);
  assert.deepEqual(report.capability.substitutedSemantics.map((item: { kind: string }) => item.kind), [
    "texture-coordinate-normal-space", "surface-coercion",
  ]);
  assert.equal(report.capability.parityReady, false);

  const generatedManifest = JSON.parse(asset("generated/ui-normal-band/manifest.json"));
  const shader = generatedManifest.shaders.UiNormalBandSemanticRecovery;
  assert.deepEqual(shader.geometryBindings.properties, [
    { attribute: "a_geomprop_col", default: "0, 0, 0", name: "col", required: true, type: "color3" },
  ]);
  assert.ok(fs.statSync(assetUrl("generated/ui-normal-band/UiNormalBandSemanticRecovery.frag")).size > 75_000);
});

test("procedural bump uses the canonical MaterialX tangent-normal wrapper", () => {
  const xml = asset("chrome-crayon-prototype.mtlx");
  assert.match(xml, /<heighttonormal name="procedural_normal"[\s\S]*?<normalmap name="bump_normal"/);
  assert.match(xml, /<input name="in" type="vector3" nodename="procedural_normal"/);
  assert.match(xml, /<input name="scale" type="float" value="0\.1"/);
  assert.match(xml, /<output name="normal" type="vector3" nodename="bump_normal"/);
});

test("baked PBR evidence proves Blender-side semantic preservation", () => {
  const report = JSON.parse(evidence("baked/bake-report.json"));
  assert.equal(report.materialxValidation.valid, true);
  assert.ok(report.comparison.rgbRootMeanSquareError < 0.005);
  assert.ok(report.comparison.luminanceCorrelation > 0.999);
  assert.ok(fs.statSync(assetUrl("baked/chrome-crayon-noise-normal.png")).size > 100_000);
  assert.ok(fs.statSync(assetUrl("baked/chrome-crayon-roughness.png")).size > 1_000);
});

test("official MaterialX shader-generator experiment is pinned and license-scoped", () => {
  const report = JSON.parse(evidence("research/official-materialx-essl.json"));
  assert.equal(report.materialXVersion, "1.39.4");
  assert.equal(report.render.compiled, true);
  assert.equal(report.render.linked, true);
  assert.ok(report.render.sphereLuminanceCorrelation > 0.8);
  assert.equal(report.offlineGeneration.blenderVersion, "5.1.2");
  assert.equal(report.offlineGeneration.materialXVersion, "1.39.4");
  assert.equal(report.offlineGeneration.sourceLowering.compiled, true);
  assert.equal(report.offlineGeneration.sourceLowering.linked, true);
  assert.ok(report.offlineGeneration.sourceLowering.fragmentShaderBytes > 100_000);
  assert.equal(report.offlineGeneration.noiseBumpProbe.compiled, true);
  assert.equal(report.offlineGeneration.noiseBumpProbe.linked, true);
  assert.ok(report.offlineGeneration.noiseBumpProbe.fragmentShaderBytes > 100_000);
  assert.match(report.offlineGeneration.directLightStatus, /bind a MaterialX light rig/);
  assert.match(report.offlineGeneration.environmentStatus, /PMREM CubeUV is not a drop-in/);
  assert.match(report.cost.boundary, /not the shipped WebGPU\/TSL route/);
  assert.ok(fs.statSync(evidenceUrl("research/official-materialx-essl.png")).size > 50_000);
  assert.ok(fs.statSync(assetUrl("licenses/LICENSE")).size > 10_000);
  assert.ok(fs.statSync(assetUrl("licenses/THIRD-PARTY.md")).size > 19_000);
});

test("comparison evidence separates pixels from graph-semantic claims", () => {
  const comparison = JSON.parse(evidence("current/comparison.json"));
  assert.equal(comparison.comparisonVersion, 5);
  assert.equal(comparison.renderContract.colorTransform, "Standard/sRGB, no tone mapping");
  assert.match(comparison.renderContract.environment, /studio-environment\.exr/);
  assert.match(comparison.renderContract.webBackend, /official MaterialX 1\.39\.4 ESSL/);
  assert.match(comparison.renderContract.webEnvironment, /FIS/);
  assert.ok(fs.statSync(assetUrl("references/studio-environment.exr")).size > 100_000);
  assert.ok(fs.statSync(assetUrl("references/studio-irradiance.exr")).size > 1_000);
  assert.ok(fs.statSync(evidenceUrl("current/coordinate-cardinals-web.png")).size > 1_000);
  assert.ok(fs.statSync(assetUrl("references/scene-contract.json")).size > 1_000);
  assert.ok(comparison.sourceLowering.luminanceCorrelation > 0);
  assert.ok(comparison.noiseBumpProbe.rgbRootMeanSquareError < 0.1);
  assert.ok(comparison.noiseBumpProbe.luminanceCorrelation > 0.8);
  assert.ok(comparison.noiseBumpProbe.sphereRegion.rgbRootMeanSquareError < 0.25);
  assert.ok(comparison.noiseBumpProbe.sphereRegion.luminanceCorrelation > 0.34);
  assert.ok(Math.abs(
    comparison.noiseBumpProbe.sphereRegion.meanLuminance.blender
      - comparison.noiseBumpProbe.sphereRegion.meanLuminance.web,
  ) < 0.01);
  assert.ok(comparison.uiNormalBandDiagnostic.rgbRootMeanSquareError < 0.02);
  assert.ok(comparison.uiNormalBandDiagnostic.luminanceCorrelation > 0.99);
  assert.ok(comparison.uiNormalBandDiagnostic.sphereRegion.rgbRootMeanSquareError < 0.02);
  assert.ok(comparison.uiNormalBandDiagnostic.sphereRegion.luminanceCorrelation > 0.99);
  assert.match(comparison.uiNormalBandDiagnostic.claim, /parity blockers/);
  for (const renderer of ["blender", "web"]) {
    assert.ok(fs.statSync(evidenceUrl(`current/ui-normal-band-${renderer}.png`)).size > 10_000, renderer);
  }
  for (const light of ["key", "fill", "rim"]) {
    const diagnostic = comparison.directionalLightDiagnostics[light].sphereRegion;
    assert.ok(diagnostic.rgbRootMeanSquareError < 0.08, light);
    assert.ok(diagnostic.luminanceCorrelation > 0.96, light);
    assert.ok(fs.statSync(evidenceUrl(`current/light-${light}-blender.png`)).size > 10_000, light);
    assert.ok(fs.statSync(evidenceUrl(`current/light-${light}-web.png`)).size > 10_000, light);
  }
  assert.match(comparison.interpretation, /Graph-semantic support is reported separately/);
});

test("upstream r186 experiment is pinned and separates native normals from the local adapter", () => {
  const comparison = JSON.parse(evidence("archive/upstream-comparison.json"));
  assert.equal(comparison.upstream.commit, "bce55b294825d273eae3e178aab3191f719594e6");
  assert.match(comparison.upstream.statusAtEvaluation, /open/);
  assert.equal(comparison.implementationDelta.r185AdapterToPrAdapter.noiseBumpProbe.fullFrame.rgbRootMeanSquareError, 0);
  assert.equal(comparison.implementationDelta.r185AdapterToPrNative.sourceLowering.fullFrame.rgbRootMeanSquareError, 0);
  assert.ok(
    comparison.implementations.pr33485Native.noiseBumpProbe.sphereRegion.rgbRootMeanSquareError
      > comparison.implementations.r185LocalAdapter.noiseBumpProbe.sphereRegion.rgbRootMeanSquareError,
  );
  assert.match(comparison.interpretation, /normalized mask/);
  for (const path of ["archive/r185/noise-bump-web.png", "archive/pr33485/noise-bump-web.png"]) {
    assert.ok(fs.statSync(evidenceUrl(path)).size > 50_000, path);
  }
});
