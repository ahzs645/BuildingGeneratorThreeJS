"""Dump evaluated positions/tangents/normals from a curve geometry socket."""
import json
import os
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1 :]
object_name, out_path, spec = args
node_name, socket_name = spec.split(":", 1)
obj = bpy.data.objects[object_name]
# Node Dojo assets can live in excluded library collections. Probe them in a
# clean scene so modifier overrides and temporary output links are evaluated,
# matching the geometry-probe/parity workflow.
probe_scene = bpy.data.scenes.new("__NODE_DOJO_CURVE_PROBE_SCENE")
probe_scene.collection.objects.link(obj)
bpy.context.window.scene = probe_scene
obj.hide_viewport = False
obj.hide_render = False
obj.hide_set(False)
mod = next(m for m in obj.modifiers if m.type == "NODES" and m.node_group)
tree = mod.node_group
probe_overrides = json.loads(os.environ.get("NODE_DOJO_PROBE_OVERRIDES", "{}"))
if probe_overrides:
    identifiers = {
        item.name: item.identifier
        for item in tree.interface.items_tree
        if item.item_type == "SOCKET" and item.in_out == "INPUT"
    }
    for name, value in probe_overrides.items():
        identifier = identifiers.get(name)
        if identifier is None:
            raise KeyError(f"modifier input not found: {name}")
        mod[identifier] = value
group_output = next(n for n in tree.nodes if n.bl_idname == "NodeGroupOutput" and n.is_active_output)
geometry_output = next(s for s in group_output.inputs if s.type == "GEOMETRY")
original = geometry_output.links[0].from_socket if geometry_output.is_linked else None

sample = tree.nodes.new("GeometryNodeCurveToPoints")
sample.mode = "EVALUATED"
store_tangent = tree.nodes.new("GeometryNodeStoreNamedAttribute")
store_tangent.data_type = "FLOAT_VECTOR"
store_tangent.domain = "POINT"
store_tangent.inputs["Name"].default_value = "__probe_tangent"
store_normal = tree.nodes.new("GeometryNodeStoreNamedAttribute")
store_normal.data_type = "FLOAT_VECTOR"
store_normal.domain = "POINT"
store_normal.inputs["Name"].default_value = "__probe_normal"
to_vertices = tree.nodes.new("GeometryNodePointsToVertices")
tree.links.new(tree.nodes[node_name].outputs[socket_name], sample.inputs["Curve"])
tree.links.new(sample.outputs["Points"], store_tangent.inputs["Geometry"])
tree.links.new(sample.outputs["Tangent"], store_tangent.inputs["Value"])
tree.links.new(store_tangent.outputs["Geometry"], store_normal.inputs["Geometry"])
tree.links.new(sample.outputs["Normal"], store_normal.inputs["Value"])
tree.links.new(store_normal.outputs["Geometry"], to_vertices.inputs["Points"])
for link in list(geometry_output.links):
    tree.links.remove(link)
tree.links.new(to_vertices.outputs["Mesh"], geometry_output)

obj.update_tag()
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh = evaluated.to_mesh()
try:
    def vectors(name):
        attribute = mesh.attributes.get(name)
        return [list(item.vector) for item in attribute.data] if attribute else []
    payload = {
        "positions": [list(vertex.co) for vertex in mesh.vertices],
        "tangents": vectors("__probe_tangent"),
        "normals": vectors("__probe_normal"),
    }
finally:
    evaluated.to_mesh_clear()
    for link in list(geometry_output.links):
        tree.links.remove(link)
    if original is not None:
        tree.links.new(original, geometry_output)
    for node in (sample, store_tangent, store_normal, to_vertices):
        tree.nodes.remove(node)

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
print(f"BLENDER_CURVE_PROBE_OK -> {out_path}")
