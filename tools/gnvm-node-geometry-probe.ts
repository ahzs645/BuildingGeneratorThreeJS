// Export one intermediate geometry-node socket from a GN-VM evaluation.
// Usage: node --import tsx tools/gnvm-node-geometry-probe.ts DUMP OBJECT [GROUP] NODE SOCKET OUT.json [OVERRIDES.json]
import { readFileSync, writeFileSync } from "node:fs";
import { runGenerator, type Dump } from "../src/gnvm/index";
import { GEOMETRY_PROBE } from "../src/gnvm/evaluator";
import { realizeInstances } from "../src/gnvm/geometry";

const args = process.argv.slice(2);
if (args.length < 5 || args.length > 7) throw new Error("usage: DUMP OBJECT [GROUP] NODE SOCKET OUT.json [OVERRIDES.json]");
const [dumpPath, objectName, ...rest] = args;
// The optional override form is intentionally paired with an explicit group
// name so it remains unambiguous with the legacy six-argument group form.
const overridesPath = rest.length === 5 ? rest.pop() : undefined;
const target = rest;
const [groupName, nodeName, socketName, outPath] = target.length === 4
  ? target
  : [null, target[0], target[1], target[2]];
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
const graphOverrides = JSON.parse(process.env.GNVM_PROBE_GRAPH_OVERRIDES ?? "[]") as Array<{
  group: string;
  node: string;
  inputs: Record<string, unknown>;
}>;
for (const override of graphOverrides) {
  const node = dump.node_groups?.[override.group]?.nodes.find((candidate) => candidate.name === override.node);
  if (!node) throw new Error(`invalid graph override: ${JSON.stringify(override)}`);
  for (const [name, value] of Object.entries(override.inputs)) {
    const socket = node.inputs.find((candidate) => candidate.name === name || candidate.identifier === name);
    if (!socket) throw new Error(`invalid graph override input: ${override.group}.${override.node}.${name}`);
    socket.value = value as never;
  }
}
const route = JSON.parse(process.env.GNVM_PROBE_ROUTE ?? "[]") as Array<{ group: string; node: string; socket: string }>;
for (const step of route) {
  const group = dump.node_groups?.[step.group];
  const output = group?.nodes.find((node) => node.type === "NodeGroupOutput");
  const target = output?.inputs.find((socket) => socket.type === "NodeSocketGeometry");
  if (!group || !output || !target) throw new Error(`invalid probe route: ${JSON.stringify(step)}`);
  group.links = group.links.filter((link) => link.to_node !== output.name || link.to_socket !== target.identifier);
  group.links.push({ from_node: step.node, from_socket: step.socket, to_node: output.name, to_socket: target.identifier });
}
GEOMETRY_PROBE.group = groupName;
GEOMETRY_PROBE.node = nodeName;
GEOMETRY_PROBE.socket = socketName;
GEOMETRY_PROBE.geometry = null;
const rawOverrides = overridesPath ? JSON.parse(readFileSync(overridesPath, "utf8")) : {};
const overrides = Array.isArray(rawOverrides) ? rawOverrides[0]?.overrides ?? {} : rawOverrides;
const result = await runGenerator(dump, { object: objectName, overrides });
// Built-in node handlers can expose their value at evaluation time. Group
// nodes are evaluated by the evaluator itself, so when a route has connected
// the requested group socket all the way to the modifier output, the final
// geometry is the authoritative probe value.
const geometry = GEOMETRY_PROBE.geometry ?? (route.length ? result.geometry : null);
GEOMETRY_PROBE.group = null;
GEOMETRY_PROBE.node = null;
GEOMETRY_PROBE.socket = null;
if (!geometry) throw new Error(`no geometry captured from ${nodeName}:${socketName}`);
const positions = geometry.mesh?.positions.length ? geometry.mesh.positions : geometry.curves.flatMap((curve) => curve.points);
const faces = geometry.mesh?.faces ?? [];
const instance_payloads = geometry.instances.map((instance) => ({
  verts: instance.geometry.mesh?.positions.length ?? 0,
  faces: instance.geometry.mesh?.faces.length ?? 0,
  curves: instance.geometry.curves.length,
  instances: instance.geometry.instances.length,
  position: instance.position,
  rotation: instance.rotation,
  scale: instance.scale,
}));
const attributes = Object.fromEntries([...(geometry.mesh?.attributes ?? [])].map(([name, attribute]) => [name, {
  domain: attribute.domain,
  count: attribute.data.length,
  sample: attribute.data.slice(0, 8),
  ...(process.env.GNVM_PROBE_ATTRIBUTES === "1" ? { data: attribute.data } : {}),
}]));
const curve_attributes = Object.fromEntries([...geometry.curveAttributes].map(([name, attribute]) => [name, {
  domain: attribute.domain,
  count: attribute.data.length,
  sample: attribute.data.slice(0, 8),
  ...(process.env.GNVM_PROBE_ATTRIBUTES === "1" ? { data: attribute.data } : {}),
}]));
const realized = realizeInstances(geometry);
const realized_positions = [
  ...(realized.mesh?.positions ?? []),
  ...realized.curves.flatMap((curve) => curve.points),
];
const realized_bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
for (const point of realized_positions) {
  for (let axis = 0; axis < 3; axis++) {
    realized_bbox.min[axis] = Math.min(realized_bbox.min[axis], point[axis]);
    realized_bbox.max[axis] = Math.max(realized_bbox.max[axis], point[axis]);
  }
}
if (!realized_positions.length) {
  realized_bbox.min.fill(0);
  realized_bbox.max.fill(0);
}
const realized_stats = {
  verts: realized.mesh?.positions.length ?? 0,
  faces: realized.mesh?.faces.length ?? 0,
  curves: realized.curves.length,
  curve_points: realized.curvePointCount(),
};
const payload: Record<string, unknown> = { positions, edges: geometry.mesh?.edges ?? [], faces, attributes, curves: geometry.curves.length, curve_lengths: geometry.curves.map((curve) => curve.points.length), curve_cyclic: geometry.curves.map((curve) => curve.cyclic), curve_attributes, instances: geometry.instances.length, instance_payloads, realized_stats, realized_bbox };
if (process.env.GNVM_PROBE_GEOMETRY === "1") {
  payload.realized_positions = realized_positions;
  payload.realized_faces = realized.mesh?.faces ?? [];
}
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`GNVM_NODE_GEOMETRY_PROBE_OK ${positions.length}v/${faces.length}f ${geometry.curves.length}c/${geometry.instances.length}i -> ${outPath}`);
