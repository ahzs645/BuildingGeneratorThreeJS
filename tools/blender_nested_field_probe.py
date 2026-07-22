"""Store a field inside a nested node group and route that group's geometry out."""
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
object_name, out_path, group_name, geometry_spec, field_spec, domain = args
obj = bpy.data.objects[object_name]
tree = bpy.data.node_groups[group_name]
probe_scene = bpy.data.scenes.new("__NODE_DOJO_FIELD_PROBE_SCENE")
probe_scene.collection.objects.link(obj)
bpy.context.window.scene = probe_scene
obj.hide_viewport = False
obj.hide_render = False
obj.hide_set(False)
if os.environ.get("NODE_DOJO_LOCAL_SPACE") == "1":
    obj.location = (0, 0, 0)
    obj.rotation_euler = (0, 0, 0)
    obj.scale = (1, 1, 1)
probe_overrides = json.loads(os.environ.get("NODE_DOJO_PROBE_OVERRIDES", "{}"))
if probe_overrides:
    modifier = next((candidate for candidate in obj.modifiers if candidate.type == "NODES" and candidate.node_group is not None), None)
    if modifier is None:
        raise RuntimeError(f"no Geometry Nodes modifier on {object_name!r}")
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

# Match the graph-override contract used by the geometry and GN-VM probes so
# nested fields can be compared under reduced repeat counts or isolated group
# inputs without modifying the source .blend on disk.
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

# Node modes such as Curve to Points' COUNT/EVALUATED selector are RNA
# properties rather than sockets. Allow precision probes to change those
# properties without editing the source .blend file.
for override in json.loads(os.environ.get("NODE_DOJO_PROBE_NODE_PROPERTIES", "[]")):
    override_group = bpy.data.node_groups.get(override["group"])
    override_node = override_group.nodes.get(override["node"]) if override_group else None
    if override_node is None:
        raise RuntimeError(f"missing property override node: {override!r}")
    for name, value in override.get("properties", {}).items():
        if not hasattr(override_node, name):
            raise AttributeError(f"node property not found: {override_node.name}.{name}")
        setattr(override_node, name, value)

# A deeply nested field can be surfaced through an existing group output before
# the parent group stores it. This keeps all of the original group inputs and
# evaluation contexts intact, which is important for field-at-index diagnostics.
inner_output_links = []
for remap in json.loads(os.environ.get("NODE_DOJO_PROBE_INNER_OUTPUTS", "[]")):
    inner_tree = bpy.data.node_groups[remap["group"]]
    inner_group_output = next(
        node for node in inner_tree.nodes
        if node.bl_idname == "NodeGroupOutput" and node.is_active_output
    )
    target = inner_group_output.inputs[remap["output"]]
    source = inner_tree.nodes[remap["node"]].outputs[remap["socket"]]
    inner_output_links.append((inner_tree, target, target.links[0].from_socket if target.is_linked else None))
    for link in list(target.links):
        inner_tree.links.remove(link)
    inner_tree.links.new(source, target)
