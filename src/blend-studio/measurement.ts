import type { Dump, DumpInterfaceItem } from "../gnvm";

type NodeGroup = Dump["node_groups"][string];
type RawNode = NodeGroup["nodes"][number];

export type BlendStudioLinearMeasurementContract = {
  groupName: string;
  gizmoNodeName: string;
  inputIdentifier: string;
  inputName: string;
  authoredMin: number;
  authoredMax: number;
  displayScale: number;
  positionAxis: [number, number, number];
  positionScale: number;
  direction: [number, number, number];
  unitHint?: "mm";
  batteryInputIdentifier?: string;
  display?: BlendStudioMeasurementDisplayContract;
};

export type BlendStudioMeasurementUnit = "mm" | "in";

export type BlendStudioMeasurementDisplayContract = {
  absoluteNodeName: string;
  valueToStringNodeName: string;
  numericTextNodeName: string;
  unitTextNodeName: string;
};

export type BlendStudioMeasurementInterpretation = {
  zeroOffsetMm: number;
  unit: BlendStudioMeasurementUnit;
};

type ScalarSource = {
  inputIdentifier: string;
  scale: number;
};

function finite(value: unknown, fallback: number): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function nodeByName(group: NodeGroup, name: string): RawNode | undefined {
  return group.nodes.find((node) => node.name === name);
}

function incomingLink(
  group: NodeGroup,
  nodeName: string,
  socketName: string,
) {
  return group.links.find((link) =>
    link.to_node === nodeName && link.to_socket === socketName);
}

function outgoingLink(
  group: NodeGroup,
  nodeName: string,
  socketName: string,
) {
  return group.links.find((link) =>
    link.from_node === nodeName && link.from_socket === socketName);
}

function inputByName(node: RawNode, name: string) {
  return node.inputs?.find((input) =>
    input.identifier === name || input.name === name);
}

function groupInputSource(
  group: NodeGroup,
  nodeName: string,
  socketName: string,
): ScalarSource | null {
  const link = incomingLink(group, nodeName, socketName);
  if (!link) return null;
  const source = nodeByName(group, link.from_node);
  if (!source) return null;
  if (source.type === "NodeGroupInput")
    return { inputIdentifier: link.from_socket, scale: 1 };
  if (
    source.type !== "ShaderNodeMath"
    || source.props?.operation !== "MULTIPLY"
  ) return null;

  const linkedInputs = group.links.filter((candidate) =>
    candidate.to_node === source.name);
  if (linkedInputs.length !== 1) return null;
  const linked = linkedInputs[0];
  const groupInput = nodeByName(group, linked.from_node);
  if (groupInput?.type !== "NodeGroupInput") return null;
  const constant = (source.inputs ?? []).find((input) =>
    input.identifier !== linked.to_socket && input.name === "Value");
  const scale = finite(constant?.value, Number.NaN);
  if (!Number.isFinite(scale) || scale === 0) return null;
  return { inputIdentifier: linked.from_socket, scale };
}

function interfaceInput(
  group: NodeGroup,
  identifier: string,
): DumpInterfaceItem | undefined {
  return group.interface.find((item) =>
    item.item_type === "SOCKET"
    && item.in_out === "INPUT"
    && item.identifier === identifier);
}

function vector3(value: unknown, fallback: [number, number, number]): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return fallback;
  const result = value.slice(0, 3).map(Number);
  return result.every(Number.isFinite)
    ? result as [number, number, number]
    : fallback;
}

function unitHint(group: NodeGroup): "mm" | undefined {
  return group.nodes.some((node) =>
    node.type === "GeometryNodeStringToCurves"
    && node.inputs?.some((input) =>
      input.name === "String"
      && typeof input.value === "string"
      && input.value.trim().toLowerCase() === "mm"))
    ? "mm"
    : undefined;
}

