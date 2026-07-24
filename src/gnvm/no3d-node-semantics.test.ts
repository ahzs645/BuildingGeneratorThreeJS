import assert from "node:assert/strict";
import test from "node:test";
import { analyzeProgramCapabilities } from "./capabilities";
import { Field, type FieldCtx } from "./core";
import { Geometry, Mesh } from "./geometry";
import { DUMP_CONTEXT, REGISTRY, type EvalAPI, type RawNode } from "./registry";
import "./index";

const fieldApi = (
  type: string,
  fields: Record<string, Field>,
  props: Record<string, unknown> = {},
): EvalAPI => ({
  node: { name: type, type, label: null, inputs: [], outputs: [] },
  input: (name) => fields[name],
  inputs: () => [],
  geoInputs: () => [],
  geo: () => new Geometry(),
  field: (name) => fields[name] ?? Field.of(0),
  num: () => 0,
  vec: () => [0, 0, 0],
  bool: () => false,
  str: () => "",
  ref: () => null,
  prop: (name, fallback) => (props[name] ?? fallback) as never,
  resolve: () => [],
});

test("Invert Rotation preserves quaternion semantics across multiple axes", () => {
  const invert = REGISTRY.get("FunctionNodeInvertRotation");
  const rotate = REGISTRY.get("FunctionNodeRotateRotation");
  assert.ok(invert && rotate);
  const authored = Field.of([0.4, -0.5, 0.7]);
  const inverse = invert(fieldApi("FunctionNodeInvertRotation", { Rotation: authored })).Rotation as Field;
  const composed = rotate(fieldApi(
    "FunctionNodeRotateRotation",
    { Rotation: authored, "Rotate By": inverse },
    { rotation_space: "LOCAL" },
  )).Rotation as Field;
  const value = composed.value as number[];
  assert.ok(value.every((component) => Math.abs(component) < 1e-6), JSON.stringify(value));
});

test("Field Min & Max aggregates independently by group on its declared domain", () => {
  const handler = REGISTRY.get("GeometryNodeFieldMinAndMax");
  assert.ok(handler);
  const result = handler(fieldApi("GeometryNodeFieldMinAndMax", {
    Value: Field.perElem((index) => [7, -2, 5, 11][index]),
    "Group Index": Field.perElem((index) => [0, 0, 1, 1][index]),
  }, { domain: "POINT", data_type: "FLOAT" }));
  const context: FieldCtx = { size: 4, domain: "POINT" };
  assert.deepEqual((result.Min as Field).array(context), [-2, -2, 5, 5]);
  assert.deepEqual((result.Max as Field).array(context), [7, 7, 11, 11]);
});

test("Warning passes through Show while gizmos emit no renderable geometry", () => {
  const warning = REGISTRY.get("GeometryNodeWarning");
  const gizmo = REGISTRY.get("GeometryNodeGizmoLinear");
  assert.ok(warning && gizmo);
  const show = Field.of(1);
  assert.equal(warning(fieldApi("GeometryNodeWarning", { Show: show })).Show, show);
  const transform = gizmo(fieldApi("GeometryNodeGizmoLinear", {})).Transform as Geometry;
  assert.equal(transform.mesh, undefined);
  assert.equal(transform.curves.length, 0);
  assert.equal(transform.instances.length, 0);
});

test("Self Object exposes the active modifier object as a datablock reference", () => {
  const handler = REGISTRY.get("GeometryNodeSelfObject");
  assert.ok(handler);
  const previous = DUMP_CONTEXT.activeObject;
  DUMP_CONTEXT.activeObject = { name: "Bolt Gen v5.3 Object", type: "MESH" };
  try {
    assert.deepEqual(handler(fieldApi("GeometryNodeSelfObject", {}))["Self Object"], {
      datablock: "Object",
      name: "Bolt Gen v5.3 Object",
    });
  } finally {
    DUMP_CONTEXT.activeObject = previous;
  }
});

test("linear and dial gizmos are reported as editor-only capabilities", () => {
  const node = (name: string, type: string): RawNode => ({
    name,
    type,
    label: null,
    inputs: [],
    outputs: [],
  });
  const report = analyzeProgramCapabilities({
    Root: {
      name: "Root",
      type: "GeometryNodeTree",
      nodes: [node("Linear", "GeometryNodeGizmoLinear"), node("Dial", "GeometryNodeGizmoDial")],
      links: [],
      interface: [],
    },
  }, "Root", REGISTRY);
  assert.equal(report.portable, true);
  assert.deepEqual(report.nodeTypes.map(({ type, support }) => ({ type, support })), [
    { type: "GeometryNodeGizmoDial", support: "editor-only" },
    { type: "GeometryNodeGizmoLinear", support: "editor-only" },
  ]);
});

test("Remove Attribute handles exact and wildcard names without mutating its input", () => {
  const handler = REGISTRY.get("GeometryNodeRemoveAttribute");
  assert.ok(handler);
  const source = new Geometry();
  source.mesh = new Mesh();
  source.mesh.positions = [[0, 0, 0]];
  source.mesh.attributes.set("temp_a", { domain: "POINT", data: [1] });
  source.mesh.attributes.set("keep", { domain: "POINT", data: [2] });
  source.curves = [{ cyclic: false, points: [[0, 0, 0]] }];
  source.curveAttributes.set("temp_curve", { domain: "POINT", data: [3] });

  const result = handler({
    ...fieldApi("GeometryNodeRemoveAttribute", {}),
    geo: () => source,
    str: (name: string) => name === "Name" ? "temp_*" : name === "Pattern Mode" ? "Wildcard" : "",
  }).Geometry as Geometry;

  assert.deepEqual([...result.mesh!.attributes.keys()], ["keep"]);
  assert.deepEqual([...result.curveAttributes.keys()], []);
  assert.deepEqual([...source.mesh.attributes.keys()], ["temp_a", "keep"]);
  assert.deepEqual([...source.curveAttributes.keys()], ["temp_curve"]);
});

test("Set Point Radius updates selected point-cloud points and preserves shared payloads", () => {
  const handler = REGISTRY.get("GeometryNodeSetPointRadius");
  assert.ok(handler);
  const points = new Geometry();
  points.mesh = new Mesh();
  points.mesh.positions = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
  points.mesh.attributes.set("__gnvm_point_cloud", { domain: "POINT", data: [1, 1, 1] });
  points.mesh.attributes.set("radius", { domain: "POINT", data: [0.1, 0.2, 0.3] });
  const source = new Geometry();
  source.instances = [0, 1].map((x) => ({
    geometry: points,
    position: [x, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  }));

  const result = handler({
    ...fieldApi("GeometryNodeSetPointRadius", {}),
    geo: () => source,
    field: (name: string) => name === "Selection"
      ? Field.perElem((index) => index === 1 ? 0 : 1)
      : Field.perElem((index) => index + 1),
  }).Points as Geometry;

  assert.equal(result.instances[0].geometry, result.instances[1].geometry);
  assert.deepEqual(result.instances[0].geometry.mesh!.attributes.get("radius")?.data, [1, 0.2, 3]);
  assert.deepEqual(points.mesh.attributes.get("radius")?.data, [0.1, 0.2, 0.3]);
});
