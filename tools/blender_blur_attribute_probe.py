"""Print Blender Blur Attribute values on a tiny loose-edge mesh."""
import bpy


mesh = bpy.data.meshes.new("Blur Probe Mesh")
mesh.from_pydata([(0, 0, 0), (1, 0, 0), (3, 0, 0)], [(0, 1), (1, 2)], [])
obj = bpy.data.objects.new("Blur Probe", mesh)
bpy.context.scene.collection.objects.link(obj)

tree = bpy.data.node_groups.new("Blur Probe", "GeometryNodeTree")
tree.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
tree.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
group_input = tree.nodes.new("NodeGroupInput")
position = tree.nodes.new("GeometryNodeInputPosition")
blur = tree.nodes.new("GeometryNodeBlurAttribute")
blur.data_type = "FLOAT_VECTOR"
blur.inputs["Iterations"].default_value = 1
blur.inputs["Weight"].default_value = 1.0
store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
store.data_type = "FLOAT_VECTOR"
store.domain = "POINT"
store.inputs["Name"].default_value = "blur_probe"
group_output = tree.nodes.new("NodeGroupOutput")
tree.links.new(position.outputs["Position"], blur.inputs["Value"])
tree.links.new(group_input.outputs["Geometry"], store.inputs["Geometry"])
tree.links.new(blur.outputs["Value"], store.inputs["Value"])
tree.links.new(store.outputs["Geometry"], group_output.inputs["Geometry"])

modifier = obj.modifiers.new("Blur Probe", "NODES")
modifier.node_group = tree
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
evaluated_mesh = evaluated.to_mesh()
values = [tuple(round(component, 6) for component in item.vector) for item in evaluated_mesh.attributes["blur_probe"].data]
print("BLUR_ATTRIBUTE_PROBE", values)
evaluated.to_mesh_clear()
