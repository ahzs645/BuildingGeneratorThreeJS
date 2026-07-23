import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import * as THREE from "three";
import {
  type BlenderSceneContract,
  bindMaterialXGeometry,
  type EsslManifest,
  MATERIALX_DIRECTION_TRANSFORM,
  materialXLightFromBlenderContract,
  materialXDirection,
  matrixFromRows,
} from "../materialx/essl-adapter";
import { makeProbeGeometry } from "../materialx/probe-geometry";

const generated = (name: string): URL => new URL(`../../public/materialx/generated/${name}`, import.meta.url);

test("offline ESSL manifest pins FIS and bound directional lights", () => {
  const manifest = JSON.parse(fs.readFileSync(generated("manifest.json"), "utf8"));
  assert.deepEqual(manifest.generator, {
    lightNodeDef: "ND_directional_light",
    lightTypeId: 1,
    materialx: "1.39.4",
    maxLights: 3,
    radianceSamples: 16,
    source: "chrome-crayon-prototype.mtlx",
    specularEnvironment: "FIS",
    target: "essl",
  });
  assert.deepEqual(manifest.licenses, {
    materialx: "../licenses/LICENSE",
    thirdPartyNotices: "../licenses/THIRD-PARTY.md",
  });
  assert.deepEqual(Object.keys(manifest.shaders).sort(), [
    "ChromeCrayonNoiseBumpProbe",
    "ChromeCrayonSourceLowering",
    "MaterialXGeompropColorDiagnostic",
    "MaterialXSmoothChromeDiagnostic",
  ]);
});

test("generated ESSL binds exported Generated bounds and typed named geometry properties", () => {
  const manifest = JSON.parse(fs.readFileSync(generated("manifest.json"), "utf8")) as EsslManifest;
  const contract = JSON.parse(fs.readFileSync(
    new URL("../../public/materialx/references/scene-contract.json", import.meta.url),
    "utf8",
  )) as BlenderSceneContract;
  const geometry = makeProbeGeometry(8, 4);
  const source = manifest.shaders.ChromeCrayonSourceLowering;
  const uniforms = Object.fromEntries([
    ...(source.geometryBindings?.generatedCoordinates?.boundsMinUniforms ?? []),
    ...(source.geometryBindings?.generatedCoordinates?.boundsMaxUniforms ?? []),
  ].map((name) => [name, { value: null }]));
  bindMaterialXGeometry(geometry, source, contract.probe, uniforms);
  assert.equal(geometry.getAttribute("a_geomprop_rough"), geometry.getAttribute("rough"));
  for (const name of source.geometryBindings?.generatedCoordinates?.boundsMinUniforms ?? []) {
    assert.deepEqual((uniforms[name].value as THREE.Vector3).toArray(), contract.probe.bounds.min);
  }
  for (const name of source.geometryBindings?.generatedCoordinates?.boundsMaxUniforms ?? []) {
    assert.deepEqual((uniforms[name].value as THREE.Vector3).toArray(), contract.probe.bounds.max);
  }
  bindMaterialXGeometry(geometry, manifest.shaders.MaterialXGeompropColorDiagnostic, contract.probe, {});
  assert.equal(geometry.getAttribute("a_geomprop_col"), geometry.getAttribute("col"));

  const missing = makeProbeGeometry(8, 4);
  missing.deleteAttribute("rough");
  assert.throws(() => bindMaterialXGeometry(missing, source, contract.probe, uniforms), /rough:float requires itemSize 1/);
});

test("generated bump shader contains FIS, irradiance, light binding, and output encoding", () => {
  const shader = fs.readFileSync(generated("ChromeCrayonNoiseBumpProbe.frag"), "utf8");
  assert.match(shader, /uniform sampler2D u_envRadiance;/);
  assert.match(shader, /uniform sampler2D u_envIrradiance;/);
  assert.match(shader, /uniform LightData u_lightData\[MAX_LIGHT_SOURCES\];/);
  assert.match(shader, /for \(int i = 0; i < envRadianceSamples; i\+\+\)/);
  assert.match(shader, /out1 = vec4\(mx_srgb_encode\(/);
  assert.ok(fs.statSync(new URL("../../public/materialx/references/studio-irradiance.exr", import.meta.url)).size > 1_000);
  const diagnostic = fs.readFileSync(generated("MaterialXSmoothChromeDiagnostic.frag"), "utf8");
  assert.match(diagnostic, /result\.direction = -light\.direction;/);
  assert.match(diagnostic, /uniform LightData u_lightData\[MAX_LIGHT_SOURCES\];/);
});

test("environment rotation and Blender light contracts remain separate", () => {
  const environmentX = materialXDirection(new THREE.Vector3(1, 0, 0), MATERIALX_DIRECTION_TRANSFORM);
  assert.ok(environmentX.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-7);

  const contract = JSON.parse(fs.readFileSync(
    new URL("../../public/materialx/references/scene-contract.json", import.meta.url),
    "utf8",
  )) as BlenderSceneContract;
  assert.equal(contract.schemaVersion, 1);
  for (const source of contract.lights) {
    const propagation = new THREE.Vector3().fromArray(source.propagationDirection);
    const toLight = new THREE.Vector3().fromArray(source.toLightDirection);
    assert.ok(Math.abs(propagation.length() - 1) < 1e-6);
    assert.ok(propagation.clone().add(toLight).length() < 1e-6);
    assert.ok(materialXLightFromBlenderContract(source).direction.distanceTo(propagation) < 1e-7);
  }
  const camera = matrixFromRows(contract.camera.matrixWorldRows);
  assert.ok(new THREE.Vector3().setFromMatrixPosition(camera).distanceTo(new THREE.Vector3(3.2, 2.2, 3.4)) < 1e-6);
  assert.throws(() => matrixFromRows([[1, 0], [0, 1]]), /four rows/);
});

test("comparison probe triangles are outward wound", () => {
  const geometry = makeProbeGeometry(8, 4);
  const positions = geometry.getAttribute("position");
  const indices = geometry.getIndex();
  assert.ok(indices);
  for (let triangle = 0; triangle < indices.count; triangle += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(triangle));
    const b = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(triangle + 1));
    const c = new THREE.Vector3().fromBufferAttribute(positions, indices.getX(triangle + 2));
    const geometricNormal = b.clone().sub(a).cross(c.clone().sub(a));
    const outward = a.clone().add(b).add(c).normalize();
    assert.ok(geometricNormal.dot(outward) > 0);
  }
});
