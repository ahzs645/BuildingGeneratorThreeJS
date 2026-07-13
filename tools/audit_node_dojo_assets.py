"""Smoke-test marked object assets in the currently opened Blender file."""

import json

import bpy


depsgraph = bpy.context.evaluated_depsgraph_get()


def linked_dependencies(tree, seen=None):
    """Return externally linked node groups reachable from a node tree."""
    if tree is None:
        return set()
    seen = seen or set()
    if tree.name_full in seen:
        return set()
    seen.add(tree.name_full)
    result = set()
    if tree.library is not None:
        result.add(tree.name)
    for node in tree.nodes:
        child = getattr(node, "node_tree", None)
        if child is not None:
            result.update(linked_dependencies(child, seen))
    return result

for source in bpy.data.objects:
    if source.asset_data is None:
        continue

    result = {
        "name": source.name,
        "source_type": source.type,
        "status": "ok",
        "vertices": None,
        "polygons": None,
        "linked_node_groups": sorted(
            {
                dependency
                for modifier in source.modifiers
                if modifier.type == "NODES"
                for dependency in linked_dependencies(modifier.node_group)
            }
        ),
    }

    evaluated = None
    try:
        evaluated = source.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        if mesh is not None:
            result["vertices"] = len(mesh.vertices)
            result["polygons"] = len(mesh.polygons)
    except Exception as error:  # Blender data can fail for missing linked dependencies.
        result["status"] = "error"
        result["error"] = repr(error)
    finally:
        if evaluated is not None:
            try:
                evaluated.to_mesh_clear()
            except RuntimeError:
                pass

    print("ND_OBJECT_ASSET|" + json.dumps(result, sort_keys=True))


for group in bpy.data.node_groups:
    if group.asset_data is None:
        continue
    print(
        "ND_NODE_GROUP_ASSET|"
        + json.dumps(
            {
                "name": group.name,
                "linked_node_groups": sorted(linked_dependencies(group)),
            },
            sort_keys=True,
        )
    )
