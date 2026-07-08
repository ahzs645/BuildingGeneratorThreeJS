"""Lightweight inventory of a .blend: objects, geometry-nodes modifiers, exposed
params, node-group sizes. Does NOT dump full graphs (keeps output small)."""
import bpy, json, sys

out_path = sys.argv[sys.argv.index("--") + 1]

def iface_params(ng):
    params = []
    for item in ng.interface.items_tree:
        if item.item_type == "SOCKET" and item.in_out == "INPUT":
            e = {"name": item.name, "socket": item.socket_type}
            for a in ("min_value", "max_value"):
                if hasattr(item, a):
                    try: e[a] = getattr(item, a)
                    except Exception: pass
            params.append(e)
    return params

result = {"blender_version": bpy.app.version_string, "objects": [], "geo_node_groups": {}}

used_groups = {}
for obj in bpy.data.objects:
    o = {"name": obj.name, "type": obj.type, "geo_mods": []}
    if obj.type == "MESH" and obj.data:
        o["verts"] = len(obj.data.vertices)
        o["faces"] = len(obj.data.polygons)
    for mod in obj.modifiers:
        if mod.type == "NODES" and mod.node_group:
            ng = mod.node_group
            used_groups[ng.name] = ng
            o["geo_mods"].append({"mod": mod.name, "node_group": ng.name,
                                  "params": iface_params(ng)})
    if o["geo_mods"] or obj.type in ("MESH",):
        result["objects"].append(o)

# node-group complexity (node count, nested group refs) for all geometry node trees
for ng in bpy.data.node_groups:
    if ng.bl_idname != "GeometryNodeTree":
        continue
    nested = sorted({n.node_tree.name for n in ng.nodes
                     if n.bl_idname == "GeometryNodeGroup" and n.node_tree})
    result["geo_node_groups"][ng.name] = {
        "nodes": len(ng.nodes),
        "used_as_modifier": ng.name in used_groups,
        "nested_groups": nested,
        "n_params": len(iface_params(ng)),
    }

with open(out_path, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=1, default=str)
print("INVENTORY_OK ->", out_path)
