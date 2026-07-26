"""Extract explicitly selected packed Blender fonts to an external directory.

Run with:
  blender --background source.blend --python tools/extract_packed_fonts.py -- \
    OUTPUT_DIR "Blender Font Datablock=Output Font.ttf" [...]

The command refuses to overwrite files and only extracts fonts that are packed
inside the open .blend. Keep extracted commercial fonts outside the repository
and review their licences before redistribution.
"""
import bpy
import hashlib
import json
import os
import sys


args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) < 2:
    raise RuntimeError(
        "expected OUTPUT_DIR and one or more 'Font Datablock=filename' mappings"
    )

output_dir = os.path.abspath(args[0])
os.makedirs(output_dir, exist_ok=True)

records = []
for spec in args[1:]:
    if "=" not in spec:
        raise RuntimeError(f"invalid packed-font mapping: {spec!r}")
    datablock_name, filename = spec.split("=", 1)
    if os.path.basename(filename) != filename or filename in ("", ".", ".."):
        raise RuntimeError(f"output must be a plain filename: {filename!r}")
    font = bpy.data.fonts.get(datablock_name)
    if font is None:
        raise RuntimeError(f"font datablock not found: {datablock_name!r}")
    if font.packed_file is None:
        raise RuntimeError(f"font is not packed: {datablock_name!r}")
    output_path = os.path.join(output_dir, filename)
    if os.path.exists(output_path):
        raise RuntimeError(f"refusing to overwrite existing file: {output_path}")
    data = bytes(font.packed_file.data)
    with open(output_path, "xb") as handle:
        handle.write(data)
    records.append(
        {
            "datablock": font.name,
            "authored_filepath": font.filepath,
            "output": output_path,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
    )

print("PACKED_FONT_EXTRACTION_OK " + json.dumps(records, sort_keys=True))
