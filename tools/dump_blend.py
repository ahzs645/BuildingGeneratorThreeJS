"""Dump geometry node trees, objects, and materials from a .blend to JSON."""
import bpy
import base64
import hashlib
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stl_payload import StlPayloadError, load_stl_payload

tool_args = sys.argv[sys.argv.index("--") + 1:]
out_path = tool_args[0]
target_object = tool_args[1] if len(tool_args) > 1 else None


def font_source_metadata(font):
    """Describe where a VectorFont can be recovered without exporting it."""
    authored_path = getattr(font, "filepath", "") or ""
    packed_file = getattr(font, "packed_file", None)
    if not authored_path or authored_path == "<builtin>":
        return {
            "status": "builtin",
            "authored_filepath": authored_path or "<builtin>",
            "binary_extractable": False,
        }
    if packed_file is not None:
        packed_size = int(getattr(packed_file, "size", 0))
        try:
            packed_data = packed_file.data
            binary_extractable = isinstance(packed_data, bytes) and len(packed_data) == packed_size
        except Exception:
            binary_extractable = False
        return {
            "status": "packed-extractable" if binary_extractable else "packed-unreadable",
            "authored_filepath": authored_path,
            "packed_size_bytes": packed_size,
            "binary_extractable": binary_extractable,
        }
    resolved_path = bpy.path.abspath(authored_path)
    external_available = os.path.isfile(resolved_path)
    return {
        "status": "external-available" if external_available else "external-missing",
        "authored_filepath": authored_path,
        "binary_extractable": external_available,
    }


def dump_opt_in_packed_font_binary(font, source_metadata):
    """Return a bounded packed binary only when the caller explicitly opts in.

    Font binaries can carry redistribution restrictions. The normal portable
    payload remains the evaluated glyph atlas; raw bytes are never included by
    default.
    """
    if os.environ.get("NODE_DOJO_INCLUDE_PACKED_FONT_BYTES") != "1":
        return None
    if source_metadata.get("status") not in ("packed-extractable", "packed-unreadable"):
        return None
    try:
        configured_limit = int(os.environ.get("NODE_DOJO_MAX_PACKED_FONT_BYTES", str(8 * 1024 * 1024)))
    except ValueError:
        configured_limit = 8 * 1024 * 1024
    # Always retain a hard ceiling even when the environment is misconfigured.
    byte_limit = max(0, min(configured_limit, 32 * 1024 * 1024))
    packed_size = int(source_metadata.get("packed_size_bytes", 0))
    if packed_size > byte_limit:
        return {
            "included": False,
            "error": "PACKED_FONT_SIZE_LIMIT_EXCEEDED",
            "byte_length": packed_size,
            "byte_limit": byte_limit,
        }
    try:
        data = bytes(font.packed_file.data)
    except Exception as error:
        return {
            "included": False,
            "error": "PACKED_FONT_DATA_UNREADABLE",
            "message": repr(error),
            "byte_limit": byte_limit,
        }
    if len(data) > byte_limit:
        return {
            "included": False,
            "error": "PACKED_FONT_SIZE_LIMIT_EXCEEDED",
            "byte_length": len(data),
            "byte_limit": byte_limit,
        }
    return {
        "included": True,
        "encoding": "base64",
        "byte_length": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "data": base64.b64encode(data).decode("ascii"),
    }


def apply_font_override():
    path = os.environ.get("NODE_DOJO_FONT_OVERRIDE")
    if not path:
        return
    replacement = bpy.data.fonts.load(path, check_existing=True)
    basename = os.path.basename(path).lower()
    for group in bpy.data.node_groups:
        for node in group.nodes:
            for socket in node.inputs:
                current = getattr(socket, "default_value", None)
                if getattr(socket, "type", "") != "FONT" or current is None:
                    continue
                if os.path.basename(bpy.path.abspath(current.filepath)).lower() == basename:
                    socket.default_value = replacement
    print(f"NODE_DOJO_FONT_OVERRIDE_OK {replacement.name} <- {path}")


apply_font_override()

def socket_value(sock):
    try:
        if not hasattr(sock, "default_value"):
            return None
        v = sock.default_value
        if hasattr(v, "__len__") and not isinstance(v, str):
            return list(v)
        if hasattr(v, "name"):  # datablock pointer (object, material, image...)
            return {"datablock": type(v).__name__, "name": v.name}
        return v
    except Exception as e:
        return f"<err {e}>"

def dump_mesh_attributes(mesh, include_uv=False):
    attrs = {}
    for attribute in mesh.attributes:
        if attribute.name.startswith(".") or attribute.name == "position":
            continue
        try:
            if attribute.data_type in ("FLOAT", "INT", "BOOLEAN"):
                attrs[attribute.name] = {
                    "domain": attribute.domain,
                    "data": [float(item.value) for item in attribute.data],
                }
            elif attribute.data_type == "FLOAT_VECTOR":
                attrs[attribute.name] = {
                    "domain": attribute.domain,
                    "data": [[float(component) for component in item.vector] for item in attribute.data],
                }
            elif attribute.data_type in ("FLOAT_COLOR", "BYTE_COLOR"):
                # GN-VM color fields and WebGL attributes use RGB. Blender's
                # fourth component is alpha metadata and is not consumed by the
                # supplied Geometry Nodes or shader graphs.
                attrs[attribute.name] = {
                    "domain": attribute.domain,
                    "data": [[float(component) for component in item.color[:3]] for item in attribute.data],
                }
        except Exception:
            pass
    # Blender keeps UV maps in mesh.uv_layers rather than exposing them as a
    # public FLOAT2 mesh attribute. Geometry Nodes and shader Texture
    # Coordinate -> UV consume the active layer on the CORNER domain, so retain
    # it explicitly as a vec3-compatible GN-VM attribute.
    active_uv = mesh.uv_layers.active if include_uv else None
    if active_uv is not None and active_uv.name not in attrs:
        attrs[active_uv.name] = {
            "domain": "CORNER",
            "data": [[float(item.uv[0]), float(item.uv[1]), 0.0] for item in active_uv.data],
        }
    return attrs

