"""Evaluate Node Dojo's Gradient Direction group on a deterministic quad.

Usage: blender --background FILE.blend --python tools/blender_gradient_direction_fixture.py -- OUT.json
"""
import json
import sys

import bpy


out_path = sys.argv[sys.argv.index("--") + 1]
mesh = bpy.data.meshes.new("__GRADIENT_DIRECTION_FIXTURE_MESH")
mesh.from_pydata(
    [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)],
    [],
    [(0, 1, 2, 3)],
)
gradient = mesh.attributes.new("gradient", "FLOAT", "POINT")
for item, value in zip(gradient.data, (0.0, 1.0, 1.0, 1.0)):
    item.value = value

obj = bpy.data.objects.new("__GRADIENT_DIRECTION_FIXTURE", mesh)
scene = bpy.data.scenes.new("__GRADIENT_DIRECTION_FIXTURE_SCENE")
scene.collection.objects.link(obj)
bpy.context.window.scene = scene

tree = bpy.data.node_groups.new("__GRADIENT_DIRECTION_FIXTURE_TREE", "GeometryNodeTree")
tree.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
tree.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
group_input = tree.nodes.new("NodeGroupInput")
group_output = tree.nodes.new("NodeGroupOutput")
named = tree.nodes.new("GeometryNodeInputNamedAttribute")
named.data_type = "FLOAT"
named.inputs["Name"].default_value = "gradient"
direction = tree.nodes.new("GeometryNodeGroup")
direction.node_tree = bpy.data.node_groups["Gradient Direction"]
store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
store.data_type = "FLOAT_VECTOR"
store.domain = "POINT"
store.inputs["Name"].default_value = "direction"
tree.links.new(group_input.outputs["Geometry"], store.inputs["Geometry"])
tree.links.new(named.outputs["Attribute"], direction.inputs["Gradient"])
tree.links.new(direction.outputs["Direction"], store.inputs["Value"])
tree.links.new(store.outputs["Geometry"], group_output.inputs["Geometry"])

modifier = obj.modifiers.new("__GRADIENT_DIRECTION_FIXTURE", "NODES")
modifier.node_group = tree
obj.update_tag()
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
evaluated_mesh = evaluated.to_mesh()
values = [list(item.vector) for item in evaluated_mesh.attributes["direction"].data]
evaluated.to_mesh_clear()

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump({"values": values}, handle, indent=2)
print(f"BLENDER_GRADIENT_DIRECTION_FIXTURE_OK -> {out_path}")