function displayContract(
  group: NodeGroup,
  measurementInputIdentifier: string,
): BlendStudioMeasurementDisplayContract | undefined {
  for (const absolute of group.nodes.filter((node) =>
    node.type === "ShaderNodeMath"
    && node.props?.operation === "ABSOLUTE")) {
    const source = groupInputSource(group, absolute.name, "Value");
    if (source?.inputIdentifier !== measurementInputIdentifier) continue;
    let valueLink = outgoingLink(group, absolute.name, "Value");
    let valueToString = valueLink
      ? nodeByName(group, valueLink.to_node)
      : undefined;
    for (let depth = 0; depth < 2 && valueToString; depth += 1) {
      if (
        valueToString.type !== "ShaderNodeMath"
        || valueToString.props?.blend_studio_interpretation
          !== "linear-measurement-lcd-v1"
      ) break;
      valueLink = outgoingLink(group, valueToString.name, "Value");
      valueToString = valueLink
        ? nodeByName(group, valueLink.to_node)
        : undefined;
    }
    if (
      valueLink?.to_socket !== "Value"
      || valueToString?.type !== "FunctionNodeValueToString"
    ) continue;
    const stringLink = outgoingLink(group, valueToString.name, "String");
    const numericText = stringLink
      ? nodeByName(group, stringLink.to_node)
      : undefined;
    if (
      stringLink?.to_socket !== "String"
      || numericText?.type !== "GeometryNodeStringToCurves"
    ) continue;
    const numericFont = inputByName(numericText, "Font")?.value;
    const unitText = group.nodes.find((candidate) =>
      candidate.type === "GeometryNodeStringToCurves"
      && candidate.name !== numericText.name
      && ["mm", "in"].includes(
        String(inputByName(candidate, "String")?.value ?? "").toLowerCase(),
      )
      && JSON.stringify(inputByName(candidate, "Font")?.value) === JSON.stringify(numericFont));
    if (!unitText) continue;
    return {
      absoluteNodeName: absolute.name,
      valueToStringNodeName: valueToString.name,
      numericTextNodeName: numericText.name,
      unitTextNodeName: unitText.name,
    };
  }
  return undefined;
}

/**
 * Recognize the portable subset of Blender's Linear Gizmo contract used by
 * Geometry Nodes assets. The mapping is topology based: a scalar group input
 * drives the gizmo Value directly or through one constant multiply, while the
 * same input places the gizmo along one Combine XYZ axis.
 */
export function linearMeasurementContractForBlendStudioTarget(
  dump: Dump,
  groupName: string,
): BlendStudioLinearMeasurementContract | null {
  const group = dump.node_groups[groupName];
  if (!group) return null;
  for (const gizmo of group.nodes.filter((node) =>
    node.type === "GeometryNodeGizmoLinear")) {
    const valueSource = groupInputSource(group, gizmo.name, "Value");
    const positionLink = incomingLink(group, gizmo.name, "Position");
    const positionNode = positionLink
      ? nodeByName(group, positionLink.from_node)
      : undefined;
    if (!valueSource || positionNode?.type !== "ShaderNodeCombineXYZ") continue;
    const components = ["X", "Y", "Z"] as const;
    const positionSources = components.map((component) =>
      groupInputSource(group, positionNode.name, component));
    const axisIndex = positionSources.findIndex((source) =>
      source?.inputIdentifier === valueSource.inputIdentifier);
    if (axisIndex < 0) continue;
    const positionSource = positionSources[axisIndex];
    const item = interfaceInput(group, valueSource.inputIdentifier);
    if (!positionSource || !item || !item.name) continue;
    const axis: [number, number, number] = [0, 0, 0];
    axis[axisIndex] = 1;
    const direction = vector3(
      inputByName(gizmo, "Direction")?.value,
      axis.map((component) => -component) as [number, number, number],
    );
    const battery = group.interface.find((candidate) =>
      candidate.item_type === "SOCKET"
      && candidate.in_out === "INPUT"
      && candidate.identifier
      && /battery/i.test(candidate.name)
      && finite(candidate.min_value, 0) === 0
      && finite(candidate.max_value, 1) === 1);
    const display = displayContract(group, valueSource.inputIdentifier);
    return {
      groupName,
      gizmoNodeName: gizmo.name,
      inputIdentifier: valueSource.inputIdentifier,
      inputName: item.name,
      authoredMin: finite(item.min_value, -1_000),
      authoredMax: finite(item.max_value, 0),
      displayScale: valueSource.scale,
      positionAxis: axis,
      positionScale: positionSource.scale,
      direction,
      unitHint: unitHint(group),
      batteryInputIdentifier: battery?.identifier,
      ...(display ? { display } : {}),
    };
  }
  return null;
}

export function measurementDistanceRange(
  contract: BlendStudioLinearMeasurementContract,
): [number, number] {
  const values = [
    contract.authoredMin * contract.displayScale,
    contract.authoredMax * contract.displayScale,
  ].sort((left, right) => left - right);
  return [Math.max(0, values[0]), Math.max(0, values[1])];
}