def dump_node(node):
    def socket_meta(socket):
        return {
            "name": socket.name,
            "identifier": socket.identifier,
            "type": socket.bl_idname,
            "linked": socket.is_linked,
            "enabled": bool(getattr(socket, "enabled", True)),
            "hide": bool(getattr(socket, "hide", False)),
            "hide_value": bool(getattr(socket, "hide_value", False)),
            "display_shape": getattr(socket, "display_shape", "CIRCLE"),
        }
    d = {
        "name": node.name,
        "type": node.bl_idname,
        "label": node.label or None,
        "ui": {
            "location": list(node.location),
            "location_absolute": list(getattr(node, "location_absolute", node.location)),
            "width": float(node.width),
            "height": float(node.height),
            "dimensions": list(node.dimensions),
            "hide": bool(node.hide),
            "mute": bool(node.mute),
            "use_custom_color": bool(node.use_custom_color),
            "color": list(node.color),
            "parent": node.parent.name if node.parent else None,
        },
        "inputs": [],
        "outputs": [{**socket_meta(o), "default": socket_value(o)} for o in node.outputs],
    }
    for i, s in enumerate(node.inputs):
        d["inputs"].append({
            **socket_meta(s),
            "idx": i,
            "value": None if s.is_linked else socket_value(s),
        })
    if node.bl_idname == "GeometryNodeBake":
        input_by_identifier = {
            socket.identifier: socket for socket in node.inputs
            if socket.identifier and socket.identifier != "__extend__"
        }
        items = []
        for output in node.outputs:
            if not output.identifier or output.identifier == "__extend__":
                continue
            source = input_by_identifier.get(output.identifier)
            items.append({
                "identifier": output.identifier,
                "name": output.name,
                "socket_type": output.bl_idname,
                "has_live_input": source is not None,
            })
        d["bake_contract"] = {
            "items": items,
            "live_passthrough_portable": True,
            "persistent_cache_portable": False,
            "persistent_cache_status": "not-exported",
            "reason": (
                "Blender does not expose a stable, self-contained Geometry "
                "Nodes bake payload through this extraction boundary."
            ),
        }
    # Import STL cannot read a user's filesystem in the browser. Embed only a
    # strict, bounded triangle payload while Blender still has access to an
    # authored, unlinked path. Missing/dynamic/rejected paths remain explicit
    # capability failures; no placeholder mesh is fabricated.
    if node.bl_idname == "GeometryNodeImportSTL":
        path_socket = next((
            socket for socket in node.inputs
            if socket.identifier == "Path" or socket.name == "Path"
        ), None)
        authored_path = (
            getattr(path_socket, "default_value", None)
            if path_socket is not None and not path_socket.is_linked
            else None
        )
        if isinstance(authored_path, str) and authored_path:
            resolved_path = bpy.path.abspath(
                authored_path,
                library=getattr(node.id_data, "library", None),
            )
            if os.path.isfile(resolved_path):
                try:
                    d["embedded_stl"] = load_stl_payload(resolved_path)
                except StlPayloadError as error:
                    d["stl_embedding_error"] = {
                        "code": error.code,
                        "message": str(error),
                    }
                except OSError as error:
                    d["stl_embedding_error"] = {
                        "code": "STL_READ_FAILED",
                        "message": str(error),
                    }
    # node-level props (operation, data_type, mode, etc.)
    props = {}
    for p in node.bl_rna.properties:
        if p.is_readonly or p.identifier in {"name", "label", "location", "width", "height",
                                              "color", "select", "show_options", "show_preview",
                                              "hide", "mute", "show_texture", "use_custom_color",
                                              "location_absolute", "warning_propagation", "parent"}:
            continue
        try:
            v = getattr(node, p.identifier)
            if hasattr(v, "name"):
                v = {"datablock": type(v).__name__, "name": v.name}
            elif hasattr(v, "__len__") and not isinstance(v, str):
                v = list(v)
            props[p.identifier] = v
        except Exception:
            pass
    if props:
        d["props"] = props
    # Float Curve stores its authored ramp in a nested CurveMapping RNA object,
    # not in the node's ordinary scalar properties. Without this explicit dump
    # every portable graph silently degenerates to an identity curve.
    if node.bl_idname == "ShaderNodeFloatCurve" and getattr(node, "mapping", None):
        mapping = node.mapping
        d.setdefault("props", {})["curve_mapping"] = {
            "extend": mapping.extend,
            "use_clip": bool(mapping.use_clip),
            "clip": [mapping.clip_min_x, mapping.clip_max_x, mapping.clip_min_y, mapping.clip_max_y],
            "curves": [[
                {"location": list(point.location), "handle_type": point.handle_type}
                for point in curve.points
            ] for curve in mapping.curves],
        }
    if node.bl_idname == "ShaderNodeValToRGB" and getattr(node, "color_ramp", None):
        ramp = node.color_ramp
        d.setdefault("props", {})["color_ramp"] = {
            "color_mode": ramp.color_mode,
            "hue_interpolation": ramp.hue_interpolation,
            "interpolation": ramp.interpolation,
            "elements": [
                {"position": float(element.position), "color": list(element.color)}
                for element in ramp.elements
            ],
        }
    if node.bl_idname == "GeometryNodeGroup" and node.node_tree:
        d["group"] = node.node_tree.name
    # Repeat/simulation zones: record the paired output node so the evaluator can
    # tie RepeatInput to its RepeatOutput without guessing.
    if hasattr(node, "paired_output") and node.paired_output:
        d["paired_output"] = node.paired_output.name
    return d

def dump_tree(tree):
    d = {
        "name": tree.name,
        "type": tree.bl_idname,
        "interface": [],
        "nodes": [dump_node(n) for n in tree.nodes],
        "links": [],
    }
    animation_data = getattr(tree, "animation_data", None)
    action = getattr(animation_data, "action", None)
    if action is not None:
        action_slot = getattr(animation_data, "action_slot", None)
        fcurves = []
        # Blender 4.4+ stores F-curves in layered Action channel bags. Retain a
        # legacy fallback so dumps remain usable with older Blender releases.
        for layer in getattr(action, "layers", []):
            for strip in getattr(layer, "strips", []):
                for channelbag in getattr(strip, "channelbags", []):
                    if action_slot is not None and channelbag.slot != action_slot:
                        continue
                    fcurves.extend(channelbag.fcurves)
        if not fcurves:
            fcurves.extend(getattr(action, "fcurves", []))
        curves = []
        for fcurve in fcurves:
            curves.append({
                "data_path": fcurve.data_path,
                "array_index": int(fcurve.array_index),
                "extrapolation": fcurve.extrapolation,
                "keyframes": [{
                    "frame": float(point.co[0]),
                    "value": float(point.co[1]),
                    "interpolation": point.interpolation,
                    "easing": point.easing,
                    "handle_left": [float(point.handle_left[0]), float(point.handle_left[1])],
                    "handle_right": [float(point.handle_right[0]), float(point.handle_right[1])],
                } for point in fcurve.keyframe_points],
            })
        if curves:
            d["animation"] = {
                "action": action.name,
                "frame_range": [float(action.frame_range[0]), float(action.frame_range[1])],
                "fcurves": curves,
            }
    if hasattr(tree, "interface"):
        for item in tree.interface.items_tree:
            entry = {"name": item.name, "item_type": item.item_type}
            if item.item_type == "SOCKET":
                entry["identifier"] = item.identifier
                entry["in_out"] = item.in_out
                entry["socket_type"] = item.socket_type
                if hasattr(item, "default_value"):
                    v = item.default_value
                    if hasattr(v, "__len__") and not isinstance(v, str):
                        v = list(v)
                    elif hasattr(v, "name"):
                        v = {"datablock": type(v).__name__, "name": v.name}
                    entry["default"] = v
                for attr in ("min_value", "max_value", "subtype", "description"):
                    if hasattr(item, attr):
                        val = getattr(item, attr)
                        if val not in (None, ""):
                            entry[attr] = val
            d["interface"].append(entry)
    for l in tree.links:
        entry = {
            "from_node": l.from_node.name, "from_socket": l.from_socket.identifier,
            "to_node": l.to_node.name, "to_socket": l.to_socket.identifier,
            "to_idx": l.to_socket.index if hasattr(l.to_socket, "index") else None,
            "from_type": l.from_socket.bl_idname,
            "to_type": l.to_socket.bl_idname,
        }
        # Multi-input sockets (Join Geometry) evaluate from highest sort id to
        # lowest. Omit the common zero to keep dumps compact; any non-zero link
        # is enough for the evaluator to enable sorted multi-input handling.
        sort_id = getattr(l, "multi_input_sort_id", 0)
        if sort_id:
            entry["multi_input_sort_id"] = sort_id
        # Muted links remain present in Blender's node tree and are exposed by
        # bpy.types.NodeTree.links, but they do not participate in evaluation.
        # Course-module lesson graphs use this to keep alternate construction
        # branches visible beside the active banner output.
        if getattr(l, "is_muted", False):
            entry["muted"] = True
        d["links"].append(entry)
    return d


