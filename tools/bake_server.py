"""Warm Blender bake server: loads the bin .blend once, then polls a comm dir for
parameter requests and bakes a fresh GLB per request (~1-2s each, warm).

Run: blender --background FILE.blend --python bake_server.py -- COMM_DIR [OBJECT] [FONT_DIR]
Protocol (file-based):
  request:  COMM_DIR/req_<id>.json   {"params": {"Size X": 1.2, ...}}
  response: COMM_DIR/res_<id>.glb  then  COMM_DIR/res_<id>.ready  (marker)
"""
import bpy, glob, hashlib, json, os, sys, time, traceback

argv = sys.argv[sys.argv.index("--") + 1:]
comm = argv[0]
obj_name = argv[1] if len(argv) > 1 else "Procedural Drawer"
repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
font_dir = argv[2] if len(argv) > 2 else os.environ.get(
    "NODE_DOJO_FONT_DIR",
    os.path.join(repo_root, ".local-assets", "node-dojo-fonts", "exact"),
)
os.makedirs(comm, exist_ok=True)

obj = bpy.data.objects[obj_name]
mod = next(m for m in obj.modifiers if m.type == "NODES")
ng = mod.node_group
name2id = {it.name: it.identifier for it in ng.interface.items_tree
           if it.item_type == "SOCKET" and it.in_out == "INPUT" and it.socket_type != "NodeSocketGeometry"}
socktype = {it.name: it.socket_type for it in ng.interface.items_tree
            if it.item_type == "SOCKET" and it.in_out == "INPUT"}

def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def font_key(value):
    lowered = value.lower()
    if "dogica" in lowered:
        return "dogica"
    if "degular" in lowered:
        return "degular"
    return None

def node_font_sockets():
    """Yield Geometry Nodes font sockets that reference a VectorFont datablock."""
    for node_group in bpy.data.node_groups:
        for node in node_group.nodes:
            for socket in node.inputs:
                if not hasattr(socket, "default_value"):
                    continue
                font = socket.default_value
                if isinstance(font, bpy.types.VectorFont):
                    yield socket, font

def load_exact_font_overrides():
    parity_path = os.path.join(repo_root, "public", "dojo", "bin-geometry-parity.json")
    with open(parity_path, encoding="utf8") as source:
        specs = json.load(source).get("fontOverrides", [])
    replacements = {}
    applied = []
    rejected = []
    for spec in specs:
        path = os.path.join(font_dir, spec["source"])
        if not os.path.isfile(path):
            continue
        actual = sha256_file(path)
        if actual.lower() != spec["sha256"].lower():
            rejected.append({"source": spec["source"], "path": path, "reason": "sha256 mismatch", "sha256": actual})
            continue
        key = font_key(spec["source"])
        if not key:
            continue
        try:
            replacement = bpy.data.fonts.load(path, check_existing=True)
            replacements[key] = replacement
            applied.append({"source": spec["source"], "path": path, "sha256": actual})
        except Exception as error:
            rejected.append({"source": spec["source"], "path": path, "reason": str(error)})

    assignments = {key: 0 for key in replacements}
    for curve in bpy.data.curves:
        if curve.type != "FONT":
            continue
        for attribute in ("font", "font_bold", "font_italic", "font_bold_italic"):
            current = getattr(curve, attribute, None)
            if not current:
                continue
            key = font_key(f"{current.name} {getattr(current, 'filepath', '')}")
            if key in replacements and current != replacements[key]:
                setattr(curve, attribute, replacements[key])
                assignments[key] += 1
    for socket, current in node_font_sockets():
        key = font_key(f"{current.name} {getattr(current, 'filepath', '')}")
        if key in replacements and current != replacements[key]:
            socket.default_value = replacements[key]
            assignments[key] += 1
    return applied, rejected, assignments

font_overrides_applied, font_overrides_rejected, font_override_assignments = load_exact_font_overrides()

def missing_external_files(datablocks):
    missing = []
    for datablock in datablocks:
        filepath = getattr(datablock, "filepath", "") or ""
        if not filepath or filepath == "<builtin>" or getattr(datablock, "packed_file", None):
            continue
        resolved = os.path.abspath(bpy.path.abspath(filepath))
        if not os.path.exists(resolved):
            missing.append({"name": datablock.name, "path": resolved})
    return missing

referenced_fonts = {
    font
    for curve in bpy.data.curves if curve.type == "FONT"
    for font in (curve.font, curve.font_bold, curve.font_italic, curve.font_bold_italic)
    if font
}
referenced_fonts.update(font for _, font in node_font_sockets())
missing_fonts = missing_external_files(referenced_fonts)
missing_images = missing_external_files(
    image for image in bpy.data.images if image.source in {"FILE", "TILED"}
)

def setp(n, v):
    ident = name2id.get(n)
    if ident is None:
        return
    st = socktype.get(n, "")
    try:
        if "Int" in st:
            mod[ident] = int(round(float(v)))
        elif "Bool" in st:
            mod[ident] = bool(v)
        else:
            mod[ident] = float(v)
    except Exception as e:
        print("  setp err", n, e)

def bake(params, out_path):
    for n, v in params.items():
        setp(n, v)
    obj.update_tag()
    for o in bpy.data.objects:
        o.select_set(False)
    obj.hide_set(False); obj.hide_render = False; obj.hide_viewport = False
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=out_path, export_format="GLB", use_selection=True,
                              export_apply=True, export_yup=True, export_materials="EXPORT", export_normals=True)

print(f"BAKE_SERVER ready  obj={obj_name}  comm={comm}  params={list(name2id)}", flush=True)
# announce readiness
with open(os.path.join(comm, "server.ready"), "w") as f:
    json.dump({
        "object": obj_name,
        "params": list(name2id),
        "blenderVersion": bpy.app.version_string,
        "dependencies": {
            "completeForGeometry": len(missing_fonts) == 0,
            "missingFonts": missing_fonts,
            "missingImages": missing_images,
        },
        "fontOverrides": {
            "directory": font_dir,
            "applied": font_overrides_applied,
            "rejected": font_overrides_rejected,
            "assignments": font_override_assignments,
        },
    }, f)

while True:
    reqs = sorted(glob.glob(os.path.join(comm, "req_*.json")))
    for r in reqs:
        rid = os.path.basename(r)[4:-5]
        try:
            with open(r) as f:
                data = json.load(f)
            os.remove(r)
            out = os.path.join(comm, f"res_{rid}.glb")
            t0 = time.time()
            bake(data.get("params", {}), out)
            open(os.path.join(comm, f"res_{rid}.ready"), "w").close()
            print(f"  baked {rid} in {time.time()-t0:.2f}s", flush=True)
        except Exception:
            traceback.print_exc()
            try: os.remove(r)
            except Exception: pass
            with open(os.path.join(comm, f"res_{rid}.err"), "w") as f:
                f.write(traceback.format_exc())
    time.sleep(0.1)
