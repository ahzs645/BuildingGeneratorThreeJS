"""Save a copy of a Node Dojo file with Bradley preset links repaired."""

import os
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1 :]
destination, preset_path = map(os.path.abspath, args[:2])
updated = []

for library in bpy.data.libraries:
    if os.path.basename(library.filepath).lower().startswith("preset.blend"):
        library.filepath = preset_path
        updated.append(library.name)

os.makedirs(os.path.dirname(destination), exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=destination)
print(f"ND_REPAIRED|{destination}|libraries={updated}|preset={preset_path}")
