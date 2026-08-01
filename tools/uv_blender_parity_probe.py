"""Emit focused Blender truth for Geometry Nodes UV evaluator parity.

This probe intentionally avoids the much heavier SDF cases in
``uv_sdf_blender_probe.py``.  It covers the authored Node Dojo planar-grid
configuration plus topology and input cases that keep UV Unwrap/Pack Islands
classified as bounded approximations.

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender \
    --background --factory-startup \
    --python tools/uv_blender_parity_probe.py
"""

import hashlib
import json

import bpy


def socket(node, in_out, identifier):
    sockets = node.inputs if in_out == "INPUT" else node.outputs
    for candidate in sockets:
        if candidate.identifier == identifier or candidate.name == identifier:
            return candidate
    raise RuntimeError(
        f"{node.bl_idname} has no {in_out.lower()} socket {identifier}: "
        + ", ".join(f"{item.name} ({item.identifier})" for item in sockets)
    )


def geometry_tree(name):
    tree = bpy.data.node_groups.new(name, "GeometryNodeTree")
    tree.interface.new_socket(
        name="Geometry", in_out="INPUT", socket_type="NodeSocketGeometry"
    )
    tree.interface.new_socket(
        name="Geometry", in_out="OUTPUT", socket_type="NodeSocketGeometry"
    )
    return tree, tree.nodes.new("NodeGroupInput"), tree.nodes.new("NodeGroupOutput")


def mesh_from_data(name, vertices, faces):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    return mesh


def evaluate(name, mesh, tree, attribute_name):
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    modifier = obj.modifiers.new(name="Probe", type="NODES")
    modifier.node_group = tree
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    result = evaluated.to_mesh()
    try:
        attribute = result.attributes[attribute_name]
        return [[float(value) for value in item.vector] for item in attribute.data]
    finally:
        evaluated.to_mesh_clear()


def unwrap(name, mesh, *, method="Conformal", margin=0.0, fill_holes=True,
           iterations=10, no_flip=False, seam_pairs=()):
    tree, group_input, group_output = geometry_tree(f"{name} Tree")
    node = tree.nodes.new("GeometryNodeUVUnwrap")
    socket(node, "INPUT", "Selection").default_value = True
    socket(node, "INPUT", "Margin").default_value = margin
    socket(node, "INPUT", "Fill Holes").default_value = fill_holes
    socket(node, "INPUT", "Method").default_value = method
    socket(node, "INPUT", "Iterations").default_value = iterations
    socket(node, "INPUT", "No Flip").default_value = no_flip
    if seam_pairs:
        seam_keys = {tuple(sorted(pair)) for pair in seam_pairs}
        seam = mesh.attributes.new("probe_seam", "BOOLEAN", "EDGE")
        for edge, value in zip(mesh.edges, seam.data):
            value.value = tuple(sorted(edge.vertices)) in seam_keys
        named = tree.nodes.new("GeometryNodeInputNamedAttribute")
        named.data_type = "BOOLEAN"
        socket(named, "INPUT", "Name").default_value = "probe_seam"
        tree.links.new(socket(named, "OUTPUT", "Attribute"), socket(node, "INPUT", "Seam"))
    store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
    store.data_type = "FLOAT_VECTOR"
    store.domain = "CORNER"
    socket(store, "INPUT", "Name").default_value = "uv_probe"
    tree.links.new(socket(group_input, "OUTPUT", "Geometry"), socket(store, "INPUT", "Geometry"))
    tree.links.new(socket(node, "OUTPUT", "UV"), socket(store, "INPUT", "Value"))
    tree.links.new(socket(store, "OUTPUT", "Geometry"), socket(group_output, "INPUT", "Geometry"))
    return evaluate(name, mesh, tree, "uv_probe")


def pack(name, mesh, source_values, *, margin=0.001):
    source = mesh.attributes.new("source_uv", "FLOAT_VECTOR", "CORNER")
    for item, value in zip(source.data, source_values):
        item.vector = value
    tree, group_input, group_output = geometry_tree(f"{name} Tree")
    named = tree.nodes.new("GeometryNodeInputNamedAttribute")
    named.data_type = "FLOAT_VECTOR"
    socket(named, "INPUT", "Name").default_value = "source_uv"
    node = tree.nodes.new("GeometryNodeUVPackIslands")
    socket(node, "INPUT", "Selection").default_value = True
    socket(node, "INPUT", "Margin").default_value = margin
    socket(node, "INPUT", "Bottom Left").default_value = (0, 0)
    socket(node, "INPUT", "Top Right").default_value = (1, 1)
    store = tree.nodes.new("GeometryNodeStoreNamedAttribute")
    store.data_type = "FLOAT_VECTOR"
    store.domain = "CORNER"
    socket(store, "INPUT", "Name").default_value = "uv_probe"
    tree.links.new(socket(named, "OUTPUT", "Attribute"), socket(node, "INPUT", "UV"))
    tree.links.new(socket(group_input, "OUTPUT", "Geometry"), socket(store, "INPUT", "Geometry"))
    tree.links.new(socket(node, "OUTPUT", "UV"), socket(store, "INPUT", "Value"))
    tree.links.new(socket(store, "OUTPUT", "Geometry"), socket(group_output, "INPUT", "Geometry"))
    return evaluate(name, mesh, tree, "uv_probe")


