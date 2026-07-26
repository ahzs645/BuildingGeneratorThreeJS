"""Report Blender VectorFont source and PackedFile capabilities.

Run with:
  blender --background file.blend --python tools/blender_font_packaging_probe.py

This intentionally reports metadata only. It never prints or writes font bytes.
"""
import bpy
import json
import os


def font_record(font):
    authored_path = getattr(font, "filepath", "") or ""
    packed_file = getattr(font, "packed_file", None)
    resolved_path = (
        bpy.path.abspath(authored_path)
        if authored_path and authored_path != "<builtin>"
        else ""
    )
    record = {
        "name": font.name,
        "filepath": authored_path,
        "builtin": not authored_path or authored_path == "<builtin>",
        "packed": packed_file is not None,
        "external_available": bool(resolved_path and os.path.isfile(resolved_path)),
    }
    if packed_file is not None:
        record["packed_size"] = int(getattr(packed_file, "size", 0))
        try:
            data = packed_file.data
            record["packed_data_type"] = type(data).__name__
            record["packed_data_length"] = len(data)
            record["packed_data_bytes_convertible"] = len(bytes(data)) == len(data)
        except Exception as error:
            record["packed_data_error"] = repr(error)
    return record


print("FONT_PACKAGING_PROBE " + json.dumps(
    [font_record(font) for font in bpy.data.fonts],
    sort_keys=True,
))
