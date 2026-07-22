"""Embed a supplied TTF's outlines into an existing GN-VM dump.

Run with Blender so its vector-font converter produces the same kind of curve
atlas as ``dump_blend.py``:

    blender --background --python tools/embed_ttf_outline_atlas.py -- \
        FONT.ttf dump.json ["Missing Font Name" ...]
"""
import bpy
import hashlib
import json
import os
import sys


args = sys.argv[sys.argv.index("--") + 1 :]
font_path, dump_path = args[:2]
target_names = set(args[2:])
if not target_names:
    target_names = {
        name.strip()
        for name in os.environ.get("NODE_DOJO_FONT_NAMES", "").split(",")
        if name.strip()
    }

with open(font_path, "rb") as source_font:
    source_sha256 = hashlib.sha256(source_font.read()).hexdigest()


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
    polygons = [list(polygon.vertices) for polygon in mesh.polygons]
    edge_occurrences = {}
    for polygon_index, vertices in enumerate(polygons):
        for edge_index, start in enumerate(vertices):
            end = vertices[(edge_index + 1) % len(vertices)]
            key = tuple(sorted((start, end)))
            edge_occurrences.setdefault(key, []).append((polygon_index, edge_index, start, end))
    boundary = {
        (occurrences[0][0], occurrences[0][1])
        for occurrences in edge_occurrences.values()
        if len(occurrences) == 1
    }

    def next_boundary_halfedge(polygon_index, edge_index):
        guard = 0
        while guard <= sum(len(vertices) for vertices in polygons):
            guard += 1
            vertices = polygons[polygon_index]
            candidate_index = (edge_index + 1) % len(vertices)
            start = vertices[candidate_index]
            end = vertices[(candidate_index + 1) % len(vertices)]
            occurrences = edge_occurrences[tuple(sorted((start, end)))]
            if len(occurrences) == 1:
                return (polygon_index, candidate_index)
            current = (polygon_index, candidate_index)
            other = next((item for item in occurrences if (item[0], item[1]) != current), None)
            if other is None:
                return None
            polygon_index, edge_index = other[0], other[1]
        return None

    unused = set(boundary)
    splines = []
    while unused:
        first = min(unused)
        edge = first
        indices = []
        cyclic = False
        while edge in unused:
            unused.remove(edge)
            polygon_index, edge_index = edge
            vertices = polygons[polygon_index]
            start = vertices[edge_index]
            end = vertices[(edge_index + 1) % len(vertices)]
            indices.append(start)
            edge = next_boundary_halfedge(polygon_index, edge_index)
            if edge == first:
                cyclic = True
                break
            if edge is None:
                indices.append(end)
                break
        if indices:
            splines.append({
                "cyclic": cyclic,
                "points": [
                    [float(value) for value in mesh.vertices[index].co]
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
    characters = [chr(codepoint) for codepoint in range(32, 127)]
    for character in os.environ.get("NODE_DOJO_FONT_CHARACTERS", ""):
        if character not in characters:
            characters.append(character)
    for character in characters:
        splines = dump_font_glyph(font, character)
        combined = dump_font_glyph(font, character + marker)
        combined_max = max((point[0] for spline in combined for point in spline["points"]), default=marker_max)
        glyphs[character] = {
            "advance": float(max(0.0, combined_max - marker_max)),
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
        align_offsets[socket_value] = float(
            min((point[1] for point in points), default=baseline_min_y) - baseline_min_y
        )
    segments = 0
    axis_aligned_segments = 0
    for glyph in glyphs.values():
        for spline in glyph["curves"]:
            points = spline["points"]
            count = len(points) if spline["cyclic"] else max(0, len(points) - 1)
            for index in range(count):
                start = points[index]
                end = points[(index + 1) % len(points)]
                segments += 1
                if abs(end[0] - start[0]) <= 1e-7 or abs(end[1] - start[1]) <= 1e-7:
                    axis_aligned_segments += 1
    sample_stride = 0 if segments and axis_aligned_segments / segments >= 0.98 else 12
    return {
        "name": font.name,
        "source": os.path.basename(font_path),
        "source_sha256": source_sha256,
        "embedding": "glyph-outline-json-only",
        "sample_stride": sample_stride,
        "align_offsets": align_offsets,
        "glyphs": glyphs,
    }


def align_atlas_to_existing(atlas, existing):
    """Keep an existing atlas' contour order while replacing rounded points."""

    if "sample_stride" in existing:
        atlas["sample_stride"] = existing["sample_stride"]
    else:
        atlas.pop("sample_stride", None)

    def aligned_points(old_curve, new_curve):
        old_points = old_curve["points"]
        new_points = new_curve["points"]
        if len(old_points) != len(new_points):
            return None
        count = len(old_points)
        if count == 0:
            return (0.0, [])
        directions = (1, -1)
        shifts = range(count) if old_curve.get("cyclic") else (0,)
        best = None
        for direction in directions:
            for shift in shifts:
                ordered = [new_points[(shift + direction * index) % count] for index in range(count)]
                score = sum(
                    (float(old[axis]) - float(new[axis])) ** 2
                    for old, new in zip(old_points, ordered)
                    for axis in range(3)
                )
                if best is None or score < best[0]:
                    best = (score, ordered)
        return best

    for character, old_glyph in existing.get("glyphs", {}).items():
        new_glyph = atlas.get("glyphs", {}).get(character)
        if not new_glyph:
            continue
        remaining = list(enumerate(new_glyph.get("curves", [])))
        ordered_curves = []
        for old_curve in old_glyph.get("curves", []):
            matches = []
            for index, new_curve in remaining:
                if bool(old_curve.get("cyclic")) != bool(new_curve.get("cyclic")):
                    continue
                aligned = aligned_points(old_curve, new_curve)
                if aligned is not None:
                    matches.append((aligned[0], index, new_curve, aligned[1]))
            if not matches:
                ordered_curves = []
                break
            _score, matched_index, matched_curve, points = min(matches, key=lambda item: item[0])
            ordered_curves.append({**matched_curve, "points": points})
            remaining = [item for item in remaining if item[0] != matched_index]
        if ordered_curves and not remaining:
            new_glyph["curves"] = ordered_curves
        else:
            # Touching pixel-font cells can be traced as one contour or as
            # several contours depending on which boundary half-edge is
            # visited first. Preserve the established topology and replace
            # each rounded coordinate with the nearest freshly extracted
            # float coordinate instead.
            fresh_points = [
                point
                for curve in new_glyph.get("curves", [])
                for point in curve.get("points", [])
            ]
            if fresh_points:
                new_glyph["curves"] = [
                    {
                        **old_curve,
                        "points": [
                            list(min(
                                fresh_points,
                                key=lambda fresh: sum(
                                    (float(old[axis]) - float(fresh[axis])) ** 2
                                    for axis in range(3)
                                ),
                            ))
                            for old in old_curve.get("points", [])
                        ],
                    }
                    for old_curve in old_glyph.get("curves", [])
                ]
    return atlas


font = bpy.data.fonts.load(font_path, check_existing=True)
with open(dump_path, "r", encoding="utf-8") as source:
    dump = json.load(source)

replaced = set()
replacement_count = 0
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
                replacement_count += 1
            socket["value"] = {"datablock": "VectorFont", "name": font.name}

missing_names = sorted(target_names - replaced)
if missing_names:
    raise RuntimeError(f"font target matched no String to Curves reference: {missing_names}")
existing_atlas = next(
    (dump.get("fonts", {}).get(old_name) for old_name in replaced if dump.get("fonts", {}).get(old_name)),
    None,
)
for old_name in replaced:
    dump.setdefault("fonts", {}).pop(old_name, None)
atlas = dump_font_atlas(font)
if existing_atlas:
    atlas = align_atlas_to_existing(atlas, existing_atlas)
dump.setdefault("fonts", {})[font.name] = atlas

temporary = dump_path + ".tmp"
with open(temporary, "w", encoding="utf-8") as destination:
    json.dump(dump, destination, indent=1)
os.replace(temporary, dump_path)
print(f"TTF_ATLAS_OK {font.name} -> {dump_path} ({replacement_count} font reference(s) replaced)")
