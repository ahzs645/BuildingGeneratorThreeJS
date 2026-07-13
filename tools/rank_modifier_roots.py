"""Rank active Geometry Nodes modifiers by reachable graph complexity.

Usage: blender --background FILE.blend --python tools/rank_modifier_roots.py -- OUT.json
"""
import bpy
import json
import sys


out_path = sys.argv[sys.argv.index("--") + 1]


def reachable(root):
    seen = set()
    stack = [root]
    while stack:
        tree = stack.pop()
        if tree.name_full in seen:
            continue
        seen.add(tree.name_full)
        for node in tree.nodes:
            if node.bl_idname == "GeometryNodeGroup" and node.node_tree:
                stack.append(node.node_tree)
    return [bpy.data.node_groups[name] for name in seen if bpy.data.node_groups.get(name)]


results = []
for obj in bpy.data.objects:
    for modifier in obj.modifiers:
        if modifier.type != "NODES" or not modifier.node_group:
            continue
        groups = reachable(modifier.node_group)
        node_types = {}
        for group in groups:
            for node in group.nodes:
                node_types[node.bl_idname] = node_types.get(node.bl_idname, 0) + 1
        results.append({
            "object": obj.name,
            "modifier": modifier.name,
            "root": modifier.node_group.name,
            "reachable_groups": len(groups),
            "reachable_nodes": sum(len(group.nodes) for group in groups),
            "node_types": node_types,
        })

results.sort(key=lambda item: (item["reachable_nodes"], item["object"], item["root"]))
with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(results, handle, indent=2)
print(f"RANK_ROOTS_OK: {len(results)} modifiers -> {out_path}")
