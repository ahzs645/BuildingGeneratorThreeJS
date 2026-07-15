"""Probe native Curve to Points rotations before/after Align Rotation to Vector."""
import json
import sys

import bpy


out_path = sys.argv[sys.argv.index("--") + 1]
scene = bpy.data.scenes.new("curve rotation quaternion probe")
bpy.context.window.scene = scene
seed = bpy.data.meshes.new("curve rotation quaternion probe")
seed.from_pydata([(0, 0, 0)], [], [])
obj = bpy.data.objects.new("curve rotation quaternion probe", seed)
scene.collection.objects.link(obj)

tree = bpy.data.node_groups.new("curve rotation quaternion probe", "GeometryNodeTree")
tree.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
line = tree.nodes.new("GeometryNodeCurvePrimitiveLine")
line.mode = "POINTS"
line.inputs["Start"].default_value = (0, 0, 1)
line.inputs["End"].default_value = (0, 0, -1)
points = tree.nodes.new("GeometryNodeCurveToPoints")
points.mode = "COUNT"
points.inputs["Count"].default_value = 2
align = tree.nodes.new("FunctionNodeAlignRotationToVector")
align.axis = "Z"
align.inputs["Factor"].default_value = 1.0
align.inputs["Vector"].default_value = (0, 0, 1)
constant_align = tree.nodes.new("FunctionNodeAlignRotationToVector")
constant_align.axis = "Z"
constant_align.inputs["Rotation"].default_value = (3.141592653589793, 0, 0)
constant_align.inputs["Factor"].default_value = 1.0
constant_align.inputs["Vector"].default_value = (0, 0, 1)
tree.links.new(line.outputs["Curve"], points.inputs["Curve"])
tree.links.new(points.outputs["Rotation"], align.inputs["Rotation"])

geometry = points.outputs["Points"]
for prefix, rotation in (
    ("curve", points.outputs["Rotation"]),
    ("aligned", align.outputs["Rotation"]),
    ("constant_aligned", constant_align.outputs["Rotation"]),
):
    converter = tree.nodes.new("FunctionNodeRotationToQuaternion")
    tree.links.new(rotation, converter.inputs["Rotation"])
    for component in ("W", "X", "Y", "Z"):
        store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
        store.data_type = "FLOAT"
        store.domain = "POINT"
        store.inputs["Name"].default_value = f"{prefix}_{component.lower()}"
        tree.links.new(geometry, store.inputs["Geometry"])
        tree.links.new(converter.outputs[component], store.inputs["Value"])
        geometry = store.outputs["Geometry"]

to_vertices = tree.nodes.new("GeometryNodePointsToVertices")
output = tree.nodes.new("NodeGroupOutput")
tree.links.new(geometry, to_vertices.inputs["Points"])
tree.links.new(to_vertices.outputs["Mesh"], output.inputs["Geometry"])
modifier = obj.modifiers.new(name="curve rotation quaternion probe", type="NODES")
modifier.node_group = tree

evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
try:
    payload = {
        prefix: [[float(mesh.attributes[f"{prefix}_{component}"].data[i].value) for component in ("x", "y", "z", "w")] for i in range(len(mesh.vertices))]
        for prefix in ("curve", "aligned", "constant_aligned")
    }
finally:
    evaluated.to_mesh_clear()

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
print(f"BLENDER_CURVE_ROTATION_QUATERNION_PROBE_OK -> {out_path}")
