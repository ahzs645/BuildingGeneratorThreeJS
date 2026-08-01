"""Measure Blender 5.x Volume Cube -> Volume to Mesh execution modes.

Usage:
  Blender --background --factory-startup \
    --python tools/blender_volume_to_mesh_topology_probe.py -- OUT.json
"""
import json
import sys

import bpy


out_path = sys.argv[sys.argv.index("--") + 1]


def summarize(result):
    face_sizes = {}
    signed_volume = 0.0
    radial_orientation = {"outward": 0, "inward": 0}
    edges = set()
    for polygon in result.polygons:
        face_sizes[str(len(polygon.vertices))] = face_sizes.get(str(len(polygon.vertices)), 0) + 1
        center = polygon.center
        radial_orientation["outward" if polygon.normal.dot(center) >= 0 else "inward"] += 1
        vertices = [result.vertices[index].co for index in polygon.vertices]
        for corner in range(1, len(vertices) - 1):
            signed_volume += vertices[0].dot(vertices[corner].cross(vertices[corner + 1])) / 6.0
        for corner, source in enumerate(polygon.vertices):
            target = polygon.vertices[(corner + 1) % len(polygon.vertices)]
            edges.add(tuple(sorted((source, target))))
    positions = [list(vertex.co) for vertex in result.vertices]
    return {
        "vertices": len(result.vertices),
        "edges": len(edges),
        "faces": len(result.polygons),
        "face_sizes": face_sizes,
        "signed_volume": signed_volume,
        "radial_orientation": radial_orientation,
        "bbox": {
            "min": [min(position[axis] for position in positions) for axis in range(3)],
            "max": [max(position[axis] for position in positions) for axis in range(3)],
        },
        "position_moments": {
            "abs": [sum(abs(position[axis]) for position in positions) for axis in range(3)],
            "squared": [sum(position[axis] ** 2 for position in positions) for axis in range(3)],
        },
    }


def evaluate_case(
    name,
    mode,
    threshold=0.0,
    adaptivity=0.0,
    voxel_size=0.3,
    voxel_amount=64.0,
    volume_resolution=16,
):
    mesh = bpy.data.meshes.new(f"{name} seed")
    mesh.from_pydata([(0, 0, 0)], [], [])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)

    tree = bpy.data.node_groups.new(f"{name} tree", "GeometryNodeTree")
    tree.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    tree.nodes.new("NodeGroupInput")
    output = tree.nodes.new("NodeGroupOutput")
    position = tree.nodes.new("GeometryNodeInputPosition")
    length = tree.nodes.new("ShaderNodeVectorMath")
    length.operation = "LENGTH"
    subtract = tree.nodes.new("ShaderNodeMath")
    subtract.operation = "SUBTRACT"
    subtract.inputs[1].default_value = 0.7
    volume = tree.nodes.new("GeometryNodeVolumeCube")
    volume.inputs["Background"].default_value = 0.0
    volume.inputs["Min"].default_value = (-1, -1, -1)
    volume.inputs["Max"].default_value = (1, 1, 1)
    volume.inputs["Resolution X"].default_value = volume_resolution
    volume.inputs["Resolution Y"].default_value = volume_resolution
    volume.inputs["Resolution Z"].default_value = volume_resolution
    to_mesh = tree.nodes.new("GeometryNodeVolumeToMesh")
    to_mesh.inputs["Resolution Mode"].default_value = mode
    to_mesh.inputs["Voxel Size"].default_value = voxel_size
    to_mesh.inputs["Voxel Amount"].default_value = voxel_amount
    to_mesh.inputs["Threshold"].default_value = threshold
    to_mesh.inputs["Adaptivity"].default_value = adaptivity
    tree.links.new(position.outputs["Position"], length.inputs[0])
    tree.links.new(length.outputs["Value"], subtract.inputs[0])
    tree.links.new(subtract.outputs[0], volume.inputs["Density"])
    tree.links.new(volume.outputs["Volume"], to_mesh.inputs["Volume"])
    tree.links.new(to_mesh.outputs["Mesh"], output.inputs["Geometry"])
    modifier = obj.modifiers.new("GeometryNodes", "NODES")
    modifier.node_group = tree

    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    result = evaluated.to_mesh()
    try:
        return {
            "inputs": {
                "resolution_mode": mode,
                "voxel_size": voxel_size,
                "voxel_amount": voxel_amount,
                "threshold": threshold,
                "adaptivity": adaptivity,
                "volume_resolution": volume_resolution,
            },
            **summarize(result),
        }
    finally:
        evaluated.to_mesh_clear()


payload = {
    "blender": bpy.app.version_string,
    "generator": "tools/blender_volume_to_mesh_topology_probe.py",
    "volume_cube": {
        "background": 0.0,
        "resolution": [16, 16, 16],
        "min": [-1.0, -1.0, -1.0],
        "max": [1.0, 1.0, 1.0],
        "radius": 0.7,
    },
    "cases": {
        "grid_zero": evaluate_case("Grid Zero", "Grid"),
        "grid_nonzero": evaluate_case("Grid Nonzero", "Grid", threshold=0.125),
        "size_zero": evaluate_case("Size Zero", "Size", voxel_size=0.08),
        "amount_zero": evaluate_case("Amount Zero", "Amount", voxel_amount=20.0),
        "grid_adapt_half": evaluate_case("Grid Adapt Half", "Grid", adaptivity=0.5),
        "grid_zero_resolution_30": evaluate_case(
            "Grid Zero Resolution 30", "Grid", volume_resolution=30
        ),
    },
}

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
print(f"BLENDER_VOLUME_TO_MESH_TOPOLOGY_OK {json.dumps(payload)} -> {out_path}")
