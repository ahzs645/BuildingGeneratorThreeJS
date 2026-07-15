"""Evaluate one root-group scalar field at explicit local-space points.

Usage:
  blender --background FILE.blend --python tools/blender_field_points_probe.py -- \
    OBJECT GROUP NODE:SOCKET OUT.json '[[0,0,0],[1,2,3]]'

The blend is modified only in memory. Each point gets a one-vertex Mesh Line so
Position-dependent fields resolve in the same geometry context as the graph.
Set NODE_DOJO_PROBE_ROUTE to route a nested group instance to the modifier
output, and NODE_DOJO_PROBE_OVERRIDES for modifier inputs used by that route.
"""
import json
import os
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1 :]
object_name, group_name, field_spec, out_path, points_json = args
node_name, socket_name = field_spec.split(":", 1)
points = json.loads(points_json)
tree = bpy.data.node_groups[group_name]
field_node = tree.nodes[node_name]
field_socket = field_node.outputs.get(socket_name)
if field_socket is None:
    field_socket = next(socket for socket in field_node.outputs if socket.identifier == socket_name)

join = tree.nodes.new("GeometryNodeJoinGeometry")
temporary = [join]
for index, point in enumerate(points):
    line = tree.nodes.new("GeometryNodeMeshLine")
    line.mode = "OFFSET"
    line.inputs["Count"].default_value = 1
    line.inputs["Start Location"].default_value = point
    store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
    store.data_type = "FLOAT"
    store.domain = "POINT"
    store.inputs["Name"].default_value = "__field_probe"
    tree.links.new(line.outputs["Mesh"], store.inputs["Geometry"])
    tree.links.new(field_socket, store.inputs["Value"])
    tree.links.new(store.outputs["Geometry"], join.inputs["Geometry"])
    temporary.extend([line, store])

group_output = next(node for node in tree.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
geometry_output = next(socket for socket in group_output.inputs if socket.type == "GEOMETRY")
original = geometry_output.links[0].from_socket if geometry_output.is_linked else None
for link in list(geometry_output.links):
    tree.links.remove(link)
tree.links.new(join.outputs["Geometry"], geometry_output)

obj = bpy.data.objects[object_name]
probe_scene = bpy.data.scenes.new("__NODE_DOJO_FIELD_POINTS_PROBE_SCENE")
probe_scene.collection.objects.link(obj)
bpy.context.window.scene = probe_scene
obj.hide_viewport = False
obj.hide_render = False
obj.hide_set(False)

modifier = next(
    (candidate for candidate in obj.modifiers if candidate.type == "NODES" and candidate.node_group),
    None,
)
probe_overrides = json.loads(os.environ.get("NODE_DOJO_PROBE_OVERRIDES", "{}"))
if modifier and probe_overrides:
    identifiers = {
        item.name: item.identifier
        for item in modifier.node_group.interface.items_tree
        if item.item_type == "SOCKET" and item.in_out == "INPUT"
    }
    for name, value in probe_overrides.items():
        modifier[identifiers[name]] = value

route_links = []
for step in json.loads(os.environ.get("NODE_DOJO_PROBE_ROUTE", "[]")):
    route_tree = bpy.data.node_groups[step["group"]]
    route_node = route_tree.nodes[step["node"]]
    route_output = next(
        node for node in route_tree.nodes
        if node.bl_idname == "NodeGroupOutput" and node.is_active_output
    )
    route_target = next(socket for socket in route_output.inputs if socket.type == "GEOMETRY")
    route_source = route_node.outputs[step["socket"]]
    route_links.append((route_tree, route_target, route_target.links[0].from_socket if route_target.is_linked else None))
    for link in list(route_target.links):
        route_tree.links.remove(link)
    route_tree.links.new(route_source, route_target)

obj.update_tag()
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
try:
    attribute = mesh.attributes["__field_probe"]
    payload = {
        "points": [list(vertex.co) for vertex in mesh.vertices],
        "values": [float(item.value) for item in attribute.data],
    }
finally:
    evaluated.to_mesh_clear()
    for route_tree, route_target, route_original in reversed(route_links):
        for link in list(route_target.links):
            route_tree.links.remove(link)
        if route_original is not None:
            route_tree.links.new(route_original, route_target)
    for link in list(geometry_output.links):
        tree.links.remove(link)
    if original is not None:
        tree.links.new(original, geometry_output)
    for node in temporary:
        tree.nodes.remove(node)

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
print(f"BLENDER_FIELD_POINTS_PROBE_OK -> {out_path}")