def grid_mesh(name, count_x=40, count_y=40, size_x=5.410000324249268,
              size_y=5.230000019073486):
    vertices = [
        (
            -size_x / 2 + size_x * x / (count_x - 1),
            -size_y / 2 + size_y * y / (count_y - 1),
            0,
        )
        for y in range(count_y)
        for x in range(count_x)
    ]
    faces = [
        (
            y * count_x + x,
            y * count_x + x + 1,
            (y + 1) * count_x + x + 1,
            (y + 1) * count_x + x,
        )
        for y in range(count_y - 1)
        for x in range(count_x - 1)
    ]
    return mesh_from_data(name, vertices, faces)


def summarize(values):
    indices = sorted({0, 1, 2, 3, len(values) // 2, len(values) - 4,
                      len(values) - 3, len(values) - 2, len(values) - 1})
    return {
        "count": len(values),
        "bounds": {
            "min": [min(value[axis] for value in values) for axis in range(2)],
            "max": [max(value[axis] for value in values) for axis in range(2)],
        },
        "samples": {str(index): values[index] for index in indices},
    }


def max_delta(left, right):
    return max(
        abs(left[index][axis] - right[index][axis])
        for index in range(min(len(left), len(right)))
        for axis in range(3)
    )


def quantized_hash(values):
    # Four decimals remains two orders of magnitude tighter than the visual UV
    # tolerance while absorbing Blender's <= 1.13e-7 LSCM float residual.
    payload = ",".join(
        f"{(0.0 if abs(component) < 0.00005 else component):.4f}"
        for value in values for component in value
    )
    return hashlib.sha256(payload.encode("ascii")).hexdigest()


def authored_grid_analytical_values(mesh):
    min_x = min(vertex.co.x for vertex in mesh.vertices)
    min_y = min(vertex.co.y for vertex in mesh.vertices)
    width = max(vertex.co.x for vertex in mesh.vertices) - min_x
    values = []
    for polygon in mesh.polygons:
        for loop_index in polygon.loop_indices:
            position = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            values.append([
                (position.y - min_y) / width,
                1.0 - (position.x - min_x) / width,
                0.0,
            ])
    return values


def ring_mesh(name):
    return mesh_from_data(
        name,
        [
            (-2, -2, 0), (2, -2, 0), (2, 2, 0), (-2, 2, 0),
            (-1, -1, 0), (-1, 1, 0), (1, 1, 0), (1, -1, 0),
        ],
        [(0, 1, 7, 4), (1, 2, 6, 7), (2, 3, 5, 6), (3, 0, 4, 5)],
    )


def disconnected_quads(name):
    return mesh_from_data(
        name,
        [(0, 0, 0), (2, 0, 0), (2, 1, 0), (0, 1, 0),
         (3, 0, 0), (4, 0, 0), (4, 2, 0), (3, 2, 0)],
        [(0, 1, 2, 3), (4, 5, 6, 7)],
    )


def single_quad(name):
    return mesh_from_data(
        name,
        [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)],
        [(0, 1, 2, 3)],
    )


def open_cube_sides(name):
    return mesh_from_data(
        name,
        [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
         (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)],
        [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)],
    )


