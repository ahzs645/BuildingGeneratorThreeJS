"""Warm Blender bake server: loads the bin .blend once, then polls a comm dir for
parameter requests and bakes a fresh GLB per request (~1-2s each, warm).

Run: blender --background FILE.blend --python bake_server.py -- COMM_DIR [OBJECT]
Protocol (file-based):
  request:  COMM_DIR/req_<id>.json   {"params": {"Size X": 1.2, ...}}
  response: COMM_DIR/res_<id>.glb  then  COMM_DIR/res_<id>.ready  (marker)
"""
import bpy, json, os, sys, time, glob, traceback

argv = sys.argv[sys.argv.index("--") + 1:]
comm = argv[0]
obj_name = argv[1] if len(argv) > 1 else "Procedural Drawer"
os.makedirs(comm, exist_ok=True)

obj = bpy.data.objects[obj_name]
mod = next(m for m in obj.modifiers if m.type == "NODES")
ng = mod.node_group
name2id = {it.name: it.identifier for it in ng.interface.items_tree
           if it.item_type == "SOCKET" and it.in_out == "INPUT" and it.socket_type != "NodeSocketGeometry"}
socktype = {it.name: it.socket_type for it in ng.interface.items_tree
            if it.item_type == "SOCKET" and it.in_out == "INPUT"}

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
    json.dump({"object": obj_name, "params": list(name2id)}, f)

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
