import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProgramCapabilities } from "./capabilities";
import { Field } from "./core";
import type { Program } from "./evaluator";
import { Geometry } from "./geometry";
import {
  UnsupportedClosureEvaluationError,
  UnsupportedGaborDimensionError,
  blenderGaborTexture2D,
  blenderGaborTexture3D,
} from "./nodes/extra";
import { EMPTY_CLOSURE, REGISTRY } from "./registry";
import {
  ClosureRecursionLimitError,
  Evaluator,
  MAX_CLOSURE_EVALUATION_DEPTH,
} from "./evaluator";
import { Mesh } from "./geometry";
import "./index";

test("2D Gabor exposes deterministic Value, Phase, and Intensity fields", () => {
  const handler = REGISTRY.get("ShaderNodeTexGabor");
  assert.ok(handler);
  const outputs = handler({
    node: {
      inputs: [
        { name: "Vector", identifier: "Vector", linked: true },
      ],
    },
    prop: (name: string) => name === "gabor_type" ? "2D" : undefined,
    field: (name: string) => {
      if (name === "Vector") return Field.of([.125, -.75, 4]);
      if (name === "Scale") return Field.of(3.5);
      if (name === "Frequency") return Field.of(2);
      if (name === "Anisotropy") return Field.of(.8);
      return Field.of(Math.PI / 4);
    },
  } as never);
  const context = { size: 1, domain: "POINT", component: "MESH" } as const;
  const expected = blenderGaborTexture2D([.125, -.75, 4], 3.5, 2, .8, Math.PI / 4);

  // Blender 5.1.2 evaluated this point through Store Named Attribute.
  assert.equal(expected.value, 0.437576562166214);
  assert.equal(expected.phase, 0.39752355217933655);
  assert.ok(Math.abs(expected.intensity - 0.20797352492809296) <= 3e-8);
  assert.deepEqual((outputs.Value as Field).array(context), [expected.value]);
  assert.deepEqual((outputs.Phase as Field).array(context), [expected.phase]);
  assert.deepEqual((outputs.Intensity as Field).array(context), [expected.intensity]);
});

test("2D Gabor ignores Z and clamps frequency and anisotropy", () => {
  assert.deepEqual(
    blenderGaborTexture2D([.25, .5, -100], 2, -5, 4, .25),
    blenderGaborTexture2D([.25, .5, 100], 2, .001, 1, .25),
  );
});

test("3D Gabor matches Blender 5.1.2 field samples", () => {
  const samples = [
    {
      args: [[.125, -.75, .4], 3.5, 2, .8, [.3, .4, .5]] as const,
      expected: {
        value: 0.6987265348434448,
        phase: 0.8872561454772949,
        intensity: 0.6108907461166382,
      },
    },
    {
      args: [[-1.25, 2.5, .75], .75, 0, 1, [1, 0, 0]] as const,
      expected: {
        value: 0.5000762939453125,
        phase: 0.9997004866600037,
        intensity: 0.0810619592666626,
      },
    },
    {
      args: [[4, -3, 2], -1.25, 4.25, 0, [-.2, .7, .1]] as const,
      expected: {
        value: 0.38758254051208496,
        phase: 0.36957454681396484,
        intensity: 0.3076576590538025,
      },
    },
  ];
  for (const { args, expected } of samples) {
    const actual = blenderGaborTexture3D(...args);
    assert.equal(actual.value, expected.value);
    assert.equal(actual.phase, expected.phase);
    assert.ok(Math.abs(actual.intensity - expected.intensity) <= 3e-8);
  }
});

test("3D Gabor uses Blender's positive-X pole limit for finite orientations", () => {
  const samples = [
    {
      orientation: [0, 0, 1] as const,
      expected: {
        value: 0.31226617097854614,
        phase: 0.3397585153579712,
        intensity: 0.44426682591438293,
      },
    },
    {
      orientation: [0, 0, -1] as const,
      expected: {
        value: 0.6877337098121643,
        phase: 0.660241425037384,
        intensity: 0.4442667067050934,
      },
    },
  ];
  for (const { orientation, expected } of samples) {
    const actual = blenderGaborTexture3D(
      [.125, -.75, .4],
      3.5,
      2,
      .8,
      [...orientation],
    );
    assert.ok(Object.values(actual).every(Number.isFinite));
    // Blender 5.1.2 itself returns NaN at the exact poles. These oracle values
    // are its positive-X limit at x=1e-7; exact-pole fallback stays within two
    // float32 ULPs while remaining finite.
    assert.ok(Math.abs(actual.value - expected.value) <= 2e-7);
    assert.ok(Math.abs(actual.phase - expected.phase) <= 2e-7);
    assert.ok(Math.abs(actual.intensity - expected.intensity) <= 2e-7);
  }
});

