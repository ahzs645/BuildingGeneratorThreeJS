"""Save a comparison copy with one Geometry Nodes modifier input overridden.

Usage:
    blender --background source.blend --python tools/prepare_modifier_override_blend.py -- \
        OBJECT "INPUT NAME" 'JSON_VALUE' output.blend
"""
import bpy
import json
import os
import sys


object_name, input_name, raw_value, output_path = sys.argv[sys.argv.index("--") + 1 :][:4]
obj = bpy.data.objects[object_name]
modifier = next(item for item in obj.modifiers if item.type == "NODES" and item.node_group)
socket = next(
    item for item in modifier.node_group.interface.items_tree
    if item.item_type == "SOCKET" and item.in_out == "INPUT" and item.name == input_name
)
modifier[socket.identifier] = json.loads(raw_value)
obj.update_tag()
bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(output_path), compress=True)
print(f"MODIFIER_OVERRIDE_BLEND_OK {object_name} :: {input_name} -> {output_path}")
