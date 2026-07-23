"""Extract Blender references for the two Intro Node Panels parent groups.

Run with Blender 5.x:
  blender SOURCE.blend --background --python tools/blender_course_node_panel_reference.py -- OUT.json
"""

import json
import sys

import bpy


ROOT_GROUP = "Geometry Nodes.023"
PARENT_NODES = ("Group.002", "Group.001")


def copy_socket_value(source, target):
    if not hasattr(source, "default_value") or not hasattr(target, "default_value"):
        return
    value = source.default_value
    try:
        target.default_value = value[:] if hasattr(value, "__len__") and not isinstance(value, str) else value
    except (TypeError, ValueError):
        target.default_value = value


def wrapper_object(source_node):
    wrapper = bpy.data.node_groups.new(f"node-panel-reference-{source_node.name}", "GeometryNodeTree")
    wrapper.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    output = wrapper.nodes.new("NodeGroupOutput")
    group = wrapper.nodes.new("GeometryNodeGroup")
    group.node_tree = source_node.node_tree
    for source_input in source_node.inputs:
        target = next((item for item in group.inputs if item.identifier == source_input.identifier), None)
        if target is not None:
            copy_socket_value(source_input, target)
    realize = wrapper.nodes.new("GeometryNodeRealizeInstances")
    wrapper.links.new(group.outputs[0], realize.inputs["Geometry"])
    wrapper.links.new(realize.outputs["Geometry"], output.inputs["Geometry"])
    mesh = bpy.data.meshes.new(f"node-panel-reference-{source_node.name}")
    obj = bpy.data.objects.new(f"node-panel-reference-{source_node.name}", mesh)
    bpy.context.scene.collection.objects.link(obj)
    modifier = obj.modifiers.new("GeometryNodes", "NODES")
    modifier.node_group = wrapper
    return obj


def bounds(points):
    if not points:
        return None
    return {
        "min": [min(point[axis] for point in points) for axis in range(3)],
        "max": [max(point[axis] for point in points) for axis in range(3)],
    }


def summary(obj):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    points = [[float(value) for value in vertex.co] for vertex in mesh.vertices]
    by_material = {}
    for polygon in mesh.polygons:
        slot = mesh.materials[polygon.material_index] if polygon.material_index < len(mesh.materials) else None
        material = slot.name if slot is not None else None
        indices = by_material.setdefault(material or "<none>", set())
        indices.update(polygon.vertices)
    payload = {
        "verts": len(mesh.vertices),
        "faces": len(mesh.polygons),
        "bounds": bounds(points),
        "materials": {
            material: {
                "vertices": len(indices),
                "bounds": bounds([points[index] for index in indices]),
            }
            for material, indices in sorted(by_material.items())
        },
    }
    evaluated.to_mesh_clear()
    return payload


def main():
    output = sys.argv[sys.argv.index("--") + 1]
    root = bpy.data.node_groups[ROOT_GROUP]
    payload = {"blender": bpy.app.version_string, "root": ROOT_GROUP, "stages": {}}
    for node_name in PARENT_NODES:
        node = root.nodes[node_name]
        payload["stages"][node_name] = {
            "group": node.node_tree.name,
            "inputs": {
                socket.identifier: socket.default_value
                for socket in node.inputs
                if hasattr(socket, "default_value") and isinstance(socket.default_value, (str, int, float, bool))
            },
            "geometry": summary(wrapper_object(node)),
        }
        print(node_name, payload["stages"][node_name]["geometry"]["verts"])
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")


main()
