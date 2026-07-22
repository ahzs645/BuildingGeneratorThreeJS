"""Dump the active values and indices of a nested Volume Cube grid.

Usage:
  blender --background FILE.blend --python tools/blender_nested_volume_grid_probe.py -- \
    OBJECT OUT.json GROUP[/GROUP...] VOLUME_NODE:SOCKET

The probe uses Blender's Get Named Grid and Grid to Points nodes, so the
reported values and active/tile state come from the actual transient OpenVDB
tree created by the evaluated graph rather than from a separately sampled
copy of its density field.
"""

import bpy
import json
import sys


args = sys.argv[sys.argv.index("--") + 1 :]
object_name, out_path, container_path, volume_spec = args
volume_node_name, volume_socket_name = volume_spec.split(":", 1)

obj = bpy.data.objects[object_name]
if obj.name not in bpy.context.view_layer.objects and bpy.context.scene.collection.objects.get(obj.name) is None:
    world_matrix = obj.matrix_world.copy()
    bpy.context.scene.collection.objects.link(obj)
    obj.matrix_world = world_matrix

modifier = next(item for item in obj.modifiers if item.type == "NODES" and item.node_group)
root = modifier.node_group
tree = root
root_source = None
root_geometry = None
tree_output_identifier = None

for container_name in container_path.split("/"):
    container = tree.nodes[container_name]
    output = next(node for node in tree.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
    geometry = next(
        socket
        for socket in output.inputs
        if socket.type == "GEOMETRY"
        and (tree_output_identifier is None or socket.identifier == tree_output_identifier)
    )
    for link in list(geometry.links):
        tree.links.remove(link)
    container_output = next(socket for socket in container.outputs if socket.type == "GEOMETRY")
    tree.links.new(container_output, geometry)
    if tree == root:
        root_source = container_output
        root_geometry = geometry
    tree_output_identifier = container_output.identifier
    tree = container.node_tree

nested = tree
nested_output = next(node for node in nested.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
nested_geometry = next(
    socket
    for socket in nested_output.inputs
    if socket.type == "GEOMETRY"
    and (tree_output_identifier is None or socket.identifier == tree_output_identifier)
)
for link in list(nested_geometry.links):
    nested.links.remove(link)

volume_outputs = nested.nodes[volume_node_name].outputs
volume_source = volume_outputs.get(volume_socket_name) or next(
    socket for socket in volume_outputs if socket.identifier == volume_socket_name
)
get_grid = nested.nodes.new("GeometryNodeGetNamedGrid")
get_grid.data_type = "FLOAT"
get_grid.inputs["Name"].default_value = "density"
get_grid.inputs["Remove"].default_value = False
nested.links.new(volume_source, get_grid.inputs["Volume"])

to_points = nested.nodes.new("GeometryNodeGridToPoints")
to_points.data_type = "FLOAT"
nested.links.new(get_grid.outputs["Grid"], to_points.inputs["Grid"])

geometry = to_points.outputs["Points"]
attribute_specs = [
    ("__grid_value", "FLOAT", to_points.outputs["Value"]),
    ("__grid_x", "INT", to_points.outputs["X"]),
    ("__grid_y", "INT", to_points.outputs["Y"]),
    ("__grid_z", "INT", to_points.outputs["Z"]),
    ("__grid_is_tile", "BOOLEAN", to_points.outputs["Is Tile"]),
    ("__grid_extent", "INT", to_points.outputs["Extent"]),
]
for name, data_type, value in attribute_specs:
    store = nested.nodes.new("GeometryNodeStoreNamedAttribute")
    store.domain = "POINT"
    store.data_type = data_type
    store.inputs["Name"].default_value = name
    nested.links.new(geometry, store.inputs["Geometry"])
    nested.links.new(value, store.inputs["Value"])
    geometry = store.outputs["Geometry"]
nested.links.new(geometry, nested_geometry)

for link in list(root_geometry.links):
    root.links.remove(link)
to_vertices = root.nodes.new("GeometryNodePointsToVertices")
root.links.new(root_source, to_vertices.inputs["Points"])
root.links.new(to_vertices.outputs["Mesh"], root_geometry)

obj.update_tag()
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
try:
    def values(name):
        attribute = mesh.attributes[name]
        return [item.value for item in attribute.data]

    payload = {
        "positions": [list(vertex.co) for vertex in mesh.vertices],
        "values": values("__grid_value"),
        "x": values("__grid_x"),
        "y": values("__grid_y"),
        "z": values("__grid_z"),
        "is_tile": values("__grid_is_tile"),
        "extent": values("__grid_extent"),
    }
finally:
    evaluated.to_mesh_clear()

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
print(f"BLENDER_NESTED_VOLUME_GRID_PROBE_OK: {len(payload['values'])} active values -> {out_path}")
