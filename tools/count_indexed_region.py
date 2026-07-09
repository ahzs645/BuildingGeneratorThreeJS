"""Count Blender's INDEXED evaluated-mesh verts in a region — the reliable way to
compare vertex density vs the VM. Do NOT use GLB soup ÷ global-factor for density
at collapsed/high-valence regions (e.g. an axis collapse): soup duplicates
high-valence verts far more than average, so the global soup factor under-counts.
Usage: blender --background FILE.blend --python count_indexed_region.py -- OBJECT [zmax] [rmax]
Region = z < zmax AND hypot(x,y) < rmax, in the object's LOCAL space."""
import bpy, sys, math
argv = sys.argv[sys.argv.index("--") + 1:]
obj_name = argv[0]
zmax = float(argv[1]) if len(argv) > 1 else 40.0
rmax = float(argv[2]) if len(argv) > 2 else 80.0
obj = bpy.data.objects[obj_name]
dg = bpy.context.evaluated_depsgraph_get()
ev = obj.evaluated_get(dg)
m = ev.to_mesh()
total = len(m.vertices)
region = sum(1 for v in m.vertices if v.co.z < zmax and math.hypot(v.co.x, v.co.y) < rmax)
axis = sum(1 for v in m.vertices if math.hypot(v.co.x, v.co.y) < 5)
print(f"INDEXED total={total} region(z<{zmax},r<{rmax})={region} axis(r<5)={axis}")
ev.to_mesh_clear()
