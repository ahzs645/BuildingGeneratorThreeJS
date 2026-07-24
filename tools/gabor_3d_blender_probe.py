"""Emit Blender 5.x Geometry Nodes truth samples for 3D Gabor.

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender \
    --background --factory-startup \
    --python tools/gabor_3d_blender_probe.py
"""

import json

import bpy


SAMPLES = [
    {
        "position": (0.125, -0.75, 0.4),
        "scale": 3.5,
        "frequency": 2.0,
        "anisotropy": 0.8,
        "orientation": (0.3, 0.4, 0.5),
    },
    {
        "position": (-1.25, 2.5, 0.75),
        "scale": 0.75,
        "frequency": 0.0,
        "anisotropy": 1.0,
        "orientation": (1.0, 0.0, 0.0),
    },
    {
        "position": (4.0, -3.0, 2.0),
        "scale": -1.25,
        "frequency": 4.25,
        "anisotropy": 0.0,
        "orientation": (-0.2, 0.7, 0.1),
    },
]


def socket(node, in_out, identifier):
    sockets = node.inputs if in_out == "INPUT" else node.outputs
    for candidate in sockets:
        if candidate.identifier == identifier or candidate.name == identifier:
            return candidate
    raise RuntimeError(
        f"{node.bl_idname} has no {in_out.lower()} socket {identifier}: "
        + ", ".join(f"{item.name} ({item.identifier})" for item in sockets)
    )


def evaluate_sample(index, sample):
    mesh = bpy.data.meshes.new(f"Gabor Probe Mesh {index}")
    mesh.from_pydata([sample["position"]], [], [])
    mesh.update()
    obj = bpy.data.objects.new(f"Gabor Probe {index}", mesh)
    bpy.context.scene.collection.objects.link(obj)

    tree = bpy.data.node_groups.new(f"Gabor Probe Tree {index}", "GeometryNodeTree")
    tree.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    group_input = tree.nodes.new("NodeGroupInput")
    group_output = tree.nodes.new("NodeGroupOutput")
    gabor = tree.nodes.new("ShaderNodeTexGabor")
    gabor.gabor_type = "3D"
    socket(gabor, "INPUT", "Scale").default_value = sample["scale"]
    socket(gabor, "INPUT", "Frequency").default_value = sample["frequency"]
    socket(gabor, "INPUT", "Anisotropy").default_value = sample["anisotropy"]
    socket(gabor, "INPUT", "Orientation 3D").default_value = sample["orientation"]

    previous = socket(group_input, "OUTPUT", "Geometry")
    for attribute_name, output_name in (
        ("gabor_value", "Value"),
        ("gabor_phase", "Phase"),
        ("gabor_intensity", "Intensity"),
    ):
        store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
        store.data_type = "FLOAT"
        store.domain = "POINT"
        socket(store, "INPUT", "Name").default_value = attribute_name
        tree.links.new(previous, socket(store, "INPUT", "Geometry"))
        tree.links.new(
            socket(gabor, "OUTPUT", output_name),
            socket(store, "INPUT", "Value"),
        )
        previous = socket(store, "OUTPUT", "Geometry")
    tree.links.new(previous, socket(group_output, "INPUT", "Geometry"))

    modifier = obj.modifiers.new(name="Gabor Probe", type="NODES")
    modifier.node_group = tree
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    evaluated_mesh = evaluated.to_mesh()
    try:
        result = {"sample": sample}
        for attribute_name in ("gabor_value", "gabor_phase", "gabor_intensity"):
            result[attribute_name] = float(
                evaluated_mesh.attributes[attribute_name].data[0].value
            )
        return result
    finally:
        evaluated.to_mesh_clear()


print(
    "GABOR_3D_PROBE "
    + json.dumps(
        [evaluate_sample(index, sample) for index, sample in enumerate(SAMPLES)],
        sort_keys=True,
    )
)
