"""Save a temporary Chrome Crayon blend with the browser's fixed input path.

Usage:
  blender --background SOURCE.blend --python tools/prepare_crayon_parity_blend.py -- OUT.blend
"""
import os
import sys

import bpy
from mathutils import Matrix


args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) != 1:
    raise SystemExit("usage: OUT.blend")
out_path = os.path.abspath(args[0])
obj = bpy.data.objects["CHROME CRAYON OBJECT"]
obj.matrix_world = Matrix.Identity(4)
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
bpy.ops.wm.save_as_mainfile(filepath=out_path)
print(f"CRAYON_PARITY_BLEND_OK -> {out_path}")
