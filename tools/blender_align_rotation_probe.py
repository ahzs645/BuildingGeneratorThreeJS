"""Probe Blender's Align Rotation to Vector semantics on constant rotations."""
import json
import math
import sys

import bpy


out_path = sys.argv[sys.argv.index("--") + 1]
scene = bpy.data.scenes.new("align rotation probe")
bpy.context.window.scene = scene
mesh = bpy.data.meshes.new("align rotation seed")
mesh.from_pydata([(0, 0, 0)], [], [])
obj = bpy.data.objects.new("align rotation probe", mesh)
scene.collection.objects.link(obj)

tree = bpy.data.node_groups.new("align rotation probe", "GeometryNodeTree")
tree.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
points = tree.nodes.new("GeometryNodeMeshLine")
points.inputs["Count"].default_value = 1
align = tree.nodes.new("FunctionNodeAlignRotationToVector")
align.axis = "Z"
align.inputs["Factor"].default_value = 1.0
align.inputs["Vector"].default_value = (0, 0, 1)
to_euler = tree.nodes.new("FunctionNodeRotationToEuler")
store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
store.data_type = "FLOAT_VECTOR"
store.domain = "POINT"
store.inputs["Name"].default_value = "__rotation_probe"
output = tree.nodes.new("NodeGroupOutput")
tree.links.new(align.outputs["Rotation"], to_euler.inputs["Rotation"])
tree.links.new(points.outputs["Mesh"], store.inputs["Geometry"])
tree.links.new(to_euler.outputs["Euler"], store.inputs["Value"])
tree.links.new(store.outputs["Geometry"], output.inputs["Geometry"])
modifier = obj.modifiers.new(name="align rotation probe", type="NODES")
modifier.node_group = tree

align_results = []
for rotation in [(0, 0, 0), (math.pi / 2, 0, 0), (math.pi / 2, 0, math.pi / 2)]:
    align.inputs["Rotation"].default_value = rotation
    obj.update_tag()
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    result = evaluated.to_mesh()
    attribute = result.attributes["__rotation_probe"]
    align_results.append({"input": rotation, "output": list(attribute.data[0].vector)})
    evaluated.to_mesh_clear()

for link in list(store.inputs["Geometry"].links):
    tree.links.remove(link)
for link in list(store.inputs["Value"].links):
    tree.links.remove(link)
for link in list(output.inputs["Geometry"].links):
    tree.links.remove(link)
to_vertices = tree.nodes.new("GeometryNodePointsToVertices")
tree.links.new(store.outputs["Geometry"], to_vertices.inputs["Points"])
tree.links.new(to_vertices.outputs["Mesh"], output.inputs["Geometry"])
line = tree.nodes.new("GeometryNodeCurvePrimitiveLine")
line.mode = "POINTS"
curve_points = tree.nodes.new("GeometryNodeCurveToPoints")
curve_points.mode = "COUNT"
curve_points.inputs["Count"].default_value = 2
curve_euler = tree.nodes.new("FunctionNodeRotationToEuler")
tree.links.new(line.outputs["Curve"], curve_points.inputs["Curve"])
tree.links.new(curve_points.outputs["Points"], store.inputs["Geometry"])
tree.links.new(curve_points.outputs["Rotation"], curve_euler.inputs["Rotation"])
tree.links.new(curve_euler.outputs["Euler"], store.inputs["Value"])
curve_results = []
for direction in [(1, 0, 0), (0, 1, 0), (0, 0, 1)]:
    line.inputs["Start"].default_value = (0, 0, 0)
    line.inputs["End"].default_value = direction
    obj.update_tag()
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    result = evaluated.to_mesh()
    attribute = result.attributes["__rotation_probe"]
    curve_results.append({"direction": direction, "output": list(attribute.data[0].vector)})
    evaluated.to_mesh_clear()

for link in list(output.inputs["Geometry"].links):
    tree.links.remove(link)
align_curve = tree.nodes.new("FunctionNodeAlignRotationToVector")
align_curve.axis = "Z"
align_curve.inputs["Factor"].default_value = 1.0
align_curve.inputs["Vector"].default_value = (0, 0, 1)
circle = tree.nodes.new("GeometryNodeCurvePrimitiveCircle")
circle.mode = "RADIUS"
circle.inputs["Resolution"].default_value = 8
circle.inputs["Radius"].default_value = 1.0
fill = tree.nodes.new("GeometryNodeFillCurve")
instance = tree.nodes.new("GeometryNodeInstanceOnPoints")
realize = tree.nodes.new("GeometryNodeRealizeInstances")
tree.links.new(curve_points.outputs["Rotation"], align_curve.inputs["Rotation"])
tree.links.new(circle.outputs["Curve"], fill.inputs["Curve"])
tree.links.new(curve_points.outputs["Points"], instance.inputs["Points"])
tree.links.new(fill.outputs["Mesh"], instance.inputs["Instance"])
tree.links.new(align_curve.outputs["Rotation"], instance.inputs["Rotation"])
tree.links.new(instance.outputs["Instances"], realize.inputs["Geometry"])
tree.links.new(realize.outputs["Geometry"], output.inputs["Geometry"])
aligned_curve_results = []
for direction in [(1, 0, 0), (0, 1, 0), (0, 0, 1)]:
    line.inputs["End"].default_value = direction
    obj.update_tag()
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    result = evaluated.to_mesh()
    positions = [vertex.co for vertex in result.vertices]
    aligned_curve_results.append({
        "direction": direction,
        "bbox": {
            "min": [min(position[axis] for position in positions) for axis in range(3)],
            "max": [max(position[axis] for position in positions) for axis in range(3)],
        },
    })
    evaluated.to_mesh_clear()

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump({"align_rotation": align_results, "curve_to_points": curve_results, "aligned_curve_instances": aligned_curve_results}, handle, indent=2)
print(f"BLENDER_ALIGN_ROTATION_PROBE_OK -> {out_path}")
