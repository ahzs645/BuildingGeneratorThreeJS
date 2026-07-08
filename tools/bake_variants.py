"""Diff-oracle: evaluate the bin modifier at several parameter values in Blender and
dump an order-independent geometry signature per variant. Lets us check whether the
REAL Blender output responds to a parameter (ground truth) and compare against the VM.

Usage:
  blender --background FILE.blend --python bake_variants.py -- OUT.json [OBJECT]
"""
import bpy, json, sys, hashlib

argv = sys.argv[sys.argv.index("--") + 1:]
out_path = argv[0]
obj_name = argv[1] if len(argv) > 1 else "Procedural Drawer"

obj = bpy.data.objects[obj_name]
mod = next(m for m in obj.modifiers if m.type == "NODES")
ng = mod.node_group
name2id = {}
for it in ng.interface.items_tree:
    if it.item_type == "SOCKET" and it.in_out == "INPUT" and it.socket_type != "NodeSocketGeometry":
        name2id[it.name] = it.identifier

def set_param(name, val):
    ident = name2id.get(name)
    if ident is None:
        print("  !! unknown param", name); return
    mod[ident] = val

def evaluate():
    obj.update_tag()
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    n = len(me.vertices)
    xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]; zs = [v.co.z for v in me.vertices]
    total = sum(xs) + sum(ys) + sum(zs)
    bbox = None
    if n:
        bbox = [[min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)]]
    # order-independent signature: sort rounded coords, hash
    pts = sorted((round(v.co.x, 4), round(v.co.y, 4), round(v.co.z, 4)) for v in me.vertices)
    h = hashlib.md5(repr(pts).encode()).hexdigest()[:12]
    stats = {"verts": n, "faces": len(me.polygons), "sum": round(total, 3),
             "bbox": [[round(c, 3) for c in bbox[0]], [round(c, 3) for c in bbox[1]]] if bbox else None,
             "hash": h}
    ev.to_mesh_clear()
    return stats

# variants: sweep the parameters we care about
VARIANTS = [
    ("baseline", {}),
    ("divide 0.0", {"divide x": 0.0, "divide y": 0.0}),
    ("divide 0.3", {"divide x": 0.3, "divide y": 0.3}),
    ("divide 0.6", {"divide x": 0.6, "divide y": 0.6}),
    ("divide 0.9", {"divide x": 0.9, "divide y": 0.9}),
    ("divide x-only 0.9", {"divide x": 0.9, "divide y": 0.0}),
    ("SizeX 3", {"Size X": 3.0}),
    ("Bin Select 3", {"Bin Select": 3}),
    ("Bin Select 9", {"Bin Select": 9}),
]

# capture the authored defaults so we can restore between variants
defaults = {}
for name, ident in name2id.items():
    try:
        v = mod[ident]
        defaults[name] = v if isinstance(v, (int, float, bool)) else None
    except Exception:
        defaults[name] = None
defaults = {k: v for k, v in defaults.items() if v is not None}

results = []
for label, params in VARIANTS:
    # restore defaults, then apply overrides
    for name, val in defaults.items():
        try: set_param(name, val)
        except Exception: pass
    for name, val in params.items():
        set_param(name, val)
    stats = evaluate()
    results.append({"label": label, "params": params, "stats": stats})
    print(f"  {label:20s} -> verts={stats['verts']} faces={stats['faces']} sum={stats['sum']} hash={stats['hash']}")

with open(out_path, "w") as f:
    json.dump({"object": obj_name, "param_ids": name2id, "variants": results}, f, indent=1)
print("VARIANTS_OK ->", out_path)
