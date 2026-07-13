"""Freeze Send Nodes Hat's evaluated front mesh before rendering embroidery.

The supplied file intentionally has a dependency cycle: `hat front` reads
`embroidery crv`, while the embroidery shrinkwrap reads `hat front`. Blender's
fresh isolated evaluation can therefore expose an arbitrary transient state.
This helper snapshots the already-evaluated front, then removes only its Nodes
modifier so the following reference render has a stable shrinkwrap target.
"""
import bpy


target = bpy.data.objects.get("hat front")
if target is None:
    raise RuntimeError("Send Nodes Hat object not found: hat front")

depsgraph = bpy.context.evaluated_depsgraph_get()
depsgraph.update()
evaluated = target.evaluated_get(depsgraph)
frozen = bpy.data.meshes.new_from_object(evaluated, depsgraph=depsgraph)
target.data = frozen
for modifier in list(target.modifiers):
    if modifier.type == "NODES":
        target.modifiers.remove(modifier)
target.update_tag()
bpy.context.view_layer.update()
print(f"HAT_FRONT_DEPENDENCY_FROZEN {len(frozen.vertices)} verts / {len(frozen.polygons)} faces")
