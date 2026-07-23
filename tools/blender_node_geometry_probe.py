"""Route one Geometry Nodes output socket to the modifier output and report it.

Usage:
  blender --background FILE.blend --python tools/blender_node_geometry_probe.py -- \
    OBJECT GROUP NODE SOCKET OUT.json
"""
import json
import os
import sys

import bpy


font_override = os.environ.get("NODE_DOJO_FONT_OVERRIDE")
if font_override:
    replacement_font = bpy.data.fonts.load(font_override, check_existing=True)
    for node_group in bpy.data.node_groups:
        for candidate in node_group.nodes:
            if candidate.bl_idname != "GeometryNodeStringToCurves":
                continue
            font_socket = candidate.inputs.get("Font")
            if font_socket is not None:
                font_socket.default_value = replacement_font


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
# by default, matching the reference-render and parity-sweep workflow. Some
# legacy volume graphs intentionally inherit their authored scene evaluation
# context; NODE_DOJO_ACTIVE_SCENE=1 keeps that context for precision probes.
if os.environ.get("NODE_DOJO_ACTIVE_SCENE") != "1":
    probe_scene = bpy.data.scenes.new("__NODE_DOJO_GEOMETRY_PROBE_SCENE")
    probe_scene.collection.objects.link(obj)
    bpy.context.window.scene = probe_scene
elif obj.name not in bpy.context.view_layer.objects and bpy.context.scene.collection.objects.get(obj.name) is None:
    world_matrix = obj.matrix_world.copy()
    bpy.context.scene.collection.objects.link(obj)
    obj.matrix_world = world_matrix
obj.hide_viewport = False
obj.hide_render = False
obj.hide_set(False)
if os.environ.get("NODE_DOJO_LOCAL_SPACE") == "1":
    # Match parity_sweep.py and the gallery's local-space mode. Relative Object
    # Info nodes then see the authored dependency transforms from an identity
    # modifier object, rather than inheriting the asset-library display offset.
    obj.location = (0, 0, 0)
    obj.rotation_euler = (0, 0, 0)
    obj.scale = (1, 1, 1)
modifier = next((candidate for candidate in obj.modifiers if candidate.type == "NODES" and candidate.node_group is not None), None)
probe_overrides = json.loads(os.environ.get("NODE_DOJO_PROBE_OVERRIDES", "{}"))
if probe_overrides:
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
node_overrides = json.loads(os.environ.get("NODE_DOJO_PROBE_NODE_OVERRIDES", "{}"))
for name, value in node_overrides.items():
    socket = node.inputs.get(name)
    if socket is None:
        raise KeyError(f"node input not found: {node_name}.{name}")
    socket.default_value = value
graph_overrides = json.loads(os.environ.get("NODE_DOJO_PROBE_GRAPH_OVERRIDES", "[]"))
for override in graph_overrides:
    override_group = bpy.data.node_groups.get(override["group"])
    override_node = override_group.nodes.get(override["node"]) if override_group else None
    if override_node is None:
        raise RuntimeError(f"missing graph override node: {override!r}")
    for name, value in override.get("inputs", {}).items():
        socket = override_node.inputs.get(name)
        if socket is None:
            raise KeyError(f"graph override input not found: {override_node.name}.{name}")
        socket.default_value = value

# Surface an internal field through an existing nested-group output while
# preserving the caller's evaluation domain. This is useful for diagnosing
# Evaluate on Domain chains whose result changes when sampled on FACE vs POINT.
for remap in json.loads(os.environ.get("NODE_DOJO_PROBE_INNER_OUTPUTS", "[]")):
    inner_group = bpy.data.node_groups.get(remap["group"])
    inner_node = inner_group.nodes.get(remap["node"]) if inner_group else None
    inner_output = next(
        (
            candidate
            for candidate in inner_group.nodes
            if candidate.bl_idname == "NodeGroupOutput" and candidate.is_active_output
        ),
        None,
    ) if inner_group else None
    source = inner_node.outputs.get(remap["socket"]) if inner_node else None
    target = inner_output.inputs.get(remap["output"]) if inner_output else None
    if source is None or target is None:
        raise RuntimeError(f"missing inner output remap: {remap!r}")
    for link in list(target.links):
        inner_group.links.remove(link)
    inner_group.links.new(source, target)

