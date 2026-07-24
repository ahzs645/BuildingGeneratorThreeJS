import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type { EsslManifest } from "../materialx/essl-adapter";
import {
  materialXPrefilterDimensions,
  validateMaterialXEnvironmentPrefilterManifest,
} from "../materialx/environment-prefilter";

const generated = (directory: string, name: string): URL => new URL(
  `../../public/materialx/generated/${directory}/${name}`,
  import.meta.url,
);

test("official prefilter writer pins the MaterialX mip contract", () => {
  const manifest = JSON.parse(fs.readFileSync(
    generated("environment-prefilter", "manifest.json"),
    "utf8",
  )) as EsslManifest;
  assert.equal(manifest.generator.materialx, "1.39.4");
  assert.equal(manifest.generator.specularEnvironment, "PREFILTER");
  assert.equal(manifest.generator.writesEnvironmentPrefilter, true);
  assert.deepEqual(manifest.generator.compatibilityRewrites, [
    "pow(2.0, u_envPrefilterMip) -> exp2(float(u_envPrefilterMip))",
  ]);
  validateMaterialXEnvironmentPrefilterManifest(
    manifest,
    "MaterialXEnvironmentPrefilter",
  );
  const shader = fs.readFileSync(
    generated("environment-prefilter", "MaterialXEnvironmentPrefilter.frag"),
    "utf8",
  );
  assert.match(shader, /vec3 mx_generate_prefilter_env\(\)/);
  assert.match(shader, /int envRadianceSamples = 1024;/);
  assert.match(shader, /uniform int u_envPrefilterMip;/);
  assert.match(shader, /exp2\(float\(u_envPrefilterMip\)\)/);
  assert.doesNotMatch(shader, /pow\(2\.0, u_envPrefilterMip\)/);
  assert.match(shader, /out1 = vec4\(mx_generate_prefilter_env\(\), 1\.0\);/);
});

test("native PREFILTER shader performs one mip lookup instead of per-fragment FIS", () => {
  const manifest = JSON.parse(fs.readFileSync(
    generated("native-prefilter", "manifest.json"),
    "utf8",
  )) as EsslManifest;
  assert.equal(manifest.generator.specularEnvironment, "PREFILTER");
  assert.equal(manifest.generator.writesEnvironmentPrefilter, undefined);
  const shader = fs.readFileSync(generated("native-prefilter", "chrome_003.frag"), "utf8");
  assert.match(shader, /float mx_latlong_alpha_to_lod\(float alpha\)/);
  assert.match(shader, /mx_latlong_map_lookup\(L, u_envMatrix, mx_latlong_alpha_to_lod\(avgAlpha\), u_envRadiance\)/);
  assert.doesNotMatch(shader, /for \(int i = 0; i < envRadianceSamples; i\+\+\)/);
});

test("prefilter mip dimensions preserve the 2:1 lat-long layout to the final level", () => {
  assert.deepEqual(materialXPrefilterDimensions(256, 128), [
    { width: 256, height: 128 },
    { width: 128, height: 64 },
    { width: 64, height: 32 },
    { width: 32, height: 16 },
    { width: 16, height: 8 },
    { width: 8, height: 4 },
    { width: 4, height: 2 },
    { width: 2, height: 1 },
    { width: 1, height: 1 },
  ]);
  assert.throws(() => materialXPrefilterDimensions(256, 256), /2:1 lat-long/);
  assert.throws(() => materialXPrefilterDimensions(300, 150), /power-of-two/);
});

test("prefilter writer validation rejects ordinary material manifests", () => {
  const manifest = JSON.parse(fs.readFileSync(
    generated("native-prefilter", "manifest.json"),
    "utf8",
  )) as EsslManifest;
  assert.throws(
    () => validateMaterialXEnvironmentPrefilterManifest(manifest, "chrome_003"),
    /PREFILTER writer manifest/,
  );
});

test("committed browser evidence contains nine finite non-empty radiance levels", () => {
  const report = JSON.parse(fs.readFileSync(
    new URL("../../docs/materialx-evidence/current/environment-prefilter-runtime.json", import.meta.url),
    "utf8",
  ));
  assert.equal(report.reportVersion, 1);
  assert.equal(report.extension, true);
  assert.equal(report.mipCount, 9);
  assert.equal(report.levels.length, 9);
  for (const level of report.levels) {
    assert.ok(Number.isFinite(level.meanRadiance) && level.meanRadiance > 0);
    assert.ok(Number.isFinite(level.maximumRadiance) && level.maximumRadiance > 0);
  }
});
