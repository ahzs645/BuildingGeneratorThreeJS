"""Route one Geometry Nodes output socket to the modifier output and report it.

Usage:
  blender --background FILE.blend --python tools/blender_node_geometry_probe.py -- \
    OBJECT GROUP NODE SOCKET OUT.json
"""
import json
import os
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) != 5:
    raise SystemExit("usage: OBJECT GROUP NODE SOCKET OUT.json")
object_name, group_name, node_name, socket_name, out_path = args

obj = bpy.data.objects.get(object_name)
group = bpy.data.node_groups.get(group_name)
if obj is None or group is None:
    raise RuntimeError(f"missing object/group: {object_name!r} / {group_name!r}")
# Several Node Dojo assets live in an excluded library collection. Evaluating
# them in the authored presentation scene can therefore hide Collection Info
# dependencies and return a misleading primitive fallback. Isolate the target
# in a clean scene, matching the reference-render and parity-sweep workflow.
probe_scene = bpy.data.scenes.new("__NODE_DOJO_GEOMETRY_PROBE_SCENE")
probe_scene.collection.objects.link(obj)
bpy.context.window.scene = probe_scene
obj.hide_viewport = False
obj.hide_render = False
obj.hide_set(False)
probe_overrides = json.loads(os.environ.get("NODE_DOJO_PROBE_OVERRIDES", "{}"))
if probe_overrides:
    modifier = next((candidate for candidate in obj.modifiers if candidate.type == "NODES" and candidate.node_group is not None), None)
    if modifier is None:
        raise RuntimeError(f'no Geometry Nodes modifier on {object_name!r}')
    identifiers = {
        item.name: item.identifier
        for item in modifier.node_group.interface.items_tree
        if item.item_type == "SOCKET" and item.in_out == "INPUT"
    }
    for name, value in probe_overrides.items():
        identifier = identifiers.get(name)
        if identifier is None:
            raise KeyError(f"modifier input not found: {name}")
        modifier[identifier] = value
node = group.nodes.get(node_name)
group_output = next((candidate for candidate in group.nodes if candidate.bl_idname == "NodeGroupOutput" and candidate.is_active_output), None)
if node is None or group_output is None:
    raise RuntimeError(f"missing node/group output: {node_name!r}")
source = node.outputs.get(socket_name)
target = next((socket for socket in group_output.inputs if socket.type == "GEOMETRY"), None)
if source is None or target is None:
    raise RuntimeError(f"missing geometry socket: {socket_name!r}")
for link in list(target.links):
    group.links.remove(link)
group.links.new(source, target)

realize_group = bpy.data.node_groups.new("__PROBE_REALIZE_INSTANCES", "GeometryNodeTree")
realize_group.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
realize_group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
realize_input = realize_group.nodes.new("NodeGroupInput")
realize = realize_group.nodes.new("GeometryNodeRealizeInstances")
realize_output = realize_group.nodes.new("NodeGroupOutput")
realize_group.links.new(realize_input.outputs["Geometry"], realize.inputs["Geometry"])
realize_group.links.new(realize.outputs["Geometry"], realize_output.inputs["Geometry"])
realize_modifier = obj.modifiers.new(name="__PROBE_REALIZE_INSTANCES", type="NODES")
realize_modifier.node_group = realize_group

obj.update_tag()
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()
depsgraph.update()
evaluated = obj.evaluated_get(depsgraph)
mesh = evaluated.to_mesh()
positions = [list(vertex.co) for vertex in mesh.vertices] if mesh else []
if positions:
    minimum = [min(position[axis] for position in positions) for axis in range(3)]
    maximum = [max(position[axis] for position in positions) for axis in range(3)]
else:
    minimum = maximum = [0.0, 0.0, 0.0]
payload = {
    "object": object_name,
    "group": group_name,
    "node": node_name,
    "socket": socket_name,
    "verts": len(mesh.vertices) if mesh else 0,
    "faces": len(mesh.polygons) if mesh else 0,
    "triangles": sum(max(0, len(polygon.vertices) - 2) for polygon in mesh.polygons) if mesh else 0,
    "bbox": {"min": minimum, "max": maximum},
}
if os.environ.get("NODE_DOJO_PROBE_GEOMETRY") == "1":
    payload["positions"] = positions
    payload["faces"] = [list(polygon.vertices) for polygon in mesh.polygons] if mesh else []
with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
if mesh:
    evaluated.to_mesh_clear()
print(f"BLENDER_NODE_GEOMETRY_PROBE_OK -> {out_path}")
