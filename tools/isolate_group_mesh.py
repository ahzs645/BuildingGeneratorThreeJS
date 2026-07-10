"""Evaluate a node GROUP in isolation in Blender on a known input mesh and dump the
full result mesh (positions + faces) for VM diffing.
Usage: blender --background FILE.blend --python isolate_group_mesh.py -- GROUP OUT.json [quad|grid|@mesh.json] [params.json]
  quad: single unit quad centered at origin (default)
  grid: 3x3-vertex grid (2x2 quads), size 1, centered
  @path: inject a mesh from JSON {verts:[[x,y,z]..], faces:[[i..]..], edges:[[a,b]..]}
  params.json: {interfaceIdentifier: value} bound onto the modifier (else defaults)"""
import bpy, bmesh, json, sys

argv = sys.argv[sys.argv.index("--") + 1:]
group_name = argv[0]
out_path = argv[1]
shape = argv[2] if len(argv) > 2 else "quad"
params_path = argv[3] if len(argv) > 3 else None

me = bpy.data.meshes.new("g")
obj = bpy.data.objects.new("g", me)
bpy.context.collection.objects.link(obj)
if shape.startswith("@"):
    src = json.load(open(shape[1:]))
    me.from_pydata([tuple(v) for v in src["verts"]],
                   [tuple(e) for e in src.get("edges", [])],
                   [tuple(f) for f in src.get("faces", [])])
    me.update()
else:
    bm = bmesh.new()
    if shape == "grid":
        N = 3
        verts = {}
        for j in range(N):
            for i in range(N):
                verts[(i, j)] = bm.verts.new((i / (N - 1) - 0.5, j / (N - 1) - 0.5, 0.0))
        bm.verts.ensure_lookup_table()
        for j in range(N - 1):
            for i in range(N - 1):
                bm.faces.new([verts[(i, j)], verts[(i + 1, j)], verts[(i + 1, j + 1)], verts[(i, j + 1)]])
    else:
        vs = [bm.verts.new(p) for p in [(-0.5, -0.5, 0), (0.5, -0.5, 0), (0.5, 0.5, 0), (-0.5, 0.5, 0)]]
        bm.faces.new(vs)
    bm.to_mesh(me)
    bm.free()

ng = bpy.data.node_groups[group_name]
mod = obj.modifiers.new("GN", "NODES")
mod.node_group = ng

defaults = {}
for it in ng.interface.items_tree:
    if it.item_type == "SOCKET" and it.in_out == "INPUT" and it.socket_type != "NodeSocketGeometry":
        defaults[it.name] = getattr(it, "default_value", None)
print("interface inputs (defaults kept):", defaults)

if params_path:
    overrides = json.load(open(params_path))
    for ident, val in overrides.items():
        try:
            mod[ident] = val
            print("  bound", ident, "=", val)
        except Exception as e:
            print("  !! bind", ident, e)

obj.update_tag()
dg = bpy.context.evaluated_depsgraph_get()
ev = obj.evaluated_get(dg)
m = ev.to_mesh()
pos = [[round(v.co.x, 5), round(v.co.y, 5), round(v.co.z, 5)] for v in m.vertices]
faces = [list(p.vertices) for p in m.polygons]
print(f"RESULT: {len(pos)} verts, {len(faces)} faces")
with open(out_path, "w") as f:
    json.dump({"group": group_name, "shape": shape, "verts": pos, "faces": faces,
               "face_materials": [p.material_index for p in m.polygons],
               "materials": [material.name if material else None for material in m.materials],
               "defaults": {k: (list(v) if hasattr(v, "__len__") and not isinstance(v, str) else v) for k, v in defaults.items()}}, f)
ev.to_mesh_clear()
print("ISOLATE_OK ->", out_path)
