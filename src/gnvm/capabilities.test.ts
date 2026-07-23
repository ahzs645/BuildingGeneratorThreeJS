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
