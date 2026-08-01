import assert from "node:assert/strict";
import test from "node:test";
import type { Dump } from "../gnvm";
import {
  aggregateCapabilityReportForBlendStudioTarget,
  autoEvaluationPolicyForBlendStudioTarget,
  BLEND_STUDIO_EVALUATION_HISTORY_MAX_ENTRIES,
  blendStudioEvaluationHistoryKey,
  blendStudioEvaluationRunsForKey,
  compatibilityForBlendStudioTarget,
  connectedGeometryInputsForBlendStudioTarget,
  controlsForBlendStudioTarget,
  datablockControlsForBlendStudioTarget,
  discoverBlendStudioTargets,
  progressivePreviewContractForBlendStudioTarget,
  recordBlendStudioEvaluationRun,
  seedableObjectNames,
  summarizeBlendStudioRuntimeDetails,
  touchBlendStudioEvaluationHistory,
  type BlendStudioEvaluationRunOutcome,
  type BlendStudioEvaluationRunRecord,
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
      panelPath: [],
      hiddenInModifier: false,
    },
    {
      identifier: "Socket_Material",
      name: "Surface",
      socketType: "NodeSocketMaterial",
      datablock: "Material",
      value: { datablock: "Material", name: "Chrome" },
      options: ["Chrome"],
      panelPath: [],
      hiddenInModifier: false,
    },
  ]);
});

