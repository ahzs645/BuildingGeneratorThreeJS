"""Measure intermediate geometry sockets in a Blender Geometry Nodes modifier.

Usage:
  blender --background FILE.blend --python tools/blender_node_probe.py -- \
    OBJECT OUT.json [CASES.json] NODE:SOCKET [NODE:SOCKET ...]

The script temporarily routes each requested root-group socket to the active
group output, evaluates the object, records topology/bounds, and restores the
authored link before moving to the next probe.
"""
import json
import sys

import bpy


def args_after_dash():
    if "--" not in sys.argv:
        raise SystemExit("missing -- arguments")
    return sys.argv[sys.argv.index("--") + 1 :]


def bbox(mesh):
    if not mesh.vertices:
        return {"min": [0.0, 0.0, 0.0], "max": [0.0, 0.0, 0.0]}
    values = [[float(v.co[i]) for v in mesh.vertices] for i in range(3)]
    return {
        "min": [round(min(axis), 4) for axis in values],
        "max": [round(max(axis), 4) for axis in values],
    }


def modifier_for(object_name):
    obj = bpy.data.objects[object_name]
    mod = next(m for m in obj.modifiers if m.type == "NODES" and m.node_group)
    return obj, mod


def set_overrides(mod, overrides):
    identifiers = {
        item.name: item.identifier
        for item in mod.node_group.interface.items_tree
        if item.item_type == "SOCKET" and item.in_out == "INPUT"
    }
    for name, value in overrides.items():
        if name == "__frame":
            bpy.context.scene.frame_set(int(value))
        else:
            mod[identifiers[name]] = value


def evaluate(obj):
    obj.update_tag()
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    depsgraph.update()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        return {
            "verts": len(mesh.vertices),
            "faces": len(mesh.polygons),
            "bbox": bbox(mesh),
        }
    finally:
        evaluated.to_mesh_clear()


def main():
    args = args_after_dash()
    if len(args) < 3:
        raise SystemExit("usage: OBJECT OUT.json [CASES.json] NODE:SOCKET ...")
    object_name, out_path = args[:2]
    case_path = args[2] if args[2].endswith(".json") else None
    specs = args[3:] if case_path else args[2:]
    cases = [{"name": "default", "overrides": {}}]
    if case_path:
        with open(case_path, "r", encoding="utf-8") as handle:
            cases = json.load(handle)

    obj, mod = modifier_for(object_name)
    realize_group = bpy.data.node_groups.new("__NODE_PROBE_REALIZE_INSTANCES", "GeometryNodeTree")
    realize_group.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    realize_group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    realize_input = realize_group.nodes.new("NodeGroupInput")
    realize = realize_group.nodes.new("GeometryNodeRealizeInstances")
    realize_output = realize_group.nodes.new("NodeGroupOutput")
    realize_group.links.new(realize_input.outputs["Geometry"], realize.inputs["Geometry"])
    realize_group.links.new(realize.outputs["Geometry"], realize_output.inputs["Geometry"])
    realize_modifier = obj.modifiers.new(name="__NODE_PROBE_REALIZE_INSTANCES", type="NODES")
    realize_modifier.node_group = realize_group
    tree = mod.node_group
    group_output = next(n for n in tree.nodes if n.bl_idname == "NodeGroupOutput" and n.is_active_output)
    geometry_input = next(s for s in group_output.inputs if s.type == "GEOMETRY")
    original = geometry_input.links[0].from_socket if geometry_input.is_linked else None
    results = []
    try:
        for case in cases:
            set_overrides(mod, case.get("overrides", {}))
            for spec in specs:
                node_name, socket_name = spec.split(":", 1)
                node = tree.nodes[node_name]
                socket = node.outputs.get(socket_name)
                if socket is None:
                    raise KeyError(f"output not found: {spec}")
                for link in list(geometry_input.links):
                    tree.links.remove(link)
                tree.links.new(socket, geometry_input)
                results.append({"case": case["name"], "probe": spec, **evaluate(obj)})
    finally:
        for link in list(geometry_input.links):
            tree.links.remove(link)
        if original is not None:
            tree.links.new(original, geometry_input)

    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump({"object": object_name, "results": results}, handle, indent=2)
    print(f"BLENDER_NODE_PROBE_OK -> {out_path}")


if __name__ == "__main__":
    main()
