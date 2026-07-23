import assert from "node:assert/strict";
import test from "node:test";
import { auditMaterialXDocument } from "../materialx/capabilities";

test("preflight accepts the loader-supported procedural noise surface", () => {
  const xml = `<?xml version="1.0"?><materialx version="1.39">
    <nodegraph name="NG"><position name="p" type="vector3"/><fractal3d name="n" type="float"><input name="position" type="vector3" nodename="p"/></fractal3d><output name="rough" type="float" nodename="n"/></nodegraph>
    <standard_surface name="SS" type="surfaceshader"><input name="specular_roughness" type="float" nodegraph="NG" output="rough"/></standard_surface>
    <surfacematerial name="M" type="material"><input name="surfaceshader" type="surfaceshader" nodename="SS"/></surfacematerial>
  </materialx>`;
  assert.deepEqual(auditMaterialXDocument(xml), {
    elements: ["fractal3d", "input", "materialx", "nodegraph", "output", "position", "standard_surface", "surfacematerial"],
    unsupportedElements: [],
    materialCount: 1,
    proceduralHeightNormalCount: 0,
    requiresProceduralHeightAdapter: false,
  });
});

test("preflight rejects Wave and named geomprops instead of accepting loader zero-substitution", () => {
  const audit = auditMaterialXDocument(`<materialx version="1.39"><nodegraph name="NG"><wave name="bands" type="float"/><geompropvalue name="rough" type="float"/></nodegraph></materialx>`);
  assert.deepEqual(audit.unsupportedElements, ["geompropvalue", "wave"]);
});

test("official ESSL accepts typed geomprops while Three TSL still rejects them", () => {
  const xml = `<materialx version="1.39"><nodegraph name="NG"><geompropvalue name="rough" type="float"/></nodegraph></materialx>`;
  assert.deepEqual(auditMaterialXDocument(xml, { implementation: "official-essl" }).unsupportedElements, []);
  assert.deepEqual(auditMaterialXDocument(xml, { implementation: "three-tsl" }).unsupportedElements, ["geompropvalue"]);
});

test("official ESSL accepts direct conductor surfaces while Three TSL rejects them", () => {
  const xml = `<materialx version="1.39">
    <nodegraph name="NG">
      <conductor_bsdf name="metal" type="BSDF"/>
      <output name="bsdf" type="BSDF" nodename="metal"/>
    </nodegraph>
    <surface name="SS" type="surfaceshader">
      <input name="bsdf" type="BSDF" nodegraph="NG" output="bsdf"/>
    </surface>
    <surfacematerial name="M" type="material">
      <input name="surfaceshader" type="surfaceshader" nodename="SS"/>
    </surfacematerial>
  </materialx>`;
  assert.deepEqual(
    auditMaterialXDocument(xml, { implementation: "official-essl" }).unsupportedElements,
    [],
  );
  assert.deepEqual(
    auditMaterialXDocument(xml, { implementation: "three-tsl" }).unsupportedElements,
    ["conductor_bsdf", "surface"],
  );
});

test("preflight identifies procedural height graphs that need the TSL derivative adapter", () => {
  const audit = auditMaterialXDocument(`<materialx version="1.39"><nodegraph name="NG"><noise3d name="height" type="float"/><heighttonormal name="bump" type="vector3"><input name="in" type="float" nodename="height"/></heighttonormal></nodegraph></materialx>`);
  assert.equal(audit.proceduralHeightNormalCount, 1);
  assert.equal(audit.requiresProceduralHeightAdapter, true);
});