test("preserves nested modifier panels and exposes editable modeled text", () => {
  const dump = fixture();
  dump.node_groups.Assigned.interface.push(
    {
      name: "Display",
      identifier: "Panel_Display",
      item_type: "PANEL",
    },
    {
      name: "Typography",
      identifier: "Panel_Typography",
      parent_identifier: "Panel_Display",
      item_type: "PANEL",
      default_closed: true,
    },
    socket("Label", "Socket_Label", "INPUT", "NodeSocketString", {
      default: "READY",
      parent_identifier: "Panel_Typography",
      hide_in_modifier: true,
    }),
  );
  const controls = controlsForBlendStudioTarget(
    dump,
    discoverBlendStudioTargets(dump)[0],
  );
  const label = controls.find((control) => control.identifier === "Socket_Label");
  assert.deepEqual(label, {
    identifier: "Socket_Label",
    name: "Label",
    socketType: "NodeSocketString",
    value: "READY",
    min: 0,
    max: 1,
    step: .001,
    panelPath: ["Display", "Typography"],
    hiddenInModifier: true,
    hideValue: false,
  });
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

test("surfaces runtime-conditional node implementations without treating them as unsupported", () => {
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
    "Runtime-conditional · GeometryNodeUVUnwrap ×1",
  ]);
  assert.deepEqual(autoEvaluationPolicyForBlendStudioTarget(dump, target), {
    enabled: true,
    reason: "Live evaluation enabled; evaluated inputs determine exact versus bounded execution",
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

test("requires explicit preview for very large unmeasured closures", () => {
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
    reason: "This 503-node closure requires explicit preview until a measured run proves it fits the live-edit budget",
  });
});

const measuredRun = (
  seconds: number,
  outcome: BlendStudioEvaluationRunOutcome = "ready",
  at = 0,
): BlendStudioEvaluationRunRecord => ({ seconds, outcome, at });

function largeFixture(): Dump {
  const dump = fixture();
  dump.node_groups.Assigned.nodes.push(...Array.from({ length: 501 }, (_, index) => ({
    name: `Math ${index}`,
    type: "ShaderNodeMath",
    inputs: [],
    outputs: [],
    props: { operation: "ADD" },
  })));
  return dump;
}

test("static gates still win over a measured-fast history", () => {
  const dump = fixture();
  const target = discoverBlendStudioTargets(dump)[0];
  dump.node_groups.Assigned.nodes.push({
    name: "Future Node",
    type: "GeometryNodeFutureUnsupported",
    label: null,
    inputs: [],
    outputs: [],
  });
  assert.deepEqual(
    autoEvaluationPolicyForBlendStudioTarget(dump, target, [measuredRun(.4)]),
    {
      enabled: false,
      reason: "1 unsupported node type requires explicit preview",
    },
  );
});

test("an empty measured history keeps the small-closure live default", () => {
  const dump = fixture();
  const target = discoverBlendStudioTargets(dump)[0];
  assert.deepEqual(autoEvaluationPolicyForBlendStudioTarget(dump, target, []), {
    enabled: true,
    reason: "Live evaluation enabled for this portable closure",
  });
});

test("a measured fast run enables live evaluation for a large closure", () => {
  const dump = largeFixture();
  const [target] = discoverBlendStudioTargets(dump);
  assert.deepEqual(
    autoEvaluationPolicyForBlendStudioTarget(dump, target, [measuredRun(1.4)]),
    {
      enabled: true,
      reason: "Live evaluation enabled · last run took 1.4 s",
    },
  );
});

test("a measured slow run disables live evaluation with the duration in the reason", () => {
  const dump = fixture();
  const target = discoverBlendStudioTargets(dump)[0];
  assert.deepEqual(
    autoEvaluationPolicyForBlendStudioTarget(dump, target, [measuredRun(86.3)]),
    {
      enabled: false,
      reason: "Last evaluation took 86.3 s, above the 4 s live-edit budget",
    },
  );
});

test("the 2-4 s hysteresis band keeps the previous decision without flapping", () => {
  const small = fixture();
  const smallTarget = discoverBlendStudioTargets(small)[0];
  assert.deepEqual(
    autoEvaluationPolicyForBlendStudioTarget(small, smallTarget, [
      measuredRun(5),
      measuredRun(3),
    ]),
    {
      enabled: false,
      reason: "Last evaluation took 3.0 s; a run at or under 2 s re-enables live evaluation",
    },
  );

  const large = largeFixture();
  const [largeTarget] = discoverBlendStudioTargets(large);
  assert.deepEqual(
    autoEvaluationPolicyForBlendStudioTarget(large, largeTarget, [
      measuredRun(1.2),
      measuredRun(3),
    ]),
    {
      enabled: true,
      reason: "Live evaluation enabled · last run took 3.0 s",
    },
  );
});

test("a timed-out or failed run counts as slow", () => {
  const dump = fixture();
  const target = discoverBlendStudioTargets(dump)[0];
  assert.deepEqual(
    autoEvaluationPolicyForBlendStudioTarget(dump, target, [measuredRun(180, "timeout")]),
    {
      enabled: false,
      reason: "Last evaluation was stopped at the 180 second safety limit",
    },
  );
  assert.deepEqual(
    autoEvaluationPolicyForBlendStudioTarget(dump, target, [measuredRun(180, "error")]),
    {
      enabled: false,
      reason: "Last evaluation failed, which counts as over the 4 s live-edit budget",
    },
  );
  // A later fast run re-enables live evaluation after a failure.
  assert.equal(
    autoEvaluationPolicyForBlendStudioTarget(dump, target, [
      measuredRun(180, "timeout"),
      measuredRun(1.1),
    ]).enabled,
    true,
  );
});

test("evaluation history keeps the newest runs and evicts least recently used entries", () => {
  const key = blendStudioEvaluationHistoryKey("sha", "object:Generator:0:Assigned");
  let store = recordBlendStudioEvaluationRun(null, key, measuredRun(1, "ready", 1));
  store = recordBlendStudioEvaluationRun(store, key, measuredRun(2, "ready", 2));
  store = recordBlendStudioEvaluationRun(store, key, measuredRun(3, "ready", 3));
  store = recordBlendStudioEvaluationRun(store, key, measuredRun(4, "ready", 4));
  assert.deepEqual(
    blendStudioEvaluationRunsForKey(store, key).map((run) => run.seconds),
    [2, 3, 4],
  );

  for (let index = 0; index < BLEND_STUDIO_EVALUATION_HISTORY_MAX_ENTRIES; index += 1) {
    store = recordBlendStudioEvaluationRun(store, `other-${index}`, measuredRun(1, "ready", 100 + index));
  }
  assert.equal(
    Object.keys(store.entries).length,
    BLEND_STUDIO_EVALUATION_HISTORY_MAX_ENTRIES,
  );
  assert.deepEqual(blendStudioEvaluationRunsForKey(store, key), []);

  const touched = touchBlendStudioEvaluationHistory(store, "other-0", 9_999);
  assert.equal(touched?.entries["other-0"].usedAt, 9_999);
  assert.equal(touchBlendStudioEvaluationHistory(store, "absent", 1), null);
});

test("evaluation history reads sanitize malformed persisted payloads", () => {
  assert.deepEqual(blendStudioEvaluationRunsForKey(null, "key"), []);
  assert.deepEqual(blendStudioEvaluationRunsForKey("not a store", "key"), []);
  assert.deepEqual(
    blendStudioEvaluationRunsForKey({
      entries: {
        key: {
          runs: [
            { seconds: "fast", outcome: "ready", at: 1 },
            { seconds: 2.5, outcome: "unknown", at: 1 },
            { seconds: 2.5, outcome: "ready", at: "later" },
            null,
          ],
          usedAt: 5,
        },
      },
    }, "key"),
    [{ seconds: 2.5, outcome: "ready", at: 0 }],
  );
});

test("progressive preview finds a literal Resolution float and quarters its span above min", () => {
  // Bubble putty shape: NodeSocketFloat, min 0, max 1, current value 0.45.
  const dump = fixture();
  dump.node_groups.Assigned.interface.push(
    socket("Resolution", "Socket_Res", "INPUT", "NodeSocketFloat", {
      default: .5,
      min_value: 0,
      max_value: 1,
    }),
  );
  dump.objects![0].modifiers![0].input_values = { Resolution: .45 };
  const target = discoverBlendStudioTargets(dump)[0];
  const contract = progressivePreviewContractForBlendStudioTarget(dump, target);
  assert.equal(contract?.control.identifier, "Socket_Res");
  assert.equal(contract?.previewValue, .1125);
});

test("progressive preview quarters integer segments-style inputs with the socket min as floor", () => {
  const dump = fixture();
  dump.node_groups.Assigned.interface.push(
    socket("Segments", "Socket_Seg", "INPUT", "NodeSocketInt", {
      default: 24,
      min_value: 2,
      max_value: 64,
    }),
  );
  const target = discoverBlendStudioTargets(dump)[0];
  const contract = progressivePreviewContractForBlendStudioTarget(dump, target);
  assert.equal(contract?.control.identifier, "Socket_Seg");
  assert.equal(contract?.previewValue, 6);

  // A large socket min floors the preview instead of dropping below it.
  dump.node_groups.Assigned.interface = dump.node_groups.Assigned.interface
    .filter((item) => item.identifier !== "Socket_Seg");
  dump.node_groups.Assigned.interface.push(
    socket("Segments", "Socket_Seg2", "INPUT", "NodeSocketInt", {
      default: 6,
      min_value: 4,
      max_value: 64,
    }),
  );
  assert.equal(
    progressivePreviewContractForBlendStudioTarget(dump, target)?.previewValue,
    4,
  );
});

test("progressive preview only accepts exact-word resolution-class names", () => {
  // "bubble density" and "wall resolution factor" are semantic inputs and
  // must never be hijacked as fidelity dials.
  const dump = fixture();
  dump.node_groups.Assigned.interface.push(
    socket("bubble density", "Socket_Density", "INPUT", "NodeSocketInt", {
      default: 26,
      min_value: 1,
      max_value: 10_000,
    }),
    socket("wall resolution factor", "Socket_Wall", "INPUT", "NodeSocketFloat", {
      default: .8,
      min_value: 0,
      max_value: 1,
    }),
  );
  const target = discoverBlendStudioTargets(dump)[0];
  assert.equal(progressivePreviewContractForBlendStudioTarget(dump, target), null);
});

test("progressive preview returns null for degenerate ranges and already-minimal values", () => {
  const dump = fixture();
  dump.node_groups.Assigned.interface.push(
    socket("Resolution", "Socket_Res", "INPUT", "NodeSocketInt", {
      default: 5,
      min_value: 5,
      max_value: 5,
    }),
  );
  const target = discoverBlendStudioTargets(dump)[0];
  assert.equal(progressivePreviewContractForBlendStudioTarget(dump, target), null);

  // A float already sitting at the socket min offers nothing to reduce.
  dump.node_groups.Assigned.interface = dump.node_groups.Assigned.interface
    .filter((item) => item.identifier !== "Socket_Res");
  dump.node_groups.Assigned.interface.push(
    socket("Resolution", "Socket_Res2", "INPUT", "NodeSocketFloat", {
      default: .2,
      min_value: .2,
      max_value: 1,
    }),
  );
  assert.equal(progressivePreviewContractForBlendStudioTarget(dump, target), null);
});

test("progressive preview prefers the literal name Resolution among multiple matches", () => {
  const dump = fixture();
  dump.node_groups.Assigned.interface.push(
    socket("Steps", "Socket_Steps", "INPUT", "NodeSocketInt", {
      default: 32,
      min_value: 1,
      max_value: 128,
    }),
    socket("Resolution", "Socket_Res", "INPUT", "NodeSocketFloat", {
      default: .6,
      min_value: 0,
      max_value: 1,
    }),
  );
  const target = discoverBlendStudioTargets(dump)[0];
  assert.equal(
    progressivePreviewContractForBlendStudioTarget(dump, target)?.control.identifier,
    "Socket_Res",
  );
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
