"""Render the deterministic flat Chrome Crayon path used by /surface-draw.

Usage mirrors render_blender_reference.py:
  blender --background FILE.blend --python tools/render_crayon_parity_path.py -- \
    "CHROME CRAYON OBJECT" OUT.png OUT.json
"""
import os
import json
import sys

import bpy
from mathutils import Matrix, Vector


args = sys.argv[sys.argv.index("--") + 1 :]
object_name = args[0]
obj = bpy.data.objects[object_name]
obj.matrix_world = Matrix.Identity(4)

# Exact web parity coordinates: the browser's fixed path is expressed in a
# normalized 8-unit scene and scaled by 20 before entering the authored graph.
points = [
    (-48.0, -14.0, 0.0),
    (-33.0, 8.4, 0.0),
    (-16.0, 16.4, 0.0),
    (1.0, 1.6, 0.0),
    (18.0, -12.4, 0.0),
    (34.0, -5.0, 0.0),
    (48.0, 13.6, 0.0),
]
obj.data.splines.clear()
spline = obj.data.splines.new("POLY")
spline.points.add(len(points) - 1)
for point, coordinate in zip(spline.points, points):
    point.co = (*coordinate, 1.0)
spline.use_cyclic_u = False

modifier = next(item for item in obj.modifiers if item.type == "NODES" and item.node_group)
identifiers = {
    item.name: item.identifier
    for item in modifier.node_group.interface.items_tree
    if item.item_type == "SOCKET" and item.in_out == "INPUT"
}
overrides = {
    "Line Thiccness": float(os.environ.get("CRAYON_THICKNESS", "6")),
    "Peak Height": float(os.environ.get("CRAYON_PEAK", "10")),
    "Sigilize": int(os.environ.get("CRAYON_SIGILIZE", "0")),
    "Soften": 0,
    "resolution": float(os.environ.get("CRAYON_RESOLUTION", "0.8")),
    "SPIRO": int(os.environ.get("CRAYON_SPIRO", "1")),
    "Extrude Base": 1.0,
    "FLATTEN": False,
}
for name, value in overrides.items():
    modifier[identifiers[name]] = value

obj.update_tag()
bpy.context.view_layer.update()

reference_script = os.path.join(os.path.dirname(__file__), "render_blender_reference.py")
with open(reference_script, "r", encoding="utf-8") as handle:
    namespace = {"__name__": "__main__", "__file__": reference_script}
    exec(compile(handle.read(), reference_script, "exec"), namespace)

# Replace Blender's stale evaluated bound_box with bounds from the realized
# Geometry Nodes mesh, then re-render top-down for a direct browser comparison.
if len(args) > 2:
    evaluated = namespace["evaluated"]
    mesh = evaluated.to_mesh()
    positions = [evaluated.matrix_world @ vertex.co for vertex in mesh.vertices]
    minimum = Vector(tuple(min(point[axis] for point in positions) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in positions) for axis in range(3)))
    with open(args[2], "r", encoding="utf-8") as handle:
        metadata = json.load(handle)
    metadata["bbox"] = {"min": list(minimum), "max": list(maximum)}
    if os.environ.get("NODE_DOJO_PARITY_MESH") == "1":
        metadata["parity_mesh"] = {
            "positions": [list(point) for point in positions],
            "faces": [list(face.vertices) for face in mesh.polygons],
        }
    evaluated.to_mesh_clear()
    with open(args[2], "w", encoding="utf-8") as handle:
        json.dump(metadata, handle, indent=2)

    center = (minimum + maximum) * 0.5
    size = maximum - minimum
    camera = namespace["camera"]
    camera.location = center + Vector((0.0, 0.0, max(size.x, size.y, 1.0) * 2.0))
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.ortho_scale = max(size.x, size.y, 1.0) * 1.2
    bpy.context.scene.render.filepath = args[1]
    bpy.ops.render.render(write_still=True)
