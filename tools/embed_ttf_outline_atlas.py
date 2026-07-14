"""Embed a supplied TTF's outlines into an existing GN-VM dump.

Run with Blender so its vector-font converter produces the same kind of curve
atlas as ``dump_blend.py``:

    blender --background --python tools/embed_ttf_outline_atlas.py -- FONT.ttf dump.json
"""
import bpy
import json
import os
import sys


args = sys.argv[sys.argv.index("--") + 1 :]
font_path, dump_path = args[:2]
target_names = {
    name.strip()
    for name in os.environ.get("NODE_DOJO_FONT_NAMES", "").split(",")
    if name.strip()
}


def dump_font_glyph(font, character, align_y="TOP_BASELINE"):
    curve = bpy.data.curves.new("__NODE_DOJO_FONT_GLYPH", "FONT")
    curve.body = character
    curve.font = font
    curve.size = 1.0
    curve.align_x = "LEFT"
    curve.align_y = align_y
    obj = bpy.data.objects.new("__NODE_DOJO_FONT_GLYPH", curve)
    bpy.context.scene.collection.objects.link(obj)
    for selected in bpy.context.selected_objects:
        selected.select_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="CURVE")

    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
    edge_uses = {}
    edge_directions = {}
    for polygon in mesh.polygons:
        vertices = list(polygon.vertices)
        for index, start in enumerate(vertices):
            end = vertices[(index + 1) % len(vertices)]
            key = tuple(sorted((start, end)))
            edge_uses[key] = edge_uses.get(key, 0) + 1
            edge_directions[key] = (start, end)
    unused = {
        edge_directions[key]
        for key, count in edge_uses.items()
        if count == 1
    }
    next_edge = {start: (start, end) for start, end in unused}
    splines = []
    while unused:
        first = next(iter(unused))
        edge = first
        indices = []
        cyclic = False
        while edge in unused:
            unused.remove(edge)
            start, end = edge
            indices.append(start)
            if end == first[0]:
                cyclic = True
                break
            edge = next_edge.get(end)
            if edge is None:
                indices.append(end)
                break
        if indices:
            splines.append({
                "cyclic": cyclic,
                "points": [
                    [round(value, 7) for value in mesh.vertices[index].co]
                    for index in indices
                ],
            })

    data = obj.data
    bpy.data.meshes.remove(mesh)
    bpy.data.objects.remove(obj, do_unlink=True)
    if data.users == 0:
        bpy.data.curves.remove(data)
    return splines


def dump_font_atlas(font):
    marker = "|"
    marker_splines = dump_font_glyph(font, marker)
    marker_max = max((point[0] for spline in marker_splines for point in spline["points"]), default=0.0)
    glyphs = {}
    for codepoint in range(32, 127):
        character = chr(codepoint)
        splines = dump_font_glyph(font, character)
        combined = dump_font_glyph(font, character + marker)
        combined_max = max((point[0] for spline in combined for point in spline["points"]), default=marker_max)
        glyphs[character] = {
            "advance": round(max(0.0, combined_max - marker_max), 7),
            "curves": splines,
        }

    baseline = [point for spline in dump_font_glyph(font, "A", "TOP_BASELINE") for point in spline["points"]]
    baseline_min_y = min((point[1] for point in baseline), default=0.0)
    alignments = {
        "TOP": "Top",
        "TOP_BASELINE": "Top Baseline",
        "CENTER": "Middle",
        "BOTTOM_BASELINE": "Bottom Baseline",
        "BOTTOM": "Bottom",
    }
    align_offsets = {}
    for blender_value, socket_value in alignments.items():
        points = [point for spline in dump_font_glyph(font, "A", blender_value) for point in spline["points"]]
        align_offsets[socket_value] = round(
            min((point[1] for point in points), default=baseline_min_y) - baseline_min_y,
            7,
        )
    return {
        "name": font.name,
        "source": os.path.basename(font_path),
        "align_offsets": align_offsets,
        "glyphs": glyphs,
    }


font = bpy.data.fonts.load(font_path, check_existing=True)
with open(dump_path, "r", encoding="utf-8") as source:
    dump = json.load(source)

replaced = set()
for group in dump.get("node_groups", {}).values():
    for node in group.get("nodes", []):
        if node.get("type") != "GeometryNodeStringToCurves":
            continue
        for socket in node.get("inputs", []):
            if socket.get("name") != "Font":
                continue
            value = socket.get("value")
            if isinstance(value, dict) and value.get("name"):
                if target_names and value["name"] not in target_names:
                    continue
                replaced.add(value["name"])
            socket["value"] = {"datablock": "VectorFont", "name": font.name}

for old_name in replaced:
    dump.setdefault("fonts", {}).pop(old_name, None)
dump.setdefault("fonts", {})[font.name] = dump_font_atlas(font)

temporary = dump_path + ".tmp"
with open(temporary, "w", encoding="utf-8") as destination:
    json.dump(dump, destination, indent=1)
os.replace(temporary, dump_path)
print(f"TTF_ATLAS_OK {font.name} -> {dump_path} ({len(replaced)} font reference(s) replaced)")
