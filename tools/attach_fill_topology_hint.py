"""Attach Blender-evaluated Fill Curve topology to a portable graph dump.

Usage:
    python tools/attach_fill_topology_hint.py \
        DUMP.json GROUP_NAME NODE_NAME BLENDER_GEOMETRY_PROBE.json

The probe is produced by ``bake_nested_geometry_probe.py`` and must include
positions, edges, and faces. Coordinates are not embedded: the hint preserves
Blender's CDT topology ordering and is applied only while the evaluated polygon
boundaries still have the same adjacency.
"""
import copy
import json
import os
import subprocess
import sys


dump_path, group_name, node_name, probe_path = sys.argv[1:5]
base_revision = sys.argv[6] if len(sys.argv) > 6 and sys.argv[5] == "--base" else None
if base_revision:
    # Useful when replacing an earlier generated hint without reserializing a
    # dump that another JSON implementation has already normalized (for
    # example JavaScript turning every 0.0 into 0).
    source_text = subprocess.check_output(
        ["git", "show", f"{base_revision}:{dump_path}"], text=True
    )
    dump = json.loads(source_text)
    with open(dump_path, "r", encoding="utf-8") as source:
        working_dump = json.load(source)
    base_for_compare = copy.deepcopy(dump)
    working_for_compare = copy.deepcopy(working_dump)

    def remove_existing_hint(payload):
        target_group = payload.get("node_groups", {}).get(group_name, {})
        target_node = next(
            (candidate for candidate in target_group.get("nodes", []) if candidate.get("name") == node_name),
            None,
        )
        if target_node:
            target_node.get("props", {}).pop("evaluated_topology", None)

    remove_existing_hint(base_for_compare)
    remove_existing_hint(working_for_compare)
    if base_for_compare != working_for_compare:
        raise RuntimeError(
            f"refusing --base {base_revision}: {dump_path} has other parsed changes; "
            "attach to the current dump or commit those edits first"
        )
else:
    with open(dump_path, "r", encoding="utf-8") as source:
        dump = json.load(source)
with open(probe_path, "r", encoding="utf-8") as source:
    probe = json.load(source)

group = dump.get("node_groups", {}).get(group_name)
if group is None:
    raise KeyError(f"node group not found: {group_name}")
node = next((candidate for candidate in group.get("nodes", []) if candidate.get("name") == node_name), None)
if node is None:
    raise KeyError(f"node not found: {group_name}/{node_name}")
if node.get("type") != "GeometryNodeFillCurve":
    raise TypeError(f"expected GeometryNodeFillCurve, got {node.get('type')}")
if not all(isinstance(probe.get(name), list) for name in ("positions", "edges", "faces")):
    raise TypeError("probe must contain positions, edges, and faces arrays")

node.setdefault("props", {})["evaluated_topology"] = {
    "position_count": len(probe["positions"]),
    "edges": probe["edges"],
    "faces": probe["faces"],
}

temporary = dump_path + ".tmp"
with open(temporary, "w", encoding="utf-8") as destination:
    json.dump(dump, destination, indent=1)
    destination.write("\n")
os.replace(temporary, dump_path)
print(
    f"FILL_TOPOLOGY_HINT_OK {group_name}/{node_name}: "
    f"{len(probe['positions'])} verts / {len(probe['edges'])} edges / {len(probe['faces'])} faces"
)
