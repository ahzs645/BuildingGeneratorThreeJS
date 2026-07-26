import assert from "node:assert/strict";
import test from "node:test";
import type { Dump } from "../gnvm";
import {
  authoredValueFromMeasurementDistance,
  interpretMeasurementDisplay,
  linearMeasurementContractForBlendStudioTarget,
  measurementDistanceForDisplay,
  measurementDistanceFromDisplay,
  measurementDistanceFromAuthoredValue,
  measurementDistanceRange,
} from "./measurement";

function caliperLikeDump(): Dump {
  return {
    blender_version: "5.1.2",
    objects: [],
    node_groups: {
      Controller: {
        name: "Controller",
        type: "GeometryNodeTree",
        interface: [
          {
            name: "Geometry",
            item_type: "SOCKET",
            identifier: "Geometry",
            in_out: "OUTPUT",
            socket_type: "NodeSocketGeometry",
          },
          {
            name: "Install Battery",
            item_type: "SOCKET",
            identifier: "Battery",
            in_out: "INPUT",
            socket_type: "NodeSocketFloat",
            min_value: 0,
            max_value: 1,
          },
          {
            name: "measure",
            item_type: "SOCKET",
            identifier: "Measure",
            in_out: "INPUT",
            socket_type: "NodeSocketFloat",
            min_value: -1_000,
            max_value: 0,
          },
        ],
        nodes: [
          {
            name: "Group Input",
            type: "NodeGroupInput",
            inputs: [],
            outputs: [],
          },
          {
            name: "Negate",
            type: "ShaderNodeMath",
            props: { operation: "MULTIPLY" },
            inputs: [
              { name: "Value", identifier: "Value", value: null },
              { name: "Value", identifier: "Value_001", value: -1 },
            ],
            outputs: [],
          },
          {
            name: "Position",
            type: "ShaderNodeCombineXYZ",
            inputs: [
              { name: "X", identifier: "X", value: null },
              { name: "Y", identifier: "Y", value: 0 },
              { name: "Z", identifier: "Z", value: 0 },
            ],
            outputs: [],
          },
          {
            name: "Linear Gizmo",
            type: "GeometryNodeGizmoLinear",
            inputs: [
              { name: "Value", identifier: "Value", value: null },
              { name: "Position", identifier: "Position", value: null },
              { name: "Direction", identifier: "Direction", value: [-1, 0, 0] },
            ],
            outputs: [],
          },
          {
            name: "Unit",
            type: "GeometryNodeStringToCurves",
            inputs: [{ name: "String", identifier: "String", value: "mm" }],
            outputs: [],
          },
        ],
        links: [
          {
            from_node: "Group Input",
            from_socket: "Measure",
            to_node: "Negate",
            to_socket: "Value",
            from_type: "NodeSocketFloat",
            to_type: "NodeSocketFloat",
          },
          {
            from_node: "Negate",
            from_socket: "Value",
            to_node: "Linear Gizmo",
            to_socket: "Value",
            from_type: "NodeSocketFloat",
            to_type: "NodeSocketFloat",
          },
          {
            from_node: "Group Input",
            from_socket: "Measure",
            to_node: "Position",
            to_socket: "X",
            from_type: "NodeSocketFloat",
            to_type: "NodeSocketFloat",
          },
          {
            from_node: "Position",
            from_socket: "Vector",
            to_node: "Linear Gizmo",
            to_socket: "Position",
            from_type: "NodeSocketVector",
            to_type: "NodeSocketVector",
          },
        ],
      },
    },
  } as Dump;
}

test("detects a Linear Gizmo measurement without relying on asset names", () => {
  const contract = linearMeasurementContractForBlendStudioTarget(
    caliperLikeDump(),
    "Controller",
  );
  assert.deepEqual(contract, {
    groupName: "Controller",
    gizmoNodeName: "Linear Gizmo",
    inputIdentifier: "Measure",
    inputName: "measure",
    authoredMin: -1_000,
    authoredMax: 0,
    displayScale: -1,
    positionAxis: [1, 0, 0],
    positionScale: 1,
    direction: [-1, 0, 0],
    unitHint: "mm",
    batteryInputIdentifier: "Battery",
  });
  assert.deepEqual(measurementDistanceRange(contract!), [0, 1_000]);
  assert.equal(measurementDistanceFromAuthoredValue(contract!, -25.4), 25.4);
  assert.equal(authoredValueFromMeasurementDistance(contract!, 25.4), -25.4);
  assert.equal(authoredValueFromMeasurementDistance(contract!, 2_000), -1_000);
  assert.equal(measurementDistanceForDisplay(25.4, "in"), 1);
  assert.equal(measurementDistanceFromDisplay(1, "in"), 25.4);
});

