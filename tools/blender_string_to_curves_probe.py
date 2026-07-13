"""Fill one String to Curves node directly and dump its Blender mesh.

Usage:
  blender --background FILE.blend --python tools/blender_string_to_curves_probe.py -- \
    OBJECT NODE OUT.json
"""

import json
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1 :]
object_name, node_name, out_path = args
obj = bpy.data.objects[object_name]
modifier = next(candidate for candidate in obj.modifiers if candidate.type == "NODES" and candidate.node_group)
tree = modifier.node_group
node = tree.nodes[node_name]
output = next(candidate for candidate in tree.nodes if candidate.bl_idname == "NodeGroupOutput" and candidate.is_active_output)
geometry_socket = next(socket for socket in output.inputs if socket.type == "GEOMETRY")
original = geometry_socket.links[0].from_socket if geometry_socket.is_linked else None
for link in list(geometry_socket.links):
    tree.links.remove(link)

fill = tree.nodes.new("GeometryNodeFillCurve")
fill.inputs["Mode"].default_value = "N-gons"
realize = tree.nodes.new("GeometryNodeRealizeInstances")
tree.links.new(node.outputs["Curve Instances"], fill.inputs["Curve"])
tree.links.new(fill.outputs["Mesh"], realize.inputs["Geometry"])
tree.links.new(realize.outputs["Geometry"], geometry_socket)
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
    for link in list(geometry_socket.links):
        tree.links.remove(link)
    if original is not None:
        tree.links.new(original, geometry_socket)
    tree.nodes.remove(fill)
    tree.nodes.remove(realize)

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
print(f"BLENDER_STRING_TO_CURVES_PROBE_OK {len(payload['positions'])}v/{len(payload['faces'])}f -> {out_path}")