def dump_font_glyph(font, character, align_y="TOP_BASELINE"):
    """Convert one Blender vector-font glyph to evaluated boundary loops."""
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

    # Blender adaptively evaluates vector-font Beziers: straight and gently
    # curved segments receive fewer points than circular ones. Sampling every
    # control segment at Curve.resolution_u therefore over-tessellates fonts.
    # The zero-thickness evaluated mesh contains only outline vertices; trace
    # its singly-used, polygon-oriented boundary edges to recover the exact
    # loops consumed by Geometry Nodes' Fill Curve.
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
    # Trace boundary half-edges through polygon adjacency. A simple
    # start-vertex -> edge map is not sufficient for pixel fonts: independent
    # glyph cells can touch at one vertex, giving that vertex several outgoing
    # boundary edges. Following the polygon on the left of each half-edge, and
    # crossing internal edges to its adjacent polygon, retains every closed
    # contour without making an arbitrary choice at those junctions.
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
        """Advance around the filled component until the next boundary edge."""
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
    baseline_points = [point for spline in dump_font_glyph(font, "A", "TOP_BASELINE") for point in spline["points"]]
    baseline_min_y = min((point[1] for point in baseline_points), default=0.0)
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
    # Grid/pixel fonts encode meaningful collinear cell corners. Ordinary
    # Bezier/CFF fonts need the 12-sample cadence so Fill Curve can dissolve
    # evaluated interiors on straight cubic segments.
    sample_stride = 0 if segments and axis_aligned_segments / segments >= 0.98 else 12
    return {"name": font.name, "sample_stride": sample_stride, "align_offsets": align_offsets, "glyphs": glyphs}

result = {
    "blender_version": bpy.app.version_string,
    "scene": {
        "frame_current": bpy.context.scene.frame_current,
        "frame_start": bpy.context.scene.frame_start,
        "frame_end": bpy.context.scene.frame_end,
        "fps": bpy.context.scene.render.fps,
        "fps_base": bpy.context.scene.render.fps_base,
        "unit_settings": {
            "system": bpy.context.scene.unit_settings.system,
            "system_rotation": bpy.context.scene.unit_settings.system_rotation,
            "scale_length": bpy.context.scene.unit_settings.scale_length,
            "length_unit": bpy.context.scene.unit_settings.length_unit,
            "mass_unit": bpy.context.scene.unit_settings.mass_unit,
            "time_unit": bpy.context.scene.unit_settings.time_unit,
            "temperature_unit": bpy.context.scene.unit_settings.temperature_unit,
        },
    },
    "objects": [], "collections": [], "node_groups": {}, "shader_node_groups": {},
    "materials": {}, "images": [], "fonts": {}, "dependency_objects": []
}

dependency_collection_names = set()
dependency_object_names = set()
dependency_image_names = set()
trees_to_dump = {}

# Traverse modifier roots, nested groups, interface-bound pointers, and
# referenced object modifier roots to a fixed point. Full-file Studio imports
# seed this with every Geometry Nodes modifier; targeted imports seed only the
# requested object. Older full dumps seeded no roots here, so large Object Info
# dependencies were discovered too late to receive portable geometry.
pending_dependency_trees = []
pending_dependency_objects = []
scanned_dependency_trees = set()
scanned_dependency_objects = set()


def add_dependency_object(obj):
    if obj is None or obj.name in dependency_object_names:
        return
    dependency_object_names.add(obj.name)
    pending_dependency_objects.append(obj)


def add_dependency_collection(collection):
    if collection is None:
        return
    dependency_collection_names.add(collection.name)
    for dependency_object in collection.objects:
        add_dependency_object(dependency_object)


def scan_dependency_pointer(value):
    if isinstance(value, bpy.types.Object):
        add_dependency_object(value)
    elif isinstance(value, bpy.types.Collection):
        add_dependency_collection(value)
    elif isinstance(value, bpy.types.Image):
        dependency_image_names.add(value.name)


def scan_nodes_modifier(modifier):
    if modifier.type != "NODES" or not modifier.node_group:
        return
    trees_to_dump[modifier.node_group.name] = modifier.node_group
    pending_dependency_trees.append(modifier.node_group)
    for item in modifier.node_group.interface.items_tree:
        if item.item_type != "SOCKET" or item.in_out != "INPUT":
            continue
        try:
            scan_dependency_pointer(modifier[item.identifier])
        except Exception:
            pass


if target_object and bpy.data.objects.get(target_object):
    root_objects = [bpy.data.objects[target_object]]
else:
    root_objects = [
        obj for obj in bpy.data.objects
        if any(modifier.type == "NODES" and modifier.node_group for modifier in obj.modifiers)
    ]
for root_object in root_objects:
    for modifier in root_object.modifiers:
        scan_nodes_modifier(modifier)

while pending_dependency_trees or pending_dependency_objects:
    while pending_dependency_objects:
        dependency_object = pending_dependency_objects.pop()
        if dependency_object.name in scanned_dependency_objects:
            continue
        scanned_dependency_objects.add(dependency_object.name)
        for modifier in dependency_object.modifiers:
            scan_nodes_modifier(modifier)
    if not pending_dependency_trees:
        continue
    tree = pending_dependency_trees.pop()
    if tree.name in scanned_dependency_trees:
        continue
    scanned_dependency_trees.add(tree.name)
    trees_to_dump[tree.name] = tree
    for node in tree.nodes:
        if node.bl_idname == "GeometryNodeGroup" and node.node_tree:
            pending_dependency_trees.append(node.node_tree)
        for socket in node.inputs:
            scan_dependency_pointer(getattr(socket, "default_value", None))

result["dependency_objects"] = sorted(dependency_object_names)
depsgraph = bpy.context.evaluated_depsgraph_get()


def float32_json(value):
    """Return the exact Python/JSON representation of one IEEE-754 float."""
    return struct.unpack("<f", struct.pack("<f", float(value)))[0]


def matrix_float32_json(matrix):
    return [[float32_json(value) for value in row] for row in matrix]

# Objects inside excluded asset-library collections can retain a stale
# matrix_world until they are linked into an active scene. Recompose ordinary
# object-parent chains from matrix_basis so targeted dumps preserve the same
# transform Blender evaluates after activation.
world_matrix_cache = {}
def resolved_world_matrix(obj):
    cached = world_matrix_cache.get(obj.name)
    if cached is not None:
        return cached
    if obj.parent is not None and obj.parent_type == "OBJECT":
        matrix = resolved_world_matrix(obj.parent) @ obj.matrix_parent_inverse @ obj.matrix_basis
    elif obj.parent is None:
        matrix = obj.matrix_basis.copy()
    else:
        matrix = obj.matrix_world.copy()
    world_matrix_cache[obj.name] = matrix
    return matrix


