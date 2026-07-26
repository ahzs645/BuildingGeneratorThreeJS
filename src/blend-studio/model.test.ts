import assert from "node:assert/strict";
import test from "node:test";
import type { Dump } from "../gnvm";
import {
  aggregateCapabilityReportForBlendStudioTarget,
  autoEvaluationPolicyForBlendStudioTarget,
  compatibilityForBlendStudioTarget,
  connectedGeometryInputsForBlendStudioTarget,
  controlsForBlendStudioTarget,
  datablockControlsForBlendStudioTarget,
  discoverBlendStudioTargets,
  seedableObjectNames,
  summarizeBlendStudioRuntimeDetails,
} from "./model";

const socket = (name: string, identifier: string, inOut: "INPUT" | "OUTPUT", socketType: string, extra = {}) => ({
  name,
  identifier,
  item_type: "SOCKET",
  in_out: inOut,
  socket_type: socketType,
  ...extra,
});

function fixture(): Dump {
  return {
    objects: [
      {
        name: "Generator",
        mesh: { verts: [[0, 0, 0]], faces: [] },
        modifiers: [{
          type: "NODES",
          node_group: "Assigned",
          input_values: { Count: 4, Socket_2: .25 },
        }],
      },
      { name: "Curve Seed", curves: [{ points: [[0, 0, 0], [1, 0, 0]], cyclic: false }] },
    ],
    node_groups: {
      Assigned: {
        name: "Assigned",
        type: "GeometryNodeTree",
        interface: [
          socket("Geometry", "Socket_0", "OUTPUT", "NodeSocketGeometry"),
          socket("Count", "Socket_1", "INPUT", "NodeSocketInt", { default: 2, min_value: 1, max_value: 12 }),
          socket("Scale", "Socket_2", "INPUT", "NodeSocketFloatFactor", { default: .5 }),
        ],
        nodes: [
          { name: "Input", type: "NodeGroupInput", label: null, inputs: [], outputs: [] },
          { name: "Output", type: "NodeGroupOutput", label: null, inputs: [], outputs: [] },
        ],
        links: [],
      },
      "Asset Root": {
        name: "Asset Root",
        type: "GeometryNodeTree",
        interface: [
          socket("Geometry", "Socket_0", "OUTPUT", "NodeSocketGeometry"),
          socket("Input", "Socket_1", "INPUT", "NodeSocketGeometry"),
        ],
        nodes: [
          { name: "Nested", type: "GeometryNodeGroup", group: "Helper", label: null, inputs: [], outputs: [] },
        ],
        links: [],
      },
      Helper: {
        name: "Helper",
        type: "GeometryNodeTree",
        interface: [socket("Geometry", "Socket_0", "OUTPUT", "NodeSocketGeometry")],
        nodes: [],
        links: [],
      },
    },
  };
}

test("discovers every modifier and only unassigned top-level reusable groups", () => {
  const targets = discoverBlendStudioTargets(fixture());
  assert.deepEqual(targets.map(({ kind, label }) => [kind, label]), [
    ["object", "Generator"],
    ["group", "Asset Root"],
  ]);
});

test("builds numeric and boolean controls with identifier-first saved values", () => {
  const dump = fixture();
  const target = discoverBlendStudioTargets(dump)[0];
  const controls = controlsForBlendStudioTarget(dump, target);
  assert.deepEqual(controls.map(({ name, value, min, max, step }) => ({ name, value, min, max, step })), [
    { name: "Count", value: 4, min: 1, max: 12, step: 1 },
    { name: "Scale", value: .25, min: 0, max: 1, step: .001 },
  ]);
});

test("builds typed datablock controls from portable dump dependencies", () => {
  const dump = fixture();
  dump.materials = {
    Chrome: {
      name: "Chrome",
      type: "ShaderNodeTree",
      interface: [],
      nodes: [],
      links: [],
    },
  };
  dump.node_groups.Assigned.interface.push(
    socket("Target", "Socket_Object", "INPUT", "NodeSocketObject", { default: null }),
    socket("Surface", "Socket_Material", "INPUT", "NodeSocketMaterial", {
      default: { datablock: "Material", name: "Chrome" },
    }),
  );
  const target = discoverBlendStudioTargets(dump)[0];
  assert.deepEqual(datablockControlsForBlendStudioTarget(dump, target), [
    {
      identifier: "Socket_Object",
      name: "Target",
      socketType: "NodeSocketObject",
      datablock: "Object",
      value: null,
      options: ["Curve Seed", "Generator"],
    },
    {
      identifier: "Socket_Material",
      name: "Surface",
      socketType: "NodeSocketMaterial",
      datablock: "Material",
      value: { datablock: "Material", name: "Chrome" },
      options: ["Chrome"],
    },
  ]);
});

