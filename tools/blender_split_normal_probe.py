"""Report Blender's source and evaluated split-normal contract for one object.

Usage:
  blender --background FILE.blend --python tools/blender_split_normal_probe.py -- \
    OBJECT_NAME [OUT.json]
"""

import json
import math
import sys

import bpy


def args_after_dash():
    if "--" not in sys.argv:
        raise SystemExit("missing -- OBJECT_NAME [OUT.json]")
    args = sys.argv[sys.argv.index("--") + 1 :]
    if not args:
        raise SystemExit("missing OBJECT_NAME")
    return args


def vec3(value):
    return [float(value[0]), float(value[1]), float(value[2])]


def rounded(value, digits=8):
    return [round(component, digits) for component in vec3(value)]


def normal_angle(a, b):
    dot = max(-1.0, min(1.0, sum(a[i] * b[i] for i in range(3))))
    return math.degrees(math.acos(dot))


def mesh_report(mesh):
    # Accessing corner_normals forces Blender to calculate the current split
    # normals. In Blender 4.x this supersedes the removed calc_normals_split().
    corner_normals = [vec3(item.vector) for item in mesh.corner_normals]
    vertex_normals = [vec3(item.normal) for item in mesh.vertices]
    smooth_faces = sum(1 for polygon in mesh.polygons if polygon.use_smooth)
    sharp_edges = sum(1 for edge in mesh.edges if getattr(edge, "use_edge_sharp", False))
    max_corner_vertex_angle = 0.0
    split_corners = 0
    point_corner_normals = {}
    for loop, corner_normal in zip(mesh.loops, corner_normals):
        vertex_normal = vertex_normals[loop.vertex_index]
        angle = normal_angle(corner_normal, vertex_normal)
        max_corner_vertex_angle = max(max_corner_vertex_angle, angle)
        if angle > 1e-4:
            split_corners += 1
        point_corner_normals.setdefault(loop.vertex_index, set()).add(
            tuple(round(component, 7) for component in corner_normal)
        )
    split_points = sum(1 for normals in point_corner_normals.values() if len(normals) > 1)
    max_normals_per_point = max((len(normals) for normals in point_corner_normals.values()), default=0)
    samples = []
    for loop, corner_normal in zip(mesh.loops, corner_normals):
        vertex_normal = vertex_normals[loop.vertex_index]
        angle = normal_angle(corner_normal, vertex_normal)
        if angle > 1e-4:
            samples.append({
                "corner": loop.index,
                "point": loop.vertex_index,
                "cornerNormal": rounded(corner_normal),
                "pointNormal": rounded(vertex_normal),
                "angleDegrees": round(angle, 6),
            })
        if len(samples) >= 12:
            break
    return {
        "vertices": len(mesh.vertices),
        "edges": len(mesh.edges),
        "faces": len(mesh.polygons),
        "corners": len(mesh.loops),
        "smoothFaces": smooth_faces,
        "flatFaces": len(mesh.polygons) - smooth_faces,
        "sharpEdges": sharp_edges,
        "splitPoints": split_points,
        "splitCornersVsPointNormal": split_corners,
        "maxNormalsPerPoint": max_normals_per_point,
        "maxCornerPointAngleDegrees": round(max_corner_vertex_angle, 6),
        "splitSamples": samples,
    }


def evaluated_mesh(obj):
    # Mixed geometry sets can contain instances that Object.to_mesh() silently
    # omits. Match the parity harness by appending a temporary realization pass.
    realize_group = bpy.data.node_groups.new("__NORMAL_PROBE_REALIZE_INSTANCES", "GeometryNodeTree")
    realize_group.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    realize_group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    group_input = realize_group.nodes.new("NodeGroupInput")
    realize = realize_group.nodes.new("GeometryNodeRealizeInstances")
    group_output = realize_group.nodes.new("NodeGroupOutput")
    realize_group.links.new(group_input.outputs["Geometry"], realize.inputs["Geometry"])
    realize_group.links.new(realize.outputs["Geometry"], group_output.inputs["Geometry"])
    realize_modifier = obj.modifiers.new(name="__NORMAL_PROBE_REALIZE_INSTANCES", type="NODES")
    realize_modifier.node_group = realize_group
    obj.update_tag()
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    depsgraph.update()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
    if mesh is None:
        raise RuntimeError(f'evaluated object "{obj.name}" did not produce a mesh')
    return evaluated, mesh, realize_modifier, realize_group


args = args_after_dash()
object_name = args[0]
out_path = args[1] if len(args) > 1 else None
obj = bpy.data.objects.get(object_name)
if obj is None:
    raise RuntimeError(f'object "{object_name}" not found')
if obj.type != "MESH":
    raise RuntimeError(f'object "{object_name}" is {obj.type}, not MESH')

report = {
    "object": object_name,
    "source": mesh_report(obj.data),
}
evaluated, mesh, realize_modifier, realize_group = evaluated_mesh(obj)
try:
    report["evaluated"] = mesh_report(mesh)
finally:
    evaluated.to_mesh_clear()
    obj.modifiers.remove(realize_modifier)
    bpy.data.node_groups.remove(realize_group)

payload = json.dumps(report, indent=2)
print(payload)
if out_path:
    with open(out_path, "w", encoding="utf8") as handle:
        handle.write(payload + "\n")
