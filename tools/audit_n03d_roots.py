"""Measure one authored Blender result for every distinct N03D root family.

Usage:
  blender --background FILE.blend --python tools/audit_n03d_roots.py -- OUT.json
"""

import json
import os
import signal
import sys
import time

import bpy

sys.path.insert(0, os.path.dirname(__file__))
from parity_sweep import bbox_for_mesh, clear_evaluated_mesh, evaluated_mesh


out_path = sys.argv[sys.argv.index("--") + 1]


class EvaluationTimeout(Exception):
    pass


def on_alarm(_signum, _frame):
    raise EvaluationTimeout("evaluation exceeded 90 seconds")


signal.signal(signal.SIGALRM, on_alarm)

representatives = {}
for obj in bpy.data.objects:
    for modifier in obj.modifiers:
        if modifier.type == "NODES" and modifier.node_group is not None:
            representatives.setdefault(modifier.node_group.name, (obj, modifier))

results = []
for root_name, (obj, modifier) in sorted(representatives.items()):
    started = time.time()
    linked = False
    try:
        if obj.name not in bpy.context.view_layer.objects:
            bpy.context.scene.collection.objects.link(obj)
            linked = True
            bpy.context.view_layer.update()
        signal.alarm(90)
        evaluated, mesh, cleanup = evaluated_mesh(obj)
        try:
            result = {
                "root": root_name,
                "object": obj.name,
                "modifier": modifier.name,
                "status": "ok",
                "verts": len(mesh.vertices),
                "faces": len(mesh.polygons),
                "bbox": bbox_for_mesh(mesh),
                "materials": [material.name if material else None for material in mesh.materials],
            }
        finally:
            clear_evaluated_mesh(evaluated, mesh, cleanup)
    except Exception as error:
        result = {
            "root": root_name,
            "object": obj.name,
            "modifier": modifier.name,
            "status": "error",
            "error": f"{type(error).__name__}: {error}",
        }
    finally:
        signal.alarm(0)
        if linked and obj.name in bpy.context.scene.collection.objects:
            bpy.context.scene.collection.objects.unlink(obj)
    result["elapsed_ms"] = round((time.time() - started) * 1000, 1)
    results.append(result)
    print(f"N03D_ROOT_AUDIT {root_name}: {result['status']} {result.get('verts', '-')} / {result.get('faces', '-')}")

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(results, handle, indent=2)
print(f"N03D_ROOT_AUDIT_OK {len(results)} roots -> {out_path}")
