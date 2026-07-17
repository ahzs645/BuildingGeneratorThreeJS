"""Probe a TTF through Blender's String to Curves -> Realize -> Fill path.

Usage:
  blender --background --python tools/blender_font_geometry_probe.py -- \
    FONT_PATH [TEXT] [OUT.json]

The legacy ``NODE_DOJO_FONT_OVERRIDE`` and ``NODE_DOJO_FONT_PROBE_TEXT``
environment variables remain supported when positional arguments are omitted.
"""
import json
import os
import sys
from collections import Counter

import bpy


args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
path = args[0] if args else os.environ.get("NODE_DOJO_FONT_OVERRIDE")
if not path:
    raise RuntimeError("FONT_PATH or NODE_DOJO_FONT_OVERRIDE is required")
probe_text = args[1] if len(args) > 1 else os.environ.get("NODE_DOJO_FONT_PROBE_TEXT", "NODE DOJO")
out_path = args[2] if len(args) > 2 else None
font = bpy.data.fonts.load(path, check_existing=True)
group = bpy.data.node_groups.new("__FONT_GEOMETRY_PROBE", "GeometryNodeTree")
group.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
text = group.nodes.new("GeometryNodeStringToCurves")
text.inputs["String"].default_value = probe_text
text.inputs["Font"].default_value = font
realize = group.nodes.new("GeometryNodeRealizeInstances")
fill = group.nodes.new("GeometryNodeFillCurve")
if fill.inputs.get("Mode") is not None:
    fill.inputs["Mode"].default_value = "N-gons"
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
if out_path:
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump({
            "font": font.name,
            "text": probe_text,
            "positions": [list(vertex.co) for vertex in result.vertices],
            "faces": [list(face.vertices) for face in result.polygons],
        }, handle)
    print(f"FONT_GEOMETRY_PROBE_JSON_OK -> {out_path}")
if os.environ.get("NODE_DOJO_FONT_PROBE_VERBOSE"):
    print("FONT_GEOMETRY_FACE_SIZES", dict(sorted(Counter(len(face.vertices) for face in result.polygons).items())))
evaluated.to_mesh_clear()
