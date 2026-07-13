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

    def bezier(a, b, c, d, factor):
        inverse = 1.0 - factor
        return [
            inverse**3 * a[index]
            + 3.0 * inverse * inverse * factor * b[index]
            + 3.0 * inverse * factor * factor * c[index]
            + factor**3 * d[index]
            for index in range(3)
        ]

    splines = []
    for spline in obj.data.splines:
        cyclic = bool(spline.use_cyclic_u)
        if spline.type == "BEZIER":
            controls = list(spline.bezier_points)
            all_vector = all(
                point.handle_left_type == "VECTOR" and point.handle_right_type == "VECTOR"
                for point in controls
            )
            if all_vector:
                points = [[round(value, 7) for value in point.co] for point in controls]
            else:
                points = []
                segment_count = len(controls) if cyclic else max(0, len(controls) - 1)
                resolution = max(2, int(spline.resolution_u or obj.data.resolution_u or 12))
                for segment in range(segment_count):
                    first = controls[segment]
                    second = controls[(segment + 1) % len(controls)]
                    for step in range(resolution):
                        points.append([
                            round(value, 7)
                            for value in bezier(
                                first.co,
                                first.handle_right,
                                second.handle_left,
                                second.co,
                                step / resolution,
                            )
                        ])
                if not cyclic and controls:
                    points.append([round(value, 7) for value in controls[-1].co])
        else:
            points = [[round(point.co[index], 7) for index in range(3)] for point in spline.points]
        if points:
            splines.append({"cyclic": cyclic, "points": points})

    data = obj.data
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