test("unknown Gabor dimensions throw a typed diagnostic", () => {
  const handler = REGISTRY.get("ShaderNodeTexGabor");
  assert.ok(handler);
  assert.throws(
    () => handler({
      node: { inputs: [] },
      prop: () => "4D",
    } as never),
    UnsupportedGaborDimensionError,
  );
});

test("an unlinked Evaluate Closure is identity over its dynamic signature", () => {
  const handler = REGISTRY.get("NodeEvaluateClosure");
  assert.ok(handler);
  const geometry = new Geometry();
  const strength = Field.of(.75);
  const values = new Map<string, unknown>([
    ["Closure", EMPTY_CLOSURE],
    ["Item_0", geometry],
    ["Item_1", strength],
  ]);
  const outputs = handler({
    node: {
      name: "Evaluate Closure",
      inputs: [
        { name: "Closure", identifier: "Closure", linked: false },
        { name: "Geometry", identifier: "Item_0", linked: true },
        { name: "Strength", identifier: "Item_1", linked: true },
      ],
      outputs: [
        { name: "Geometry", identifier: "Item_0" },
        { name: "Strength", identifier: "Item_1" },
        { name: "", identifier: "__extend__" },
      ],
    },
    input: (name: string) => values.get(name),
  } as never);

  assert.equal(outputs.Item_0, geometry);
  assert.equal(outputs.Item_1, strength);
  assert.equal("__extend__" in outputs, false);
});

test("a linked Evaluate Closure throws a typed diagnostic", () => {
  const handler = REGISTRY.get("NodeEvaluateClosure");
  assert.ok(handler);
  assert.throws(
    () => handler({
      node: {
        name: "Evaluate Closure",
        inputs: [{ name: "Closure", identifier: "Closure", linked: true }],
        outputs: [],
      },
      input: () => Field.of(0),
    } as never),
    UnsupportedClosureEvaluationError,
  );
});