test("reports reachable support and seedable extracted objects", () => {
  const dump = fixture();
  const target = discoverBlendStudioTargets(dump)[0];
  const compatibility = compatibilityForBlendStudioTarget(dump, target);
  assert.equal(compatibility.score, 100);
  assert.deepEqual(seedableObjectNames(dump), ["Curve Seed", "Generator"]);
});

test("only offers geometry inputs that the root graph actually consumes", () => {
  const dump = fixture();
  const target = discoverBlendStudioTargets(dump).find((candidate) => candidate.kind === "group")!;
  const group = dump.node_groups[target.groupName];
  group.nodes.push({
    name: "Input",
    type: "NodeGroupInput",
    label: null,
    inputs: [],
    outputs: [{ name: "Input", identifier: "Socket_1", type: "NodeSocketGeometry" }],
  });
  assert.deepEqual(connectedGeometryInputsForBlendStudioTarget(dump, target), []);
  group.links.push({
    from_node: "Input",
    from_socket: "Socket_1",
    to_node: "Nested",
    to_socket: "Geometry",
  });
  assert.deepEqual(
    connectedGeometryInputsForBlendStudioTarget(dump, target).map((item) => item.identifier),
    ["Socket_1"],
  );
});

test("surfaces bounded node implementations without treating them as unsupported", () => {
  const dump = fixture();
  const target = discoverBlendStudioTargets(dump)[0];
  dump.node_groups.Assigned.nodes.push({
    name: "UV Unwrap",
    type: "GeometryNodeUVUnwrap",
    label: null,
    inputs: [],
    outputs: [],
  });
  const compatibility = compatibilityForBlendStudioTarget(dump, target);
  assert.equal(compatibility.score, 100);
  assert.deepEqual(compatibility.report.unsupportedNodeTypes, []);
  assert.deepEqual(compatibility.gaps, [
    "Bounded approximation · GeometryNodeUVUnwrap ×1",
  ]);
  assert.deepEqual(autoEvaluationPolicyForBlendStudioTarget(dump, target), {
    enabled: true,
    reason: "Live evaluation enabled with reported bounded approximations",
  });
});

test("requires explicit preview when a target closure contains unsupported nodes", () => {
  const dump = fixture();
  const target = discoverBlendStudioTargets(dump)[0];
  dump.node_groups.Assigned.nodes.push({
    name: "Future Node",
    type: "GeometryNodeFutureUnsupported",
    label: null,
    inputs: [],
    outputs: [],
  });
  assert.deepEqual(autoEvaluationPolicyForBlendStudioTarget(dump, target), {
    enabled: false,
    reason: "1 unsupported node type requires explicit preview",
  });
});

test("requires explicit preview for resource-bounded volume grids", () => {
  const dump = fixture();
  const target = discoverBlendStudioTargets(dump)[0];
  dump.node_groups.Assigned.nodes.push({
    name: "Mesh to SDF",
    type: "GeometryNodeMeshToSDFGrid",
    label: null,
    inputs: [],
    outputs: [],
  });
  assert.deepEqual(autoEvaluationPolicyForBlendStudioTarget(dump, target), {
    enabled: false,
    reason: "Volume-grid approximations require explicit preview because evaluation cost depends on voxel density",
  });
});

test("summarizes executed volume budget and adaptivity warnings independently of static coverage", () => {
  assert.deepEqual(summarizeBlendStudioRuntimeDetails([
    {
      kind: "volume-grid-budget",
      severity: "warning",
      stage: "mesh-to-sdf-grid",
      message: "resampled",
      adjusted: true,
      requestedSpacing: .01,
      effectiveSpacing: [.02, .02, .02],
      requestedSampleCount: 8_000_000,
      effectiveSampleCount: 1_000_000,
      sampleBudget: 1_000_000,
    },
    {
      kind: "volume-grid-budget",
      severity: "info",
      stage: "grid-to-mesh",
      message: "within budget",
      adjusted: false,
      requestedSpacing: .02,
      effectiveSpacing: [.02, .02, .02],
      requestedSampleCount: 1_000_000,
      effectiveSampleCount: 1_000_000,
      sampleBudget: 1_000_000,
    },
    {
      kind: "bounded-grid-adaptivity",
      severity: "warning",
      stage: "grid-to-mesh",
      message: "bounded",
      requestedAdaptivity: .5,
      implementation: "dense-surface-net-decimation",
    },
  ]), {
    warningCount: 2,
    budgetAdjustedCount: 1,
    boundedAdaptivityCount: 1,
  });
});

