"""Route one root-group geometry socket to output and dump its evaluated mesh."""
import json
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1 :]
object_name, out_path, spec = args[:3]
mode = args[3] if len(args) > 3 else "direct"
node_name, socket_name = spec.split(":", 1)
obj = bpy.data.objects[object_name]
mod = next(modifier for modifier in obj.modifiers if modifier.type == "NODES" and modifier.node_group)
tree = mod.node_group
output = next(node for node in tree.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
geometry_socket = next(socket for socket in output.inputs if socket.type == "GEOMETRY")
original = geometry_socket.links[0].from_socket if geometry_socket.is_linked else None
for link in list(geometry_socket.links):
    tree.links.remove(link)
temporary_nodes = []
source_socket = tree.nodes[node_name].outputs[socket_name]
if mode == "fill":
    fill = tree.nodes.new("GeometryNodeFillCurve")
    fill.inputs["Mode"].default_value = "N-gons"
    realize = tree.nodes.new("GeometryNodeRealizeInstances")
    tree.links.new(source_socket, fill.inputs["Curve"])
    tree.links.new(fill.outputs["Mesh"], realize.inputs["Geometry"])
    source_socket = realize.outputs["Geometry"]
    temporary_nodes.extend([realize, fill])
elif mode == "realize":
    realize = tree.nodes.new("GeometryNodeRealizeInstances")
    tree.links.new(source_socket, realize.inputs["Geometry"])
    source_socket = realize.outputs["Geometry"]
    temporary_nodes.append(realize)
elif mode == "instance_points":
    to_points = tree.nodes.new("GeometryNodeInstancesToPoints")
    vertex = tree.nodes.new("GeometryNodeMeshLine")
    vertex.inputs["Count"].default_value = 1
    instance = tree.nodes.new("GeometryNodeInstanceOnPoints")
    realize = tree.nodes.new("GeometryNodeRealizeInstances")
    tree.links.new(source_socket, to_points.inputs["Instances"])
    tree.links.new(to_points.outputs["Points"], instance.inputs["Points"])
    tree.links.new(vertex.outputs["Mesh"], instance.inputs["Instance"])
    tree.links.new(instance.outputs["Instances"], realize.inputs["Geometry"])
    source_socket = realize.outputs["Geometry"]
    temporary_nodes.extend([realize, instance, vertex, to_points])
tree.links.new(source_socket, geometry_socket)
obj.update_tag()
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
try:
    payload = {"positions": [list(vertex.co) for vertex in mesh.vertices], "faces": [list(face.vertices) for face in mesh.polygons]}
finally:
    evaluated.to_mesh_clear()
    for link in list(geometry_socket.links):
        tree.links.remove(link)
    if original is not None:
        tree.links.new(original, geometry_socket)
    for node in temporary_nodes:
        tree.nodes.remove(node)
with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
print(f"BLENDER_GEOMETRY_SOCKET_DUMP_OK -> {out_path}")
