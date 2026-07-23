"""Audit source mesh payloads that portable graph dumps must preserve.

Usage:
  blender --background FILE.blend --python tools/audit_blender_mesh_payloads.py -- \
    CATALOG.json OUT.json
"""

import json
import os
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) < 2:
    raise SystemExit("usage: CATALOG.json OUT.json")
catalog_path, out_path = map(os.path.abspath, args[:2])
with open(catalog_path, "r", encoding="utf8") as handle:
    catalog = json.load(handle)

records = []
for entry in catalog:
    if not entry.get("dump", "").startswith("dojo/n03d/"):
        continue
    obj = bpy.data.objects.get(entry.get("object", ""))
    if obj is None or obj.type != "MESH" or obj.data is None:
        continue
    mesh = obj.data
    color_attributes = []
    for attribute in mesh.attributes:
        if attribute.data_type not in {"FLOAT_COLOR", "BYTE_COLOR"}:
            continue
        unique = set()
        for item in attribute.data:
            unique.add(tuple(round(float(component), 8) for component in item.color))
            if len(unique) > 16:
                break
        color_attributes.append({
            "name": attribute.name,
            "domain": attribute.domain,
            "dataType": attribute.data_type,
            "count": len(attribute.data),
            "uniqueValues": [list(value) for value in sorted(unique)] if len(unique) <= 16 else None,
        })
    slots = [material.name if material else None for material in mesh.materials]
    material_indices = sorted({polygon.material_index for polygon in mesh.polygons})
    if color_attributes or any(material is None for material in slots) or (
        material_indices and material_indices[-1] >= len(slots)
    ):
        records.append({
            "id": entry.get("id"),
            "object": obj.name,
            "vertices": len(mesh.vertices),
            "faces": len(mesh.polygons),
            "materialSlots": slots,
            "materialIndices": material_indices,
            "colorAttributes": color_attributes,
        })

with open(out_path, "w", encoding="utf8") as handle:
    json.dump({"blenderVersion": bpy.app.version_string, "records": records}, handle, indent=2)
print(f"BLENDER_MESH_PAYLOAD_AUDIT_OK {len(records)} -> {out_path}")