export function measurementDistanceFromAuthoredValue(
  contract: BlendStudioLinearMeasurementContract,
  authoredValue: number,
): number {
  return Math.max(0, authoredValue * contract.displayScale);
}

export function authoredValueFromMeasurementDistance(
  contract: BlendStudioLinearMeasurementContract,
  distance: number,
): number {
  const candidate = Math.max(0, distance) / contract.displayScale;
  return Math.min(
    Math.max(candidate, Math.min(contract.authoredMin, contract.authoredMax)),
    Math.max(contract.authoredMin, contract.authoredMax),
  );
}

export function measurementDistanceForDisplay(
  distanceMm: number,
  unit: BlendStudioMeasurementUnit,
): number {
  return unit === "in" ? distanceMm / 25.4 : distanceMm;
}

export function measurementDistanceFromDisplay(
  distance: number,
  unit: BlendStudioMeasurementUnit,
): number {
  return unit === "in" ? distance * 25.4 : distance;
}

/**
 * One node-editor unit measured as a CSS pixel printed at 96 DPI. This is the
 * whole joke made rigorous: the caliper reads the graph "as printed", so a
 * default-width Blender node (140 units) calipers at a plausible 37.042 mm.
 */
export const NODE_CANVAS_MM_PER_UNIT = 25.4 / 96;

export type BlendStudioNodeCanvasPick = {
  groupName: string;
  nodeName: string;
  label: string;
  position: [number, number];
};

export type BlendStudioNodeCanvasMeasurementSnapshot = {
  picks: BlendStudioNodeCanvasPick[];
  distanceMm?: number;
};

export function nodeCanvasDistanceMm(
  from: [number, number],
  to: [number, number],
): number {
  return Math.hypot(to[0] - from[0], to[1] - from[1]) * NODE_CANVAS_MM_PER_UNIT;
}

export function nodeCanvasPickForMeasurement(
  dump: Dump,
  groupName: string,
  nodeName: string,
): BlendStudioNodeCanvasPick | null {
  const group = dump.node_groups[groupName];
  const node = group ? nodeByName(group, nodeName) : undefined;
  const location = node?.ui?.location_absolute ?? node?.ui?.location;
  if (!node || !Array.isArray(location) || location.length < 2) return null;
  const [x, y] = [Number(location[0]), Number(location[1])];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    groupName,
    nodeName,
    label: node.label?.trim() || nodeName,
    position: [x, y],
  };
}

/**
 * The caliper-jaw pick sequence over the node canvas: the first pick sets the
 * fixed jaw, the second sets the sliding jaw and yields a distance, and a
 * third starts a fresh measurement. Re-picking the lone fixed jaw is a no-op.
 */
export function appendNodeCanvasPick(
  snapshot: BlendStudioNodeCanvasMeasurementSnapshot,
  pick: BlendStudioNodeCanvasPick,
): BlendStudioNodeCanvasMeasurementSnapshot {
  if (snapshot.picks.length !== 1) return { picks: [pick] };
  const [first] = snapshot.picks;
  if (first.groupName === pick.groupName && first.nodeName === pick.nodeName)
    return snapshot;
  return {
    picks: [first, pick],
    distanceMm: nodeCanvasDistanceMm(first.position, pick.position),
  };
}

const ZERO_NODE_NAME = "__BlendStudio LCD Zero Offset";
const UNIT_NODE_NAME = "__BlendStudio LCD Unit Scale";

function mathNode(
  name: string,
  operation: "SUBTRACT" | "MULTIPLY",
  constant: number,
): RawNode {
  return {
    name,
    type: "ShaderNodeMath",
    label: "BlendBridge interpreted LCD",
    inputs: [
      {
        name: "Value",
        identifier: "Value",
        type: "NodeSocketFloat",
        linked: true,
        value: null,
      },
      {
        name: "Value",
        identifier: "Value_001",
        type: "NodeSocketFloat",
        linked: false,
        value: constant,
      },
    ],
    outputs: [{
      name: "Value",
      identifier: "Value",
      type: "NodeSocketFloat",
      linked: true,
      default: 0,
    }],
    props: {
      operation,
      use_clamp: false,
      blend_studio_interpretation: "linear-measurement-lcd-v1",
    },
  };
}

function setSocketValue(node: RawNode, socketName: string, value: unknown): void {
  const socket = inputByName(node, socketName);
  if (socket) socket.value = value;
}

