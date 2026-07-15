"""Evaluate a nested matrix socket on origin and unit-axis mesh points.

Usage:
  blender -b file.blend --python tools/blender_nested_matrix_socket_dump.py -- \
    OBJECT OUT.json GROUP[:OUTPUT][/GROUP[:OUTPUT]...] NODE:SOCKET
"""
import json
import sys

import bpy


object_name, out_path, container_path, spec = sys.argv[sys.argv.index("--") + 1 :][:4]
node_name, socket_name = spec.split(":", 1)
obj = bpy.data.objects[object_name]
if obj.name not in bpy.context.view_layer.objects:
    authored_world = obj.matrix_world.copy()
    bpy.context.scene.collection.objects.link(obj)
    obj.matrix_world = authored_world

modifier = next(item for item in obj.modifiers if item.type == "NODES" and item.node_group)
root = modifier.node_group
tree = root
rewired = []
tree_output_identifier = None
for container_spec in container_path.split("/"):
    container_name, separator, container_socket = container_spec.partition(":")
    container = tree.nodes[container_name]
    output = next(node for node in tree.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
    geometry = next(
        socket for socket in output.inputs
        if socket.type == "GEOMETRY"
        and (tree_output_identifier is None or socket.identifier == tree_output_identifier)
    )
    old = geometry.links[0].from_socket if geometry.is_linked else None
    for link in list(geometry.links):
        tree.links.remove(link)
    container_output = next(
        socket for socket in container.outputs
        if socket.type == "GEOMETRY"
        and (not separator or socket.name == container_socket or socket.identifier == container_socket)
    )
    tree.links.new(container_output, geometry)
    rewired.append((tree, geometry, old))
    tree_output_identifier = container_output.identifier
    tree = container.node_tree

nested = tree
output = next(node for node in nested.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
geometry = next(
    socket for socket in output.inputs
    if socket.type == "GEOMETRY"
    and (tree_output_identifier is None or socket.identifier == tree_output_identifier)
)
old_nested = geometry.links[0].from_socket if geometry.is_linked else None
for link in list(geometry.links):
    nested.links.remove(link)

lines = []
for direction in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
    line = nested.nodes.new("GeometryNodeMeshLine")
    line.mode = "OFFSET"
    line.inputs["Count"].default_value = 2
    line.inputs["Start Location"].default_value = (0, 0, 0)
    line.inputs["Offset"].default_value = direction
    lines.append(line)
join = nested.nodes.new("GeometryNodeJoinGeometry")
for line in lines:
    nested.links.new(line.outputs["Mesh"], join.inputs["Geometry"])
transform = nested.nodes.new("GeometryNodeTransform")
transform.inputs["Mode"].default_value = "Matrix"
nested.links.new(join.outputs["Geometry"], transform.inputs["Geometry"])
nested.links.new(nested.nodes[node_name].outputs[socket_name], transform.inputs["Transform"])
nested.links.new(transform.outputs["Geometry"], geometry)

obj.update_tag()
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
try:
    positions = [list(vertex.co) for vertex in mesh.vertices]
finally:
    evaluated.to_mesh_clear()
    for link in list(geometry.links):
        nested.links.remove(link)
    if old_nested is not None:
        nested.links.new(old_nested, geometry)
    for parent_tree, parent_geometry, old in reversed(rewired):
        for link in list(parent_geometry.links):
            parent_tree.links.remove(link)
        if old is not None:
            parent_tree.links.new(old, parent_geometry)
    nested.nodes.remove(transform)
    nested.nodes.remove(join)
    for line in lines:
        nested.nodes.remove(line)

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump({"positions": positions}, handle, indent=2)
print(f"BLENDER_NESTED_MATRIX_SOCKET_DUMP_OK -> {out_path}")
