"""Store a field inside a nested node group and route that group's geometry out."""
import json
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1 :]
object_name, out_path, group_name, geometry_spec, field_spec, domain = args
obj = bpy.data.objects[object_name]
tree = bpy.data.node_groups[group_name]
geometry_node, geometry_socket = geometry_spec.split(":", 1)
field_node, field_socket = field_spec.split(":", 1)
group_output = next(node for node in tree.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
geometry_output = next(socket for socket in group_output.inputs if socket.type == "GEOMETRY")
original = geometry_output.links[0].from_socket if geometry_output.is_linked else None
synthetic_field = None
if field_node == "__POSITION__":
    synthetic_field = tree.nodes.new("GeometryNodeInputPosition")
    field_output = synthetic_field.outputs[field_socket]
else:
    field_output = tree.nodes[field_node].outputs[field_socket]
store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
store.data_type = {
    "NodeSocketBool": "BOOLEAN",
    "NodeSocketInt": "INT",
    "NodeSocketVector": "FLOAT_VECTOR",
}.get(field_output.bl_idname, "FLOAT")
store.domain = domain.upper()
store.inputs["Name"].default_value = "__nested_probe"
tree.links.new(tree.nodes[geometry_node].outputs[geometry_socket], store.inputs["Geometry"])
tree.links.new(field_output, store.inputs["Value"])
for link in list(geometry_output.links):
    tree.links.remove(link)
realize = None
if domain.upper() == "INSTANCE":
    # Object evaluation realizes output instances, but attributes stored only
    # on the instance domain are otherwise omitted from the resulting mesh
    # attribute list. Realize explicitly so the captured value propagates to
    # every point of each payload and can be inspected below.
    realize = tree.nodes.new("GeometryNodeRealizeInstances")
    tree.links.new(store.outputs["Geometry"], realize.inputs["Geometry"])
    tree.links.new(realize.outputs["Geometry"], geometry_output)
else:
    tree.links.new(store.outputs["Geometry"], geometry_output)

obj.update_tag()
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
try:
    attribute = mesh.attributes.get("__nested_probe")
    if not attribute:
        values = []
    elif store.data_type == "FLOAT_VECTOR":
        values = [[float(component) for component in item.vector] for item in attribute.data]
    else:
        values = [item.value for item in attribute.data]
    positions = [[float(vertex.co.x), float(vertex.co.y), float(vertex.co.z)] for vertex in mesh.vertices]
    payload = {"domain": domain.upper(), "values": values, "positions": positions, "verts": len(mesh.vertices), "faces": len(mesh.polygons), "edges": len(mesh.edges)}
finally:
    evaluated.to_mesh_clear()
    for link in list(geometry_output.links):
        tree.links.remove(link)
    if original is not None:
        tree.links.new(original, geometry_output)
    if realize is not None:
        tree.nodes.remove(realize)
    if synthetic_field is not None:
        tree.nodes.remove(synthetic_field)
    tree.nodes.remove(store)

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
print(f"BLENDER_NESTED_FIELD_PROBE_OK -> {out_path}")
