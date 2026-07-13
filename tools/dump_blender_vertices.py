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