test("does not infer a measurement contract without a traceable position", () => {
  const dump = caliperLikeDump();
  dump.node_groups.Controller.links = dump.node_groups.Controller.links.filter(
    (link) => link.to_node !== "Position",
  );
  assert.equal(
    linearMeasurementContractForBlendStudioTarget(dump, "Controller"),
    null,
  );
});

test("adds reversible zero and unit nodes to a detected LCD branch", () => {
  const dump = caliperLikeDump();
  const group = dump.node_groups.Controller;
  group.nodes.push(
    {
      name: "Display Absolute",
      type: "ShaderNodeMath",
      props: { operation: "ABSOLUTE" },
      inputs: [{ name: "Value", identifier: "Value", value: null }],
      outputs: [{ name: "Value", identifier: "Value", default: 0 }],
    },
    {
      name: "Value to String",
      type: "FunctionNodeValueToString",
      inputs: [
        { name: "Value", identifier: "Value", value: null },
        { name: "Decimals", identifier: "Decimals", value: 3 },
      ],
      outputs: [{ name: "String", identifier: "String", default: "" }],
    },
    {
      name: "Numeric Text",
      type: "GeometryNodeStringToCurves",
      inputs: [
        { name: "String", identifier: "String", value: null },
        { name: "Font", identifier: "Font", value: undefined },
      ],
      outputs: [{ name: "Curve Instances", identifier: "Curve Instances" }],
    },
  );
  group.links.push(
    {
      from_node: "Group Input",
      from_socket: "Measure",
      to_node: "Display Absolute",
      to_socket: "Value",
    },
    {
      from_node: "Display Absolute",
      from_socket: "Value",
      to_node: "Value to String",
      to_socket: "Value",
    },
    {
      from_node: "Value to String",
      from_socket: "String",
      to_node: "Numeric Text",
      to_socket: "String",
    },
  );
  const contract = linearMeasurementContractForBlendStudioTarget(dump, "Controller");
  assert.deepEqual(contract?.display, {
    absoluteNodeName: "Display Absolute",
    valueToStringNodeName: "Value to String",
    numericTextNodeName: "Numeric Text",
    unitTextNodeName: "Unit",
  });

  const interpreted = interpretMeasurementDisplay(dump, contract!, {
    zeroOffsetMm: 12.7,
    unit: "in",
  });
  assert.notEqual(interpreted, dump);
  assert.equal(group.nodes.some((node) => node.name.startsWith("__BlendStudio")), false);
  const interpretedGroup = interpreted.node_groups.Controller;
  const zero = interpretedGroup.nodes.find((node) =>
    node.name === "__BlendStudio LCD Zero Offset");
  const scale = interpretedGroup.nodes.find((node) =>
    node.name === "__BlendStudio LCD Unit Scale");
  assert.equal(zero?.props?.operation, "SUBTRACT");
  assert.equal(zero?.inputs.find((input) => input.identifier === "Value_001")?.value, 12.7);
  assert.equal(scale?.props?.operation, "MULTIPLY");
  assert.equal(
    scale?.inputs.find((input) => input.identifier === "Value_001")?.value,
    1 / 25.4,
  );
  assert.equal(
    interpretedGroup.nodes.find((node) => node.name === "Unit")
      ?.inputs.find((input) => input.name === "String")?.value,
    "in",
  );
  assert.equal(
    interpretedGroup.nodes.find((node) => node.name === "Value to String")
      ?.inputs.find((input) => input.name === "Decimals")?.value,
    3,
  );
  assert.equal(
    interpretedGroup.links.some((link) =>
      link.from_node === "__BlendStudio LCD Unit Scale"
      && link.to_node === "Value to String"),
    true,
  );
  assert.deepEqual(
    (interpreted.studio_interpretation as { extensions: unknown[] }).extensions.length,
    1,
  );

  (interpreted.studio_interpretation as { extensions: unknown[] }).extensions.unshift({
    id: "unrelated-extension",
  });
  const interpretedContract = linearMeasurementContractForBlendStudioTarget(
    interpreted,
    "Controller",
  );
  assert.deepEqual(interpretedContract?.display, contract?.display);
  const reinterpreted = interpretMeasurementDisplay(interpreted, interpretedContract!, {
    zeroOffsetMm: 25.4,
    unit: "mm",
  });
  const reinterpretedGroup = reinterpreted.node_groups.Controller;
  assert.equal(
    reinterpretedGroup.nodes.filter((node) =>
      node.name.startsWith("__BlendStudio LCD")).length,
    2,
  );
  assert.equal(
    reinterpretedGroup.nodes.find((node) =>
      node.name === "__BlendStudio LCD Zero Offset")
      ?.inputs.find((input) => input.identifier === "Value_001")?.value,
    25.4,
  );
  assert.equal(
    (reinterpreted.studio_interpretation as { extensions: Array<{ id: string }> })
      .extensions.some((extension) => extension.id === "unrelated-extension"),
    true,
  );
});
