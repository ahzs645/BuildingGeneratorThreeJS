"""Dump geometry node trees, objects, and materials from a .blend to JSON."""
import bpy
import json
import sys

out_path = sys.argv[sys.argv.index("--") + 1]

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
    d = {
        "name": node.name,
        "type": node.bl_idname,
        "label": node.label or None,
        "inputs": [],
        "outputs": [{"name": o.name, "identifier": o.identifier,
                     "default": socket_value(o) if not o.is_linked or True else None}
                    for o in node.outputs],
    }
    for i, s in enumerate(node.inputs):
        d["inputs"].append({
            "name": s.name,
            "identifier": s.identifier,
            "idx": i,
            "type": s.bl_idname,
            "linked": s.is_linked,
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
        d["links"].append({
            "from_node": l.from_node.name, "from_socket": l.from_socket.identifier,
            "to_node": l.to_node.name, "to_socket": l.to_socket.identifier,
            "to_idx": l.to_socket.index if hasattr(l.to_socket, "index") else None,
        })
    return d

result = {"blender_version": bpy.app.version_string, "objects": [], "node_groups": {}, "materials": {}, "images": []}

trees_to_dump = {}

for obj in bpy.data.objects:
    o = {"name": obj.name, "type": obj.type, "location": list(obj.location),
         "rotation": list(obj.rotation_euler), "scale": list(obj.scale),
         "visible": not obj.hide_render, "modifiers": [], "materials": [m.name for m in obj.data.materials] if obj.type == "MESH" and obj.data else []}
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
    for mod in obj.modifiers:
        m = {"name": mod.name, "type": mod.type}
        if mod.type == "NODES" and mod.node_group:
            m["node_group"] = mod.node_group.name
            trees_to_dump[mod.node_group.name] = mod.node_group
            # modifier input overrides
            inputs = {}
            for item in mod.node_group.interface.items_tree:
                if item.item_type == "SOCKET" and item.in_out == "INPUT":
                    key = item.identifier
                    try:
                        v = mod[key]
                        if hasattr(v, "name"):
                            v = {"datablock": type(v).__name__, "name": v.name}
                        elif hasattr(v, "__len__") and not isinstance(v, str):
                            v = list(v)
                        inputs[item.name] = v
                    except Exception:
                        pass
            m["input_values"] = inputs
        o["modifiers"].append(m)
    result["objects"].append(o)

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
        if n.bl_idname == "GeometryNodeGroup" and n.node_tree and n.node_tree.name not in done:
            pending[n.node_tree.name] = n.node_tree

# also dump any geometry node groups not reachable (just in case)
for tree in bpy.data.node_groups:
    if tree.bl_idname == "GeometryNodeTree" and tree.name not in done:
        result["node_groups"][tree.name] = dump_tree(tree)

for mat in bpy.data.materials:
    if mat.use_nodes and mat.node_tree:
        result["materials"][mat.name] = dump_tree(mat.node_tree)

for img in bpy.data.images:
    result["images"].append({"name": img.name, "filepath": img.filepath, "size": list(img.size)})

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=1, default=str)

print("DUMP_OK ->", out_path)
