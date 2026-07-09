"""Bake an arbitrary internal branch's geometry: rewire the group output to a
given node's geometry output and evaluate the object.
Usage: blender --background FILE.blend --python bake_branch_geometry.py -- \
    OBJECT GROUP NODE SOCKET OUT.json"""
import bpy, json, sys

argv = sys.argv[sys.argv.index("--") + 1:]
obj_name, group_name, node_name, socket_name, out_path = argv

tree = bpy.data.node_groups[group_name]
src = tree.nodes[node_name]
out_node = next(n for n in tree.nodes if n.bl_idname == "NodeGroupOutput")
geo_out = next(s for s in out_node.inputs if s.bl_idname == "NodeSocketGeometry")
for l in list(geo_out.links):
    tree.links.remove(l)
src_sock = next(s for s in src.outputs if s.identifier == socket_name or s.name == socket_name)
# Realize instances + convert any curve component to a wire mesh (Curve to Mesh
# with no profile = control points as verts) so curve/instance branches (the
# arrayed arc, trimmed profile) dump their points instead of 0.
realize = tree.nodes.new("GeometryNodeRealizeInstances")
c2m = tree.nodes.new("GeometryNodeCurveToMesh")
join = tree.nodes.new("GeometryNodeJoinGeometry")
tree.links.new(src_sock, realize.inputs[0])
tree.links.new(realize.outputs[0], c2m.inputs["Curve"])  # no profile -> wire mesh
tree.links.new(realize.outputs[0], join.inputs[0])
tree.links.new(c2m.outputs[0], join.inputs[0])
tree.links.new(join.outputs[0], geo_out)

obj = bpy.data.objects[obj_name]
obj.update_tag()
dg = bpy.context.evaluated_depsgraph_get()
ev = obj.evaluated_get(dg)
m = ev.to_mesh()
verts = [[round(v.co.x, 4), round(v.co.y, 4), round(v.co.z, 4)] for v in m.vertices]
print(f"BRANCH_OK: {len(verts)} verts")
import math
if verts:
    rs = sorted(math.hypot(v[0], v[1]) for v in verts)
    zs = sorted(v[2] for v in verts)
    n = len(verts)
    print(f"  r[p10={rs[n//10]:.1f} med={rs[n//2]:.1f} p90={rs[9*n//10]:.1f}] z[p10={zs[n//10]:.1f} med={zs[n//2]:.1f} p90={zs[9*n//10]:.1f}]")
with open(out_path, "w") as f:
    json.dump({"verts": verts}, f)
ev.to_mesh_clear()
