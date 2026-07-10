"""Evaluate an internal geometry socket as a node group's temporary output.

Usage: blender --background FILE.blend --python bake_geometry_probe.py -- \
    OBJECT GROUP SRC_NODE SRC_SOCKET OUT.json [overrides.json]
"""
import bpy, json, sys

argv = sys.argv[sys.argv.index("--") + 1:]
obj_name, group_name, src_node_name, src_socket_name, out_path = argv[:5]
overrides_path = argv[5] if len(argv) > 5 else None

tree = bpy.data.node_groups[group_name]
source = tree.nodes[src_node_name]
source_socket = next(
    (socket for socket in source.outputs if socket.identifier == src_socket_name or socket.name == src_socket_name),
    None,
)
assert source_socket is not None, f"socket {src_socket_name} not found on {src_node_name}"
assert source_socket.bl_idname == "NodeSocketGeometry", f"{src_socket_name} is not geometry"

group_output = next((node for node in tree.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output), None)
assert group_output is not None, "active Group Output not found"
geometry_input = next((socket for socket in group_output.inputs if socket.bl_idname == "NodeSocketGeometry"), None)
assert geometry_input is not None, "Group Output has no Geometry input"
for link in list(geometry_input.links):
    tree.links.remove(link)
tree.links.new(source_socket, geometry_input)

obj = bpy.data.objects[obj_name]
modifier = next((m for m in obj.modifiers if m.type == "NODES" and m.node_group == tree), None)
assert modifier is not None, f"no Geometry Nodes modifier using {group_name} on {obj_name}"
overrides = json.load(open(overrides_path)) if overrides_path else {}
inputs = {
    item.name: item.identifier
    for item in tree.interface.items_tree
    if item.item_type == "SOCKET" and item.in_out == "INPUT"
}
for name, value in overrides.items():
    identifier = inputs.get(name, name)
    modifier[identifier] = value
    print("  override", name, "->", identifier, "=", value)

obj.update_tag()
depsgraph = bpy.context.evaluated_depsgraph_get()
evaluated = obj.evaluated_get(depsgraph)
mesh = evaluated.to_mesh()
positions = [[round(component, 7) for component in vertex.co] for vertex in mesh.vertices]
faces = [list(polygon.vertices) for polygon in mesh.polygons]
with open(out_path, "w") as handle:
    json.dump({
        "node": src_node_name,
        "socket": src_socket_name,
        "overrides": overrides,
        "positions": positions,
        "faces": faces,
    }, handle)
evaluated.to_mesh_clear()
print(f"GEOMETRY_PROBE_OK: {len(positions)} verts, {len(faces)} faces -> {out_path}")
