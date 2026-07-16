"""Copy full-precision object geometry from a freshly extracted dump.

Usage:
  python tools/refresh_dump_geometry_precision.py TARGET.json FRESH.json OBJECT [OBJECT ...]

This deliberately leaves the target dump's graph, dependency closure, fonts,
and extraction metadata unchanged. It is useful when re-extracting an older
portable graph after dump_blend.py's coordinate precision improves.
"""

import json
import struct
import sys


target_path, fresh_path, *object_names = sys.argv[1:]
if not object_names:
    raise SystemExit("usage: TARGET.json FRESH.json OBJECT [OBJECT ...]")

with open(target_path, encoding="utf-8") as handle:
    target = json.load(handle)
with open(fresh_path, encoding="utf-8") as handle:
    fresh = json.load(handle)

target_objects = {item["name"]: item for item in target.get("objects", [])}
fresh_objects = {item["name"]: item for item in fresh.get("objects", [])}
precision_keys = ("matrix_world", "relative_matrices", "mesh", "curves", "evaluated_mesh")


def shortest_float32(value):
    """Keep every Blender float bit while avoiding Python's long double spelling."""
    if isinstance(value, float):
        packed = struct.pack("!f", value)
        rounded = struct.unpack("!f", packed)[0]
        compact = float(format(rounded, ".9g"))
        assert struct.pack("!f", compact) == packed
        return compact
    if isinstance(value, list):
        return [shortest_float32(item) for item in value]
    if isinstance(value, dict):
        return {key: shortest_float32(item) for key, item in value.items()}
    return value

for name in object_names:
    if name not in target_objects or name not in fresh_objects:
        raise KeyError(f"object missing from one dump: {name}")
    old = target_objects[name]
    new = fresh_objects[name]
    for key in precision_keys:
        if key in new:
            # Blender stores these geometry and transform payloads as float32.
            # Nine significant decimal digits are sufficient for exact binary32
            # round-tripping while keeping browser dumps reasonably small.
            if key == "evaluated_mesh" and isinstance(old.get(key), dict):
                # Precision refreshes must not silently expand a portable dump
                # with optional attributes or hundreds of thousands of cached
                # edges that its existing dependency closure did not retain.
                old[key] = {
                    child: shortest_float32(new[key][child])
                    for child in old[key]
                    if child in new[key]
                }
            else:
                old[key] = shortest_float32(new[key])
        else:
            old.pop(key, None)

with open(target_path, "w", encoding="utf-8") as handle:
    json.dump(target, handle, indent=1)
    handle.write("\n")

print(f"REFRESH_DUMP_GEOMETRY_PRECISION_OK: {', '.join(object_names)} -> {target_path}")
