"""Extract named packed Blender images byte-for-byte and write a portable manifest.

Usage:
  blender --background source.blend --python tools/extract_packed_images.py -- OUT_DIR IMAGE_NAME...
"""
import json
import re
import sys
from pathlib import Path

import bpy


args = sys.argv[sys.argv.index("--") + 1:]
if len(args) < 2:
    raise SystemExit("expected output directory and at least one Blender image name")

output_dir = Path(args[0])
wanted = args[1:]
output_dir.mkdir(parents=True, exist_ok=True)


def safe_filename(name: str) -> str:
    source = Path(name)
    stem = re.sub(r"[^a-z0-9]+", "-", source.stem.lower()).strip("-") or "image"
    suffix = source.suffix.lower() or ".bin"
    return f"{stem}{suffix}"


images = {}
missing = []
for name in wanted:
    image = bpy.data.images.get(name)
    packed = image.packed_file if image else None
    if packed is None:
        missing.append(name)
        continue
    filename = safe_filename(name)
    (output_dir / filename).write_bytes(bytes(packed.data))
    images[name] = {
        "file": filename,
        "width": int(image.size[0]),
        "height": int(image.size[1]),
        "bytes": len(packed.data),
    }
    print(f"PACKED_IMAGE_OK {name} -> {filename}")

(output_dir / "manifest.json").write_text(json.dumps({
    "source": Path(bpy.data.filepath).name,
    "images": images,
    "missing": missing,
}, indent=2) + "\n", encoding="utf-8")
print(f"PACKED_IMAGE_MANIFEST -> {output_dir / 'manifest.json'}")
