import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { auditMaterialXDocument } from "../materialx/capabilities";

const publicAsset = (path: string): string => fs.readFileSync(
  new URL(`../../public/materialx/${path}`, import.meta.url),
  "utf8",
);
const evidenceUrl = (path: string): URL => new URL(
  `../../docs/materialx-evidence/current/${path}`,
  import.meta.url,
);

const expectedPresets = {
  aluminum: { shader: "MetalPresetAluminum", ior: [0.729, 0.588, 0.784], extinction: [6.46, 5.196, 4.377] },
  copper: { shader: "MetalPresetCopper", ior: [0.134, 1.057, 1.686], extinction: [3.106, 2.631, 2.427] },
  gold: { shader: "MetalPresetGold", ior: [0, 0.352, 1.859], extinction: [6.594, 2.081, 1.496] },
  "stainless-steel": { shader: "MetalPresetStainlessSteel", ior: [2.23, 2.041, 2.157], extinction: [4.219, 3.641, 3.074] },
  titanium: { shader: "MetalPresetTitanium", ior: [1.935, 1.868, 2.059], extinction: [2.34, 2.053, 1.745] },
} as const;

test("rights-safe metal probe index preserves the physical constants and roughness mapping", () => {
  const index = JSON.parse(publicAsset("metal-preset-probes.json"));
  assert.equal(index.schemaVersion, 1);
  assert.equal(index.sourceOracle.sha256, "608e5bae814fba45cfa5d6c6934aae54312128cb72ed940a5aa1a03dd10d8a7d");
  assert.match(index.sourceOracle.redistribution, /not redistributed/);
  assert.equal(index.probeContract.fresnelMode, "PHYSICAL_CONDUCTOR");
  assert.equal(index.probeContract.blenderPerceptualRoughness, 0.35);
  assert.equal(index.probeContract.materialxMicrofacetAlpha, 0.1225);
  assert.match(index.probeContract.roughnessMapping, /square Blender/);
  assert.ok(Math.abs(
    index.probeContract.materialxMicrofacetAlpha
      - index.probeContract.blenderPerceptualRoughness ** 2,
  ) < Number.EPSILON);

  assert.deepEqual(index.presets.map((preset: { id: string }) => preset.id), Object.keys(expectedPresets));
  for (const preset of index.presets) {
    assert.deepEqual(
      { shader: preset.shader, ior: preset.ior, extinction: preset.extinction },
      expectedPresets[preset.id as keyof typeof expectedPresets],
    );
  }
  assert.deepEqual(index.f82Probe, {
    id: "gold",
    label: "Gold F82",
    shader: "MetalF82GoldProbe",
    fresnelMode: "F82",
    sourceGroup: "Metallic BSDF+",
    sourceSockets: { baseColor: "Socket_887", edgeTint: "Socket_888" },
    baseColor: [1, 0.7758224606513977, 0.3049874007701874],
    edgeTint: [0.9734454154968262, 1, 0.9911020398139954],
    color90: [1, 1, 1],
    exponent: 5,
    scope: "Constant-input Blender Metallic BSDF F82 semantics only; no source node group or texture branch is embedded.",
  });
  assert.equal(index.anisotropyProbe.blenderPerceptualRoughness, 0.35);
  assert.equal(index.anisotropyProbe.blenderAnisotropy, 0.8);
  assert.deepEqual(index.anisotropyProbe.blenderRotationQuarterTurns, [0, 0.25]);
  assert.ok(Math.abs(index.anisotropyProbe.mapping.aspect - Math.sqrt(0.28)) < 1e-15);
  assert.ok(Math.abs(
    index.anisotropyProbe.mapping.alphaX
      - 0.35 ** 2 / index.anisotropyProbe.mapping.aspect,
  ) < 1e-15);
  assert.ok(Math.abs(
    index.anisotropyProbe.mapping.alphaY
      - 0.35 ** 2 * index.anisotropyProbe.mapping.aspect,
  ) < 1e-15);
  assert.equal(index.thinFilmProbe.shader, "MetalF82GoldThinFilm243nm");
  assert.equal(index.thinFilmProbe.anodizationVoltage, 150);
  assert.equal(index.thinFilmProbe.nanometersPerVolt, 1.62);
  assert.equal(index.thinFilmProbe.thinFilmThicknessNanometers, 243);
  assert.equal(index.thinFilmProbe.thinFilmIor, 2.46);
  assert.deepEqual(index.thinFilmProbe.sourceSockets, {
    voltage: "Socket_30 · Annodization Voltage (Thin Film)",
    thinFilmIor: "Socket_14 · Thin Film IOR",
    proceduralStreakFactor: "Socket_29 · Factor",
  });
  assert.ok(Math.abs(
    index.thinFilmProbe.thinFilmThicknessNanometers
      - index.thinFilmProbe.anodizationVoltage * index.thinFilmProbe.nanometersPerVolt,
  ) < 1e-12);
  assert.equal(index.layeredRoughnessProbe.shader, "MetalF82GoldLayeredRoughness");
  assert.deepEqual(index.layeredRoughnessProbe.mixFactors, [0.4, 0.2, 0.1]);
  assert.deepEqual(index.layeredRoughnessProbe.effectiveWeights, [0.432, 0.288, 0.18, 0.1]);
  for (const layer of index.layeredRoughnessProbe.layers) {
    assert.ok(Math.abs(
      layer.microfacetAlpha
        - (index.layeredRoughnessProbe.blenderPerceptualRoughness * layer.roughnessScale) ** 2,
    ) < 1e-15);
  }
});

