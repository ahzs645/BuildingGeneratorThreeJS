"""Report summary statistics for named attributes on an evaluated Blender object.

Usage:
  blender --background FILE.blend --python tools/blender-attribute-probe.py -- \
    OBJECT OUT.json ATTRIBUTE [ATTRIBUTE ...]
"""
import json
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) < 3:
    raise SystemExit("usage: OBJECT OUT.json ATTRIBUTE [ATTRIBUTE ...]")
object_name, out_path, *attribute_names = args
obj = bpy.data.objects.get(object_name)
if obj is None:
    raise RuntimeError(f"object not found: {object_name!r}")

scene = bpy.data.scenes.new("__NODE_DOJO_ATTRIBUTE_PROBE_SCENE")
scene.collection.objects.link(obj)
bpy.context.window.scene = scene
obj.hide_viewport = False
obj.hide_render = False
obj.hide_set(False)
obj.location = (0, 0, 0)
obj.rotation_euler = (0, 0, 0)
obj.scale = (1, 1, 1)
bpy.context.view_layer.update()

evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
try:
    summaries = {}
    for name in attribute_names:
        attribute = mesh.attributes.get(name)
        if attribute is None:
            summaries[name] = None
            continue
        if attribute.data_type in {"FLOAT_COLOR", "BYTE_COLOR"}:
            values = [list(item.color) for item in attribute.data]
        elif attribute.data_type == "FLOAT_VECTOR":
            values = [list(item.vector) for item in attribute.data]
        else:
            values = [float(item.value) for item in attribute.data]
        if values and isinstance(values[0], list):
            average = [sum(value[channel] for value in values) / len(values) for channel in range(len(values[0]))]
        else:
            average = sum(values) / len(values) if values else None
        summaries[name] = {
            "domain": attribute.domain,
            "data_type": attribute.data_type,
            "count": len(values),
            "average": average,
            "sample": values[:8],
        }
    payload = {
        "object": obj.name,
        "verts": len(mesh.vertices),
        "faces": len(mesh.polygons),
        "attributes": summaries,
    }
finally:
    evaluated.to_mesh_clear()

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
print(f"BLENDER_ATTRIBUTE_PROBE_OK -> {out_path}")
