"""Bake an internal field value from a node group by splicing a
StoreNamedAttribute before a consumer node, then evaluating an object.
Usage: blender --background FILE.blend --python bake_field_probe.py -- \
    OBJECT GROUP SRC_NODE SRC_SOCKET CONSUMER_NODE OUT.json
Stores SRC_NODE.SRC_SOCKET (FLOAT, POINT) on the geometry entering
CONSUMER_NODE.Geometry and dumps per-vertex {value, x, y, z}."""
import bpy, json, sys

argv = sys.argv[sys.argv.index("--") + 1:]
obj_name, group_name, src_node, src_socket, consumer_node, out_path = argv

tree = bpy.data.node_groups[group_name]
src = tree.nodes[src_node]
consumer = tree.nodes[consumer_node]

geo_in = None
for s in consumer.inputs:
    if s.bl_idname == "NodeSocketGeometry" and s.is_linked:
        geo_in = s
        break
assert geo_in is not None, "no linked geometry input on consumer"
from_sock = geo_in.links[0].from_socket

out_sock = None
for s in src.outputs:
    if s.identifier == src_socket or s.name == src_socket:
        out_sock = s
        break
assert out_sock is not None, f"socket {src_socket} not found on {src_node}"
is_vec = out_sock.bl_idname.startswith("NodeSocketVector")

store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
store.data_type = "FLOAT_VECTOR" if is_vec else "FLOAT"
store.domain = "POINT"
store.inputs["Name"].default_value = "__probe"
tree.links.new(from_sock, store.inputs["Geometry"])
tree.links.new(out_sock, store.inputs["Value"])
# rewire consumer to take the stored geometry
for l in list(geo_in.links):
    tree.links.remove(l)
tree.links.new(store.outputs["Geometry"], geo_in)

obj = bpy.data.objects[obj_name]
obj.update_tag()
dg = bpy.context.evaluated_depsgraph_get()
ev = obj.evaluated_get(dg)
m = ev.to_mesh()
attr = m.attributes.get("__probe")
if attr and is_vec:
    vals = [[round(c, 5) for c in a.vector] for a in attr.data]
else:
    vals = [round(a.value, 5) for a in attr.data] if attr else []
print(f"FIELD_PROBE_OK: {len(vals)} values (vector={is_vec})")
if vals and not is_vec:
    s = sorted(vals)
    n = len(s)
    print(f"  stats: min={s[0]} p25={s[n//4]} med={s[n//2]} p75={s[3*n//4]} max={s[-1]}")
elif vals:
    import math
    mags = sorted(math.sqrt(v[0]**2 + v[1]**2 + v[2]**2) for v in vals)
    n = len(mags)
    print(f"  |v| stats: min={mags[0]:.4f} p25={mags[n//4]:.4f} med={mags[n//2]:.4f} p75={mags[3*n//4]:.4f} max={mags[-1]:.4f}")
with open(out_path, "w") as f:
    json.dump({"values": vals}, f)
ev.to_mesh_clear()