evaluated_world_matrix_cache = {}
def evaluated_world_matrix(obj):
    cached = evaluated_world_matrix_cache.get(obj.name)
    if cached is not None:
        return cached
    # evaluated_get() can succeed while returning an identity/stale matrix for
    # objects in excluded asset-library collections. Those objects are absent
    # from the active view layer, so resolve their ordinary parent chain from
    # matrix_basis instead of accepting the stale dependency-graph value.
    if obj.name not in bpy.context.view_layer.objects:
        matrix = resolved_world_matrix(obj)
    else:
        try:
            matrix = obj.evaluated_get(depsgraph).matrix_world.copy()
        except Exception:
            matrix = resolved_world_matrix(obj)
    evaluated_world_matrix_cache[obj.name] = matrix
    return matrix


active_evaluated_world = evaluated_world_matrix(bpy.data.objects[target_object]) if target_object and bpy.data.objects.get(target_object) else None

# A full Studio import does not know which modifier the user will preview yet.
# Keep small meshes as before, and additionally reserve a bounded budget for
# larger objects that are direct Geometry Nodes modifier entry points. This
# makes those targets runnable without a second extraction while preventing a
# library of high-poly meshes from producing an unbounded JSON payload.
SMALL_BASE_MESH_VERTEX_LIMIT = 10_000
MODIFIER_SEED_VERTEX_LIMIT = 250_000
MODIFIER_SEED_TOTAL_VERTEX_LIMIT = 1_000_000
BASE_MESH_SERIALIZED_BYTE_LIMIT = int(os.environ.get(
    "NODE_DOJO_BASE_MESH_SERIALIZED_BYTE_LIMIT",
    64 * 1024 * 1024,
))
BASE_MESH_TOTAL_SERIALIZED_BYTE_LIMIT = int(os.environ.get(
    "NODE_DOJO_BASE_MESH_TOTAL_SERIALIZED_BYTE_LIMIT",
    128 * 1024 * 1024,
))
modifier_seed_object_names = set()
modifier_seed_vertices = 0
embedded_mesh_serialized_bytes = 0


def reserve_serialized_mesh_payload(mesh_payload):
    global embedded_mesh_serialized_bytes
    serialized_bytes = len(json.dumps(
        mesh_payload,
        indent=1,
        default=str,
        ensure_ascii=False,
    ).encode("utf-8"))
    remaining_bytes = BASE_MESH_TOTAL_SERIALIZED_BYTE_LIMIT - embedded_mesh_serialized_bytes
    if (
        serialized_bytes <= BASE_MESH_SERIALIZED_BYTE_LIMIT
        and serialized_bytes <= remaining_bytes
    ):
        embedded_mesh_serialized_bytes += serialized_bytes
        return None
    return {
        "code": (
            "BASE_MESH_OBJECT_SERIALIZED_LIMIT"
            if serialized_bytes > BASE_MESH_SERIALIZED_BYTE_LIMIT
            else "BASE_MESH_TOTAL_SERIALIZED_LIMIT"
        ),
        "serialized_bytes": serialized_bytes,
        "per_object_limit": BASE_MESH_SERIALIZED_BYTE_LIMIT,
        "remaining_total_limit": max(0, remaining_bytes),
    }


for candidate in sorted(bpy.data.objects, key=lambda item: item.name):
    if candidate.type != "MESH" or not candidate.data:
        continue
    if not any(modifier.type == "NODES" and modifier.node_group for modifier in candidate.modifiers):
        continue
    vertex_count = len(candidate.data.vertices)
    if (
        vertex_count <= MODIFIER_SEED_VERTEX_LIMIT
        and modifier_seed_vertices + vertex_count <= MODIFIER_SEED_TOTAL_VERTEX_LIMIT
    ):
        modifier_seed_object_names.add(candidate.name)
        modifier_seed_vertices += vertex_count

