#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length < 3 || args.length % 2 !== 1) {
  throw new Error("usage: node tools/audit-course-roots.mjs OUT.json PROJECT_ID DUMP.json [PROJECT_ID DUMP.json ...]");
}

const outputPath = args.shift();
const projects = [];
for (let index = 0; index < args.length; index += 2) {
  projects.push({ id: args[index], dump: JSON.parse(readFileSync(args[index + 1], "utf8")) });
}

function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "ui" || key === "name" || key === "node_tree" || key.startsWith("bl_")) continue;
    out[key] = clean(child);
  }
  return out;
}

function signatures(dump) {
  const cache = new Map();
  const visiting = new Set();
  const signature = (groupName) => {
    if (cache.has(groupName)) return cache.get(groupName);
    if (visiting.has(groupName)) return `cycle:${groupName}`;
    visiting.add(groupName);
    const group = dump.node_groups[groupName];
    if (!group) return `missing:${groupName}`;
    const nodeIndex = new Map(group.nodes.map((node, index) => [node.name, index]));
    const nodes = group.nodes.map((node) => {
      const subtree = node.props?.node_tree?.name;
      return {
        type: node.type,
        inputs: node.inputs.map((socket) => clean(socket)),
        outputs: node.outputs.map((socket) => clean(socket)),
        props: clean(node.props),
        subtree: subtree ? signature(subtree) : undefined,
        pairedOutput: node.paired_output ? nodeIndex.get(node.paired_output) : undefined,
      };
    });
    const links = group.links.map((link) => [
      nodeIndex.get(link.from_node), link.from_socket,
      nodeIndex.get(link.to_node), link.to_socket,
      link.multi_input_sort_id ?? null,
    ]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const payload = JSON.stringify({ interface: group.interface.map(clean), nodes, links });
    const digest = createHash("sha256").update(payload).digest("hex");
    visiting.delete(groupName);
    cache.set(groupName, digest);
    return digest;
  };
  return signature;
}

const roots = [];
for (const project of projects) {
  const signature = signatures(project.dump);
  const seen = new Set();
  for (const object of project.dump.objects ?? []) {
    for (const modifier of object.modifiers ?? []) {
      if (modifier.type !== "NODES" || !modifier.node_group || seen.has(modifier.node_group)) continue;
      seen.add(modifier.node_group);
      const group = project.dump.node_groups[modifier.node_group];
      const reachable = new Set();
      const visit = (name) => {
        if (reachable.has(name) || !project.dump.node_groups[name]) return;
        reachable.add(name);
        for (const node of project.dump.node_groups[name].nodes) {
          const child = node.props?.node_tree?.name;
          if (child) visit(child);
        }
      };
      visit(modifier.node_group);
      const nodes = [...reachable].reduce((sum, name) => sum + project.dump.node_groups[name].nodes.length, 0);
      roots.push({
        project: project.id,
        root: modifier.node_group,
        exampleObject: object.name,
        reachableGroups: reachable.size,
        reachableNodes: nodes,
        signature: signature(modifier.node_group),
        classification: modifier.node_group === "Auto Smooth"
          ? "auto-smooth-helper"
          : nodes <= 4
            ? "empty-or-passthrough-helper"
            : nodes <= 53
              ? "instructional-step"
              : "complex-study",
      });
    }
  }
}

const bySignature = new Map();
for (const root of roots) {
  const family = bySignature.get(root.signature) ?? [];
  family.push(root);
  bySignature.set(root.signature, family);
}
const families = [...bySignature.entries()].map(([signature, members]) => ({
  signature,
  members: members.map(({ signature: _signature, ...member }) => member),
})).sort((a, b) => b.members[0].reachableNodes - a.members[0].reachableNodes || b.members.length - a.members.length);

const report = {
  generatedBy: "tools/audit-course-roots.mjs",
  projects: projects.map((project) => project.id),
  activeRootFamilies: roots.length,
  exactStructuralFamilies: families.length,
  duplicateRootsCollapsed: roots.length - families.length,
  classifications: Object.fromEntries([...new Set(roots.map((root) => root.classification))].sort().map((classification) => [
    classification,
    roots.filter((root) => root.classification === classification).length,
  ])),
  crossProjectDuplicateFamilies: families.filter((family) => new Set(family.members.map((member) => member.project)).size > 1),
  largestComplexStudies: families.filter((family) => family.members[0].classification === "complex-study").slice(0, 30),
  families,
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`COURSE_AUDIT_OK ${roots.length} roots -> ${families.length} structural families (${outputPath})`);
