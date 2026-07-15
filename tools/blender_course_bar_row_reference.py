"""Extract focused Blender geometry for the Intro Node Panels socket row.

Run with Blender 5.x:
  blender SOURCE.blend --background --python tools/blender_course_bar_row_reference.py -- OUT.json
"""

import json
import sys

import bpy


def input_by_identifier(node, identifier):
    return next(socket for socket in node.inputs if socket.identifier == identifier)


def group_node(wrapper, node_tree, values):
    node = wrapper.nodes.new("GeometryNodeGroup")
    node.node_tree = node_tree
    for identifier, value in values.items():
        input_by_identifier(node, identifier).default_value = value
    return node


def wrapper_object(stage):
    wrapper = bpy.data.node_groups.new(f"bar-row-reference-{stage}", "GeometryNodeTree")
    wrapper.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    output = wrapper.nodes.new("NodeGroupOutput")

    socket_shape = group_node(wrapper, bpy.data.node_groups["socket shapes"], {
        "Input_0": 1,
        "Input_2": 1,
    })
    if stage == "socket_shape":
        geometry = socket_shape.outputs["Instances"]
    elif stage == "line_thickness":
        line = group_node(wrapper, bpy.data.node_groups["line thiccness"], {})
        wrapper.links.new(socket_shape.outputs["Instances"], input_by_identifier(line, "Input_1"))
        geometry = line.outputs["Mesh"]
    elif stage == "bar_row":
        row = group_node(wrapper, bpy.data.node_groups["BAR ROWS"], {
            "Input_9": 2,
            "Input_10": "Selection",
            "Input_0": 3.8399996757507324,
            "Input_1": 0.10999999940395355,
            "Input_5": True,
            "Input_3": 1,
            "Input_4": 1,
            "Input_6": False,
            "Input_7": 0,
            "Input_8": 0,
            "Input_11": True,
            "Socket_0": "Radius",
            "Socket_1": "1.000",
        })
        geometry = row.outputs["Mesh"]
    else:
        raise ValueError(stage)

    realize = wrapper.nodes.new("GeometryNodeRealizeInstances")
    wrapper.links.new(geometry, realize.inputs["Geometry"])
    wrapper.links.new(realize.outputs["Geometry"], output.inputs["Geometry"])
    mesh = bpy.data.meshes.new(f"bar-row-reference-{stage}")
    obj = bpy.data.objects.new(f"bar-row-reference-{stage}", mesh)
    bpy.context.scene.collection.objects.link(obj)
    modifier = obj.modifiers.new("GeometryNodes", "NODES")
    modifier.node_group = wrapper
    return obj


def summary(obj):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    points = [[float(value) for value in vertex.co] for vertex in mesh.vertices]
    if not points:
        evaluated.to_mesh_clear()
        return {"verts": 0, "faces": 0, "bounds": None, "extrema": [], "samples": []}
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
    payload = {
        "verts": len(points),
        "faces": len(mesh.polygons),
        "bounds": bounds,
        "extrema": extrema,
        "samples": [{"index": index, "position": points[index]} for index in sample_indices],
    }
    evaluated.to_mesh_clear()
    return payload


def main():
    output = sys.argv[sys.argv.index("--") + 1]
    payload = {
        "blender": bpy.app.version_string,
        "parameters": {"instance_scale": 0.27000004053115845, "profile_radius": 0.006489999771118164},
        "stages": {},
    }
    for stage in ("socket_shape", "line_thickness", "bar_row"):
        payload["stages"][stage] = summary(wrapper_object(stage))
        print(stage, payload["stages"][stage]["verts"], payload["stages"][stage]["faces"])
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


main()
