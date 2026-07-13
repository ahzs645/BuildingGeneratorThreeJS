"""Probe a geometry socket inside one nested group node of a modifier root.

Usage:
  blender --background file.blend --python tools/blender_nested_geometry_socket_dump.py -- \
    OBJECT OUT.json ROOT_GROUP_NODE INNER_NODE:SOCKET [direct|realize]
"""
import bpy
import json
import sys


args = sys.argv[sys.argv.index("--") + 1 :]
object_name, out_path, container_name, spec = args[:4]
mode = args[4] if len(args) > 4 else "direct"
node_name, socket_name = spec.split(":", 1)
obj = bpy.data.objects[object_name]
modifier = next(item for item in obj.modifiers if item.type == "NODES" and item.node_group)
root = modifier.node_group
container = root.nodes[container_name]
nested = container.node_tree
nested_output = next(node for node in nested.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
nested_geometry = next(socket for socket in nested_output.inputs if socket.type == "GEOMETRY")
root_output = next(node for node in root.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
root_geometry = next(socket for socket in root_output.inputs if socket.type == "GEOMETRY")

old_nested = nested_geometry.links[0].from_socket if nested_geometry.is_linked else None
old_root = root_geometry.links[0].from_socket if root_geometry.is_linked else None
for link in list(nested_geometry.links):
    nested.links.remove(link)
for link in list(root_geometry.links):
    root.links.remove(link)

source = nested.nodes[node_name].outputs[socket_name]
nested.links.new(source, nested_geometry)
container_output = next(socket for socket in container.outputs if socket.type == "GEOMETRY")
temporary = None
if mode == "realize":
    temporary = root.nodes.new("GeometryNodeRealizeInstances")
    root.links.new(container_output, temporary.inputs["Geometry"])
    container_output = temporary.outputs["Geometry"]
root.links.new(container_output, root_geometry)
obj.update_tag()
bpy.context.view_layer.update()

evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
try:
    payload = {
        "positions": [list(vertex.co) for vertex in mesh.vertices],
        "faces": [list(face.vertices) for face in mesh.polygons],
    }
finally:
    evaluated.to_mesh_clear()
    for link in list(nested_geometry.links):
        nested.links.remove(link)
    for link in list(root_geometry.links):
        root.links.remove(link)
    if old_nested is not None:
        nested.links.new(old_nested, nested_geometry)
    if old_root is not None:
        root.links.new(old_root, root_geometry)
    if temporary is not None:
        root.nodes.remove(temporary)

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
print(f"BLENDER_NESTED_GEOMETRY_SOCKET_DUMP_OK -> {out_path}")
