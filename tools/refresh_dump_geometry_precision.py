"""Copy full-precision object geometry from a freshly extracted dump.

Usage:
  python tools/refresh_dump_geometry_precision.py TARGET.json FRESH.json OBJECT [OBJECT ...]

This deliberately leaves the target dump's graph, dependency closure, fonts,
and extraction metadata unchanged. It is useful when re-extracting an older
portable graph after dump_blend.py's coordinate precision improves.
"""

import json
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

for name in object_names:
    if name not in target_objects or name not in fresh_objects:
        raise KeyError(f"object missing from one dump: {name}")
    old = target_objects[name]
    new = fresh_objects[name]
    for key in precision_keys:
        if key in new:
            old[key] = new[key]
        else:
            old.pop(key, None)

with open(target_path, "w", encoding="utf-8") as handle:
    json.dump(target, handle, indent=1)
    handle.write("\n")

print(f"REFRESH_DUMP_GEOMETRY_PRECISION_OK: {', '.join(object_names)} -> {target_path}")
