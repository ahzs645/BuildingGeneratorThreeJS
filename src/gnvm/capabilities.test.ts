import assert from "node:assert/strict";
import test from "node:test";
import type { Program } from "./evaluator";
import { analyzeProgramCapabilities } from "./capabilities";
import type { Handler, RawNode } from "./registry";

function node(name: string, type: string, options: Partial<RawNode> = {}): RawNode {
  return {
    name,
    type,
    label: null,
    inputs: [],
    outputs: [],
    ...options,
  };
}

function group(name: string, nodes: RawNode[]) {
  return { name, type: "GeometryNodeTree", nodes, links: [], interface: [] };
}

const handler: Handler = () => ({});

test("capability analysis follows nested groups once and classifies node support", () => {
  const program: Program = {
    Root: group("Root", [
      node("Input", "NodeGroupInput"),
      node("Math", "ShaderNodeMath"),
      node("Viewer", "GeometryNodeViewer"),
      node("Nested", "GeometryNodeGroup", { group: "Nested" }),
      node("Missing nested", "GeometryNodeGroup", { group: "Absent" }),
      node("Simulation input", "GeometryNodeSimulationInput"),
      node("Future node", "GeometryNodeFutureFeature"),
      node("Muted future node", "GeometryNodeFutureFeature", { ui: { mute: true } }),
    ]),
    Nested: group("Nested", [
      node("Cycle", "GeometryNodeGroup", { group: "Root" }),
      node("Output", "NodeGroupOutput"),
    ]),
  };
  const registry = new Map<string, Handler>([["ShaderNodeMath", handler]]);

  const report = analyzeProgramCapabilities(program, "Root", registry);

  assert.deepEqual(report.reachableGroups, ["Nested", "Root"]);
  assert.deepEqual(report.missingGroups, [{
    group: "Absent",
    referencedByGroup: "Root",
    referencedByNode: "Missing nested",
  }]);
  assert.deepEqual(report.unsupportedNodeTypes, [
    { type: "GeometryNodeFutureFeature", count: 1 },
    { type: "GeometryNodeSimulationInput", count: 1 },
  ]);
  assert.ok(report.nodeTypes.some((entry) =>
    entry.type === "GeometryNodeFutureFeature"
    && entry.support === "muted-passthrough"
    && entry.count === 1));
  assert.ok(report.nodeTypes.some((entry) =>
    entry.type === "GeometryNodeViewer"
    && entry.support === "editor-only"
    && entry.count === 1));
  assert.equal(report.portable, false);
});

test("capability analysis reports a missing root without throwing", () => {
  const report = analyzeProgramCapabilities({}, "Missing Root", new Map());
  assert.deepEqual(report.reachableGroups, []);
  assert.deepEqual(report.unsupportedNodeTypes, []);
  assert.deepEqual(report.missingGroups, [{
    group: "Missing Root",
    referencedByGroup: null,
    referencedByNode: null,
  }]);
  assert.equal(report.portable, false);
});

test("capability analysis is portable when every reachable node is supported", () => {
  const program: Program = {
    Root: group("Root", [
      node("Input", "NodeGroupInput"),
      node("Math", "ShaderNodeMath"),
      node("Output", "NodeGroupOutput"),
    ]),
  };
  const registry = new Map<string, Handler>([["ShaderNodeMath", handler]]);
  assert.equal(analyzeProgramCapabilities(program, "Root", registry).portable, true);
});

test("capability analysis distinguishes runnable approximations from exact support", () => {
  const program: Program = {
    Root: group("Root", [
      node("UV", "GeometryNodeUVUnwrap"),
      node("Output", "NodeGroupOutput"),
    ]),
  };
  const registry = new Map<string, Handler>([["GeometryNodeUVUnwrap", handler]]);
  const report = analyzeProgramCapabilities(program, "Root", registry);
  assert.equal(report.portable, true);
  assert.equal(report.exact, false);
  assert.deepEqual(report.approximatedNodeTypes, [
    { type: "GeometryNodeUVUnwrap", count: 1 },
  ]);
});

test("capability analysis classifies dense volume creation and resampling as bounded", () => {
  const program: Program = {
    Root: group("Root", [
      node("Volume Cube", "GeometryNodeVolumeCube"),
      node("Volume to Mesh", "GeometryNodeVolumeToMesh"),
      node("Output", "NodeGroupOutput"),
    ]),
  };
  const registry = new Map<string, Handler>([
    ["GeometryNodeVolumeCube", handler],
    ["GeometryNodeVolumeToMesh", handler],
  ]);
  const report = analyzeProgramCapabilities(program, "Root", registry);
  assert.equal(report.portable, true);
  assert.equal(report.exact, false);
  assert.deepEqual(report.approximatedNodeTypes, [
    { type: "GeometryNodeVolumeCube", count: 1 },
    { type: "GeometryNodeVolumeToMesh", count: 1 },
  ]);
});

test("Set Mesh Normal is exact only for the implemented sharpness mode", () => {
  const makeProgram = (mode: string): Program => ({
    Root: group("Root", [
      node("Set Mesh Normal", "GeometryNodeSetMeshNormal", {
        props: { mode },
      }),
      node("Output", "NodeGroupOutput"),
    ]),
  });
  const registry = new Map<string, Handler>([
    ["GeometryNodeSetMeshNormal", handler],
  ]);

  const sharpness = analyzeProgramCapabilities(
    makeProgram("SHARPNESS"),
    "Root",
    registry,
  );
  assert.equal(sharpness.exact, true);
  assert.deepEqual(sharpness.approximatedNodeTypes, []);

  for (const mode of ["FREE", "TANGENT_SPACE"]) {
    const custom = analyzeProgramCapabilities(makeProgram(mode), "Root", registry);
    assert.equal(custom.portable, true);
    assert.equal(custom.exact, false);
    assert.deepEqual(custom.approximatedNodeTypes, [
      { type: "GeometryNodeSetMeshNormal", count: 1 },
    ]);
  }
});

test("Import STL support is conditional on a validated embedded payload", () => {
  const withoutPayload: Program = {
    Root: group("Root", [
      node("Import", "GeometryNodeImportSTL"),
      node("Output", "NodeGroupOutput"),
    ]),
  };
  const registry = new Map<string, Handler>([["GeometryNodeImportSTL", handler]]);
  const unsupported = analyzeProgramCapabilities(withoutPayload, "Root", registry);
  assert.equal(unsupported.portable, false);
  assert.deepEqual(unsupported.unsupportedNodeTypes, [
    { type: "GeometryNodeImportSTL", count: 1 },
  ]);

  const withPayload: Program = {
    Root: group("Root", [
      node("Import", "GeometryNodeImportSTL", {
        embedded_stl: {
          version: 1,
          format: "ascii",
          source_size_bytes: 120,
          source_sha256: "b".repeat(64),
          triangle_count: 1,
          positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
          faces: [[0, 1, 2]],
        },
      }),
      node("Output", "NodeGroupOutput"),
    ]),
  };
  const supported = analyzeProgramCapabilities(withPayload, "Root", registry);
  assert.equal(supported.portable, true);
  assert.equal(supported.exact, true);
  assert.deepEqual(supported.unsupportedNodeTypes, []);
});
