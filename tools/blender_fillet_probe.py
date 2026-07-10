"""Probe Blender's Fillet Curve point placement on a three-point poly spline.

Usage: blender --background --python blender_fillet_probe.py -- OUT.json
"""
import bpy, json, sys

out_path = sys.argv[sys.argv.index("--") + 1]
results = []
for count in (1, 2, 3, 9, 13):
    curve = bpy.data.curves.new(f"probe_{count}", "CURVE")
    curve.dimensions = "3D"
    spline = curve.splines.new("POLY")
    spline.points.add(2)
    for point, co in zip(spline.points, ((0, 0, 0, 1), (1, 0, 0, 1), (1, 1, 0, 1))):
        point.co = co
    obj = bpy.data.objects.new(f"probe_{count}", curve)
    bpy.context.collection.objects.link(obj)

    tree = bpy.data.node_groups.new(f"probe_{count}", "GeometryNodeTree")
    tree.interface.new_socket(name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry")
    tree.interface.new_socket(name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry")
    group_in = tree.nodes.new("NodeGroupInput")
    group_out = tree.nodes.new("NodeGroupOutput")
    fillet = tree.nodes.new("GeometryNodeFilletCurve")
    fillet.inputs["Radius"].default_value = 0.5
    fillet.inputs["Limit Radius"].default_value = True
    fillet.inputs["Mode"].default_value = "Poly"
    fillet.inputs["Count"].default_value = count
    to_mesh = tree.nodes.new("GeometryNodeCurveToMesh")
    tree.links.new(group_in.outputs["Geometry"], fillet.inputs["Curve"])
    tree.links.new(fillet.outputs["Curve"], to_mesh.inputs["Curve"])
    tree.links.new(to_mesh.outputs["Mesh"], group_out.inputs["Geometry"])
    modifier = obj.modifiers.new("probe", "NODES")
    modifier.node_group = tree

    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    results.append({
        "count": count,
        "positions": [[round(component, 7) for component in vertex.co] for vertex in mesh.vertices],
        "edges": [list(edge.vertices) for edge in mesh.edges],
    })
    evaluated.to_mesh_clear()

with open(out_path, "w") as handle:
    json.dump(results, handle, indent=2)
print("BLENDER_FILLET_PROBE_OK ->", out_path)
