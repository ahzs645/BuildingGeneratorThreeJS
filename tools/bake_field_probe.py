"""Bake an internal field value from a node group by splicing a
StoreNamedAttribute before a consumer node, then evaluating an object.
Usage: blender --background FILE.blend --python bake_field_probe.py -- \
    OBJECT GROUP SRC_NODE SRC_SOCKET CONSUMER_NODE OUT.json [overrides.json]
Stores SRC_NODE.SRC_SOCKET (FLOAT, POINT) on the geometry entering
CONSUMER_NODE.Geometry and dumps per-vertex {value, x, y, z}."""
import bpy, json, os, sys

argv = sys.argv[sys.argv.index("--") + 1:]
obj_name, group_name, src_node, src_socket, consumer_node, out_path = argv[:6]
overrides_path = argv[6] if len(argv) > 6 else None

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
is_color = out_sock.bl_idname.startswith("NodeSocketColor")

store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
store.data_type = "FLOAT_VECTOR" if is_vec else "FLOAT_COLOR" if is_color else "FLOAT"
store.domain = "POINT"
store.inputs["Name"].default_value = "__probe"
tree.links.new(from_sock, store.inputs["Geometry"])
tree.links.new(out_sock, store.inputs["Value"])
if os.environ.get("NODE_DOJO_PROBE_DIRECT_OUTPUT") == "1":
    group_output = next(
        node for node in tree.nodes if node.bl_idname == "NodeGroupOutput" and node.is_active_output
    )
    geometry_output = next(socket for socket in group_output.inputs if socket.type == "GEOMETRY")
    for link in list(geometry_output.links):
        tree.links.remove(link)
    tree.links.new(store.outputs["Geometry"], geometry_output)
else:
    # Rewire the consumer to preserve the original downstream evaluation.
    for l in list(geo_in.links):
        tree.links.remove(l)
    tree.links.new(store.outputs["Geometry"], geo_in)

obj = bpy.data.objects[obj_name]
if obj.name not in bpy.context.view_layer.objects:
    probe_scene = bpy.data.scenes.new("__NODE_DOJO_FIELD_PROBE_SCENE")
    probe_scene.collection.objects.link(obj)
    bpy.context.window.scene = probe_scene
obj.hide_viewport = False
obj.hide_render = False
obj.hide_set(False)
if overrides_path:
    overrides = json.load(open(overrides_path))
    modifier = next((m for m in obj.modifiers if m.type == "NODES" and m.node_group == tree), None)
    assert modifier is not None, f"no Geometry Nodes modifier using {group_name} on {obj_name}"
    inputs = {
        item.name: item.identifier
        for item in tree.interface.items_tree
        if item.item_type == "SOCKET" and item.in_out == "INPUT"
    }
    for name, value in overrides.items():
        identifier = inputs.get(name, name)
        modifier[identifier] = value
        print("  override", name, "->", identifier, "=", value)
obj.update_tag()
dg = bpy.context.evaluated_depsgraph_get()
ev = obj.evaluated_get(dg)
m = ev.to_mesh()
attr = m.attributes.get("__probe")
full_precision = os.environ.get("NODE_DOJO_PROBE_FULL_PRECISION") == "1"
encode = (lambda value: value) if full_precision else (lambda value: round(value, 5))
if attr and is_color:
    vals = [[encode(c) for c in a.color] for a in attr.data]
elif attr and is_vec:
    vals = [[encode(c) for c in a.vector] for a in attr.data]
else:
    vals = [encode(a.value) for a in attr.data] if attr else []
print(f"FIELD_PROBE_OK: {len(vals)} values (vector={is_vec}, color={is_color})")
if vals and not is_vec:
    s = sorted(vals)
    n = len(s)
    print(f"  stats: min={s[0]} p25={s[n//4]} med={s[n//2]} p75={s[3*n//4]} max={s[-1]}")
elif vals and is_vec:
    import math
    mags = sorted(math.sqrt(v[0]**2 + v[1]**2 + v[2]**2) for v in vals)
    n = len(mags)
    print(f"  |v| stats: min={mags[0]:.4f} p25={mags[n//4]:.4f} med={mags[n//2]:.4f} p75={mags[3*n//4]:.4f} max={mags[-1]:.4f}")
positions = [[encode(c) for c in vertex.co] for vertex in m.vertices]
with open(out_path, "w") as f:
    json.dump({"values": vals, "positions": positions, "overrides": json.load(open(overrides_path)) if overrides_path else {}}, f)
ev.to_mesh_clear()
