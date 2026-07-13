"""Dump geometry node trees, objects, and materials from a .blend to JSON."""
import bpy
import base64
import json
import sys

tool_args = sys.argv[sys.argv.index("--") + 1:]
out_path = tool_args[0]
target_object = tool_args[1] if len(tool_args) > 1 else None

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
        d["links"].append(entry)
    return d

result = {
    "blender_version": bpy.app.version_string,
    "scene": {
        "frame_current": bpy.context.scene.frame_current,
        "fps": bpy.context.scene.render.fps,
        "fps_base": bpy.context.scene.render.fps_base,
    },
    "objects": [], "collections": [], "node_groups": {}, "materials": {}, "images": [], "dependency_objects": []
}

dependency_collection_names = set()
dependency_object_names = set()
dependency_image_names = set()
if target_object and bpy.data.objects.get(target_object):
    for modifier in bpy.data.objects[target_object].modifiers:
        if modifier.type != "NODES" or not modifier.node_group:
            continue
        for item in modifier.node_group.interface.items_tree:
            if item.item_type != "SOCKET" or item.in_out != "INPUT":
                continue
            try:
                value = modifier[item.identifier]
                if isinstance(value, bpy.types.Collection):
                    dependency_collection_names.add(value.name)
                elif isinstance(value, bpy.types.Object):
                    dependency_object_names.add(value.name)
                elif isinstance(value, bpy.types.Image):
                    dependency_image_names.add(value.name)
            except Exception:
                pass
dependency_object_names.update({
    obj.name
    for name in dependency_collection_names
    for obj in bpy.data.collections[name].objects
})
result["dependency_objects"] = sorted(dependency_object_names)
depsgraph = bpy.context.evaluated_depsgraph_get()

trees_to_dump = {}

for obj in bpy.data.objects:
    o = {"name": obj.name, "type": obj.type, "location": list(obj.location),
         "rotation": list(obj.rotation_euler), "scale": list(obj.scale),
         "visible": not obj.hide_render, "modifiers": [], "materials": [m.name for m in obj.data.materials] if obj.type in ("MESH", "CURVE") and obj.data else []}
    if obj.type == "MESH" and obj.data:
        o["mesh_stats"] = {"verts": len(obj.data.vertices), "faces": len(obj.data.polygons)}
        # Embed small BASE meshes (pre-modifier obj.data): ObjectInfo materializes
        # referenced objects (e.g. 'printbed'), and GN modifiers need the object's
        # own mesh bound to their Geometry input (e.g. the bubble vase's seed).
        if len(obj.data.vertices) <= 10000:
            me = obj.data
            o["mesh"] = {
                "verts": [[round(v.co.x, 6), round(v.co.y, 6), round(v.co.z, 6)] for v in me.vertices],
                "faces": [list(p.vertices) for p in me.polygons],
                "face_materials": [p.material_index for p in me.polygons],
                "edges": [[e.vertices[0], e.vertices[1]] for e in me.edges if e.is_loose],
            }
            # authored custom attributes (e.g. the bubble vase's 'bottom' vertex
            # tag drives a Named Attribute -> Separate chain in the graph)
            attrs = {}
            for a in me.attributes:
                if a.domain != "POINT" or a.name.startswith(".") or a.name == "position":
                    continue
                try:
                    if a.data_type in ("FLOAT", "INT", "BOOLEAN"):
                        attrs[a.name] = {"domain": "POINT",
                                         "data": [float(x.value) for x in a.data]}
                    elif a.data_type == "FLOAT_VECTOR":
                        attrs[a.name] = {"domain": "POINT",
                                         "data": [[round(c, 6) for c in x.vector] for x in a.data]}
                except Exception:
                    pass
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
                o["mesh"]["attributes"] = attrs
    elif obj.type == "CURVE" and obj.data:
        # Geometry Nodes receives the object's pre-modifier curve component.
        # Store evaluated polylines so the browser VM can resample Bezier input
        # without needing Blender's proprietary curve datablock implementation.
        def bezier(a, b, c, d, t):
            u = 1.0 - t
            return [u*u*u*a[i] + 3*u*u*t*b[i] + 3*u*t*t*c[i] + t*t*t*d[i] for i in range(3)]
        splines = []
        for spline in obj.data.splines:
            cyclic = bool(spline.use_cyclic_u)
            points = []
            tilts = []
            if spline.type == "BEZIER":
                bp = list(spline.bezier_points)
                segments = len(bp) if cyclic else max(0, len(bp) - 1)
                resolution = max(2, int(getattr(spline, "resolution_u", 0) or obj.data.resolution_u or 12))
                for segment in range(segments):
                    p0 = bp[segment]
                    p1 = bp[(segment + 1) % len(bp)]
                    for step in range(resolution):
                        factor = step / resolution
                        points.append([round(v, 6) for v in bezier(p0.co, p0.handle_right, p1.handle_left, p1.co, factor)])
                        tilts.append(round((1.0 - factor) * p0.tilt + factor * p1.tilt, 6))
                if not cyclic and bp:
                    points.append([round(v, 6) for v in bp[-1].co])
                    tilts.append(round(bp[-1].tilt, 6))
            else:
                points = [[round(p.co.x, 6), round(p.co.y, 6), round(p.co.z, 6)] for p in spline.points]
                tilts = [round(p.tilt, 6) for p in spline.points]
            if points:
                splines.append({"points": points, "cyclic": cyclic, "tilts": tilts})
        o["curves"] = splines
    if obj.name in dependency_object_names and obj.type in ("MESH", "CURVE"):
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            o["evaluated_mesh"] = {
                "verts": [[round(v.co.x, 6), round(v.co.y, 6), round(v.co.z, 6)] for v in mesh.vertices],
                "faces": [list(p.vertices) for p in mesh.polygons],
                "face_materials": [p.material_index for p in mesh.polygons],
                "edges": [[e.vertices[0], e.vertices[1]] for e in mesh.edges if e.is_loose],
                "materials": [material.name if material else None for material in mesh.materials],
            }
        finally:
            evaluated.to_mesh_clear()
    for mod in obj.modifiers:
        m = {"name": mod.name, "type": mod.type}
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

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=1, default=str)

print("DUMP_OK ->", out_path)