# Persist otherwise-anonymous fields through a simulation/repeat zone by
# inserting Store Named Attribute on an existing geometry link inside the
# zone. The final routed geometry then exposes the values through to_mesh().
stored_fields = []
for spec in json.loads(os.environ.get("NODE_DOJO_PROBE_STORE_FIELDS", "[]")):
    store_group = bpy.data.node_groups.get(spec["group"])
    consumer_node = store_group.nodes.get(spec["consumer_node"]) if store_group else None
    field_node = store_group.nodes.get(spec["field_node"]) if store_group else None
    geometry_node = store_group.nodes.get(spec["geometry_node"]) if store_group and spec.get("geometry_node") else None
    if consumer_node is None or field_node is None:
        raise RuntimeError(f"missing stored-field node: {spec!r}")
    consumer_input = consumer_node.inputs.get(spec.get("consumer_socket", "Geometry"))
    field_source = field_node.outputs.get(spec["field_socket"])
    geometry_source = (
        geometry_node.outputs.get(spec["geometry_socket"])
        if geometry_node is not None
        else consumer_input.links[0].from_socket if consumer_input and consumer_input.is_linked else None
    )
    if geometry_source is None or consumer_input is None or field_source is None:
        raise RuntimeError(f"missing stored-field socket: {spec!r}")
    store = store_group.nodes.new("GeometryNodeStoreNamedAttribute")
    store.data_type = spec.get("data_type", "FLOAT")
    store.domain = spec.get("domain", "POINT")
    store.inputs["Name"].default_value = spec["name"]
    for link in list(consumer_input.links):
        store_group.links.remove(link)
    store_group.links.new(geometry_source, store.inputs["Geometry"])
    store_group.links.new(field_source, store.inputs["Value"])
    store_group.links.new(store.outputs["Geometry"], consumer_input)
    if spec.get("route_stored_geometry"):
        store_output = next(
            (
                candidate
                for candidate in store_group.nodes
                if candidate.bl_idname == "NodeGroupOutput" and candidate.is_active_output
            ),
            None,
        )
        store_target = next(
            (socket for socket in store_output.inputs if socket.type == "GEOMETRY"),
            None,
        ) if store_output else None
        if store_target is None:
            raise RuntimeError(f"missing stored-field route output: {spec!r}")
        for link in list(store_target.links):
            store_group.links.remove(link)
        store_group.links.new(store.outputs["Geometry"], store_target)
    stored_fields.append((spec["name"], store.data_type))
source = node.outputs.get(socket_name)
target = next((socket for socket in group_output.inputs if socket.type == "GEOMETRY"), None)
if source is None or target is None:
    raise RuntimeError(f"missing geometry socket: {socket_name!r}")
for link in list(target.links):
    group.links.remove(link)
group.links.new(source, target)

# When probing a node inside nested groups, optionally route every containing
# group instance outward to its active geometry output. The route is ordered
# from the source's immediate parent to the modifier root, for example:
# [{"group":"inner parent","node":"Group.001","socket":"Mesh"}, ...]
# This prevents downstream smoothing/boolean stages from obscuring the
# intermediate topology being measured.
route = json.loads(os.environ.get("NODE_DOJO_PROBE_ROUTE", "[]"))
for step in route:
    route_group = bpy.data.node_groups.get(step["group"])
    route_node = route_group.nodes.get(step["node"]) if route_group else None
    route_output = next((candidate for candidate in route_group.nodes if candidate.bl_idname == "NodeGroupOutput" and candidate.is_active_output), None) if route_group else None
    route_source = route_node.outputs.get(step["socket"]) if route_node else None
    route_target = next((socket for socket in route_output.inputs if socket.type == "GEOMETRY"), None) if route_output else None
    if route_source is None or route_target is None:
        raise RuntimeError(f"missing probe route: {step!r}")
    for link in list(route_target.links):
        route_group.links.remove(link)
    route_group.links.new(route_source, route_target)

# Preserve the original one-level environment variables used by existing
# parity investigations.
root_node_name = os.environ.get("NODE_DOJO_PROBE_ROOT_NODE")
if root_node_name and not route:
    if modifier is None:
        raise RuntimeError(f'no Geometry Nodes modifier on {object_name!r}')
    root_group = modifier.node_group
    root_node = root_group.nodes.get(root_node_name)
    root_output = next((candidate for candidate in root_group.nodes if candidate.bl_idname == "NodeGroupOutput" and candidate.is_active_output), None)
    root_socket_name = os.environ.get("NODE_DOJO_PROBE_ROOT_SOCKET", socket_name)
    root_source = root_node.outputs.get(root_socket_name) if root_node else None
    root_target = next((socket for socket in root_output.inputs if socket.type == "GEOMETRY"), None) if root_output else None
    if root_source is None or root_target is None:
        raise RuntimeError(f"missing root probe socket: {root_node_name!r}:{root_socket_name!r}")
    for link in list(root_target.links):
        root_group.links.remove(link)
    root_group.links.new(root_source, root_target)

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
    payload["edges"] = [list(edge.vertices) for edge in mesh.edges] if mesh else []
    payload["faces"] = [list(polygon.vertices) for polygon in mesh.polygons] if mesh else []
    if mesh:
        mesh.calc_loop_triangles()
        payload["loop_triangles"] = [list(triangle.vertices) for triangle in mesh.loop_triangles]
        payload["attributes"] = {}
        for name, data_type in stored_fields:
            attribute = mesh.attributes.get(name)
            if attribute is None:
                payload["attributes"][name] = []
            elif data_type == "FLOAT_VECTOR":
                payload["attributes"][name] = [list(item.vector) for item in attribute.data]
            elif data_type in {"FLOAT_COLOR", "BYTE_COLOR"}:
                payload["attributes"][name] = [list(item.color) for item in attribute.data]
            else:
                payload["attributes"][name] = [item.value for item in attribute.data]
with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
if mesh:
    evaluated.to_mesh_clear()
print(f"BLENDER_NODE_GEOMETRY_PROBE_OK -> {out_path}")