test("requires explicit preview for Volume Cube and Volume to Mesh", () => {
  for (const type of ["GeometryNodeVolumeCube", "GeometryNodeVolumeToMesh"]) {
    const dump = fixture();
    const target = discoverBlendStudioTargets(dump)[0];
    dump.node_groups.Assigned.nodes.push({
      name: type,
      type,
      label: null,
      inputs: [],
      outputs: [],
    });
    assert.deepEqual(autoEvaluationPolicyForBlendStudioTarget(dump, target), {
      enabled: false,
      reason: "Volume-grid approximations require explicit preview because evaluation cost depends on voxel density",
    });
  }
});

test("requires explicit preview for very large exact closures", () => {
  const dump = fixture();
  const group = dump.node_groups.Assigned;
  group.nodes.push(...Array.from({ length: 501 }, (_, index) => ({
    name: `Math ${index}`,
    type: "ShaderNodeMath",
    inputs: [],
    outputs: [],
    props: { operation: "ADD" },
  })));
  const [target] = discoverBlendStudioTargets(dump);
  assert.deepEqual(autoEvaluationPolicyForBlendStudioTarget(dump, target), {
    enabled: false,
    reason: "This 503-node closure requires explicit preview to stay inside the live-edit budget",
  });
});

test("aggregates unsupported nodes from earlier executed Geometry Nodes modifiers", () => {
  const dump = fixture();
  dump.node_groups.Earlier = {
    name: "Earlier",
    type: "GeometryNodeTree",
    interface: [socket("Geometry", "Socket_0", "OUTPUT", "NodeSocketGeometry")],
    nodes: [{
      name: "Unsupported",
      type: "GeometryNodeFutureUnsupported",
      label: null,
      inputs: [],
      outputs: [],
    }],
    links: [],
  };
  dump.objects![0].modifiers = [
    { type: "NODES", node_group: "Earlier" },
    { type: "NODES", node_group: "Assigned" },
  ];
  const target = discoverBlendStudioTargets(dump)
    .find((candidate) => candidate.kind === "object" && candidate.modifierIndex === 1)!;
  const compatibility = compatibilityForBlendStudioTarget(dump, target);
  assert.deepEqual(compatibility.report.unsupportedNodeTypes, [
    { type: "GeometryNodeFutureUnsupported", count: 1 },
  ]);
  assert.deepEqual(autoEvaluationPolicyForBlendStudioTarget(dump, target), {
    enabled: false,
    reason: "1 unsupported node type requires explicit preview",
  });
});

test("requires explicit preview when an earlier modifier group is missing", () => {
  const dump = fixture();
  dump.objects![0].modifiers = [
    { type: "NODES", node_group: "Missing Earlier" },
    { type: "NODES", node_group: "Assigned" },
  ];
  const target = discoverBlendStudioTargets(dump)
    .find((candidate) => candidate.kind === "object" && candidate.modifierIndex === 1)!;
  assert.deepEqual(autoEvaluationPolicyForBlendStudioTarget(dump, target), {
    enabled: false,
    reason: "1 referenced group is missing",
  });
  assert.match(compatibilityForBlendStudioTarget(dump, target).gaps.join("\n"), /Missing Earlier/);
});

test("requires explicit preview for resource-heavy approximations in an earlier modifier", () => {
  const dump = fixture();
  dump.node_groups.Earlier = {
    name: "Earlier",
    type: "GeometryNodeTree",
    interface: [socket("Geometry", "Socket_0", "OUTPUT", "NodeSocketGeometry")],
    nodes: [{
      name: "Mesh to SDF",
      type: "GeometryNodeMeshToSDFGrid",
      label: null,
      inputs: [],
      outputs: [],
    }],
    links: [],
  };
  dump.objects![0].modifiers = [
    { type: "NODES", node_group: "Earlier" },
    { type: "NODES", node_group: "Assigned" },
  ];
  const target = discoverBlendStudioTargets(dump)
    .find((candidate) => candidate.kind === "object" && candidate.modifierIndex === 1)!;
  assert.deepEqual(autoEvaluationPolicyForBlendStudioTarget(dump, target), {
    enabled: false,
    reason: "Volume-grid approximations require explicit preview because evaluation cost depends on voxel density",
  });
});

