"""Probe a TTF through Blender's String to Curves -> Realize -> Fill path."""
import os

import bpy


path = os.environ.get("NODE_DOJO_FONT_OVERRIDE")
if not path:
    raise RuntimeError("NODE_DOJO_FONT_OVERRIDE is required")
font = bpy.data.fonts.load(path, check_existing=True)
group = bpy.data.node_groups.new("__FONT_GEOMETRY_PROBE", "GeometryNodeTree")
group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
text = group.nodes.new("GeometryNodeStringToCurves")
text.inputs["String"].default_value = os.environ.get("NODE_DOJO_FONT_PROBE_TEXT", "NODE DOJO")
text.inputs["Font"].default_value = font
realize = group.nodes.new("GeometryNodeRealizeInstances")
fill = group.nodes.new("GeometryNodeFillCurve")
output = group.nodes.new("NodeGroupOutput")
group.links.new(text.outputs["Curve Instances"], realize.inputs["Geometry"])
group.links.new(realize.outputs["Geometry"], fill.inputs["Curve"])
group.links.new(fill.outputs["Mesh"], output.inputs["Geometry"])

mesh = bpy.data.meshes.new("__FONT_GEOMETRY_PROBE")
obj = bpy.data.objects.new("__FONT_GEOMETRY_PROBE", mesh)
bpy.context.scene.collection.objects.link(obj)
modifier = obj.modifiers.new("__FONT_GEOMETRY_PROBE", "NODES")
modifier.node_group = group
bpy.context.view_layer.update()
evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
result = evaluated.to_mesh()
print(f"FONT_GEOMETRY_PROBE_OK {font.name}: {len(result.vertices)} verts / {len(result.polygons)} faces")
evaluated.to_mesh_clear()