def seam_cube(name):
    return mesh_from_data(
        name,
        [(-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
         (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)],
        [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
         (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)],
    )


def planar_two_quads(name):
    return mesh_from_data(
        name,
        [(0, 0, 0), (2, 0, 0), (4, 0, 0),
         (0, 1, 0), (2, 1, 0), (4, 1, 0)],
        [(0, 1, 4, 3), (1, 2, 5, 4)],
    )


authored_mesh = grid_mesh("Authored Grid Mesh")
authored = unwrap("Authored Grid", authored_mesh)
authored_analytical = authored_grid_analytical_values(authored_mesh)
ring_true = unwrap("Ring Fill", ring_mesh("Ring Fill Mesh"), fill_holes=True)
ring_false = unwrap("Ring No Fill", ring_mesh("Ring No Fill Mesh"), fill_holes=False)
open_cube_fill = unwrap(
    "Open Cube Fill", open_cube_sides("Open Cube Fill Mesh"), fill_holes=True
)
open_cube_no_fill = unwrap(
    "Open Cube No Fill", open_cube_sides("Open Cube No Fill Mesh"), fill_holes=False
)
cube_seams = ((0, 1), (1, 2), (2, 3), (0, 3), (0, 4), (2, 6))
cube_iteration_1 = unwrap(
    "Cube Iteration 1", seam_cube("Cube Iteration 1 Mesh"),
    method="Angle Based", margin=0.001, iterations=1, seam_pairs=cube_seams
)
cube_iteration_10 = unwrap(
    "Cube Iteration 10", seam_cube("Cube Iteration 10 Mesh"),
    method="Angle Based", margin=0.001, iterations=10, seam_pairs=cube_seams
)
cube_no_flip = unwrap(
    "Cube No Flip", seam_cube("Cube No Flip Mesh"),
    method="Angle Based", margin=0.001, iterations=10, no_flip=True,
    seam_pairs=cube_seams
)
pack_values = pack(
    "Two Island Pack",
    disconnected_quads("Two Island Pack Mesh"),
    [(0, 0, 0), (2, 0, 0), (2, 1, 0), (0, 1, 0),
     (4, 0, 0), (5, 0, 0), (5, 2, 0), (4, 2, 0)],
)
single_rectangle_pack = {
    str(margin): pack(
        f"Single Rectangle Pack {margin}",
        single_quad(f"Single Rectangle Pack {margin} Mesh"),
        [(2, 4, 0), (6, 4, 0), (6, 6, 0), (2, 6, 0)],
        margin=margin,
    )
    for margin in (0.0, 0.001, 0.1)
}
planar_cases = {
    "angle_margin_0": unwrap(
        "Planar Angle Margin 0", planar_two_quads("Planar Angle Margin 0 Mesh"),
        method="Angle Based", margin=0.0,
    ),
    "angle_margin_001": unwrap(
        "Planar Angle Margin 001", planar_two_quads("Planar Angle Margin 001 Mesh"),
        method="Angle Based", margin=0.001,
    ),
    "conformal_margin_0": unwrap(
        "Planar Conformal Margin 0", planar_two_quads("Planar Conformal Margin 0 Mesh"),
        method="Conformal", margin=0.0,
    ),
    "conformal_margin_001": unwrap(
        "Planar Conformal Margin 001", planar_two_quads("Planar Conformal Margin 001 Mesh"),
        method="Conformal", margin=0.001,
    ),
    "conformal_fill_holes_false": unwrap(
        "Planar Conformal No Fill", planar_two_quads("Planar Conformal No Fill Mesh"),
        method="Conformal", margin=0.001, fill_holes=False,
    ),
    "conformal_iterations_1": unwrap(
        "Planar Conformal Iteration 1", planar_two_quads("Planar Conformal Iteration 1 Mesh"),
        method="Conformal", margin=0.001, iterations=1,
    ),
    "conformal_no_flip": unwrap(
        "Planar Conformal No Flip", planar_two_quads("Planar Conformal No Flip Mesh"),
        method="Conformal", margin=0.001, no_flip=True,
    ),
    "conformal_shared_seam": unwrap(
        "Planar Conformal Seam", planar_two_quads("Planar Conformal Seam Mesh"),
        method="Conformal", margin=0.001, seam_pairs=((1, 4),),
    ),
    "angle_shared_seam": unwrap(
        "Planar Angle Seam", planar_two_quads("Planar Angle Seam Mesh"),
        method="Angle Based", margin=0.001, seam_pairs=((1, 4),),
    ),
}

print("UV_PARITY_PROBE " + json.dumps({
    "blender": bpy.app.version_string,
    "authored_grid_40x40_conformal": {
        **summarize(authored),
        "all_corner_quantized_sha256": quantized_hash(authored),
        "analytical_quantized_sha256": quantized_hash(authored_analytical),
        "all_corner_analytical_max_delta": max_delta(authored, authored_analytical),
    },
    "ring_fill_holes_true": summarize(ring_true),
    "ring_fill_holes_false": summarize(ring_false),
    "ring_fill_holes_max_delta": max_delta(ring_true, ring_false),
    "open_cube_fill_holes_max_delta": max_delta(open_cube_fill, open_cube_no_fill),
    "iteration_1_vs_10_max_delta": max_delta(cube_iteration_1, cube_iteration_10),
    "no_flip_false_vs_true_max_delta": max_delta(cube_iteration_10, cube_no_flip),
    "cube_iteration_1": summarize(cube_iteration_1),
    "cube_iteration_10": summarize(cube_iteration_10),
    "cube_no_flip": summarize(cube_no_flip),
    "planar_two_quads": planar_cases,
    "single_rectangle_pack": single_rectangle_pack,
    "two_island_pack": summarize(pack_values),
}, sort_keys=True))
