"""Read a Geometry Nodes rotation field by storing its Euler value on points.

Usage:
  blender --background FILE.blend --python tools/blender_rotation_probe.py -- \
    OBJECT OUT.json POINTS_NODE:SOCKET ROTATION_NODE:SOCKET
"""
import json
import sys

import bpy


def main():
    args = sys.argv[sys.argv.index("--") + 1 :]
    if len(args) not in (4, 5, 6):
        raise SystemExit("usage: OBJECT OUT.json GEOMETRY_NODE:SOCKET FIELD_NODE:SOCKET [DIRECT] [DOMAIN]")
    object_name, out_path, points_spec, rotation_spec = args[:4]
    direct_geometry = len(args) == 5 and args[4].upper() == "DIRECT"
    if len(args) == 6:
        direct_geometry = args[4].upper() == "DIRECT"
    probe_domain = args[5].upper() if len(args) == 6 else "POINT"
    obj = bpy.data.objects[object_name]
    mod = next(m for m in obj.modifiers if m.type == "NODES" and m.node_group)
    tree = mod.node_group
    points_node, points_socket = points_spec.split(":", 1)
    rotation_node, rotation_socket = rotation_spec.split(":", 1)
    group_output = next(n for n in tree.nodes if n.bl_idname == "NodeGroupOutput" and n.is_active_output)
    geometry_output = next(s for s in group_output.inputs if s.type == "GEOMETRY")
    original = geometry_output.links[0].from_socket if geometry_output.is_linked else None

    field_socket = tree.nodes[rotation_node].outputs[rotation_socket]
    to_euler = tree.nodes.new("FunctionNodeRotationToEuler") if field_socket.type == "ROTATION" else None
    store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
    to_vertices = tree.nodes.new("GeometryNodePointsToVertices")
    store.data_type = "FLOAT_VECTOR"
    store.domain = probe_domain
    store.inputs["Name"].default_value = "__rotation_probe"
    tree.links.new(tree.nodes[points_node].outputs[points_socket], store.inputs["Geometry"])
    if to_euler is not None:
        tree.links.new(field_socket, to_euler.inputs["Rotation"])
        tree.links.new(to_euler.outputs["Euler"], store.inputs["Value"])
    else:
        tree.links.new(field_socket, store.inputs["Value"])
    tree.links.new(store.outputs["Geometry"], to_vertices.inputs["Points"])
    for link in list(geometry_output.links):
        tree.links.remove(link)
    tree.links.new(store.outputs["Geometry"] if direct_geometry else to_vertices.outputs["Mesh"], geometry_output)

    obj.update_tag()
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    depsgraph.update()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        attribute = mesh.attributes.get("__rotation_probe")
        values = [list(item.vector) for item in attribute.data] if attribute else []
        payload = {
            "positions": [list(polygon.center) for polygon in mesh.polygons] if probe_domain == "FACE" else [list(vertex.co) for vertex in mesh.vertices],
            "rotations": values,
        }
    finally:
        evaluated.to_mesh_clear()
        for link in list(geometry_output.links):
            tree.links.remove(link)
        if original is not None:
            tree.links.new(original, geometry_output)
        tree.nodes.remove(store)
        if to_euler is not None:
            tree.nodes.remove(to_euler)
        tree.nodes.remove(to_vertices)

    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    print(f"BLENDER_ROTATION_PROBE_OK -> {out_path}")


if __name__ == "__main__":
    main()
