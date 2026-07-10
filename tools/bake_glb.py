"""Evaluate an object's geometry-nodes modifier(s) and export the realized mesh to GLB.

Usage:
  blender --background FILE.blend --python bake_glb.py -- OUT.glb [OBJECT_NAME ...]

If object names are omitted, exports the first mesh object that has a NODES modifier.
Uses export_apply=True so geometry nodes (incl. instances) are realized into the GLB.
"""
import bpy, sys

argv = sys.argv[sys.argv.index("--") + 1:]
out_path = argv[0]
want_names = argv[1:]

def has_nodes_mod(o):
    return any(m.type == "NODES" and m.node_group for m in o.modifiers)

# pick target objects
targets = [bpy.data.objects[name] for name in want_names if name in bpy.data.objects]
if want_names and len(targets) != len(want_names):
    missing = [name for name in want_names if name not in bpy.data.objects]
    print("BAKE_ERR missing object(s):", ", ".join(missing))
    sys.exit(1)
if not targets:
    for o in bpy.data.objects:
        if o.type == "MESH" and has_nodes_mod(o):
            targets = [o]
            break
if not targets:
    print("BAKE_ERR no mesh object with a geometry-nodes modifier found")
    sys.exit(1)

print("BAKE targets:", ", ".join(target.name for target in targets))

# Tutorial files often park finished studies in a collection that is not linked
# into the active scene. Temporarily link the requested object so Blender's
# selection-only glTF export can still bake it by name.
for target in targets:
    if target.name not in bpy.context.view_layer.objects:
        bpy.context.scene.collection.objects.link(target)
bpy.context.view_layer.update()

# make sure they render/export: unhide and select only the targets
for o in bpy.data.objects:
    o.select_set(False)
for target in targets:
    target.hide_set(False)
    target.hide_render = False
    target.hide_viewport = False
    target.select_set(True)
bpy.context.view_layer.objects.active = targets[0]

# report evaluated stats
dg = bpy.context.evaluated_depsgraph_get()
for target in targets:
    ev = target.evaluated_get(dg)
    try:
        m = ev.to_mesh()
        print(f"BAKE evaluated {target.name}: verts={len(m.vertices)} faces={len(m.polygons)}")
        ev.to_mesh_clear()
    except Exception as e:
        print("BAKE eval-stats skipped:", target.name, e)

bpy.ops.export_scene.gltf(
    filepath=out_path,
    export_format="GLB",
    use_selection=True,
    export_apply=True,          # realize modifiers (geometry nodes) into mesh
    export_yup=True,            # Blender Z-up -> glTF/three Y-up
    export_materials="EXPORT",
    export_normals=True,
)
print("BAKE_OK ->", out_path)
