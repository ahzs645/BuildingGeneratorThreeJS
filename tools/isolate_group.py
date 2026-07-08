"""Evaluate a node GROUP in isolation in Blender on a known grid, to get ground
truth for the VM. Usage: blender --background FILE.blend --python isolate_group.py -- GROUP OUT.json"""
import bpy, bmesh, json, sys

argv = sys.argv[sys.argv.index("--") + 1:]
group_name = argv[0]
out_path = argv[1]

# build a 3x3-vertex grid (2x2 quads), size 1, centered — matches meshGrid(1,1,3,3)
me = bpy.data.meshes.new("g")
obj = bpy.data.objects.new("g", me)
bpy.context.collection.objects.link(obj)
bm = bmesh.new()
N = 3
verts = {}
for j in range(N):
    for i in range(N):
        verts[(i, j)] = bm.verts.new((i / (N - 1) - 0.5, j / (N - 1) - 0.5, 0.0))
bm.verts.ensure_lookup_table()
for j in range(N - 1):
    for i in range(N - 1):
        bm.faces.new([verts[(i, j)], verts[(i + 1, j)], verts[(i + 1, j + 1)], verts[(i, j + 1)]])
bm.to_mesh(me)
bm.free()

ng = bpy.data.node_groups[group_name]
mod = obj.modifiers.new("GN", "NODES")
mod.node_group = ng
name2id = {it.name: it.identifier for it in ng.interface.items_tree if it.item_type == "SOCKET" and it.in_out == "INPUT"}

def setp(n, v):
    if n in name2id:
        try: mod[name2id[n]] = v
        except Exception as e: print("  !! set", n, e)

print("interface inputs:", list(name2id.keys()))
results = []
for iters in [0, 1, 2, 3]:
    setp("Iterations", iters); setp("X", 0.5); setp("Y", 0.5)
    obj.update_tag()
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    m = ev.to_mesh()
    results.append({"iter": iters, "verts": len(m.vertices), "faces": len(m.polygons)})
    print(f"  iter={iters}: {len(m.vertices)} verts, {len(m.polygons)} faces")
    ev.to_mesh_clear()

with open(out_path, "w") as f:
    json.dump({"group": group_name, "results": results}, f, indent=1)
print("ISOLATE_OK ->", out_path)