geometry_node, geometry_socket = geometry_spec.split(":", 1)
field_node, field_socket = field_spec.split(":", 1)
group_output = next(node for node in tree.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
geometry_output = next(socket for socket in group_output.inputs if socket.type == "GEOMETRY")
original = geometry_output.links[0].from_socket if geometry_output.is_linked else None
synthetic_field = None
if field_node == "__POSITION__":
    synthetic_field = tree.nodes.new("GeometryNodeInputPosition")
    field_output = synthetic_field.outputs[field_socket]
elif field_node == "__INSTANCE_SCALE__":
    synthetic_field = tree.nodes.new("GeometryNodeInputInstanceScale")
    field_output = synthetic_field.outputs[field_socket]
else:
    field_outputs = tree.nodes[field_node].outputs
    field_output = field_outputs.get(field_socket) or next(
        socket for socket in field_outputs if socket.identifier == field_socket
    )
rotation_converter = None
if field_output.bl_idname == "NodeSocketRotation":
    quaternion_component = os.environ.get("NODE_DOJO_ROTATION_COMPONENT", "").upper()
    if quaternion_component in {"W", "X", "Y", "Z"}:
        rotation_converter = tree.nodes.new("FunctionNodeRotationToQuaternion")
        tree.links.new(field_output, rotation_converter.inputs["Rotation"])
        field_output = rotation_converter.outputs[quaternion_component]
    else:
        rotation_converter = tree.nodes.new("FunctionNodeRotationToEuler")
        tree.links.new(field_output, rotation_converter.inputs["Rotation"])
        field_output = rotation_converter.outputs["Euler"]
store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
store.data_type = "FLOAT_VECTOR" if field_output.bl_idname.startswith("NodeSocketVector") else {
    "NodeSocketBool": "BOOLEAN",
    "NodeSocketInt": "INT",
}.get(field_output.bl_idname, "FLOAT")
store.domain = domain.upper()
store.inputs["Name"].default_value = "__nested_probe"
geometry_outputs = tree.nodes[geometry_node].outputs
geometry_source = geometry_outputs.get(geometry_socket) or next(
    socket for socket in geometry_outputs if socket.identifier == geometry_socket
)
tree.links.new(geometry_source, store.inputs["Geometry"])
tree.links.new(field_output, store.inputs["Value"])
for link in list(geometry_output.links):
    tree.links.remove(link)
realize = None
to_vertices = None
if domain.upper() == "INSTANCE":
    # Object evaluation realizes output instances, but attributes stored only
    # on the instance domain are otherwise omitted from the resulting mesh
    # attribute list. Realize explicitly so the captured value propagates to
    # every point of each payload and can be inspected below.
    realize = tree.nodes.new("GeometryNodeRealizeInstances")
    tree.links.new(store.outputs["Geometry"], realize.inputs["Geometry"])
    tree.links.new(realize.outputs["Geometry"], geometry_output)
elif os.environ.get("NODE_DOJO_PROBE_POINTS_TO_VERTICES") == "1":
    # Point-cloud components are not exposed by Object.to_mesh(). Convert them
    # to loose mesh vertices so POINT-domain texture/field probes remain
    # inspectable without changing their positions or stored attributes.
    to_vertices = tree.nodes.new("GeometryNodePointsToVertices")
    tree.links.new(store.outputs["Geometry"], to_vertices.inputs["Points"])
    tree.links.new(to_vertices.outputs["Mesh"], geometry_output)
else:
    tree.links.new(store.outputs["Geometry"], geometry_output)

# Optionally carry a nested group's temporary output through each containing
# group to the modifier root. Without this, downstream nodes can delete or
# remap the stored domain before it reaches the evaluated object.
route_links = []
for step in json.loads(os.environ.get("NODE_DOJO_PROBE_ROUTE", "[]")):
    route_tree = bpy.data.node_groups[step["group"]]
    route_node = route_tree.nodes[step["node"]]
    route_output = next(node for node in route_tree.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output)
    route_target = next(
        socket
        for socket in route_output.inputs
        if socket.type == "GEOMETRY"
        and (
            not step.get("output")
            or socket.name == step["output"]
            or socket.identifier == step["output"]
        )
    )
    route_source = route_node.outputs[step["socket"]]
    route_links.append((route_tree, route_target, route_target.links[0].from_socket if route_target.is_linked else None))
    for link in list(route_target.links):
        route_tree.links.remove(link)
    route_tree.links.new(route_source, route_target)

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
    edge_vertices = [[int(vertex) for vertex in edge.vertices] for edge in mesh.edges]
    faces = [[int(vertex) for vertex in polygon.vertices] for polygon in mesh.polygons]
    payload = {
        "domain": domain.upper(),
        "values": values,
        "positions": positions,
        "edge_vertices": edge_vertices,
        "face_vertices": faces,
        "verts": len(mesh.vertices),
        "faces": len(mesh.polygons),
        "edges": len(mesh.edges),
    }
finally:
    evaluated.to_mesh_clear()
    for route_tree, route_target, route_original in reversed(route_links):
        for link in list(route_target.links):
            route_tree.links.remove(link)
        if route_original is not None:
            route_tree.links.new(route_original, route_target)
    for inner_tree, target, inner_original in reversed(inner_output_links):
        for link in list(target.links):
            inner_tree.links.remove(link)
        if inner_original is not None:
            inner_tree.links.new(inner_original, target)
    for link in list(geometry_output.links):
        tree.links.remove(link)
    if original is not None:
        tree.links.new(original, geometry_output)
    if realize is not None:
        tree.nodes.remove(realize)
    if to_vertices is not None:
        tree.nodes.remove(to_vertices)
    if synthetic_field is not None:
        tree.nodes.remove(synthetic_field)
    if rotation_converter is not None:
        tree.nodes.remove(rotation_converter)
    tree.nodes.remove(store)

with open(out_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2)
print(f"BLENDER_NESTED_FIELD_PROBE_OK -> {out_path}")
