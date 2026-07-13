"""Create a Blender comparison copy with missing String-to-Curves fonts replaced.

Usage:
    blender --background source.blend --python tools/prepare_font_override_blend.py -- font.ttf output.blend

Only font sockets whose external file is absent are changed. The source file is
never saved over, which keeps the generated reference honest and reproducible.
"""
import bpy
import os
import sys


args = sys.argv[sys.argv.index("--") + 1 :]
font_path, output_path = args[:2]
font_path = os.path.abspath(font_path)
output_path = os.path.abspath(output_path)
replacement = bpy.data.fonts.load(font_path, check_existing=True)

replaced = []
for group in bpy.data.node_groups:
    for node in group.nodes:
        if node.bl_idname != "GeometryNodeStringToCurves":
            continue
        socket = next((item for item in node.inputs if item.name == "Font"), None)
        current = getattr(socket, "default_value", None) if socket else None
        if not isinstance(current, bpy.types.VectorFont):
            continue
        current_path = bpy.path.abspath(current.filepath)
        if current_path and os.path.exists(current_path):
            continue
        replaced.append((group.name, node.name, current.name, current_path))
        socket.default_value = replacement

bpy.ops.wm.save_as_mainfile(filepath=output_path, compress=True)
print(f"FONT_OVERRIDE_BLEND_OK {replacement.name} -> {output_path} ({len(replaced)} sockets)")
for group_name, node_name, old_name, old_path in replaced:
    print(f"  {group_name} :: {node_name}: {old_name} ({old_path or 'no path'})")
