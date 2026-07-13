"""Print Blender's asymmetric Curve to Mesh profile-axis mapping."""

import bpy


bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

mesh = bpy.data.meshes.new("Curve to Mesh axes probe")
mesh.from_pydata([(0.0, 0.0, 0.0)], [], [])
obj = bpy.data.objects.new("Curve to Mesh axes probe", mesh)
bpy.context.scene.collection.objects.link(obj)

group = bpy.data.node_groups.new("Curve to Mesh axes probe", "GeometryNodeTree")
group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
output = group.nodes.new("NodeGroupOutput")
rail = group.nodes.new("GeometryNodeCurvePrimitiveLine")
rail.inputs["Start"].default_value = (0.0, 0.0, 0.0)
rail.inputs["End"].default_value = (1.0, 0.0, 0.0)
profile = group.nodes.new("GeometryNodeCurvePrimitiveLine")
profile.inputs["Start"].default_value = (2.0, 3.0, 0.0)
profile.inputs["End"].default_value = (4.0, 5.0, 0.0)
sweep = group.nodes.new("GeometryNodeCurveToMesh")
group.links.new(rail.outputs["Curve"], sweep.inputs["Curve"])
group.links.new(profile.outputs["Curve"], sweep.inputs["Profile Curve"])
group.links.new(sweep.outputs["Mesh"], output.inputs["Geometry"])

modifier = obj.modifiers.new(name="Curve to Mesh axes probe", type="NODES")
modifier.node_group = group
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
result = evaluated.to_mesh()
print("CURVE_TO_MESH_AXES", [tuple(round(value, 6) for value in vertex.co) for vertex in result.vertices])
evaluated.to_mesh_clear()
