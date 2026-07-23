"""Export one Blender object's evaluated surface for GN-VM surface diffs.

Run configuration helpers before this script when an asset is hidden behind a
wrapper. Example:

  blender --background FILE.blend \
    --python tools/configure_n03d_reference.py \
    --python tools/export_blender_evaluated_mesh.py -- OBJECT OUT.json LOCAL

The JSON shape is accepted directly by ``tools/mesh-surface-diff.ts``.
"""

import json
import os
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1:]
if len(args) < 2:
    raise RuntimeError("expected OBJECT_NAME OUT.json [LOCAL]")

object_name = args[0]
out_path = os.path.abspath(args[1])
local_space = len(args) > 2 and args[2].upper() == "LOCAL"
obj = bpy.data.objects.get(object_name)
if obj is None:
    raise RuntimeError(f'object not found: "{object_name}"')

depsgraph = bpy.context.evaluated_depsgraph_get()
depsgraph.update()
evaluated = obj.evaluated_get(depsgraph)
mesh = evaluated.to_mesh()
if mesh is None:
    raise RuntimeError(f'evaluated mesh unavailable: "{object_name}"')

try:
    mesh.calc_loop_triangles()
    transform = None if local_space else evaluated.matrix_world
    positions = [
        list(vertex.co if transform is None else transform @ vertex.co)
        for vertex in mesh.vertices
    ]
    faces = [list(polygon.vertices) for polygon in mesh.polygons]
    loop_triangles = [list(triangle.vertices) for triangle in mesh.loop_triangles]
    material_names = [material.name if material else None for material in mesh.materials]
    face_materials = [
        material_names[polygon.material_index]
        if polygon.material_index < len(material_names)
        else None
        for polygon in mesh.polygons
    ]
    payload = {
        "object": object_name,
        "space": "LOCAL" if local_space else "WORLD",
        "positions": positions,
        "faces": faces,
        "loop_triangles": loop_triangles,
        "face_materials": face_materials,
        "stats": {
            "verts": len(mesh.vertices),
            "edges": len(mesh.edges),
            "faces": len(mesh.polygons),
            "triangles": len(mesh.loop_triangles),
        },
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)
        handle.write("\n")
finally:
    evaluated.to_mesh_clear()

print(
    "BLENDER_EVALUATED_MESH_OK "
    f"{out_path} ({payload['stats']['verts']} verts, "
    f"{payload['stats']['faces']} faces, "
    f"{payload['stats']['triangles']} triangles)"
)
