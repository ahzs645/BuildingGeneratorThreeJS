"""Inspect Blender's converted curve representation for one font glyph.

Usage:
  blender --background [FILE.blend] --python tools/probe_font_geometry.py -- GLYPH [FONT_PATH]
"""

import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1 :]
glyph = args[0] if args else "A"
font_path = args[1] if len(args) > 1 else None
align_y = args[2] if len(args) > 2 else "TOP_BASELINE"
curve = bpy.data.curves.new("__FONT_PROBE", "FONT")
font = bpy.data.fonts.load(font_path, check_existing=True) if font_path else curve.font
curve.body = glyph
curve.font = font
curve.size = 1.0
curve.align_x = "LEFT"
curve.align_y = align_y
obj = bpy.data.objects.new("__FONT_PROBE", curve)
bpy.context.scene.collection.objects.link(obj)
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.object.convert(target="CURVE")

print(f"FONT_PROBE font={font.name!r} glyph={glyph!r} dimensions={tuple(round(v, 7) for v in obj.dimensions)}")
for index, spline in enumerate(obj.data.splines):
    if spline.type == "BEZIER":
        points = spline.bezier_points
        print(f"  spline={index} type=BEZIER cyclic={spline.use_cyclic_u} points={len(points)} resolution={spline.resolution_u}")
        for point in points[:4]:
            print("   ", point.handle_left_type, point.handle_right_type, tuple(round(v, 7) for v in point.co), tuple(round(v, 7) for v in point.handle_left), tuple(round(v, 7) for v in point.handle_right))
    else:
        print(f"  spline={index} type={spline.type} cyclic={spline.use_cyclic_u} points={len(spline.points)} resolution={spline.resolution_u}")

bpy.ops.object.convert(target="MESH")
print(f"  mesh verts={len(obj.data.vertices)} edges={len(obj.data.edges)} faces={len(obj.data.polygons)}")
