"""Bake a field on the geometry entering a node inside a nested GN group.

Usage: blender --background FILE.blend --python tools/bake_nested_field_probe.py -- \
  OBJECT ROOT_GROUP INSTANCE_NODE NESTED_GROUP SRC_NODE SRC_SOCKET CONSUMER OUT.json [overrides.json]
"""
import bpy
import json
import sys


args = sys.argv[sys.argv.index("--") + 1:]
object_name, root_name, instance_name, nested_name, source_name, socket_name, consumer_name, out_path = args[:8]
overrides_path = args[8] if len(args) > 8 else None
root = bpy.data.node_groups[root_name]
nested = bpy.data.node_groups[nested_name]
source = nested.nodes[source_name]
consumer = nested.nodes[consumer_name]

field = next((s for s in source.outputs if s.identifier == socket_name or s.name == socket_name), None)
assert field is not None, f"field socket not found: {source_name}.{socket_name}"
geometry_input = next((s for s in consumer.inputs if s.bl_idname == "NodeSocketGeometry" and s.is_linked), None)
assert geometry_input is not None, f"linked geometry input not found on {consumer_name}"
geometry_source = geometry_input.links[0].from_socket

store = nested.nodes.new("GeometryNodeStoreNamedAttribute")
store.domain = "POINT"
data_types = {
    "NodeSocketBool": "BOOLEAN",
    "NodeSocketInt": "INT",
    "NodeSocketVector": "FLOAT_VECTOR",
    "NodeSocketFloat": "FLOAT",
}
store.data_type = data_types.get(field.bl_idname, "FLOAT")
store.inputs["Name"].default_value = "__nested_probe"
nested.links.new(geometry_source, store.inputs["Geometry"])
nested.links.new(field, store.inputs["Value"])

nested_output = next(n for n in nested.nodes if n.bl_idname == "NodeGroupOutput" and n.is_active_output)
nested_geometry = next(s for s in nested_output.inputs if s.bl_idname == "NodeSocketGeometry")
for link in list(nested_geometry.links):
    nested.links.remove(link)
nested.links.new(store.outputs["Geometry"], nested_geometry)

instance = root.nodes[instance_name]
instance_geometry = next(s for s in instance.outputs if s.bl_idname == "NodeSocketGeometry")
root_output = next(n for n in root.nodes if n.bl_idname == "NodeGroupOutput" and n.is_active_output)
root_geometry = next(s for s in root_output.inputs if s.bl_idname == "NodeSocketGeometry")
for link in list(root_geometry.links):
    root.links.remove(link)
root.links.new(instance_geometry, root_geometry)

obj = bpy.data.objects[object_name]
modifier = next(m for m in obj.modifiers if m.type == "NODES" and m.node_group == root)
overrides = json.load(open(overrides_path)) if overrides_path else {}
inputs = {
    item.name: item.identifier
    for item in root.interface.items_tree
    if item.item_type == "SOCKET" and item.in_out == "INPUT"
}
for name, value in overrides.items():
    modifier[inputs.get(name, name)] = value

obj.update_tag()
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
attribute = mesh.attributes.get("__nested_probe")
if not attribute:
    values = []
elif store.data_type == "FLOAT_VECTOR":
    values = [list(item.vector) for item in attribute.data]
else:
    values = [item.value for item in attribute.data]
positions = [[round(v.co.x, 7), round(v.co.y, 7), round(v.co.z, 7)] for v in mesh.vertices]
with open(out_path, "w") as handle:
    json.dump({"values": values, "positions": positions}, handle)
evaluated.to_mesh_clear()
print(f"NESTED_FIELD_PROBE_OK: {len(values)} values -> {out_path}")
