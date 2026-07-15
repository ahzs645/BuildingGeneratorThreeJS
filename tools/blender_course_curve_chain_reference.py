"""Generate the Blender reference for the Intro Node Panels rounded curve chain.

Run with Blender 5.x:
  blender --background --factory-startup --python tools/blender_course_curve_chain_reference.py -- OUT.json
"""

import json
import sys

import bpy


WIDTH = 3.84
HEIGHT = 0.44
RADIUS = 0.15
COUNT = 266
LENGTH = 0.015


def socket(node, name):
    return next(item for item in node.inputs if item.name == name)


def build(stage):
    mesh = bpy.data.meshes.new(f"curve-chain-{stage}")
    obj = bpy.data.objects.new(f"curve-chain-{stage}", mesh)
    bpy.context.scene.collection.objects.link(obj)

    group = bpy.data.node_groups.new(f"curve-chain-{stage}", "GeometryNodeTree")
    group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    output = group.nodes.new("NodeGroupOutput")
    quad = group.nodes.new("GeometryNodeCurvePrimitiveQuadrilateral")
    quad.mode = "RECTANGLE"
    socket(quad, "Width").default_value = WIDTH
    socket(quad, "Height").default_value = HEIGHT

    spline_type = group.nodes.new("GeometryNodeCurveSplineType")
    spline_type.spline_type = "BEZIER"
    group.links.new(quad.outputs["Curve"], spline_type.inputs["Curve"])

    fillet = group.nodes.new("GeometryNodeFilletCurve")
    socket(fillet, "Radius").default_value = RADIUS
    socket(fillet, "Limit Radius").default_value = False
    socket(fillet, "Mode").default_value = "Poly"
    socket(fillet, "Count").default_value = COUNT
    group.links.new(spline_type.outputs["Curve"], fillet.inputs["Curve"])

    resample = group.nodes.new("GeometryNodeResampleCurve")
    socket(resample, "Mode").default_value = "Length"
    socket(resample, "Length").default_value = LENGTH
    group.links.new(fillet.outputs["Curve"], resample.inputs["Curve"])

    stages = {
        "quadrilateral": quad.outputs["Curve"],
        "bezier": spline_type.outputs["Curve"],
        "fillet": fillet.outputs["Curve"],
        "resample": resample.outputs["Curve"],
    }
    to_points = group.nodes.new("GeometryNodeCurveToPoints")
    to_points.mode = "EVALUATED"
    vertex = group.nodes.new("GeometryNodeMeshLine")
    socket(vertex, "Count").default_value = 1
    instances = group.nodes.new("GeometryNodeInstanceOnPoints")
    realize = group.nodes.new("GeometryNodeRealizeInstances")
    group.links.new(stages[stage], to_points.inputs["Curve"])
    group.links.new(to_points.outputs["Points"], instances.inputs["Points"])
    group.links.new(vertex.outputs["Mesh"], instances.inputs["Instance"])
    group.links.new(instances.outputs["Instances"], realize.inputs["Geometry"])
    group.links.new(realize.outputs["Geometry"], output.inputs["Geometry"])
    modifier = obj.modifiers.new("GeometryNodes", "NODES")
    modifier.node_group = group
    return obj


def evaluated_points(obj):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    data = evaluated.to_mesh()
    if data is not None and len(data.vertices):
        points = [[float(value) for value in vertex.co] for vertex in data.vertices]
        evaluated.to_mesh_clear()
        return points
    data = evaluated.data
    if hasattr(data, "points"):
        return [[float(value) for value in point.position] for point in data.points]
    return [[float(value) for value in vertex.co] for vertex in data.vertices]


def summary(points):
    bounds = {
        "min": [min(point[axis] for point in points) for axis in range(3)],
        "max": [max(point[axis] for point in points) for axis in range(3)],
    }
    extrema = []
    for axis in range(3):
        extrema.append({
            "min_index": min(range(len(points)), key=lambda index: points[index][axis]),
            "max_index": max(range(len(points)), key=lambda index: points[index][axis]),
        })
    sample_indices = sorted(set(
        [0, len(points) // 4, len(points) // 2, (len(points) * 3) // 4, len(points) - 1]
        + [item[key] for item in extrema for key in ("min_index", "max_index")]
    ))
    return {
        "count": len(points),
        "bounds": bounds,
        "extrema": extrema,
        "samples": [{"index": index, "position": points[index]} for index in sample_indices],
    }


def main():
    output = sys.argv[sys.argv.index("--") + 1]
    payload = {
        "blender": bpy.app.version_string,
        "parameters": {
            "width": WIDTH,
            "height": HEIGHT,
            "radius": RADIUS,
            "count": COUNT,
            "length": LENGTH,
        },
        "stages": {},
    }
    for stage in ("quadrilateral", "bezier", "fillet", "resample"):
        payload["stages"][stage] = summary(evaluated_points(build(stage)))
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


main()
