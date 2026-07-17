"""Bake the bin at several parameter values, one GLB per variant + a manifest.
Gives a complete, interactive, 100%-Blender-fidelity example on the web.

Usage: blender --background FILE.blend --python bake_param_variants.py -- OUTDIR [OBJECT]
"""
import bpy, json, os, sys

argv = sys.argv[sys.argv.index("--") + 1:]
outdir = argv[0]
obj_name = argv[1] if len(argv) > 1 else "Procedural Drawer"
os.makedirs(outdir, exist_ok=True)

obj = bpy.data.objects[obj_name]
mod = next(m for m in obj.modifiers if m.type == "NODES")
ng = mod.node_group
name2id = {it.name: it.identifier for it in ng.interface.items_tree
           if it.item_type == "SOCKET" and it.in_out == "INPUT" and it.socket_type != "NodeSocketGeometry"}

def setp(n, v):
    if n in name2id:
        try: mod[name2id[n]] = v
        except Exception as e: print("  !!", n, e)

defaults = {}
for n, ident in name2id.items():
    try:
        v = mod[ident]
        if isinstance(v, (int, float, bool)): defaults[n] = v
    except Exception: pass

# interactive axis: Bin Select moves the red highlight across bins
VARIANTS = []
for sel in [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]:
    VARIANTS.append({"id": f"sel{sel}", "label": f"Bin Select {sel}", "params": {"Bin Select": sel}})

referenced_fonts = {}
for group in bpy.data.node_groups:
    for node in group.nodes:
        if node.bl_idname != "GeometryNodeStringToCurves":
            continue
        socket = node.inputs.get("Font")
        font = getattr(socket, "default_value", None) if socket else None
        if isinstance(font, bpy.types.VectorFont):
            path = bpy.path.abspath(font.filepath)
            referenced_fonts[font.name] = os.path.basename(path) if path else "<builtin>"

manifest = {
    "object": obj_name,
    "axis": "Bin Select",
    "generator": {
        "blender_version": bpy.app.version_string,
        "fonts": [
            {"name": name, "source": source}
            for name, source in sorted(referenced_fonts.items())
        ],
        "font_binaries_in_glb": False,
    },
    "variants": [],
}
for v in VARIANTS:
    for n, val in defaults.items():
        setp(n, val)
    for n, val in v["params"].items():
        setp(n, val)
    obj.update_tag()
    for o in bpy.data.objects: o.select_set(False)
    obj.hide_set(False); obj.hide_render = False; obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    path = os.path.join(outdir, f"bin_{v['id']}.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True,
                              export_apply=True, export_yup=True, export_materials="EXPORT", export_normals=True)
    size = os.path.getsize(path)
    manifest["variants"].append({"id": v["id"], "label": v["label"], "params": v["params"], "file": f"bin_{v['id']}.glb", "bytes": size})
    print(f"  baked {v['label']:16s} -> {os.path.basename(path)} ({size//1024} KB)")

with open(os.path.join(outdir, "variants.json"), "w") as f:
    json.dump(manifest, f, indent=1)
print("VARIANTS_BAKED", len(VARIANTS), "->", outdir)
