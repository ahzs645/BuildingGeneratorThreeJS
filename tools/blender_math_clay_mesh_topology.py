"""Report evaluated Blender polygon/edge topology for a named object.

Usage:
  blender -b math-clay.blend -P tools/blender_math_clay_mesh_topology.py -- Dsurface
"""
import json
import sys
from collections import Counter

import bpy


def json_value(value):
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    try:
        return list(value)
    except TypeError:
        return str(value)


object_name = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "Dsurface"
obj = bpy.data.objects[object_name]
linked_for_probe = False
if obj.name not in bpy.context.view_layer.objects:
    bpy.context.scene.collection.objects.link(obj)
    linked_for_probe = True
bpy.context.view_layer.update()
modifier_inputs = {}
modifier_state = []
for modifier in obj.modifiers:
    if modifier.type == "NODES" and modifier.node_group:
        modifier_state.append({
            "name": modifier.name,
            "show_viewport": modifier.show_viewport,
            "show_render": modifier.show_render,
        })
        for item in modifier.node_group.interface.items_tree:
            if getattr(item, "item_type", None) == "SOCKET" and item.in_out == "INPUT":
                modifier_inputs[item.name] = json_value(modifier.get(item.identifier, "<default>"))
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
try:
    edge_faces = Counter()
    for polygon in mesh.polygons:
        vertices = list(polygon.vertices)
        for corner, vertex in enumerate(vertices):
            other = vertices[(corner + 1) % len(vertices)]
            edge_faces[tuple(sorted((vertex, other)))] += 1
    incidence = Counter(edge_faces.values())
    payload = {
        "object": object_name,
        "verts": len(mesh.vertices),
        "edges": len(edge_faces),
        "faces": len(mesh.polygons),
        "faceSizes": dict(sorted(Counter(len(p.vertices) for p in mesh.polygons).items())),
        "edgeFaceIncidence": dict(sorted(incidence.items())),
        "eulerCharacteristic": len(mesh.vertices) - len(edge_faces) + len(mesh.polygons),
        "modifierInputs": modifier_inputs,
        "modifierState": modifier_state,
        "frame": bpy.context.scene.frame_current,
        "linkedForProbe": linked_for_probe,
    }
    print("BLENDER_MATH_CLAY_TOPOLOGY " + json.dumps(payload, sort_keys=True))
finally:
    evaluated.to_mesh_clear()
