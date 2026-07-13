"""Evaluate one root-group scalar field at explicit local-space points.

Usage:
  blender --background FILE.blend --python tools/blender_field_points_probe.py -- \
    OBJECT GROUP NODE:SOCKET OUT.json '[[0,0,0],[1,2,3]]'

The blend is modified only in memory. Each point gets a one-vertex Mesh Line so
Position-dependent fields resolve in the same geometry context as the graph.
"""
import json
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
for link in list(geometry_output.links):
    tree.links.remove(link)
tree.links.new(join.outputs["Geometry"], geometry_output)

obj = bpy.data.objects[object_name]
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

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
print(f"BLENDER_FIELD_POINTS_PROBE_OK -> {out_path}")