test("metal preset MaterialX and official ESSL bundle carry microfacet alpha without third-party assets", () => {
  const source = publicAsset("metal-preset-probes.mtlx");
  const audit = auditMaterialXDocument(source, { implementation: "official-essl" });
  assert.deepEqual(audit.unsupportedElements, []);
  assert.equal(audit.materialCount, 10);
  assert.equal((source.match(/value="0\.1225, 0\.1225"/g) ?? []).length, 8);
  assert.doesNotMatch(source, /<(?:image|tiledimage|triplanarprojection)\b|type="filename"/);

  const manifest = JSON.parse(publicAsset("generated/metal-presets/manifest.json"));
  assert.equal(manifest.generator.materialx, "1.39.4");
  assert.equal(manifest.generator.specularEnvironment, "PREFILTER");
  assert.deepEqual(Object.keys(manifest.shaders).sort(), [
    ...Object.values(expectedPresets).map(({ shader }) => shader),
    "MetalF82GoldProbe",
    "MetalF82GoldAnisotropicR0",
    "MetalF82GoldAnisotropicR90",
    "MetalF82GoldThinFilm243nm",
    "MetalF82GoldLayeredRoughness",
  ].sort());
  for (const { shader } of Object.values(expectedPresets)) {
    const uniforms = manifest.shaders[shader].fragmentInterface.uniforms.PublicUniforms;
    const roughness = uniforms.find((uniform: { name: string }) => uniform.name === "conductor_roughness");
    assert.ok(Math.abs(roughness.value[0] - 0.1225) < 1e-6, shader);
    assert.ok(Math.abs(roughness.value[1] - 0.1225) < 1e-6, shader);
    const fragment = publicAsset(`generated/metal-presets/${shader}.frag`);
    assert.match(fragment, /void mx_conductor_bsdf\(/);
    assert.match(fragment, /mx_latlong_alpha_to_lod\(avgAlpha\)/);
    assert.doesNotMatch(fragment, /for \(int i = 0; i < envRadianceSamples; i\+\+\)/);
  }
  const f82Fragment = publicAsset("generated/metal-presets/MetalF82GoldProbe.frag");
  assert.match(f82Fragment, /void mx_generalized_schlick_bsdf\(/);
  assert.match(f82Fragment, /mx_init_fresnel_schlick/);
  assert.match(f82Fragment, /mx_latlong_alpha_to_lod\(avgAlpha\)/);
  assert.doesNotMatch(f82Fragment, /for \(int i = 0; i < envRadianceSamples; i\+\+\)/);
  for (const shader of ["MetalF82GoldAnisotropicR0", "MetalF82GoldAnisotropicR90"]) {
    const uniforms = manifest.shaders[shader].fragmentInterface.uniforms.PublicUniforms;
    const roughness = uniforms.find((uniform: { name: string }) => uniform.name === "f82_roughness");
    assert.ok(Math.abs(roughness.value[0] - 0.23150323971815168) < 1e-6, shader);
    assert.ok(Math.abs(roughness.value[1] - 0.06482090712108245) < 1e-6, shader);
    const fragment = publicAsset(`generated/metal-presets/${shader}.frag`);
    assert.match(fragment, /mx_generalized_schlick_bsdf\(/);
  }
  assert.match(
    publicAsset("generated/metal-presets/MetalF82GoldAnisotropicR90.frag"),
    /mx_rotate_vector3\(/,
  );
  const thinFilmUniforms = manifest.shaders.MetalF82GoldThinFilm243nm
    .fragmentInterface.uniforms.PublicUniforms;
  assert.equal(
    thinFilmUniforms.find((uniform: { name: string }) => uniform.name === "f82_thinfilm_thickness").value,
    243,
  );
  assert.ok(Math.abs(
    thinFilmUniforms.find((uniform: { name: string }) => uniform.name === "f82_thinfilm_ior").value
      - 2.46,
  ) < 1e-6);
  const thinFilmFragment = publicAsset("generated/metal-presets/MetalF82GoldThinFilm243nm.frag");
  assert.match(thinFilmFragment, /mx_generalized_schlick_bsdf\(/);
  assert.match(thinFilmFragment, /mx_init_fresnel_schlick\([^;]+thinfilm_thickness, thinfilm_ior\)/);
  const layeredUniforms = manifest.shaders.MetalF82GoldLayeredRoughness
    .fragmentInterface.uniforms.PublicUniforms;
  for (const [suffix, alpha] of [
    ["025", 0.00765625],
    ["050", 0.030625],
    ["075", 0.06890625],
    ["100", 0.1225],
  ] as const) {
    const roughness = layeredUniforms.find(
      (uniform: { name: string }) => uniform.name === `roughness_${suffix}_roughness`,
    );
    assert.ok(Math.abs(roughness.value[0] - alpha) < 1e-6, suffix);
    assert.ok(Math.abs(roughness.value[1] - alpha) < 1e-6, suffix);
  }
  for (const [name, factor] of [
    ["mix_025_050_mix", 0.4],
    ["mix_050_075_mix", 0.2],
    ["mix_075_100_mix", 0.1],
  ] as const) {
    assert.ok(Math.abs(
      layeredUniforms.find((uniform: { name: string }) => uniform.name === name).value - factor,
    ) < 1e-6);
  }
});

test("matched Blender and browser metal probes pass the constant-input similarity gate", () => {
  const comparison = JSON.parse(fs.readFileSync(evidenceUrl("comparison.json"), "utf8"));
  assert.equal(comparison.comparisonVersion, 11);
  assert.match(comparison.renderContract.metalPresetMatrix, /0\.35.*0\.1225/);
  assert.deepEqual(Object.keys(comparison.metalPresetMatrix), Object.keys(expectedPresets));
  for (const id of Object.keys(expectedPresets)) {
    const result = comparison.metalPresetMatrix[id];
    assert.ok(result.sphereRegion.rgbRootMeanSquareError < 0.03, id);
    assert.ok(result.sphereRegion.luminanceCorrelation > 0.97, id);
    assert.match(result.claim, /constant-input PHYSICAL_CONDUCTOR semantics only/);
    for (const renderer of ["blender", "web"]) {
      assert.ok(fs.statSync(evidenceUrl(`metal-preset-${id}-${renderer}.png`)).size > 10_000, `${id} ${renderer}`);
    }
  }
  const f82 = comparison.metalF82Probe;
  assert.match(comparison.renderContract.metalF82Probe, /generalized_schlick_bsdf/);
  assert.ok(f82.sphereRegion.rgbRootMeanSquareError < 0.04);
  assert.ok(f82.sphereRegion.luminanceCorrelation > 0.95);
  assert.match(f82.claim, /constant-input F82 semantics only/);
  for (const renderer of ["blender", "web"]) {
    assert.ok(fs.statSync(evidenceUrl(`metal-f82-gold-${renderer}.png`)).size > 10_000, renderer);
  }
  assert.match(comparison.renderContract.metalLayeredRoughnessProbe, /sequential mix factors 0\.4\/0\.2\/0\.1/);
  const layeredRoughness = comparison.metalLayeredRoughnessProbe;
  assert.ok(layeredRoughness.sphereRegion.rgbRootMeanSquareError < 0.02);
  assert.ok(layeredRoughness.sphereRegion.luminanceCorrelation > 0.99);
  assert.ok(Math.abs(
    layeredRoughness.sphereRegion.meanLuminance.blender
      - layeredRoughness.sphereRegion.meanLuminance.web,
  ) < 0.01);
  assert.match(layeredRoughness.claim, /layered-roughness closure semantics only/);
  for (const renderer of ["blender", "web"]) {
    assert.ok(
      fs.statSync(evidenceUrl(`metal-layered-roughness-gold-${renderer}.png`)).size > 10_000,
      renderer,
    );
  }
  assert.match(comparison.renderContract.metalAnisotropyProbe, /Blender Cycles/);
  const anisotropy = comparison.metalAnisotropyProbe;
  assert.ok(anisotropy.r0.sphereRegion.rgbRootMeanSquareError < 0.13);
  assert.ok(anisotropy.r0.sphereRegion.luminanceCorrelation > 0.88);
  assert.ok(anisotropy.r90.sphereRegion.rgbRootMeanSquareError < 0.09);
  assert.ok(anisotropy.r90.sphereRegion.luminanceCorrelation > 0.94);
  assert.ok(Math.abs(
    anisotropy.r0.sphereRegion.meanLuminance.blender
      - anisotropy.r0.sphereRegion.meanLuminance.web,
  ) < 0.01);
  assert.ok(Math.abs(
    anisotropy.r90.sphereRegion.meanLuminance.blender
      - anisotropy.r90.sphereRegion.meanLuminance.web,
  ) < 0.01);
  for (const rotation of ["r0", "r90"]) {
    assert.match(anisotropy[rotation].claim, /anisotropy\/tangent semantics only/);
    for (const renderer of ["blender", "web"]) {
      assert.ok(
        fs.statSync(evidenceUrl(`metal-anisotropy-gold-${rotation}-${renderer}.png`)).size > 10_000,
        `${rotation} ${renderer}`,
      );
    }
  }
  assert.match(comparison.renderContract.metalThinFilmProbe, /150 V x 1\.62 nm\/V = 243 nm/);
  const thinFilmBaseline = comparison.metalThinFilmProbe["0nm"];
  assert.ok(thinFilmBaseline.sphereRegion.rgbRootMeanSquareError < 0.012);
  assert.ok(thinFilmBaseline.sphereRegion.luminanceCorrelation > 0.999);
  const thinFilm = comparison.metalThinFilmProbe["243nm"];
  assert.ok(thinFilm.sphereRegion.rgbRootMeanSquareError < 0.07);
  assert.ok(thinFilm.sphereRegion.luminanceCorrelation > 0.99);
  assert.ok(Math.abs(
    thinFilm.sphereRegion.meanLuminance.blender
      - thinFilm.sphereRegion.meanLuminance.web,
  ) < 0.02);
  assert.ok(Math.max(...thinFilm.sphereMeanRgb.blender.map(
    (value: number, index: number) => Math.abs(value - thinFilm.sphereMeanRgb.web[index]),
  )) < 0.1);
  assert.ok(Math.max(...thinFilm.sphereMeanRgb.web.map(
    (value: number, index: number) => Math.abs(value - thinFilmBaseline.sphereMeanRgb.web[index]),
  )) > 0.03);
  assert.match(thinFilm.claim, /thin-film thickness and IOR semantics only/);
  assert.match(thinFilm.residual, /different spectral approximations/);
  for (const thickness of [0, 243]) {
    for (const renderer of ["blender", "web"]) {
      assert.ok(
        fs.statSync(evidenceUrl(`metal-thin-film-gold-${thickness}nm-${renderer}.png`)).size > 10_000,
        `${thickness}nm ${renderer}`,
      );
    }
  }
});
