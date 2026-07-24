"""Evaluate a Geometry Nodes group on a canonical cube for UV consumer probes.

Usage:
  blender --background asset.blend --python tools/uv_unwrap_blender_probe.py -- \
    "orient print by face"
"""

import json
import math
import sys

import bpy


def arguments():
    separator = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    return sys.argv[separator + 1 :]


def cube_mesh(name):
    vertices = [
        (-0.5, -0.5, -0.5),
        (0.5, -0.5, -0.5),
        (0.5, 0.5, -0.5),
        (-0.5, 0.5, -0.5),
        (-0.5, -0.5, 0.5),
        (0.5, -0.5, 0.5),
        (0.5, 0.5, 0.5),
        (-0.5, 0.5, 0.5),
    ]
    faces = [
        (0, 3, 2, 1),
        (4, 5, 6, 7),
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
    ]
    mesh = bpy.data.meshes.new(f"{name} Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    return mesh


def evaluate(group_name):
    group = bpy.data.node_groups.get(group_name)
    if group is None:
        raise RuntimeError(f"Geometry Nodes group not found: {group_name}")
    probe = bpy.data.objects.new(
        f"UV Probe {group_name}",
        cube_mesh(f"UV Probe {group_name}"),
    )
    bpy.context.scene.collection.objects.link(probe)
    modifier = probe.modifiers.new(name="UV Probe", type="NODES")
    modifier.node_group = group
    for item in group.interface.items_tree:
        if (
            item.item_type == "SOCKET"
            and item.in_out == "INPUT"
            and item.name == "Surface Selection"
        ):
            modifier[item.identifier] = True
    bpy.context.view_layer.update()
    evaluated = probe.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    try:
        mesh.calc_loop_triangles()
        positions = [[float(value) for value in vertex.co] for vertex in mesh.vertices]
        finite = all(math.isfinite(value) for point in positions for value in point)
        bounds = {
            "min": [
                min((point[axis] for point in positions), default=0.0)
                for axis in range(3)
            ],
            "max": [
                max((point[axis] for point in positions), default=0.0)
                for axis in range(3)
            ],
        }
        return {
            "group": group_name,
            "vertices": len(mesh.vertices),
            "faces": len(mesh.polygons),
            "triangles": len(mesh.loop_triangles),
            "finite": finite,
            "bounds": bounds,
        }
    finally:
        evaluated.to_mesh_clear()


for requested_group in arguments():
    print("UV_UNWRAP_PROBE " + json.dumps(evaluate(requested_group), sort_keys=True))