for obj in bpy.data.objects:
    o = {"name": obj.name, "type": obj.type, "location": list(obj.location),
         "rotation": list(obj.rotation_euler), "scale": list(obj.scale),
         # Geometry Nodes consumes evaluated object_to_world matrices. Preserve
         # their exact float32 values; decimal rounding can move a relative
         # dependency surface by several ULPs before Raycast amplifies it.
         "matrix_world": matrix_float32_json(evaluated_world_matrix(obj)),
         "visible": not obj.hide_render, "modifiers": [],
         # Preserve empty slot positions. Polygon material_index values address
         # the slot array, so filtering None silently shifts every later
         # material and can turn Blender's unassigned faces into authored ones.
         "materials": [m.name if m else None for m in obj.data.materials]
         if obj.type in ("MESH", "CURVE") and obj.data else []}
    if active_evaluated_world is not None and obj.name in dependency_object_names:
        # Relative Object/Collection Info is evaluated in the modifier object's
        # space. Export Blender's own matrix inversion/multiplication result so
        # the portable runtime does not have to reproduce it from rounded TRS.
        relative = active_evaluated_world.inverted_safe() @ evaluated_world_matrix(obj)
        o["relative_matrices"] = {target_object: matrix_float32_json(relative)}
    if obj.get("node_dojo_dependency_snapshot"):
        o["node_dojo_dependency_snapshot"] = str(obj["node_dojo_dependency_snapshot"])
    if obj.type == "MESH" and obj.data:
        o["mesh_stats"] = {"verts": len(obj.data.vertices), "faces": len(obj.data.polygons)}
        # Embed small BASE meshes (pre-modifier obj.data): ObjectInfo materializes
        # referenced objects (e.g. 'printbed'), and GN modifiers need the object's
        # own mesh bound to their Geometry input (e.g. the bubble vase's seed).
        if (
            obj.name == target_object
            or len(obj.data.vertices) <= SMALL_BASE_MESH_VERTEX_LIMIT
            or obj.name in dependency_object_names
            or obj.name in modifier_seed_object_names
        ):
            me = obj.data
            mesh_payload = {
                "verts": [[float(v.co.x), float(v.co.y), float(v.co.z)] for v in me.vertices],
                "faces": [list(p.vertices) for p in me.polygons],
                "face_materials": [p.material_index for p in me.polygons],
                # Mesh polygon smoothness is not an ordinary named attribute in
                # Blender RNA, but it is part of the geometry contract consumed
                # by Geometry Nodes and Workbench split-normal shading.
                "face_smooth": [bool(p.use_smooth) for p in me.polygons],
                # Preserve Blender's stored edge order, including polygon
                # boundaries. Mesh to Curve and edge-domain fields use this
                # order; rebuilding only from face winding can reverse a
                # cyclic rail and therefore its Curve to Mesh frame.
                "edges": [[e.vertices[0], e.vertices[1]] for e in me.edges],
            }
            # authored custom attributes (e.g. the bubble vase's 'bottom' vertex
            # tag drives a Named Attribute -> Separate chain in the graph)
            attrs = dump_mesh_attributes(
                me,
                include_uv=obj.name == target_object or obj.name in dependency_object_names,
            )
            # vertex groups are readable via Named Attribute too
            for vg in obj.vertex_groups:
                data = []
                for v in me.vertices:
                    w = 0.0
                    for gref in v.groups:
                        if gref.group == vg.index:
                            w = gref.weight
                            break
                    data.append(round(w, 6))
                attrs[vg.name] = {"domain": "POINT", "data": data}
            if attrs:
                mesh_payload["attributes"] = attrs
            # Vertex counts alone do not bound polygon corners or custom
            # attributes. Measure the exact representation used by the final
            # indented JSON and keep both per-object and aggregate limits.
            embedding_error = reserve_serialized_mesh_payload(mesh_payload)
            if embedding_error is None:
                o["mesh"] = mesh_payload
            else:
                o["mesh_embedding_error"] = embedding_error
    elif obj.type == "CURVE" and obj.data:
        # Geometry Nodes receives the object's pre-modifier curve component.
        # Store evaluated polylines so the browser VM can resample Bezier input
        # without needing Blender's proprietary curve datablock implementation.
        def bezier(a, b, c, d, t):
            u = 1.0 - t
            return [u*u*u*a[i] + 3*u*u*t*b[i] + 3*u*t*t*c[i] + t*t*t*d[i] for i in range(3)]
        def bezier_tangent(a, b, c, d, t):
            u = 1.0 - t
            value = [3*u*u*(b[i]-a[i]) + 6*u*t*(c[i]-b[i]) + 3*t*t*(d[i]-c[i]) for i in range(3)]
            length = sum(component * component for component in value) ** 0.5
            return [component / length for component in value] if length > 1e-12 else [0.0, 0.0, 1.0]
        splines = []
        for spline in obj.data.splines:
            cyclic = bool(spline.use_cyclic_u)
            points = []
            tilts = []
            radii = []
            tangents = []
            if spline.type == "BEZIER":
                bp = list(spline.bezier_points)
                control_points = [[float(v) for v in point.co] for point in bp]
                bezier_left = [[float(v) for v in point.handle_left] for point in bp]
                bezier_right = [[float(v) for v in point.handle_right] for point in bp]
                segments = len(bp) if cyclic else max(0, len(bp) - 1)
                resolution = max(2, int(getattr(spline, "resolution_u", 0) or obj.data.resolution_u or 12))
                for segment in range(segments):
                    p0 = bp[segment]
                    p1 = bp[(segment + 1) % len(bp)]
                    for step in range(resolution):
                        factor = step / resolution
                        points.append([float(v) for v in bezier(p0.co, p0.handle_right, p1.handle_left, p1.co, factor)])
                        tilts.append(float((1.0 - factor) * p0.tilt + factor * p1.tilt))
                        radii.append(float((1.0 - factor) * p0.radius + factor * p1.radius))
                        tangents.append([float(v) for v in bezier_tangent(p0.co, p0.handle_right, p1.handle_left, p1.co, factor)])
                if not cyclic and bp:
                    points.append([float(v) for v in bp[-1].co])
                    tilts.append(float(bp[-1].tilt))
                    radii.append(float(bp[-1].radius))
                    if len(bp) > 1:
                        tangents.append([float(v) for v in bezier_tangent(bp[-2].co, bp[-2].handle_right, bp[-1].handle_left, bp[-1].co, 1.0)])
                    else:
                        tangents.append([0.0, 0.0, 1.0])
            else:
                control_points = None
                bezier_left = None
                bezier_right = None
                points = [[float(p.co.x), float(p.co.y), float(p.co.z)] for p in spline.points]
                tilts = [float(p.tilt) for p in spline.points]
                radii = [float(p.radius) for p in spline.points]
            if points:
                entry = {"points": points, "cyclic": cyclic, "tilts": tilts, "radii": radii, "tangents": tangents,
                         "resolution": int(getattr(spline, "resolution_u", 0) or obj.data.resolution_u or 12)}
                if control_points is not None:
                    entry["control_points"] = control_points
                    entry["bezier_left"] = bezier_left
                    entry["bezier_right"] = bezier_right
                splines.append(entry)
        o["curves"] = splines
    if obj.name in dependency_object_names and obj.type in ("MESH", "CURVE"):
        # Referenced asset-library objects can live in collections excluded from
        # the active scene. Link them temporarily so evaluated_get() captures
        # their Geometry Nodes result rather than silently returning seed data.
        if obj.name not in bpy.context.view_layer.objects and bpy.context.scene.collection.objects.get(obj.name) is None:
            bpy.context.scene.collection.objects.link(obj)
            bpy.context.view_layer.update()
            depsgraph.update()
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            evaluated_mesh_payload = {
                "verts": [[float(v.co.x), float(v.co.y), float(v.co.z)] for v in mesh.vertices],
                "faces": [list(p.vertices) for p in mesh.polygons],
                "face_materials": [p.material_index for p in mesh.polygons],
                "face_smooth": [bool(p.use_smooth) for p in mesh.polygons],
                "edges": [[e.vertices[0], e.vertices[1]] for e in mesh.edges],
                "materials": [material.name if material else None for material in mesh.materials],
                "attributes": dump_mesh_attributes(mesh, include_uv=True),
            }
            embedding_error = reserve_serialized_mesh_payload(evaluated_mesh_payload)
            if embedding_error is None:
                o["evaluated_mesh"] = evaluated_mesh_payload
            else:
                o["evaluated_mesh_embedding_error"] = embedding_error
        finally:
            evaluated.to_mesh_clear()
    for mod in obj.modifiers:
        # Modifier enablement is part of Blender's evaluated viewport contract,
        # not merely UI state. Keep it for every modifier type so the browser
        # does not execute authored-but-disabled Geometry Nodes helpers.
        m = {
            "name": mod.name,
            "type": mod.type,
            "show_viewport": bool(getattr(mod, "show_viewport", True)),
            "show_render": bool(getattr(mod, "show_render", True)),
        }
        if mod.type == "HOOK":
            m["vertex_indices"] = list(mod.vertex_indices)
            m["strength"] = float(mod.strength)
            m["falloff_type"] = str(mod.falloff_type)
            m["falloff_radius"] = float(mod.falloff_radius)
            m["use_falloff_uniform"] = bool(mod.use_falloff_uniform)
            m["vertex_group"] = str(mod.vertex_group or "")
            m["invert_vertex_group"] = bool(getattr(mod, "invert_vertex_group", False))
            if mod.object:
                m["object"] = mod.object.name
                m["matrix_inverse"] = matrix_float32_json(mod.matrix_inverse)
        if mod.type == "NODES" and mod.node_group:
            m["node_group"] = mod.node_group.name
            if target_object is None or obj.name == target_object or obj.name in dependency_object_names:
                trees_to_dump[mod.node_group.name] = mod.node_group
            # modifier input overrides
            inputs = {}
            input_items = [
                item for item in mod.node_group.interface.items_tree
                if item.item_type == "SOCKET" and item.in_out == "INPUT"
            ]
            input_name_counts = {
                item.name: sum(1 for candidate in input_items if candidate.name == item.name)
                for item in input_items
            }
            for item in input_items:
                key = item.identifier
                try:
                    v = mod[key]
                    if hasattr(v, "name"):
                        v = {"datablock": type(v).__name__, "name": v.name}
                    elif hasattr(v, "__len__") and not isinstance(v, str):
                        v = list(v)
                    # Field-capable modifier sockets can be bound to a named
                    # mesh attribute. Preserve that binding instead of dumping
                    # only the fallback constant shown beside the attribute UI.
                    try:
                        if bool(mod.get(f"{key}_use_attribute", False)):
                            attribute_name = str(mod.get(f"{key}_attribute_name", ""))
                            if attribute_name:
                                v = {"attribute": attribute_name, "value": v}
                    except Exception:
                        pass
                    # Identifier keys preserve duplicate interface names;
                    # friendly names remain available when unambiguous.
                    inputs[item.identifier] = v
                    if input_name_counts[item.name] == 1:
                        inputs[item.name] = v
                except Exception:
                    pass
            m["input_values"] = inputs
        o["modifiers"].append(m)
    result["objects"].append(o)

