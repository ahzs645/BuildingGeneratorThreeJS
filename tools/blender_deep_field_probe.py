"""Bake a field from a pure nested group on its parent group's geometry.

Usage:
  blender -b FILE.blend --python tools/blender_deep_field_probe.py -- \
    OBJECT ROOT_GROUP OUTER_INSTANCE OUTER_GROUP INNER_INSTANCE INNER_GROUP \
    SRC_NODE SRC_SOCKET CONSUMER OUT.json [DOMAIN]

The inner group may have no geometry sockets. A temporary interface output
exposes its field to the outer instance, where it is stored on the geometry
entering CONSUMER. Nothing is saved back to the source blend file.
"""
import bpy
import json
import sys


args = sys.argv[sys.argv.index("--") + 1:]
(
    object_name,
    root_name,
    outer_instance_name,
    outer_name,
    inner_instance_name,
    inner_name,
    source_name,
    socket_name,
    consumer_name,
    out_path,
) = args[:10]
domain = args[10].upper() if len(args) > 10 else "POINT"

root = bpy.data.node_groups[root_name]
outer = bpy.data.node_groups[outer_name]
inner = bpy.data.node_groups[inner_name]
outer_instance = root.nodes[outer_instance_name]
inner_instance = outer.nodes[inner_instance_name]
source = inner.nodes[source_name]
consumer = outer.nodes[consumer_name]

field = next(
    socket
    for socket in source.outputs
    if socket.identifier == socket_name or socket.name == socket_name
)
socket_types = {
    "NodeSocketBool": "NodeSocketBool",
    "NodeSocketInt": "NodeSocketInt",
    "NodeSocketFloat": "NodeSocketFloat",
    "NodeSocketVector": "NodeSocketVector",
    "NodeSocketRotation": "NodeSocketVector",
}
probe_socket = inner.interface.new_socket(
    name="__deep_probe", in_out="OUTPUT", socket_type=socket_types.get(field.bl_idname, "NodeSocketFloat")
)
inner_output = next(
    node for node in inner.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output
)
probe_input = next(socket for socket in inner_output.inputs if socket.identifier == probe_socket.identifier)

stored_field = field
if field.bl_idname == "NodeSocketRotation":
    rotation_to_euler = inner.nodes.new("FunctionNodeRotationToEuler")
    inner.links.new(field, rotation_to_euler.inputs["Rotation"])
    stored_field = rotation_to_euler.outputs["Euler"]
inner.links.new(stored_field, probe_input)

instance_field = next(
    socket for socket in inner_instance.outputs if socket.identifier == probe_socket.identifier
)
geometry_input = next(
    socket for socket in consumer.inputs if socket.bl_idname == "NodeSocketGeometry" and socket.is_linked
)
geometry_source = geometry_input.links[0].from_socket
store = outer.nodes.new("GeometryNodeStoreNamedAttribute")
store.domain = domain
data_types = {
    "NodeSocketBool": "BOOLEAN",
    "NodeSocketInt": "INT",
    "NodeSocketVector": "FLOAT_VECTOR",
    "NodeSocketFloat": "FLOAT",
    "NodeSocketRotation": "FLOAT_VECTOR",
}
store.data_type = data_types.get(field.bl_idname, "FLOAT")
store.inputs["Name"].default_value = "__deep_probe"
outer.links.new(geometry_source, store.inputs["Geometry"])
outer.links.new(instance_field, store.inputs["Value"])

outer_output = next(
    node for node in outer.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output
)
outer_geometry = next(socket for socket in outer_output.inputs if socket.type == "GEOMETRY")
for link in list(outer_geometry.links):
    outer.links.remove(link)
outer.links.new(store.outputs["Geometry"], outer_geometry)

root_output = next(
    node for node in root.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output
)
root_geometry = next(socket for socket in root_output.inputs if socket.type == "GEOMETRY")
outer_geometry_output = next(socket for socket in outer_instance.outputs if socket.type == "GEOMETRY")
for link in list(root_geometry.links):
    root.links.remove(link)
root.links.new(outer_geometry_output, root_geometry)

obj = bpy.data.objects[object_name]
probe_scene = bpy.data.scenes.new("__NODE_DOJO_DEEP_FIELD_PROBE_SCENE")
probe_scene.collection.objects.link(obj)
bpy.context.window.scene = probe_scene
obj.hide_viewport = False
obj.hide_render = False
obj.hide_set(False)
obj.update_tag()
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
attribute = mesh.attributes.get("__deep_probe")
if not attribute:
    values = []
elif store.data_type == "FLOAT_VECTOR":
    values = [list(item.vector) for item in attribute.data]
else:
    values = [item.value for item in attribute.data]
evaluated.to_mesh_clear()

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump({"domain": domain, "values": values}, handle)
print(f"BLENDER_DEEP_FIELD_PROBE_OK: {len(values)} values -> {out_path}")