test("a callable Closure zone evaluates with dynamic inputs", () => {
  const geometry = new Geometry();
  geometry.mesh = new Mesh();
  geometry.mesh.positions = [[0, 0, 0]];
  const evaluator = new Evaluator({
    Root: {
      name: "Root",
      type: "GeometryNodeTree",
      interface: [],
      links: [
        { from_node: "Closure Input", from_socket: "Item_0", to_node: "Transform", to_socket: "Geometry" },
        { from_node: "Closure Input", from_socket: "Item_1", to_node: "Transform", to_socket: "Translation" },
        { from_node: "Transform", from_socket: "Geometry", to_node: "Closure Output", to_socket: "Item_0" },
        { from_node: "Closure Output", from_socket: "Closure", to_node: "Evaluate Closure", to_socket: "Closure" },
        { from_node: "Group Input", from_socket: "Geometry", to_node: "Evaluate Closure", to_socket: "Item_0" },
        { from_node: "Evaluate Closure", from_socket: "Item_0", to_node: "Group Output", to_socket: "Geometry" },
      ],
      nodes: [
        {
          name: "Group Input",
          type: "NodeGroupInput",
          label: null,
          inputs: [],
          outputs: [{ name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry" }],
        },
        {
          name: "Closure Input",
          type: "NodeClosureInput",
          label: null,
          paired_output: "Closure Output",
          inputs: [],
          outputs: [
            { name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry" },
            { name: "Translation", identifier: "Item_1", type: "NodeSocketVector" },
          ],
        },
        {
          name: "Transform",
          type: "GeometryNodeTransform",
          label: null,
          inputs: [
            { name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry", linked: true, value: null },
            { name: "Translation", identifier: "Translation", type: "NodeSocketVector", linked: true, value: null },
            { name: "Rotation", identifier: "Rotation", type: "NodeSocketRotation", linked: false, value: [0, 0, 0] },
            { name: "Scale", identifier: "Scale", type: "NodeSocketVector", linked: false, value: [1, 1, 1] },
          ],
          outputs: [{ name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry" }],
        },
        {
          name: "Closure Output",
          type: "NodeClosureOutput",
          label: null,
          inputs: [
            { name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry", linked: true, value: null },
          ],
          outputs: [{ name: "Closure", identifier: "Closure", type: "NodeSocketClosure" }],
        },
        {
          name: "Evaluate Closure",
          type: "NodeEvaluateClosure",
          label: null,
          inputs: [
            { name: "Closure", identifier: "Closure", type: "NodeSocketClosure", linked: true, value: null },
            { name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry", linked: true, value: null },
            { name: "Translation", identifier: "Item_1", type: "NodeSocketVector", linked: false, value: [1, 2, 3] },
          ],
          outputs: [{ name: "Geometry", identifier: "Item_0", type: "NodeSocketGeometry" }],
        },
        {
          name: "Group Output",
          type: "NodeGroupOutput",
          label: null,
          inputs: [
            { name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry", linked: true, value: null },
          ],
          outputs: [],
        },
      ],
    },
  });

  const outputs = evaluator.evalGroup("Root", { Geometry: geometry });
  assert.deepEqual((outputs.Geometry as Geometry).mesh?.positions, [[1, 2, 3]]);
});

test("recursive Closure zones stop at a typed bounded depth", () => {
  const evaluator = new Evaluator({
    Root: {
      name: "Root",
      type: "GeometryNodeTree",
      interface: [],
      links: [
        {
          from_node: "Closure Input",
          from_socket: "Item_0",
          to_node: "Recursive Evaluate",
          to_socket: "Closure",
        },
        {
          from_node: "Closure Input",
          from_socket: "Item_0",
          to_node: "Recursive Evaluate",
          to_socket: "Item_0",
        },
        {
          from_node: "Recursive Evaluate",
          from_socket: "Item_1",
          to_node: "Closure Output",
          to_socket: "Item_1",
        },
        {
          from_node: "Closure Output",
          from_socket: "Closure",
          to_node: "Initial Evaluate",
          to_socket: "Closure",
        },
        {
          from_node: "Closure Output",
          from_socket: "Closure",
          to_node: "Initial Evaluate",
          to_socket: "Item_0",
        },
        {
          from_node: "Initial Evaluate",
          from_socket: "Item_1",
          to_node: "Group Output",
          to_socket: "Value",
        },
      ],
      nodes: [
        {
          name: "Closure Input",
          type: "NodeClosureInput",
          label: null,
          paired_output: "Closure Output",
          inputs: [],
          outputs: [{
            name: "Closure",
            identifier: "Item_0",
            type: "NodeSocketClosure",
          }],
        },
        {
          name: "Recursive Evaluate",
          type: "NodeEvaluateClosure",
          label: null,
          inputs: [{
            name: "Closure",
            identifier: "Closure",
            type: "NodeSocketClosure",
            linked: true,
          }, {
            name: "Closure",
            identifier: "Item_0",
            type: "NodeSocketClosure",
            linked: true,
          }],
          outputs: [{
            name: "Value",
            identifier: "Item_1",
            type: "NodeSocketFloat",
          }],
        },
        {
          name: "Closure Output",
          type: "NodeClosureOutput",
          label: null,
          inputs: [{
            name: "Value",
            identifier: "Item_1",
            type: "NodeSocketFloat",
            linked: true,
          }],
          outputs: [{
            name: "Closure",
            identifier: "Closure",
            type: "NodeSocketClosure",
          }],
        },
        {
          name: "Initial Evaluate",
          type: "NodeEvaluateClosure",
          label: null,
          inputs: [
            {
              name: "Closure",
              identifier: "Closure",
              type: "NodeSocketClosure",
              linked: true,
            },
            {
              name: "Closure",
              identifier: "Item_0",
              type: "NodeSocketClosure",
              linked: true,
            },
          ],
          outputs: [{
            name: "Value",
            identifier: "Item_1",
            type: "NodeSocketFloat",
          }],
        },
        {
          name: "Group Output",
          type: "NodeGroupOutput",
          label: null,
          inputs: [{
            name: "Value",
            identifier: "Value",
            type: "NodeSocketFloat",
            linked: true,
          }],
          outputs: [],
        },
      ],
    },
  });

  assert.throws(
    () => evaluator.evalGroup("Root", {}),
    (error: unknown) => {
      assert.ok(error instanceof ClosureRecursionLimitError, String(error));
      assert.equal(error.groupName, "Root");
      assert.equal(error.nodeName, "Closure Output");
      assert.equal(error.limit, MAX_CLOSURE_EVALUATION_DEPTH);
      return true;
    },
  );
});

test("static capabilities accept only the implemented closure and Gabor configurations", () => {
  const makeProgram = (closureLinked: boolean, dimension: string): Program => ({
    Root: {
      name: "Root",
      type: "GeometryNodeTree",
      interface: [],
      links: [],
      nodes: [
        {
          name: "Gabor",
          type: "ShaderNodeTexGabor",
          label: null,
          inputs: [],
          outputs: [],
          props: { gabor_type: dimension },
        },
        {
          name: "Evaluate Closure",
          type: "NodeEvaluateClosure",
          label: null,
          inputs: [{
            name: "Closure",
            identifier: "Closure",
            type: "NodeSocketClosure",
            linked: closureLinked,
          }],
          outputs: [],
        },
      ],
    },
  });

  const supported = analyzeProgramCapabilities(makeProgram(false, "2D"), "Root");
  assert.equal(supported.portable, true);
  assert.equal(supported.exact, true);

  const unsupported = analyzeProgramCapabilities(makeProgram(true, "4D"), "Root");
  assert.equal(unsupported.portable, false);
  assert.deepEqual(unsupported.unsupportedNodeTypes, [
    { type: "ShaderNodeTexGabor", count: 1 },
  ]);
});

test("static capabilities trace an empty closure through a nested group input", () => {
  const program: Program = {
    Root: {
      name: "Root",
      type: "GeometryNodeTree",
      interface: [],
      links: [],
      nodes: [{
        name: "Displace",
        type: "GeometryNodeGroup",
        group: "Displace",
        label: null,
        inputs: [{
          name: "Post Process",
          identifier: "ClosureSocket",
          type: "NodeSocketClosure",
          linked: false,
        }],
        outputs: [],
      }],
    },
    Unreachable: {
      name: "Unreachable",
      type: "GeometryNodeTree",
      interface: [],
      links: [{
        from_node: "Closure Producer",
        from_socket: "Closure",
        to_node: "Displace Linked",
        to_socket: "ClosureSocket",
      }],
      nodes: [
        {
          name: "Closure Producer",
          type: "FutureClosureNode",
          label: null,
          inputs: [],
          outputs: [],
        },
        {
          name: "Displace Linked",
          type: "GeometryNodeGroup",
          group: "Displace",
          label: null,
          inputs: [{
            name: "Post Process",
            identifier: "ClosureSocket",
            type: "NodeSocketClosure",
            linked: true,
          }],
          outputs: [],
        },
      ],
    },
    Displace: {
      name: "Displace",
      type: "GeometryNodeTree",
      interface: [],
      links: [{
        from_node: "Group Input",
        from_socket: "ClosureSocket",
        to_node: "Evaluate Closure",
        to_socket: "Closure",
      }],
      nodes: [
        {
          name: "Group Input",
          type: "NodeGroupInput",
          label: null,
          inputs: [],
          outputs: [],
        },
        {
          name: "Evaluate Closure",
          type: "NodeEvaluateClosure",
          label: null,
          inputs: [{
            name: "Closure",
            identifier: "Closure",
            type: "NodeSocketClosure",
            linked: true,
          }],
          outputs: [],
        },
      ],
    },
  };

  const report = analyzeProgramCapabilities(program, "Root");
  assert.equal(report.portable, true);
  assert.ok(report.nodeTypes.some((entry) =>
    entry.type === "NodeEvaluateClosure" && entry.support === "handler"));
});