for collection in bpy.data.collections:
    if target_object is None or collection.name in dependency_collection_names:
        result["collections"].append({"name": collection.name, "objects": [obj.name for obj in collection.objects]})

# collect all node groups (including nested ones)
pending = dict(trees_to_dump)
done = set()
while pending:
    name, tree = pending.popitem()
    if name in done:
        continue
    done.add(name)
    result["node_groups"][name] = dump_tree(tree)
    for n in tree.nodes:
        for socket in n.inputs:
            value = getattr(socket, "default_value", None)
            if isinstance(value, bpy.types.Image):
                dependency_image_names.add(value.name)
        if n.bl_idname == "GeometryNodeGroup" and n.node_tree and n.node_tree.name not in done:
            pending[n.node_tree.name] = n.node_tree

# Full-file extraction keeps every group for graph browsing. Targeted extraction
# intentionally contains only the selected modifier's reachable group closure.
if target_object is None:
    for tree in bpy.data.node_groups:
        if tree.bl_idname == "GeometryNodeTree" and tree.name not in done:
            result["node_groups"][tree.name] = dump_tree(tree)

# ShaderNodeGroup material nodes otherwise contain only a datablock reference.
# Keep shader graphs separate from executable Geometry Nodes programs while
# making their authored internals portable to the browser material VM.
for tree in bpy.data.node_groups:
    if tree.bl_idname == "ShaderNodeTree":
        result["shader_node_groups"][tree.name] = dump_tree(tree)

for mat in bpy.data.materials:
    if mat.use_nodes and mat.node_tree:
        result["materials"][mat.name] = dump_tree(mat.node_tree)

for img in bpy.data.images:
    entry = {"name": img.name, "filepath": img.filepath, "size": list(img.size)}
    if target_object and img.name in dependency_image_names and img.size[0] and img.size[1]:
        try:
            channels = max(1, int(img.channels))
            values = list(img.pixels[:])
            rgba = bytearray(img.size[0] * img.size[1] * 4)
            for pixel in range(img.size[0] * img.size[1]):
                for channel in range(4):
                    source_channel = min(channel, channels - 1)
                    value = values[pixel * channels + source_channel] if pixel * channels + source_channel < len(values) else (1.0 if channel == 3 else 0.0)
                    if channel == 3 and channels < 4:
                        value = 1.0
                    rgba[pixel * 4 + channel] = max(0, min(255, round(float(value) * 255)))
            entry["pixels_rgba8"] = base64.b64encode(rgba).decode("ascii")
            entry["channels"] = 4
        except Exception as error:
            entry["pixel_error"] = repr(error)
    result["images"].append(entry)

# String to Curves depends on Blender's vector-font outlines, which browsers
# cannot recover from a .blend. Export the referenced ASCII glyphs as cyclic
# polylines so the GN-VM can reproduce packed fonts and explicitly supplied
# font overrides without shipping Blender or a TTF parser.
referenced_fonts = {}
for tree_name in result["node_groups"]:
    tree = bpy.data.node_groups.get(tree_name)
    if tree is None:
        continue
    for node in tree.nodes:
        if node.bl_idname != "GeometryNodeStringToCurves":
            continue
        socket = next((candidate for candidate in node.inputs if candidate.name == "Font"), None)
        font = getattr(socket, "default_value", None) if socket else None
        if isinstance(font, bpy.types.VectorFont):
            referenced_fonts[font.name] = font

if os.environ.get("NODE_DOJO_SKIP_FONT_ATLAS") == "1":
    print("FONT_ATLAS_SKIPPED")
else:
    for font_name, font in referenced_fonts.items():
        source_metadata = font_source_metadata(font)
        if source_metadata["status"] == "external-missing":
            result["fonts"][font_name] = {
                "name": font_name,
                "filepath": source_metadata["authored_filepath"],
                "unavailable": True,
                "atlas_status": "unavailable",
                "source": source_metadata,
                "glyphs": {},
            }
            print(f"FONT_ATLAS_UNAVAILABLE {font_name}: {source_metadata['authored_filepath']}")
            continue
        try:
            atlas = dump_font_atlas(font)
            atlas["atlas_status"] = "embedded"
            atlas["source"] = source_metadata
            packed_binary = dump_opt_in_packed_font_binary(font, source_metadata)
            if packed_binary is not None:
                atlas["packed_binary"] = packed_binary
            result["fonts"][font_name] = atlas
        except Exception as error:
            result["fonts"][font_name] = {
                "name": font_name,
                "error": repr(error),
                "atlas_status": "error",
                "source": source_metadata,
                "glyphs": {},
            }
            print(f"FONT_ATLAS_ERROR {font_name}: {error!r}")


