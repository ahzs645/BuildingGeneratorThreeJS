"""Report source and evaluated geometry attributes for one Blender object.

Usage:
  blender --background FILE.blend --python tools/probe_geometry_attributes.py -- OBJECT_NAME [REALIZE]

``REALIZE`` appends a temporary Realize Instances modifier before probing the
evaluated mesh. The JSON output is intentionally compact enough to retain in a
terminal transcript while exposing domains, types, ranges, and representative
values needed to reconstruct shader-visible attributes.
"""
import json
import math
import sys

import bpy


args = sys.argv[sys.argv.index("--") + 1:]
object_name = args[0]
realize = len(args) > 1 and args[1].upper() == "REALIZE"
obj = bpy.data.objects.get(object_name)
if obj is None:
    raise RuntimeError(f'object not found: "{object_name}"')


def item_value(item):
    for name in ("value", "vector", "color", "color_srgb", "uv"):
        if hasattr(item, name):
            value = getattr(item, name)
            if isinstance(value, (int, float, bool)):
                return float(value)
            try:
                return [float(component) for component in value]
            except TypeError:
                pass
    return None


def attribute_summary(attributes):
    result = {}
    for attribute in attributes:
        values = [item_value(item) for item in attribute.data]
        numeric = [
            component
            for value in values
            for component in (value if isinstance(value, list) else [value])
            if isinstance(component, (int, float)) and math.isfinite(component)
        ]
        serialized = {
            "domain": attribute.domain,
            "data_type": attribute.data_type,
            "count": len(values),
            "sample": values[:12],
        }
        if numeric:
            serialized["range"] = [min(numeric), max(numeric)]
        result[attribute.name] = serialized
    return result


source_attributes = attribute_summary(getattr(obj.data, "attributes", [])) if obj.data else {}
if realize:
    group = bpy.data.node_groups.new("__ATTRIBUTE_PROBE_REALIZE", "GeometryNodeTree")
    group.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    group_input = group.nodes.new("NodeGroupInput")
    realize_node = group.nodes.new("GeometryNodeRealizeInstances")
    group_output = group.nodes.new("NodeGroupOutput")
    group.links.new(group_input.outputs["Geometry"], realize_node.inputs["Geometry"])
    group.links.new(realize_node.outputs["Geometry"], group_output.inputs["Geometry"])
    modifier = obj.modifiers.new(name="__ATTRIBUTE_PROBE_REALIZE", type="NODES")
    modifier.node_group = group

depsgraph = bpy.context.evaluated_depsgraph_get()
depsgraph.update()
evaluated = obj.evaluated_get(depsgraph)
mesh = evaluated.to_mesh()
try:
    report = {
        "object": object_name,
        "source_type": obj.type,
        "realized": realize,
        "source_attributes": source_attributes,
        "evaluated": {
            "verts": len(mesh.vertices),
            "faces": len(mesh.polygons),
            "attributes": attribute_summary(mesh.attributes),
        },
    }
finally:
    evaluated.to_mesh_clear()

print(f"GEOMETRY_ATTRIBUTE_PROBE {json.dumps(report, sort_keys=True)}")
