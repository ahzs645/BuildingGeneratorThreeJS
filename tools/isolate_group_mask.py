"""Bake a group's boolean FIELD output (e.g. a selection mask) into a face
attribute by wrapping the group in a generated tree, so the VM's field outputs
can be oracle-diffed per-face.
Usage: blender --background FILE.blend --python isolate_group_mask.py -- \
    GROUP FIELD_OUTPUT_NAME OUT.json @mesh.json [params.json]
FIELD_OUTPUT_NAME matches by interface socket name+identifier (e.g. Output_86).
Writes {centers:[[x,y,z]..], mask:[0/1..]} for every face of the group's mesh output."""
import bpy, json, sys

argv = sys.argv[sys.argv.index("--") + 1:]
group_name, field_ident, out_path, mesh_spec = argv[0], argv[1], argv[2], argv[3]
params_path = argv[4] if len(argv) > 4 else None

# input object from JSON mesh
src = json.load(open(mesh_spec[1:]))
me = bpy.data.meshes.new("g")
me.from_pydata([tuple(v) for v in src["verts"]],
               [tuple(e) for e in src.get("edges", [])],
               [tuple(f) for f in src.get("faces", [])])
me.update()
obj = bpy.data.objects.new("g", me)
bpy.context.collection.objects.link(obj)

inner = bpy.data.node_groups[group_name]

# wrapper tree: GroupInput -> inner group -> StoreNamedAttribute(mask) -> GroupOutput
wrap = bpy.data.node_groups.new("MaskWrapper", "GeometryNodeTree")
wrap.interface.new_socket("Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
wrap.interface.new_socket("Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
n_in = wrap.nodes.new("NodeGroupInput")
n_grp = wrap.nodes.new("GeometryNodeGroup")
n_grp.node_tree = inner
n_store = wrap.nodes.new("GeometryNodeStoreNamedAttribute")
n_store.data_type = "BOOLEAN"
n_store.domain = "FACE"
n_store.inputs["Name"].default_value = "__oracle_mask"
n_out = wrap.nodes.new("NodeGroupOutput")
wrap.links.new(n_in.outputs[0], n_grp.inputs[0])
wrap.links.new(n_grp.outputs[0], n_store.inputs["Geometry"])
# find the requested field output on the inner group node
field_sock = None
for s in n_grp.outputs:
    if s.identifier == field_ident or s.name == field_ident:
        field_sock = s
        break
assert field_sock is not None, f"field output {field_ident} not found"
wrap.links.new(field_sock, n_store.inputs["Value"])
wrap.links.new(n_store.outputs["Geometry"], n_out.inputs[0])

mod = obj.modifiers.new("GN", "NODES")
mod.node_group = wrap

# bind inner-group params by copying them onto the inner group node defaults
if params_path:
    overrides = json.load(open(params_path))
    for s in n_grp.inputs:
        if s.identifier in overrides:
            try:
                s.default_value = overrides[s.identifier]
                print("  bound", s.identifier, "=", overrides[s.identifier])
            except Exception as e:
                print("  !! bind", s.identifier, e)

obj.update_tag()
dg = bpy.context.evaluated_depsgraph_get()
ev = obj.evaluated_get(dg)
m = ev.to_mesh()
attr = m.attributes.get("__oracle_mask")
mask = [0] * len(m.polygons)
if attr:
    for i, v in enumerate(attr.data):
        mask[i] = 1 if v.value else 0
centers = [[round(p.center.x, 4), round(p.center.y, 4), round(p.center.z, 4)] for p in m.polygons]
with open(out_path, "w") as f:
    json.dump({"centers": centers, "mask": mask}, f)
on = sum(mask)
print(f"MASK_ORACLE_OK: {len(mask)} faces, {on} selected -> {out_path}")
ev.to_mesh_clear()
