"""Evaluate a nested vector field by routing it to a one-point geometry."""
import bpy
import json
import sys


args = sys.argv[sys.argv.index("--") + 1 :]
object_name, out_path, container_path, spec = args[:4]
node_name, socket_name = spec.split(":", 1)
obj = bpy.data.objects[object_name]
modifier = next(item for item in obj.modifiers if item.type == "NODES" and item.node_group)
root = modifier.node_group
tree = root
rewired = []
for container_name in container_path.split("/"):
    container = tree.nodes[container_name]
    output = next(node for node in tree.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
    geometry = next(socket for socket in output.inputs if socket.type == "GEOMETRY")
    old = geometry.links[0].from_socket if geometry.is_linked else None
    for link in list(geometry.links):
        tree.links.remove(link)
    container_output = next(socket for socket in container.outputs if socket.type == "GEOMETRY")
    tree.links.new(container_output, geometry)
    rewired.append((tree, geometry, old))
    tree = container.node_tree

nested = tree
nested_output = next(node for node in nested.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
nested_geometry = next(socket for socket in nested_output.inputs if socket.type == "GEOMETRY")
old_nested = nested_geometry.links[0].from_socket if nested_geometry.is_linked else None
for link in list(nested_geometry.links):
    nested.links.remove(link)

# A Points component does not become a mesh through Object.to_mesh(). A
# one-vertex Mesh Line does, so its Start Location is a dependable field probe.
points = nested.nodes.new("GeometryNodeMeshLine")
points.mode = "OFFSET"
points.inputs["Count"].default_value = 1
source = nested.nodes[node_name].outputs[socket_name]
scalar_to_vector = None
if source.bl_idname == "NodeSocketFloat":
    scalar_to_vector = nested.nodes.new("ShaderNodeCombineXYZ")
    nested.links.new(source, scalar_to_vector.inputs["X"])
    source = scalar_to_vector.outputs["Vector"]
nested.links.new(source, points.inputs["Start Location"])
nested.links.new(points.outputs["Mesh"], nested_geometry)
obj.update_tag()
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
try:
    value = list(mesh.vertices[0].co) if mesh and mesh.vertices else []
finally:
    evaluated.to_mesh_clear()
    for link in list(nested_geometry.links):
        nested.links.remove(link)
    if old_nested is not None:
        nested.links.new(old_nested, nested_geometry)
    for parent_tree, geometry, old in reversed(rewired):
        for link in list(geometry.links):
            parent_tree.links.remove(link)
        if old is not None:
            parent_tree.links.new(old, geometry)
    nested.nodes.remove(points)
    if scalar_to_vector is not None:
        nested.nodes.remove(scalar_to_vector)

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump({"value": value}, handle, indent=2)
print(f"BLENDER_NESTED_VECTOR_SOCKET_DUMP_OK -> {out_path}")
