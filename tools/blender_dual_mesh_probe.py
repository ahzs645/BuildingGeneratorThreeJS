"""Evaluate Blender's Dual Mesh node for a JSON mesh.

Usage:
  blender --background --python tools/blender_dual_mesh_probe.py -- INPUT.json OUT.json

INPUT.json must contain ``positions`` and ``faces`` arrays. The probe is kept
minimal so polygon ordering, cyclic loop starts, and generated face centers can
be compared directly with GN-VM without any surrounding asset graph.
"""

import bpy
import json
import sys


input_path, output_path = sys.argv[sys.argv.index("--") + 1 :]
with open(input_path, "r", encoding="utf-8") as handle:
    source = json.load(handle)

mesh = bpy.data.meshes.new("__NODE_DOJO_DUAL_INPUT")
mesh.from_pydata(source["positions"], [], source["faces"])
mesh.update()
obj = bpy.data.objects.new("__NODE_DOJO_DUAL_INPUT", mesh)
bpy.context.scene.collection.objects.link(obj)

tree = bpy.data.node_groups.new("__NODE_DOJO_DUAL_PROBE", "GeometryNodeTree")
tree.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
tree.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
group_input = tree.nodes.new("NodeGroupInput")
dual = tree.nodes.new("GeometryNodeDualMesh")
group_output = tree.nodes.new("NodeGroupOutput")
tree.links.new(group_input.outputs["Geometry"], dual.inputs["Mesh"])
tree.links.new(dual.outputs["Dual Mesh"], group_output.inputs["Geometry"])
modifier = obj.modifiers.new(name="Dual Mesh", type="NODES")
modifier.node_group = tree

bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
result = evaluated.to_mesh()
try:
    result.calc_loop_triangles()
    payload = {
        "positions": [list(vertex.co) for vertex in result.vertices],
        "edges": [list(edge.vertices) for edge in result.edges],
        "faces": [list(face.vertices) for face in result.polygons],
        "loop_triangles": [list(triangle.vertices) for triangle in result.loop_triangles],
    }
finally:
    evaluated.to_mesh_clear()

with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle)
print(f"BLENDER_DUAL_MESH_PROBE_OK: {len(payload['positions'])} verts, {len(payload['faces'])} faces -> {output_path}")
