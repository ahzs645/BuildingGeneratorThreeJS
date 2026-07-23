"""Probe Blender's mesh BVH nearest-face result from a raw parity mesh.

Usage:
  blender --background --factory-startup --python tools/blender_mesh_proximity_probe.py -- \
    MESH.json '[x,y,z]' OUT.json
"""

import json
import sys

from mathutils import Vector
from mathutils.bvhtree import BVHTree


mesh_path, point_json, output_path = sys.argv[sys.argv.index("--") + 1 :]
with open(mesh_path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)
positions = payload["positions"]
if positions and not isinstance(positions[0], list):
    positions = [positions[index : index + 3] for index in range(0, len(positions), 3)]
faces = payload.get("faces") or payload.get("triangles")
point = json.loads(point_json)
tree = BVHTree.FromPolygons([Vector(value) for value in positions], faces, all_triangles=False, epsilon=0.0)
nearest, normal, index, distance = tree.find_nearest(Vector(point))
result = {
    "point": point,
    "position": list(nearest) if nearest is not None else None,
    "normal": list(normal) if normal is not None else None,
    "index": index,
    "distance": distance,
}
with open(output_path, "w", encoding="utf-8") as handle:
    json.dump(result, handle, indent=2)
    handle.write("\n")
print(f"BLENDER_MESH_PROXIMITY_PROBE_OK -> {output_path}")
