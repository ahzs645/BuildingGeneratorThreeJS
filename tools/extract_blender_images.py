"""Extract named packed Blender images as web-ready PNG files.

Usage:
  blender --background FILE.blend --python tools/extract_blender_images.py -- \
    OUT_DIR "Blender Image Name=output-name.png" [...]

The script copies image pixels through a temporary datablock so the source
blend remains untouched. Non-color maps retain their linear channel values;
sRGB color maps retain their declared source color space.
"""
import json
import os
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1:]
if len(args) < 2:
    raise RuntimeError("expected OUT_DIR and at least one IMAGE_NAME=OUTPUT_NAME mapping")

output_dir = os.path.abspath(args[0])
os.makedirs(output_dir, exist_ok=True)
results = []

for mapping in args[1:]:
    source_name, separator, output_name = mapping.partition("=")
    if not separator or not source_name or not output_name:
        raise RuntimeError(f"invalid image mapping: {mapping}")
    source = bpy.data.images.get(source_name)
    if source is None:
        raise KeyError(f"image not found: {source_name}")
    if source.size[0] <= 0 or source.size[1] <= 0:
        raise RuntimeError(f"image has no pixels: {source_name}")

    target = bpy.data.images.new(
        f"__NODE_DOJO_EXTRACT_{source_name}",
        width=source.size[0],
        height=source.size[1],
        alpha=source.channels == 4,
        float_buffer=False,
        is_data=source.colorspace_settings.is_data,
    )
    target.colorspace_settings.name = source.colorspace_settings.name
    target.pixels.foreach_set(source.pixels[:])
    target.file_format = "PNG"
    target.filepath_raw = os.path.join(output_dir, output_name)
    target.save()
    results.append(
        {
            "source": source_name,
            "output": target.filepath_raw,
            "size": list(source.size),
            "channels": source.channels,
            "color_space": source.colorspace_settings.name,
            "packed": source.packed_file is not None,
        }
    )
    bpy.data.images.remove(target)

print(f"BLENDER_IMAGES_EXTRACTED {json.dumps(results, sort_keys=True)}")
