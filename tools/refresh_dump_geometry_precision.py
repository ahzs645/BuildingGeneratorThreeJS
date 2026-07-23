"""Copy full-precision object geometry from a freshly extracted dump.

Usage:
  python tools/refresh_dump_geometry_precision.py TARGET.json FRESH.json [--keys=KEY,...]
    [--mesh-fields=FIELD,...] [--curve-fields=FIELD,...]
    [--evaluated-mesh-fields=FIELD,...] OBJECT [OBJECT ...]

This deliberately leaves the target dump's graph, dependency closure, fonts,
and extraction metadata unchanged. It is useful when re-extracting an older
portable graph after dump_blend.py's coordinate precision improves.
"""

import json
import struct
import sys


target_path, fresh_path, *arguments = sys.argv[1:]
precision_keys = ("matrix_world", "relative_matrices", "mesh", "curves", "evaluated_mesh")
mesh_fields = None
curve_fields = None
evaluated_mesh_fields = None
if arguments and arguments[0].startswith("--keys="):
    selected = tuple(key for key in arguments.pop(0).removeprefix("--keys=").split(",") if key)
    unknown = sorted(set(selected) - set(precision_keys))
    if unknown:
        raise SystemExit(f"unknown precision keys: {', '.join(unknown)}")
    precision_keys = selected
if arguments and arguments[0].startswith("--mesh-fields="):
    mesh_fields = tuple(
        field for field in arguments.pop(0).removeprefix("--mesh-fields=").split(",") if field
    )
if arguments and arguments[0].startswith("--curve-fields="):
    curve_fields = tuple(
        field for field in arguments.pop(0).removeprefix("--curve-fields=").split(",") if field
    )
if arguments and arguments[0].startswith("--evaluated-mesh-fields="):
    evaluated_mesh_fields = tuple(
        field
        for field in arguments.pop(0).removeprefix("--evaluated-mesh-fields=").split(",")
        if field
    )
object_names = arguments
if not object_names:
    raise SystemExit(
        "usage: TARGET.json FRESH.json [--keys=KEY,...] [--mesh-fields=FIELD,...] "
        "[--curve-fields=FIELD,...] [--evaluated-mesh-fields=FIELD,...] OBJECT [OBJECT ...]"
    )

with open(target_path, encoding="utf-8") as handle:
    target = json.load(handle)
with open(fresh_path, encoding="utf-8") as handle:
    fresh = json.load(handle)

target_objects = {item["name"]: item for item in target.get("objects", [])}
fresh_objects = {item["name"]: item for item in fresh.get("objects", [])}
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
            if key == "mesh" and mesh_fields is not None and isinstance(old.get(key), dict):
                for field in mesh_fields:
                    if field in new[key]:
                        old[key][field] = shortest_float32(new[key][field])
                    else:
                        old[key].pop(field, None)
            elif key == "curves" and curve_fields is not None and isinstance(old.get(key), list):
                if len(old[key]) != len(new[key]):
                    raise ValueError(f"curve spline count changed for {name}: {len(old[key])} -> {len(new[key])}")
                for old_spline, new_spline in zip(old[key], new[key]):
                    for field in curve_fields:
                        if field in new_spline:
                            old_spline[field] = shortest_float32(new_spline[field])
                        else:
                            old_spline.pop(field, None)
            elif (
                key == "evaluated_mesh"
                and evaluated_mesh_fields is not None
                and isinstance(old.get(key), dict)
            ):
                for field in evaluated_mesh_fields:
                    if field in new[key]:
                        old[key][field] = shortest_float32(new[key][field])
                    else:
                        old[key].pop(field, None)
            elif key == "evaluated_mesh" and isinstance(old.get(key), dict):
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
