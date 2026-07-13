"""Create stable reference objects for N03D groups hidden behind wrappers.

The supplied N03D asset library exposes ``Split n Tap WIP`` through a source
object whose active root currently evaluates to a placeholder icosphere.  The
browser catalog intentionally evaluates the nested asset group itself, so this
script creates the equivalent one-point carrier object in Blender before the
normal reference renderer runs.

Usage:
  blender --background FILE.blend --python tools/configure_n03d_reference.py \
    --python tools/render_blender_reference.py -- __GNVM_SPLIT_N_TAP OUT.png
"""

import bpy


OBJECT_NAME = "__GNVM_SPLIT_N_TAP"
GROUP_NAME = "Split n Tap WIP"

group = bpy.data.node_groups.get(GROUP_NAME)
if group is None:
    raise RuntimeError(f"N03D node group not found: {GROUP_NAME}")

existing = bpy.data.objects.get(OBJECT_NAME)
if existing is not None:
    for collection in list(existing.users_collection):
        collection.objects.unlink(existing)
    bpy.data.objects.remove(existing, do_unlink=True)

mesh = bpy.data.meshes.new(f"{OBJECT_NAME}_MESH")
mesh.from_pydata([(0.0, 0.0, 0.0)], [], [])
mesh.update()
obj = bpy.data.objects.new(OBJECT_NAME, mesh)
bpy.context.scene.collection.objects.link(obj)

modifier = obj.modifiers.new(name="Split n Tap", type="NODES")
modifier.node_group = group
values = {
    "length": 10.0,
    "diameter": 9.529999732971191,
    "Object": None,
    "Split!": False,
    "resolution": 121,
    "Object Parent": None,
    "select parts": 0,
    "Z": 0.0,
    "Value": (0.8, 0.8, 0.8, 1.0),
}
for item in group.interface.items_tree:
    if item.item_type != "SOCKET" or item.in_out != "INPUT":
        continue
    if item.name in values:
        modifier[item.identifier] = values[item.name]

obj.update_tag()
bpy.context.view_layer.update()
print(f"N03D_REFERENCE_CONFIGURED {OBJECT_NAME} -> {GROUP_NAME}")
