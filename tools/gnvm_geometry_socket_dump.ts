// Route one root/nested-group geometry socket to the modifier output and serialize it.
// Mirrors the Blender geometry socket probes for intermediate parity checks.
// Usage: tsx tools/gnvm_geometry_socket_dump.ts dump.json Object out.json [Group/]Node:Socket [direct|realize] [overrides.json]
import { readFileSync, writeFileSync } from "node:fs";
import { Dump, runGenerator } from "../src/gnvm/index";

const [, , dumpPath, objectName, outPath, spec, mode = "direct", overridesPath] = process.argv;
if (!dumpPath || !objectName || !outPath || !spec) throw new Error("missing dump/object/output/spec");
const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Dump;
const source = dump.objects?.find((object) => object.name === objectName)?.modifiers?.find((modifier) => modifier.type === "NODES");
if (!source?.node_group) throw new Error(`no Geometry Nodes modifier on ${objectName}`);
const root = (dump.node_groups as any)[source.node_group];
const split = spec.lastIndexOf(":");
const path = spec.slice(0, split).split("/");
const nodeName = path.pop()!, socketName = spec.slice(split + 1);
let group = root;
for (const containerName of path) {
  const container = group.nodes.find((node: any) => node.name === containerName);
  const outputNode = group.nodes.find((node: any) => node.type === "NodeGroupOutput" && node.props?.is_active_output !== false)
    ?? group.nodes.find((node: any) => node.type === "NodeGroupOutput");
  const outputSocket = outputNode?.inputs.find((socket: any) => socket.type === "NodeSocketGeometry" || socket.identifier === "Socket_1");
  const containerSocket = container?.outputs.find((socket: any) => socket.type === "NodeSocketGeometry");
  if (!container?.group || !outputNode || !outputSocket || !containerSocket) throw new Error(`cannot resolve container ${containerName}`);
  group.links = group.links.filter((link: any) => !(link.to_node === outputNode.name && link.to_socket === outputSocket.identifier));
  group.links.push({ from_node: container.name, from_socket: containerSocket.identifier, to_node: outputNode.name, to_socket: outputSocket.identifier });
  group = (dump.node_groups as any)[container.group];
}
const repeatIterations = process.env.GNVM_REPEAT_ITERATIONS;
if (repeatIterations !== undefined) {
  for (const candidateNode of group.nodes ?? []) {
    if (candidateNode.type !== "GeometryNodeRepeatInput") continue;
    const iterations = candidateNode.inputs?.find((input: any) => input.name === "Iterations" || input.identifier === "Iterations");
    if (iterations) iterations.value = Number(repeatIterations);
  }
}
const sourceNode = group.nodes.find((node: any) => node.name === nodeName);
const sourceSocket = sourceNode?.outputs.find((socket: any) => socket.name === socketName || socket.identifier === socketName);
const outputNode = group.nodes.find((node: any) => node.type === "NodeGroupOutput" && node.props?.is_active_output !== false)
  ?? group.nodes.find((node: any) => node.type === "NodeGroupOutput");
const outputSocket = outputNode?.inputs.find((socket: any) => socket.type === "NodeSocketGeometry" || socket.identifier === "Socket_1");
if (!sourceNode || !sourceSocket || !outputNode || !outputSocket) throw new Error(`cannot resolve ${spec}`);
group.links = group.links.filter((link: any) => !(link.to_node === outputNode.name && link.to_socket === outputSocket.identifier));
let fromNode = sourceNode.name, fromSocket = sourceSocket.identifier;
if (mode === "realize") {
  const name = "__GNVM_PROBE_REALIZE";
  group.nodes.push({
    name, type: "GeometryNodeRealizeInstances", label: null,
    inputs: [
      { name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry", linked: true, value: null },
      { name: "Selection", identifier: "Selection", type: "NodeSocketBool", linked: false, value: true },
      { name: "Realize All", identifier: "Realize All", type: "NodeSocketBool", linked: false, value: true },
      { name: "Depth", identifier: "Depth", type: "NodeSocketInt", linked: false, value: 0 },
    ],
    outputs: [{ name: "Geometry", identifier: "Geometry", type: "NodeSocketGeometry" }],
  });
  group.links.push({ from_node: fromNode, from_socket: fromSocket, to_node: name, to_socket: "Geometry" });
  fromNode = name; fromSocket = "Geometry";
}
group.links.push({ from_node: fromNode, from_socket: fromSocket, to_node: outputNode.name, to_socket: outputSocket.identifier });
const overrides = process.env.GNVM_PROBE_OVERRIDES
  ? JSON.parse(process.env.GNVM_PROBE_OVERRIDES)
  : overridesPath
  ? JSON.parse(readFileSync(overridesPath, "utf8"))[0]?.overrides ?? {}
  : undefined;
const result = await runGenerator(dump, { object: objectName, overrides });
const geometry = result.geometry;
writeFileSync(outPath, JSON.stringify({
  positions: geometry.mesh?.positions ?? [],
  faces: geometry.mesh?.faces ?? [],
  edges: geometry.mesh?.edges ?? [],
  curves: geometry.curves,
  instances: geometry.instances.map((instance) => ({ position: instance.position, rotation: instance.rotation, scale: instance.scale })),
}));
console.log(`GNVM_GEOMETRY_SOCKET_DUMP_OK -> ${outPath}`);