/**
 * Clone a portable dump and make the studio's zero/unit display semantics
 * explicit as ordinary Geometry Nodes. The source dump remains byte-for-byte
 * untouched; the returned graph can be evaluated or exported independently.
 */
export function interpretMeasurementDisplay(
  dump: Dump,
  contract: BlendStudioLinearMeasurementContract,
  interpretation: BlendStudioMeasurementInterpretation,
): Dump {
  if (!contract.display) return dump;
  const interpreted = structuredClone(dump);
  const group = interpreted.node_groups[contract.groupName];
  if (!group) return dump;
  const display = contract.display;
  const absolute = nodeByName(group, display.absoluteNodeName);
  const valueToString = nodeByName(group, display.valueToStringNodeName);
  const unitText = nodeByName(group, display.unitTextNodeName);
  if (!absolute || !valueToString || !unitText) return dump;

  let zeroNode = nodeByName(group, ZERO_NODE_NAME);
  if (!zeroNode) {
    zeroNode = mathNode(
      ZERO_NODE_NAME,
      "SUBTRACT",
      Math.max(0, interpretation.zeroOffsetMm),
    );
    group.nodes.push(zeroNode);
  }
  let unitNode = nodeByName(group, UNIT_NODE_NAME);
  if (!unitNode) {
    unitNode = mathNode(
      UNIT_NODE_NAME,
      "MULTIPLY",
      interpretation.unit === "in" ? 1 / 25.4 : 1,
    );
    group.nodes.push(unitNode);
  }
  if (
    zeroNode.type !== "ShaderNodeMath"
    || zeroNode.props?.blend_studio_interpretation !== "linear-measurement-lcd-v1"
    || unitNode.type !== "ShaderNodeMath"
    || unitNode.props?.blend_studio_interpretation !== "linear-measurement-lcd-v1"
  ) return dump;

  zeroNode.props = { ...zeroNode.props, operation: "SUBTRACT", use_clamp: false };
  unitNode.props = { ...unitNode.props, operation: "MULTIPLY", use_clamp: false };
  setSocketValue(zeroNode, "Value_001", Math.max(0, interpretation.zeroOffsetMm));
  setSocketValue(unitNode, "Value_001", interpretation.unit === "in" ? 1 / 25.4 : 1);
  // Preserve the authored three-place instrument precision in both units.
  setSocketValue(valueToString, "Decimals", 3);
  setSocketValue(unitText, "String", interpretation.unit);

  group.links = group.links.filter((link) =>
    !(
      link.to_node === valueToString.name
      && link.to_socket === "Value"
    )
    && !(
      (link.to_node === zeroNode.name || link.to_node === unitNode.name)
      && link.to_socket === "Value"
    ));
  group.links.push(
    {
      from_node: absolute.name,
      from_socket: "Value",
      to_node: zeroNode.name,
      to_socket: "Value",
      from_type: "NodeSocketFloat",
      to_type: "NodeSocketFloat",
    },
    {
      from_node: zeroNode.name,
      from_socket: "Value",
      to_node: unitNode.name,
      to_socket: "Value",
      from_type: "NodeSocketFloat",
      to_type: "NodeSocketFloat",
    },
    {
      from_node: unitNode.name,
      from_socket: "Value",
      to_node: valueToString.name,
      to_socket: "Value",
      from_type: "NodeSocketFloat",
      to_type: "NodeSocketFloat",
    },
  );
  const existingInterpretation = interpreted.studio_interpretation;
  const existingExtensions = (
    existingInterpretation
    && typeof existingInterpretation === "object"
    && Array.isArray((existingInterpretation as { extensions?: unknown }).extensions)
  )
    ? (existingInterpretation as { extensions: unknown[] }).extensions
    : [];
  interpreted.studio_interpretation = {
    ...(existingInterpretation && typeof existingInterpretation === "object"
      ? existingInterpretation
      : {}),
    version: 1,
    extensions: [
      ...existingExtensions.filter((extension) =>
        !(
          extension
          && typeof extension === "object"
          && (extension as { id?: unknown }).id === "linear-measurement-lcd-v1"
          && (extension as { groupName?: unknown }).groupName === contract.groupName
        )),
      {
      id: "linear-measurement-lcd-v1",
      authoredByBlender: false,
      reversible: true,
      groupName: contract.groupName,
      zeroOffsetMm: Math.max(0, interpretation.zeroOffsetMm),
      unit: interpretation.unit,
      },
    ],
  };
  return interpreted;
}
