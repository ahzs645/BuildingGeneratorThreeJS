"""Apply validated graph-authoring fields without normalizing the base dump.

Usage:
    python3 tools/merge_authoring_refresh.py BASE.json REFRESHED.json OUTPUT.json

The TypeScript decoder owns the refresh semantics. This final merge starts from
the pre-refresh artifact so Python preserves authored numeric spellings such as
``1.0``, ``-0.0``, and scientific notation instead of creating corpus-wide
text churn unrelated to node layout or annotations.
"""
import json
import os
import re
import sys


base_path, refreshed_path, output_path = sys.argv[1:4]
with open(base_path, "r", encoding="utf-8") as source:
    base_text = source.read()
    base = json.loads(base_text)
with open(refreshed_path, "r", encoding="utf-8") as source:
    refreshed = json.load(source)

for group_name, group in base.get("node_groups", {}).items():
    refreshed_group = refreshed.get("node_groups", {}).get(group_name)
    if not refreshed_group:
        continue
    if "view_center" in refreshed_group:
        group["view_center"] = refreshed_group["view_center"]
    if "annotation" in refreshed_group:
        group["annotation"] = refreshed_group["annotation"]

    refreshed_nodes = {
        node.get("name"): node
        for node in refreshed_group.get("nodes", [])
        if isinstance(node, dict) and isinstance(node.get("name"), str)
    }
    for node in group.get("nodes", []):
        refreshed_node = refreshed_nodes.get(node.get("name"))
        if not refreshed_node or refreshed_node.get("type") != node.get("type"):
            continue
        if "ui" in node or "ui" in refreshed_node:
            dimensions = node.get("ui", {}).get("dimensions")
            node["ui"] = {**node.get("ui", {}), **refreshed_node.get("ui", {})}
            if dimensions is not None and "dimensions" not in refreshed_node.get("ui", {}):
                node["ui"]["dimensions"] = dimensions
        node["label"] = refreshed_node.get("label")
        if node.get("type") == "NodeFrame":
            refreshed_props = refreshed_node.get("props", {})
            props = node.setdefault("props", {})
            for key in ("label_size", "shrink"):
                if key in refreshed_props:
                    props[key] = refreshed_props[key]

annotations = refreshed.get("annotations", {})
if annotations or "annotations" in base:
    base["annotations"] = annotations
if "node_editor_views" in refreshed:
    base["node_editor_views"] = refreshed["node_editor_views"]
if "authoring_refresh" in refreshed:
    base["authoring_refresh"] = refreshed["authoring_refresh"]

os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
compact = not base_text.startswith("{\n")
with open(output_path, "w", encoding="utf-8") as destination:
    if compact:
        json.dump(base, destination, separators=(",", ":"))
    else:
        indent_match = re.search(r"\n( +)\"", base_text)
        json.dump(base, destination, indent=len(indent_match.group(1)) if indent_match else 1)
    if base_text.endswith("\n"):
        destination.write("\n")

print("AUTHORING_REFRESH_MERGED ->", output_path)
