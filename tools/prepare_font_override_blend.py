"""Create a Blender comparison copy with missing String-to-Curves fonts replaced.

Usage:
    blender --background source.blend --python tools/prepare_font_override_blend.py -- font.ttf output.blend
    blender --background source.blend --python tools/prepare_font_override_blend.py -- \
        output.blend "Missing Font Name=font.ttf" ["Other Font=other.otf" ...]

Only font sockets whose external file is absent are changed. The source file is
never saved over, which keeps the generated reference honest and reproducible.
"""
import bpy
import json
import os
import sys


args = sys.argv[sys.argv.index("--") + 1 :]
font_map = {}
if len(args) >= 2 and all("=" in spec for spec in args[1:]):
    output_path = os.path.abspath(args[0])
    font_map = dict(spec.split("=", 1) for spec in args[1:])
else:
    font_map = json.loads(os.environ.get("NODE_DOJO_FONT_MAP", "{}"))

if font_map:
    output_path = os.path.abspath(args[0])
    replacements = {
        name: bpy.data.fonts.load(os.path.abspath(path), check_existing=True)
        for name, path in font_map.items()
    }
elif not font_map:
    font_path, output_path = args[:2]
    font_path = os.path.abspath(font_path)
    output_path = os.path.abspath(output_path)
    replacement = bpy.data.fonts.load(font_path, check_existing=True)
    replacements = None

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
        replacement = replacements.get(current.name) if replacements is not None else replacement
        if replacement is None:
            continue
        replaced.append((group.name, node.name, current.name, current_path))
        socket.default_value = replacement

if font_map:
    matched_names = {old_name for _group, _node, old_name, _path in replaced}
    missing_names = sorted(set(font_map) - matched_names)
    if missing_names:
        raise RuntimeError(f"font mapping matched no missing String to Curves socket: {missing_names}")

bpy.ops.wm.save_as_mainfile(filepath=output_path, compress=True)
print(f"FONT_OVERRIDE_BLEND_OK -> {output_path} ({len(replaced)} sockets)")
for group_name, node_name, old_name, old_path in replaced:
    print(f"  {group_name} :: {node_name}: {old_name} ({old_path or 'no path'})")