test("blocks live evaluation when a non-portable Blender modifier precedes the target", () => {
  const dump = fixture();
  dump.objects![0].modifiers = [
    { type: "BEVEL", name: "Bevel" },
    { type: "NODES", node_group: "Assigned" },
  ];
  const target = discoverBlendStudioTargets(dump)
    .find((candidate) => candidate.kind === "object" && candidate.modifierIndex === 1)!;
  assert.deepEqual(autoEvaluationPolicyForBlendStudioTarget(dump, target), {
    enabled: false,
    reason: "1 preceding Blender modifier is not portable; target-aware extraction is required",
  });
  assert.match(compatibilityForBlendStudioTarget(dump, target).gaps.join("\n"), /BEVEL/);
});

test("allows only the captured exact pre-nodes Hook subset", () => {
  const dump = fixture();
  const identity = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  dump.objects!.push({
    name: "Hook Target",
    matrix_world: identity,
    modifiers: [],
  });
  dump.objects![0].matrix_world = identity;
  dump.objects![0].modifiers = [
    {
      type: "HOOK",
      name: "Hook",
      object: "Hook Target",
      vertex_indices: [0],
      matrix_inverse: identity,
      strength: .5,
      falloff_type: "NONE",
      vertex_group: "",
    },
    { type: "NODES", node_group: "Assigned" },
  ];
  const target = discoverBlendStudioTargets(dump)
    .find((candidate) => candidate.kind === "object" && candidate.modifierIndex === 1)!;
  assert.deepEqual(autoEvaluationPolicyForBlendStudioTarget(dump, target), {
    enabled: true,
    reason: "Live evaluation enabled for this portable closure",
  });

  dump.objects![0].modifiers![0].falloff_type = "SMOOTH";
  assert.match(
    autoEvaluationPolicyForBlendStudioTarget(dump, target).reason,
    /Hook.*not portable|modifier is not portable/,
  );

  dump.objects![0].modifiers![0].falloff_type = "NONE";
  dump.objects![0].modifiers![0].vertex_group = "Pinned";
  assert.equal(autoEvaluationPolicyForBlendStudioTarget(dump, target).enabled, false);
});

test("treats a disabled pre-nodes Hook as an exact no-op", () => {
  const dump = fixture();
  dump.objects![0].modifiers = [
    {
      type: "HOOK",
      name: "Disabled Hook",
      object: "Missing Hook Target",
      show_viewport: false,
      falloff_type: "SMOOTH",
    },
    { type: "NODES", node_group: "Assigned" },
  ];
  const target = discoverBlendStudioTargets(dump)
    .find((candidate) => candidate.kind === "object" && candidate.modifierIndex === 1)!;
  assert.equal(autoEvaluationPolicyForBlendStudioTarget(dump, target).enabled, true);
});

test("aggregate target compatibility rejects a non-GN modifier between GN stages", () => {
  const dump = fixture();
  dump.node_groups.Earlier = {
    name: "Earlier",
    type: "GeometryNodeTree",
    interface: [socket("Geometry", "Socket_0", "OUTPUT", "NodeSocketGeometry")],
    nodes: [],
    links: [],
  };
  dump.objects![0].modifiers = [
    { type: "NODES", node_group: "Earlier" },
    { type: "BEVEL", name: "Intervening Bevel" },
    { type: "NODES", node_group: "Assigned" },
  ];
  const target = discoverBlendStudioTargets(dump)
    .find((candidate) => candidate.kind === "object" && candidate.modifierIndex === 2)!;
  const report = aggregateCapabilityReportForBlendStudioTarget(dump, target);

  assert.equal(report.portable, false);
  assert.equal(report.exact, false);
  assert.deepEqual(report.unsupportedNodeTypes, []);
  assert.match(
    compatibilityForBlendStudioTarget(dump, target).gaps.join("\n"),
    /BEVEL between Geometry Nodes modifiers/,
  );
});
