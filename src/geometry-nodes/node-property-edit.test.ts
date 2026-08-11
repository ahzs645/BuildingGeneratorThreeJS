import assert from "node:assert/strict";
import test from "node:test";
import { Evaluator, type Program, type RawGroup } from "../gnvm/evaluator";
import { Geometry } from "../gnvm/geometry";
import "../gnvm";
import { nodePropertyControls } from "./node-property-catalog";

/**
 * The editor's dropdowns rest on two assumptions that live outside the React
 * component: the evaluator reads `node.props` when it runs rather than when the
 * dump is loaded, and the group snapshot `commit` keeps for the undo stack is
 * not aliased by the mutation. Both are exercised here on a graph small enough
 * to evaluate in milliseconds — Mesh Circle's vertex count and cap fill are
 * countable, so a property change is visible as an integer.
 */
function circleProgram(): Program {
  const group: RawGroup = {
    name: "Root",
    type: "GeometryNodeTree",
    interface: [
      { item_type: "SOCKET", in_out: "OUTPUT", identifier: "Geometry", name: "Geometry", socket_type: "NodeSocketGeometry" },
    ],
    nodes: [
      {
        name: "Math",
        type: "ShaderNodeMath",
        label: null,
        props: { operation: "MULTIPLY" },
        inputs: [
          { name: "Value", identifier: "Value", type: "NodeSocketFloat", linked: false, value: 3 },
          { name: "Value", identifier: "Value_001", type: "NodeSocketFloat", linked: false, value: 2 },
          { name: "Value", identifier: "Value_002", type: "NodeSocketFloat", linked: false, value: 0 },
        ],
        outputs: [{ name: "Value", identifier: "Value", type: "NodeSocketFloat" }],
      },
      {
        name: "Circle",
        type: "GeometryNodeMeshCircle",
        label: null,
        props: { fill_type: "NGON" },
        inputs: [
          { name: "Vertices", identifier: "Vertices", type: "NodeSocketInt", linked: true, value: 32 },
          { name: "Radius", identifier: "Radius", type: "NodeSocketFloat", linked: false, value: 1 },
        ],
        outputs: [{ name: "Mesh", identifier: "Mesh", type: "NodeSocketGeometry" }],
      },
      {
        name: "Group Output",
        type: "NodeGroupOutput",
        label: null,
        inputs: [{ name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry", linked: true, value: null }],
        outputs: [],
      },
    ],
    links: [
      { from_node: "Math", from_socket: "Value", to_node: "Circle", to_socket: "Vertices" },
      { from_node: "Circle", from_socket: "Mesh", to_node: "Group Output", to_socket: "Geometry" },
    ],
  };
  return { Root: group };
}

const evaluate = (program: Program): { verts: number; faces: number } => {
  const geometry = new Evaluator(program).evalModifierGroup("Root").geometry;
  assert.ok(geometry instanceof Geometry && geometry.mesh);
  return { verts: geometry.mesh.positions.length, faces: geometry.mesh.faces.length };
};

/** The mutation `changeProp` performs, on the clone shape `commit` produces. */
function changeProp(program: Program, nodeName: string, prop: string, value: string): Program {
  const next: Program = { ...program, Root: structuredClone(program.Root) };
  const node = next.Root.nodes.find((candidate) => candidate.name === nodeName);
  assert.ok(node);
  node.props = { ...node.props, [prop]: value };
  return next;
}

test("a property change re-evaluates through the same dump the editor mutates", () => {
  const program = circleProgram();
  assert.deepEqual(evaluate(program), { verts: 6, faces: 1 });

  // Math is upstream of the circle's vertex count: 3 * 2 becomes 3 + 2.
  assert.deepEqual(evaluate(changeProp(program, "Math", "operation", "ADD")), { verts: 5, faces: 1 });
  // The circle's own cap fill removes the n-gon without touching the ring.
  assert.deepEqual(evaluate(changeProp(program, "Circle", "fill_type", "NONE")), { verts: 6, faces: 0 });
  // Both at once, because each commit builds on the previous dump.
  const twice = changeProp(changeProp(program, "Math", "operation", "ADD"), "Circle", "fill_type", "TRIANGLE_FAN");
  assert.deepEqual(evaluate(twice), { verts: 6, faces: 5 });
});

test("the pre-edit group the undo stack keeps still evaluates to the old result", () => {
  const program = circleProgram();
  const undoEntry = program.Root;
  const edited = changeProp(program, "Math", "operation", "ADD");

  assert.notEqual(edited.Root, undoEntry, "commit must not hand the undo stack the group it mutated");
  assert.equal(undoEntry.nodes.find((node) => node.name === "Math")!.props!.operation, "MULTIPLY");
  assert.deepEqual(evaluate(edited), { verts: 5, faces: 1 });
  assert.deepEqual(evaluate({ ...edited, Root: undoEntry }), { verts: 6, faces: 1 });
});

test("the dropdown reads back the value the change wrote", () => {
  const edited = changeProp(circleProgram(), "Circle", "fill_type", "TRIANGLE_FAN");
  const node = edited.Root.nodes.find((candidate) => candidate.name === "Circle")!;
  const [control] = nodePropertyControls(node.type, node.props);
  assert.equal(control.prop, "fill_type");
  assert.equal(control.value, "TRIANGLE_FAN");
  assert.ok(control.options.every((option) => !option.label.endsWith("(as authored)")));
});
