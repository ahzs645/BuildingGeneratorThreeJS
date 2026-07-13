"""Print Blender Merge by Distance topology for coincident duplicate faces."""
import bpy


mesh = bpy.data.meshes.new("Merge Probe Mesh")
positions = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)] * 2
mesh.from_pydata(positions, [], [(0, 1, 2, 3), (4, 5, 6, 7)])
obj = bpy.data.objects.new("Merge Probe", mesh)
bpy.context.scene.collection.objects.link(obj)

tree = bpy.data.node_groups.new("Merge Probe", "GeometryNodeTree")
tree.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
tree.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
group_input = tree.nodes.new("NodeGroupInput")
merge = tree.nodes.new("GeometryNodeMergeByDistance")
merge.inputs["Distance"].default_value = 0.00001
group_output = tree.nodes.new("NodeGroupOutput")
tree.links.new(group_input.outputs["Geometry"], merge.inputs["Geometry"])
tree.links.new(merge.outputs["Geometry"], group_output.inputs["Geometry"])

modifier = obj.modifiers.new("Merge Probe", "NODES")
modifier.node_group = tree
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
evaluated_mesh = evaluated.to_mesh()
print("MERGE_BY_DISTANCE_PROBE", len(evaluated_mesh.vertices), len(evaluated_mesh.polygons), [list(face.vertices) for face in evaluated_mesh.polygons])
evaluated.to_mesh_clear()
