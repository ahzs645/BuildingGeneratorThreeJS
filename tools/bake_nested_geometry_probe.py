"""Evaluate one geometry output inside a nested Geometry Nodes group.

Usage: blender --background FILE.blend --python tools/bake_nested_geometry_probe.py -- \
  OBJECT ROOT_GROUP INSTANCE_NODE NESTED_GROUP SOURCE_NODE SOURCE_SOCKET OUT.json [overrides.json]

The source is temporarily connected to the nested group's geometry output and
the corresponding group instance is connected directly to the modifier
group's geometry output. The .blend on disk is never changed.
"""
import bpy
import json
import sys


args = sys.argv[sys.argv.index("--") + 1:]
object_name, root_name, instance_name, nested_name, source_name, socket_name, out_path = args[:7]
overrides_path = args[7] if len(args) > 7 else None


def geometry_socket(sockets, requested=None):
    if requested:
        found = next((s for s in sockets if s.identifier == requested or s.name == requested), None)
        assert found is not None, f"socket not found: {requested}"
        assert found.bl_idname == "NodeSocketGeometry", f"socket is not geometry: {requested}"
        return found
    return next((s for s in sockets if s.bl_idname == "NodeSocketGeometry"), None)


def active_output(tree):
    return next((n for n in tree.nodes if n.bl_idname == "NodeGroupOutput" and n.is_active_output), None)


root = bpy.data.node_groups[root_name]
nested = bpy.data.node_groups[nested_name]
source = nested.nodes[source_name]
source_output = geometry_socket(source.outputs, socket_name)
nested_output = active_output(nested)
nested_geometry_input = geometry_socket(nested_output.inputs)
assert nested_geometry_input is not None, "nested group has no geometry output"
for link in list(nested_geometry_input.links):
    nested.links.remove(link)
nested.links.new(source_output, nested_geometry_input)

instance = root.nodes[instance_name]
assert instance.node_tree == nested, f"{instance_name} does not instance {nested_name}"
instance_output = geometry_socket(instance.outputs)
root_output = active_output(root)
root_geometry_input = geometry_socket(root_output.inputs)
assert root_geometry_input is not None, "root group has no geometry output"
for link in list(root_geometry_input.links):
    root.links.remove(link)
root.links.new(instance_output, root_geometry_input)

obj = bpy.data.objects[object_name]
modifier = next((m for m in obj.modifiers if m.type == "NODES" and m.node_group == root), None)
assert modifier is not None, f"no Geometry Nodes modifier using {root_name}"
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
depsgraph = bpy.context.evaluated_depsgraph_get()
evaluated = obj.evaluated_get(depsgraph)
mesh = evaluated.to_mesh()
positions = [[round(v.co.x, 7), round(v.co.y, 7), round(v.co.z, 7)] for v in mesh.vertices]
faces = [list(p.vertices) for p in mesh.polygons]
with open(out_path, "w") as handle:
    json.dump({
        "group": nested_name,
        "node": source_name,
        "socket": socket_name,
        "positions": positions,
        "faces": faces,
    }, handle)
evaluated.to_mesh_clear()
print(f"NESTED_GEOMETRY_PROBE_OK: {len(positions)} verts, {len(faces)} faces -> {out_path}")
