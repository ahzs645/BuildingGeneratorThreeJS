"""Write realized evaluated mesh positions for one object (parity diagnostics)."""
import json
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(__file__))
from parity_sweep import clear_evaluated_mesh, evaluated_mesh


args = sys.argv[sys.argv.index("--") + 1:]
obj = bpy.data.objects.get(args[0])
if obj is None:
    raise RuntimeError(f"object not found: {args[0]}")
# Asset-library studies are often stored in collections excluded from the
# active scene. evaluated_get() returns only their seed mesh until they are
# temporarily linked into the active dependency graph.
if obj.name not in bpy.context.view_layer.objects and bpy.context.scene.collection.objects.get(obj.name) is None:
    bpy.context.scene.collection.objects.link(obj)
bpy.context.view_layer.update()
if len(args) > 2 and args[2].upper() == "VIEWPORT":
    # Background dependency-graph evaluation follows the render branch of Is
    # Viewport. Replace that source in-memory so browser truth compares against
    # Blender's interactive/viewport branch instead of its high-density render.
    for tree in bpy.data.node_groups:
        for node in list(tree.nodes):
            if node.bl_idname != "GeometryNodeIsViewport":
                continue
            targets = [(link.to_node, link.to_socket) for link in list(node.outputs[0].links)]
            if not targets:
                continue
            value = tree.nodes.new("ShaderNodeValue")
            value.name = "__FORCE_VIEWPORT_TRUE"
            value.outputs[0].default_value = 1.0
            for to_node, to_socket in targets:
                tree.links.new(value.outputs[0], to_socket)
    bpy.context.view_layer.update()
evaluated, mesh, cleanup = evaluated_mesh(obj)
try:
    payload = {
        "object": obj.name,
        "verts": [list(vertex.co) for vertex in mesh.vertices],
        "faces": [list(face.vertices) for face in mesh.polygons],
    }
    with open(args[1], "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
finally:
    clear_evaluated_mesh(evaluated, mesh, cleanup)
print(f"BLENDER_VERTICES_OK -> {args[1]}")