def build_extraction_metadata(payload):
    """Build an additive v1 metadata index without changing dump payloads."""
    object_ids = {
        obj["name"]: f"object:{index:06d}"
        for index, obj in enumerate(sorted(payload["objects"], key=lambda item: item["name"]), 1)
    }
    group_ids = {
        name: f"node_tree:{index:06d}"
        for index, name in enumerate(sorted(payload["node_groups"]), 1)
    }
    groups = {}
    for group_name in sorted(payload["node_groups"]):
        group = payload["node_groups"][group_name]
        group_id = group_ids[group_name]
        node_ids = {
            node["name"]: f"{group_id}/node:{index:06d}"
            for index, node in enumerate(group.get("nodes", []), 1)
        }
        interface_ids = [
            {
                "index": index,
                "id": f"{group_id}/interface:{index:06d}",
                **({"identifier": item["identifier"]} if item.get("identifier") else {}),
            }
            for index, item in enumerate(group.get("interface", []), 1)
        ]
        socket_ids = []
        for node in group.get("nodes", []):
            node_id = node_ids[node["name"]]
            for direction in ("input", "output"):
                for index, socket in enumerate(node.get(f"{direction}s", []), 1):
                    socket_ids.append({
                        "node": node["name"],
                        "direction": direction,
                        "index": index,
                        "id": f"{node_id}/{direction}:{index:06d}",
                        **({"identifier": socket["identifier"]} if socket.get("identifier") else {}),
                    })
        groups[group_name] = {
            "id": group_id,
            "nodes": node_ids,
            "interface": interface_ids,
            "sockets": socket_ids,
        }

    object_payloads = {obj["name"]: obj for obj in payload["objects"]}
    collections = {entry["name"]: entry for entry in payload["collections"]}
    images = {entry["name"]: entry for entry in payload["images"]}
    kind_map = {
        "object": "object", "collection": "collection", "material": "material",
        "image": "image", "vectorfont": "font", "font": "font",
        "scene": "scene", "nodetree": "node_tree", "geometrynodetree": "node_tree",
    }
    descriptors = []
    descriptor_keys = set()

    def availability(kind, name):
        if kind == "object":
            item = object_payloads.get(name)
            if not item:
                return "unavailable"
            return "embedded" if any(key in item for key in ("mesh", "curves", "evaluated_mesh")) else "unavailable"
        if kind == "collection":
            return "embedded" if name in collections else "unavailable"
        if kind == "material":
            return "embedded" if name in payload["materials"] else "unavailable"
        if kind == "image":
            item = images.get(name)
            if not item:
                return "unavailable"
            return "embedded" if item.get("pixels_rgba8") else "referenced"
        if kind == "font":
            item = payload["fonts"].get(name)
            if not item:
                font = bpy.data.fonts.get(name)
                if font is not None and font_source_metadata(font)["status"] == "external-missing":
                    return "unavailable"
                return "referenced"
            if item.get("unavailable") or item.get("source", {}).get("status") == "external-missing":
                return "unavailable"
            return "embedded" if item.get("atlas_status") == "embedded" or item.get("glyphs") else "referenced"
        if kind == "scene":
            return "referenced"
        if kind == "node_tree":
            return "embedded" if name in payload["node_groups"] else "unavailable"
        return "unavailable"

    def target_id(kind, name):
        if kind == "object":
            return object_ids.get(name)
        if kind == "node_tree":
            return group_ids.get(name)
        return f"{kind}:{name}"

    def library_path(kind, name):
        stores = {
            "object": bpy.data.objects, "collection": bpy.data.collections,
            "material": bpy.data.materials, "image": bpy.data.images,
            "font": bpy.data.fonts, "scene": bpy.data.scenes, "node_tree": bpy.data.node_groups,
        }
        datablock = stores.get(kind).get(name) if stores.get(kind) else None
        library = getattr(datablock, "library", None)
        return bpy.path.abspath(library.filepath) if library else None

    def add_descriptor(kind, source, name, provenance):
        if not name:
            return
        key = (kind, source.get("tree"), source.get("node"), source.get("socket"),
               source.get("direction"), source.get("object"), source.get("modifier"), name, provenance)
        if key in descriptor_keys:
            return
        descriptor_keys.add(key)
        target = {"name": name, "id": target_id(kind, name), "library_path": library_path(kind, name)}
        if kind == "object" and object_payloads.get(name, {}).get("node_dojo_dependency_snapshot"):
            target["snapshot"] = object_payloads[name]["node_dojo_dependency_snapshot"]
        source_id = dict(source)
        if source.get("tree") in groups:
            source_id["tree_id"] = groups[source["tree"]]["id"]
            if source.get("node") in groups[source["tree"]]["nodes"]:
                source_id["node_id"] = groups[source["tree"]]["nodes"][source["node"]]
                sockets = groups[source["tree"]]["sockets"]
                direction = source.get("direction")
                matches = [entry for entry in sockets if entry["node"] == source.get("node")
                           and entry["direction"] == direction and entry.get("identifier") == source.get("socket")]
                if matches:
                    source_id["socket_id"] = matches[0]["id"]
        descriptors.append({
            "id": f"dependency:{len(descriptors) + 1:06d}",
            "kind": kind,
            "source": source_id,
            "target": target,
            "required": True,
            "availability": availability(kind, name),
            "provenance": provenance,
        })

    def scan_value(value, source, provenance):
        if isinstance(value, dict):
            datablock = str(value.get("datablock", "")).lower()
            kind = kind_map.get(datablock)
            if kind and isinstance(value.get("name"), str):
                add_descriptor(kind, source, value["name"], provenance)
            for nested in value.values():
                scan_value(nested, source, provenance)
        elif isinstance(value, list):
            for nested in value:
                scan_value(nested, source, provenance)

    for group_name, group in payload["node_groups"].items():
        for node in group.get("nodes", []):
            if node.get("group"):
                add_descriptor("node_tree", {
                    "tree": group_name, "node": node["name"], "direction": "nested_tree",
                }, node["group"], "nested_tree")
            for direction in ("input", "output"):
                for socket in node.get(f"{direction}s", []):
                    scan_value(socket.get("value", socket.get("default")), {
                        "tree": group_name, "node": node["name"], "socket": socket.get("identifier"),
                        "direction": direction,
                    }, "node_socket")
            scan_value(node.get("props"), {"tree": group_name, "node": node["name"]}, "node_socket")
        for item in group.get("interface", []):
            scan_value(item.get("default"), {"tree": group_name, "socket": item.get("identifier"), "direction": "input"}, "node_socket")

    for obj in payload["objects"]:
        for modifier in obj.get("modifiers", []):
            for socket, value in (modifier.get("input_values") or {}).items():
                scan_value(value, {
                    "object": obj["name"], "modifier": modifier.get("name"), "socket": socket,
                    "direction": "modifier_input",
                }, "modifier_input")

    # Keep the legacy list populated for old consumers while typed descriptors
    # become the authoritative record for new extraction.
    payload["dependency_objects"] = sorted(set(payload.get("dependency_objects", [])) | {
        descriptor["target"]["name"]
        for descriptor in descriptors
        if descriptor["kind"] == "object" and descriptor["availability"] != "unavailable"
    })

    object_graph = {}
    for descriptor in descriptors:
        source_tree = descriptor["source"].get("tree")
        if descriptor["kind"] != "object" or not source_tree:
            continue
        for obj in payload["objects"]:
            if any(mod.get("type") == "NODES" and mod.get("node_group") == source_tree for mod in obj.get("modifiers", [])):
                object_graph.setdefault(obj["name"], set()).add(descriptor["target"]["name"])
    warnings = []
    visited = set()
    visiting = []
    def find_cycles(name):
        if name in visiting:
            path = visiting[visiting.index(name):] + [name]
            if not any(warning.get("path") == path for warning in warnings):
                warnings.append({
                    "code": "DEPENDENCY_CYCLE",
                    "message": "Evaluated object dependencies contain a cycle; use an authoritative frozen snapshot when reproducibility matters.",
                    "path": path,
                })
            return
        if name in visited:
            return
        visiting.append(name)
        for target in object_graph.get(name, set()):
            find_cycles(target)
        visiting.pop()
        visited.add(name)
    for object_name in object_graph:
        find_cycles(object_name)
    for obj in payload["objects"]:
        if obj.get("node_dojo_dependency_snapshot"):
            warnings.append({
                "code": "FROZEN_EVALUATED_DEPENDENCY",
                "message": f"{obj['name']} uses an explicitly frozen evaluated dependency snapshot.",
                "path": [obj["name"]],
            })
        if (
            obj.get("type") == "MESH"
            and obj.get("mesh_stats", {}).get("verts", 0) > 0
            and not obj.get("mesh")
            and any(modifier.get("type") == "NODES" for modifier in obj.get("modifiers", []))
        ):
            embedding_error = obj.get("mesh_embedding_error")
            warnings.append({
                "code": "MODIFIER_BASE_MESH_OMITTED",
                "message": (
                    f"{obj['name']} base mesh was omitted by the portable extraction budget"
                    + (
                        f" ({embedding_error.get('serialized_bytes', 0)} serialized bytes; "
                        f"{embedding_error.get('code', 'limit exceeded')})"
                        if embedding_error else ""
                    )
                    + "; run a target-aware extraction for this object."
                ),
                "path": [obj["name"]],
            })
    dependency_names = set(payload.get("dependency_objects", []))
    for dependency_name in sorted(dependency_names):
        obj = object_payloads.get(dependency_name)
        if not obj or obj.get("type") not in ("MESH", "CURVE"):
            continue
        has_geometry = any(key in obj for key in ("mesh", "curves", "evaluated_mesh"))
        if not has_geometry:
            embedding_error = (
                obj.get("evaluated_mesh_embedding_error")
                or obj.get("mesh_embedding_error")
            )
            warnings.append({
                "code": "DEPENDENCY_OBJECT_GEOMETRY_UNAVAILABLE",
                "message": (
                    f"{dependency_name} is required by Object/Collection Info, but its geometry "
                    "was omitted from the bounded portable payload"
                    + (
                        f" ({embedding_error.get('serialized_bytes', 0)} serialized bytes; "
                        f"{embedding_error.get('code', 'limit exceeded')})"
                        if embedding_error else ""
                    )
                    + "."
                ),
                "path": [dependency_name],
            })
        elif (
            obj.get("evaluated_mesh_embedding_error")
            and any(modifier.get("type") == "NODES" for modifier in obj.get("modifiers", []))
        ):
            embedding_error = obj["evaluated_mesh_embedding_error"]
            warnings.append({
                "code": "DEPENDENCY_EVALUATED_MESH_OMITTED",
                "message": (
                    f"{dependency_name} evaluated dependency snapshot exceeded the portable budget "
                    f"({embedding_error.get('serialized_bytes', 0)} serialized bytes; "
                    f"{embedding_error.get('code', 'limit exceeded')}); browser evaluation must "
                    "reconstruct it from the embedded base and node groups."
                ),
                "path": [dependency_name],
            })
    for collection_name in sorted(dependency_collection_names):
        collection = collections.get(collection_name)
        if not collection:
            continue
        unavailable = []
        for object_name in collection.get("objects", []):
            child = object_payloads.get(object_name)
            if (
                child
                and child.get("type") in ("MESH", "CURVE")
                and not any(key in child for key in ("mesh", "curves", "evaluated_mesh"))
            ):
                unavailable.append(object_name)
        if unavailable:
            warnings.append({
                "code": "DEPENDENCY_COLLECTION_GEOMETRY_INCOMPLETE",
                "message": (
                    f"{collection_name} is required by Collection Info, but "
                    f"{len(unavailable)} geometry-bearing "
                    f"{'object is' if len(unavailable) == 1 else 'objects are'} unavailable."
                ),
                "path": [collection_name, *unavailable],
            })
    for group_name, group in payload["node_groups"].items():
        for node in group.get("nodes", []):
            if node.get("type") != "GeometryNodeImportSTL":
                continue
            path_socket = next((
                socket for socket in node.get("inputs", [])
                if socket.get("identifier") == "Path" or socket.get("name") == "Path"
            ), None)
            if path_socket and path_socket.get("linked"):
                warnings.append({
                    "code": "EXTERNAL_STL_PATH_DYNAMIC",
                    "message": f"{group_name} / {node['name']} uses a linked STL path that cannot be embedded statically.",
                    "path": [group_name, node["name"]],
                })
                continue
            authored_path = path_socket.get("value") if path_socket else None
            if not isinstance(authored_path, str) or not authored_path:
                warnings.append({
                    "code": "EXTERNAL_STL_PATH_EMPTY",
                    "message": f"{group_name} / {node['name']} has no portable STL path.",
                    "path": [group_name, node["name"]],
                })
                continue
            if node.get("embedded_stl"):
                continue
            embedding_error = node.get("stl_embedding_error")
            resolved_path = bpy.path.abspath(authored_path)
            warnings.append({
                "code": (
                    "EXTERNAL_STL_UNAVAILABLE"
                    if not os.path.isfile(resolved_path)
                    else "EXTERNAL_STL_EMBED_REJECTED"
                    if embedding_error
                    else "EXTERNAL_STL_NOT_EMBEDDED"
                ),
                "message": (
                    f"{group_name} / {node['name']} references an STL that is unavailable: {authored_path}"
                    if not os.path.isfile(resolved_path)
                    else (
                        f"{group_name} / {node['name']} STL was rejected: {embedding_error.get('code')}: {embedding_error.get('message')}"
                        if embedding_error
                        else f"{group_name} / {node['name']} references an external STL that was not embedded: {authored_path}"
                    )
                ),
                "path": [group_name, node["name"], authored_path],
            })
    for font in bpy.data.fonts:
        authored_path = getattr(font, "filepath", "") or ""
        if not authored_path or authored_path == "<builtin>" or getattr(font, "packed_file", None):
            continue
        resolved_path = bpy.path.abspath(authored_path)
        if not os.path.isfile(resolved_path):
            warnings.append({
                "code": "EXTERNAL_FONT_UNAVAILABLE",
                "message": f"{font.name} references an unavailable external font: {authored_path}",
                "path": [font.name, authored_path],
            })
    for image in bpy.data.images:
        authored_path = getattr(image, "filepath", "") or ""
        if (
            not authored_path
            or authored_path == "<builtin>"
            or getattr(image, "packed_file", None)
            or getattr(image, "source", "") in ("GENERATED", "VIEWER")
        ):
            continue
        resolved_path = bpy.path.abspath(authored_path)
        extracted_image = images.get(image.name, {})
        if extracted_image.get("pixels_rgba8"):
            continue
        available = os.path.isfile(resolved_path)
        pixel_error = extracted_image.get("pixel_error")
        warnings.append({
            "code": (
                "EXTERNAL_IMAGE_UNAVAILABLE"
                if not available
                else "EXTERNAL_IMAGE_EMBED_REJECTED"
                if pixel_error
                else "EXTERNAL_IMAGE_NOT_EMBEDDED"
            ),
            "message": (
                f"{image.name} references an unavailable external image: {authored_path}"
                if not available
                else (
                    f"{image.name} image pixels could not be embedded: {pixel_error}"
                    if pixel_error
                    else f"{image.name} references an external image that was not embedded: {authored_path}"
                )
            ),
            "path": [image.name, authored_path],
        })

    roots = []
    if target_object and target_object in object_ids:
        roots.append(object_ids[target_object])
    root_groups = []
    if target_object:
        target_payload = object_payloads.get(target_object, {})
        root_groups = [group_ids[modifier["node_group"]] for modifier in target_payload.get("modifiers", [])
                       if modifier.get("type") == "NODES" and modifier.get("node_group") in group_ids]
    source = {}
    if bpy.data.filepath:
        source["filename"] = os.path.basename(bpy.data.filepath)
        try:
            digest = hashlib.sha256()
            with open(bpy.data.filepath, "rb") as blend_file:
                for chunk in iter(lambda: blend_file.read(1024 * 1024), b""):
                    digest.update(chunk)
            source["fingerprint_sha256"] = digest.hexdigest()
        except Exception as error:
            warnings.append({"code": "SOURCE_FINGERPRINT_FAILED", "message": repr(error)})

    font_inventory = {}
    for font in bpy.data.fonts:
        atlas = payload["fonts"].get(font.name)
        font_inventory[font.name] = {
            "source": font_source_metadata(font),
            "atlas_status": (
                atlas.get("atlas_status", "embedded" if atlas.get("glyphs") else "error")
                if atlas is not None
                else "skipped" if os.environ.get("NODE_DOJO_SKIP_FONT_ATLAS") == "1"
                else "not-referenced"
            ),
            "referenced_by_geometry_nodes": font.name in referenced_fonts,
        }

    return {
        "schema_version": 1,
        "extractor": {"name": "tools/dump_blend.py", "version": "1.6", "blender_version": bpy.app.version_string},
        "source": source,
        "roots": {"objects": roots, "node_groups": root_groups},
        "provenance": {
            "payload": "Blender RNA plus evaluated dependency snapshots",
            "dependency_policy": "reachable typed datablock pointers; legacy dependency_objects retained",
        },
        "warnings": warnings,
        "fonts": font_inventory,
        "ids": {"objects": object_ids, "node_groups": groups},
        "dependencies": descriptors,
    }


result["extraction_metadata"] = build_extraction_metadata(result)

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=1, default=str)

print("DUMP_OK ->", out_path)
