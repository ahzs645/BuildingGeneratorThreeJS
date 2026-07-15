"""Probe a geometry socket inside nested group nodes of a modifier root.

Usage:
  blender --background file.blend --python tools/blender_nested_geometry_socket_dump.py -- \
    OBJECT OUT.json GROUP[:OUTPUT][/GROUP[:OUTPUT]...] INNER_NODE:SOCKET [direct|realize|points|instance_points]

When a container group node has multiple geometry outputs, append the output
name or identifier (for example ``Group.008:wrapper``). The legacy form keeps
using the first geometry output.
"""
import bpy
import json
import os
import sys


args = sys.argv[sys.argv.index("--") + 1 :]
object_name, out_path, container_path, spec = args[:4]
mode = args[4] if len(args) > 4 else "direct"
node_name, socket_name = spec.split(":", 1)
obj = bpy.data.objects[object_name]
if obj.name not in bpy.context.view_layer.objects and bpy.context.scene.collection.objects.get(obj.name) is None:
    world_matrix = obj.matrix_world.copy()
    bpy.context.scene.collection.objects.link(obj)
    # Linking an object from an excluded asset-library collection can rebuild
    # matrix_world from stale collection state. Preserve the authored world
    # transform so the probe does not manufacture a relative-transform delta.
    obj.matrix_world = world_matrix
modifier = next(item for item in obj.modifiers if item.type == "NODES" and item.node_group)
root = modifier.node_group
tree = root
rewired = []
root_source = None
root_geometry = None
tree_output_identifier = None
for container_spec in container_path.split("/"):
    container_name, separator, container_socket = container_spec.partition(":")
    container = tree.nodes[container_name]
    output = next(node for node in tree.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
    geometry = next(
        socket
        for socket in output.inputs
        if socket.type == "GEOMETRY"
        and (tree_output_identifier is None or socket.identifier == tree_output_identifier)
    )
    old = geometry.links[0].from_socket if geometry.is_linked else None
    for link in list(geometry.links):
        tree.links.remove(link)
    if separator:
        container_output = next(
            socket
            for socket in container.outputs
            if socket.name == container_socket or socket.identifier == container_socket
        )
        if container_output.type != "GEOMETRY":
            raise TypeError(f"container output is not geometry: {container_spec}")
    else:
        container_output = next(socket for socket in container.outputs if socket.type == "GEOMETRY")
    tree.links.new(container_output, geometry)
    rewired.append((tree, geometry, old))
    if tree == root:
        root_source = container_output
        root_geometry = geometry
    tree_output_identifier = container_output.identifier
    tree = container.node_tree

nested = tree
repeat_iterations = os.environ.get("NODE_DOJO_REPEAT_ITERATIONS")
if repeat_iterations is not None:
    for repeat_input in nested.nodes:
        if repeat_input.bl_idname == "GeometryNodeRepeatInput":
            repeat_input.inputs["Iterations"].default_value = int(repeat_iterations)
nested_output = next(node for node in nested.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
nested_geometry = next(
    socket
    for socket in nested_output.inputs
    if socket.type == "GEOMETRY"
    and (tree_output_identifier is None or socket.identifier == tree_output_identifier)
)
old_nested = nested_geometry.links[0].from_socket if nested_geometry.is_linked else None
for link in list(nested_geometry.links):
    nested.links.remove(link)

source = nested.nodes[node_name].outputs[socket_name]
nested.links.new(source, nested_geometry)
for link in list(root_geometry.links):
    root.links.remove(link)
container_output = root_source
temporaries = []
if mode == "realize":
    realize = root.nodes.new("GeometryNodeRealizeInstances")
    temporaries.append(realize)
    root.links.new(container_output, realize.inputs["Geometry"])
    container_output = realize.outputs["Geometry"]
elif mode in {"points", "instance_points"}:
    # Object.to_mesh() cannot serialize a point-cloud component. Instance a
    # one-vertex mesh on every point and realize it without changing positions.
    if mode == "instance_points":
        to_points = root.nodes.new("GeometryNodeInstancesToPoints")
        temporaries.append(to_points)
        root.links.new(container_output, to_points.inputs["Instances"])
        container_output = to_points.outputs["Points"]
    vertex = root.nodes.new("GeometryNodeMeshLine")
    vertex.inputs["Count"].default_value = 1
    instance = root.nodes.new("GeometryNodeInstanceOnPoints")
    realize = root.nodes.new("GeometryNodeRealizeInstances")
    temporaries.extend([vertex, instance, realize])
    root.links.new(container_output, instance.inputs["Points"])
    root.links.new(vertex.outputs["Mesh"], instance.inputs["Instance"])
    root.links.new(instance.outputs["Instances"], realize.inputs["Geometry"])
    container_output = realize.outputs["Geometry"]
root.links.new(container_output, root_geometry)
obj.update_tag()
bpy.context.view_layer.update()

evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
try:
    payload = {
        "positions": [list(vertex.co) for vertex in mesh.vertices],
        "edges": [list(edge.vertices) for edge in mesh.edges],
        "faces": [list(face.vertices) for face in mesh.polygons],
    }
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
    for temporary in reversed(temporaries):
        root.nodes.remove(temporary)

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
print(f"BLENDER_NESTED_GEOMETRY_SOCKET_DUMP_OK -> {out_path}")
